// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

interface IHookConfig {
    function setPoolConfig(
        PoolId id,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external;
    function setCreator(
        PoolId id,
        address creator
    ) external;
    function creator() external view returns (address);
    function creators(
        PoolId id
    ) external view returns (address);
    function poolConfig(
        PoolId id
    ) external view returns (uint32 launchBlock, uint32 antiSniperBlocks, uint16 buybackBurnBps);
}

interface ICurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
}

interface IBondingCurveReserves {
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
}

/// @title  GraduatorV3
/// @notice Third-generation graduator. Combines V7's curve-marginal pricing
///         (so late-curve buyers don't get their positions immediately halved)
///         with V8's excess-token burn + pull-based ETH refund (so nothing
///         stays stranded when the LP-add doesn't absorb everything).
///
///         WHAT CHANGED FROM V2
///           V2 opened the pool at the RAW REAL RATIO of the ETH + tokens the
///           curve handed off:  price = ethAmount / tokenAmount. For a curve
///           with 4.2 ETH raised and ~483M tokens still in reserve at grad,
///           that comes out ~4x LOWER than the curve's marginal price at the
///           same moment (17 virtEth + 4.2 realEth) / (800M virtTok + 483M
///           realTok). Every curve buyer — even the earliest — was
///           immediately worth ~50% less the moment the pool opened.
///
///           V3 opens the pool at the CURVE'S MARGINAL PRICE — the price the
///           last buyer paid before graduation. Uses virtualEthReserve +
///           virtualTokenReserve from the calling curve (both `public
///           immutable`, so the getters are always callable):
///
///             marginalPrice = (virtEth + ethAmount) * 1e18 / (virtTok + tokenAmount)
///
///           At that price, LP absorbs ALL the ETH but only a fraction of the
///           tokens. Leftover tokens go through the existing burn path at
///           `residual > 0 → BURN_ADDRESS` (this was already in V2, just
///           dormant because V2's raw-ratio math absorbed everything).
///
///         WHY V7 FAILED WHERE V3 SHOULDN'T
///           V7 also priced at curve marginal but LACKED the excess-token
///           burn. LP would absorb only some tokens; leftovers sat on the
///           graduator forever with no owner + no sweep. V3 has BOTH the
///           marginal pricing AND the burn (+ owner sweep + pull-refund
///           ledger V8 added), so no funds stay stuck.
///
///         WHY THIS IS SAFE FOR ETH
///           At marginal pricing, ETH is the limiting factor in the LP-add,
///           not tokens. LP-add absorbs `ethAmount` exactly. Any wei of
///           rounding-dust ETH that survives (integer math + LiquidityAmounts
///           truncation) is credited to the launcher's pull-based refund
///           ledger — same path V8 uses for its own dust.
contract GraduatorV3 is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    error Graduator__NotPoolManager();
    error Graduator__EthMismatch(uint256 sent, uint256 expected);
    error Graduator__ZeroAmount();
    error Graduator__NotAuthorizedCurve(address caller, address expected);
    error Graduator__NotOwner();
    error Graduator__ZeroAddress();
    error Graduator__HookConfigMismatch();
    error Graduator__HookCreatorMismatch(address expected, address actual);
    error Graduator__NothingToClaim();

    event Graduated(
        address indexed token,
        address indexed hook,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );
    event ExcessBurned(address indexed token, uint256 amount);
    event RefundCredited(address indexed token, address indexed launcher, uint256 amount);
    event RefundClaimed(address indexed launcher, address indexed recipient, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event OwnerSet(address indexed oldOwner, address indexed newOwner);

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IHooks public immutable defaultHook;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    ICurveFactoryLookup public immutable curveFactory;

    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    address public owner;

    mapping(address launcher => uint256 amount) public claimableRefunds;
    uint256 public totalClaimable;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Graduator__NotOwner();
        _;
    }

    constructor(
        IPoolManager _poolManager,
        IHooks _defaultHook,
        uint24 _fee,
        int24 _tickSpacing,
        address _curveFactory,
        address _owner
    ) {
        if (_owner == address(0)) revert Graduator__ZeroAddress();
        poolManager = _poolManager;
        defaultHook = _defaultHook;
        fee = _fee;
        tickSpacing = _tickSpacing;
        curveFactory = ICurveFactoryLookup(_curveFactory);
        tickLower = (TickMath.MIN_TICK / _tickSpacing + 1) * _tickSpacing;
        tickUpper = (TickMath.MAX_TICK / _tickSpacing) * _tickSpacing;
        owner = _owner;
        emit OwnerSet(address(0), _owner);
    }

    function setOwner(
        address newOwner
    ) external onlyOwner {
        if (newOwner == address(0)) revert Graduator__ZeroAddress();
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
    }

    /// Sweep unallocated ETH — safety net, reserved-aware (won't touch
    /// pull-refund balances).
    function sweep(
        address payable to
    ) external onlyOwner {
        if (to == address(0)) revert Graduator__ZeroAddress();
        uint256 balance = address(this).balance;
        uint256 reserved = totalClaimable;
        uint256 amount = balance > reserved ? balance - reserved : 0;
        if (amount > 0) SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    function claimRefund() external {
        _claimTo(msg.sender);
    }

    function claimRefundTo(
        address recipient
    ) external {
        if (recipient == address(0)) revert Graduator__ZeroAddress();
        _claimTo(recipient);
    }

    function _claimTo(
        address recipient
    ) private {
        uint256 amount = claimableRefunds[msg.sender];
        if (amount == 0) revert Graduator__NothingToClaim();
        claimableRefunds[msg.sender] = 0;
        totalClaimable -= amount;
        SafeTransferLib.safeTransferETH(recipient, amount);
        emit RefundClaimed(msg.sender, recipient, amount);
    }

    /// @notice Graduate a curve. Same signature as V2 — no BondingCurve.sol
    ///         changes needed. Only the internal price + burn behavior differ.
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable {
        address authorized = curveFactory.curveFor(token);
        if (msg.sender != authorized) revert Graduator__NotAuthorizedCurve(msg.sender, authorized);
        if (ethAmount == 0 || tokenAmount == 0) revert Graduator__ZeroAmount();
        if (msg.value != ethAmount) revert Graduator__EthMismatch(msg.value, ethAmount);

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);

        // Read the curve's virtual reserves so we can price the pool at the
        // marginal (last-buyer) price, not the raw ratio. Both getters are
        // `public` on BondingCurve — auto-generated, always callable. The
        // caller HAS to be a curveFactory-authorized curve (checked above)
        // so we trust its state.
        //
        // Curve marginal price (ETH per whole token, 18-decimal fixed point):
        //     price18 = (virtEth + realEth) * 1e18 / (virtTok + realTok)
        //
        // realEth = ethAmount (curve handed us everything)
        // realTok = tokenAmount (same)
        IBondingCurveReserves curveReserves = IBondingCurveReserves(msg.sender);
        uint256 virtEth = curveReserves.virtualEthReserve();
        uint256 virtTok = curveReserves.virtualTokenReserve();
        uint256 curveFinalPrice = ((virtEth + ethAmount) * 1e18) / (virtTok + tokenAmount);

        PoolKey memory key;
        key.currency0 = Currency.wrap(address(0));
        key.currency1 = Currency.wrap(token);
        key.fee = fee;
        key.tickSpacing = tickSpacing;
        key.hooks = defaultHook;

        PoolId poolId = key.toId();
        IHookConfig hookCfg = IHookConfig(address(defaultHook));
        hookCfg.setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps);

        address creatorForPool = launcher;
        if (creatorForPool == address(0)) {
            try hookCfg.creator() returns (address fallbackCreator) {
                creatorForPool = fallbackCreator;
            } catch {}
        }
        if (creatorForPool != address(0)) {
            hookCfg.setCreator(poolId, creatorForPool);
        }

        // URU-A12: verify hook read-back before initialize freezes state.
        (, uint32 configuredAntiSniper, uint16 configuredBurn) = hookCfg.poolConfig(poolId);
        if (configuredAntiSniper != antiSniperBlocks || configuredBurn != buybackBurnBps) {
            revert Graduator__HookConfigMismatch();
        }
        if (creatorForPool != address(0)) {
            address configuredCreator = hookCfg.creators(poolId);
            if (configuredCreator != creatorForPool) {
                revert Graduator__HookCreatorMismatch(creatorForPool, configuredCreator);
            }
        }

        // sqrtPriceX96 for the curve's marginal (not raw ratio). Formula
        // rearranged to avoid uint256 overflow — see V2 comment block for
        // derivation; identical math, different `curveFinalPrice` input.
        uint160 sqrtPriceX96 = uint160((uint256(1e9) << 96) / FixedPointMathLib.sqrt(curveFinalPrice));

        poolManager.initialize(key, sqrtPriceX96);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, ethAmount, tokenAmount);

        poolManager.unlock(abi.encode(key, uint256(liquidity), ethAmount, tokenAmount, token));

        // At marginal pricing, LP absorbs all ETH + only a fraction of tokens.
        // The unabsorbed tokens go to 0xdEaD — deflationary, matches
        // pump.fun-style graduation semantics. Post-launch supply reflects
        // actual on-market float, not the initial mint.
        uint256 residual = _tokenBalance(token);
        if (residual > 0) {
            SafeTransferLib.safeTransfer(token, BURN_ADDRESS, residual);
            emit ExcessBurned(token, residual);
        }

        // Any wei of rounding-dust ETH survives → launcher pull-refund.
        // With marginal pricing this should be ≈ 0 (integer math truncation
        // only), but the ledger path is here as a defensive belt.
        uint256 ethResidual = address(this).balance - totalClaimable;
        if (ethResidual > 0 && launcher != address(0)) {
            claimableRefunds[launcher] += ethResidual;
            totalClaimable += ethResidual;
            emit RefundCredited(token, launcher, ethResidual);
        }

        emit Graduated(token, address(defaultHook), ethAmount, tokenAmount, sqrtPriceX96, liquidity);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Graduator__NotPoolManager();
        (PoolKey memory key, uint256 liquidity,,, address token) =
            abi.decode(data, (PoolKey, uint256, uint256, uint256, address));

        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = _amount0(callerDelta);
        int128 delta1 = _amount1(callerDelta);

        if (delta0 < 0) {
            uint256 owed = uint256(uint128(-delta0));
            poolManager.settle{value: owed}();
        } else if (delta0 > 0) {
            poolManager.take(key.currency0, address(this), uint256(uint128(delta0)));
        }

        if (delta1 < 0) {
            uint256 owed = uint256(uint128(-delta1));
            poolManager.sync(Currency.wrap(token));
            SafeTransferLib.safeTransfer(token, address(poolManager), owed);
            poolManager.settle();
        } else if (delta1 > 0) {
            poolManager.take(key.currency1, address(this), uint256(uint128(delta1)));
        }

        return "";
    }

    function _amount0(
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d) >> 128));
    }

    function _amount1(
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d)));
    }

    function _tokenBalance(
        address token
    ) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok && ret.length >= 32);
        return abi.decode(ret, (uint256));
    }

    receive() external payable {}
}
