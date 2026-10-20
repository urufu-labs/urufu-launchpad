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
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

interface IFairHookConfig {
    function setPoolConfig(
        PoolId id,
        address creator,
        uint256 creatorBaseline,
        bool forfeited,
        uint32 antiSniperSeconds
    ) external;
    function pools(
        PoolId id
    )
        external
        view
        returns (
            address token,
            address creator,
            uint64 launchTs,
            uint32 antiSniperSeconds,
            uint24 fee,
            int24 tickSpacing,
            bool configured,
            bool forfeited,
            uint256 creatorBaseline
        );
    function initializer() external view returns (address);
    function forfeitDropBps() external view returns (uint16);
}

interface IFairFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
    function batchFor(
        address token
    ) external view returns (address);
}

interface IOpeningBatchCreator {
    function tokensBought() external view returns (uint256);
    function entitlement(
        address user
    ) external view returns (uint256);
    function claimFor(
        address user
    ) external returns (uint256 tokens, uint256 refund);
}

interface IFairCurveReserves {
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
    function creatorBought() external view returns (uint256);
}

/// @title  FairGraduator
/// @notice Fair-lane copy of the GraduatorV3 LP flow: locked full-range position owned by
///         this contract (no remove / collect path exists), excess-token burn, pull-based
///         ETH refund ledger for rounding dust, owner `sweep` that can never touch
///         credited refunds, and URU-A12 read-back of the hook config before `initialize`
///         freezes it. Fair-lane additions:
///
///           * Writes the creator baseline and a start-forfeited flag to `FairHookHost`
///             (spec §3). The creator should hold at least what the launch wallet got
///             from the lane: its curve buys plus its opening-batch share. Baseline =
///             max(balance, that amount). The pool starts forfeited if the creator sold
///             on the curve OR already holds more than the drop allowance below that
///             amount, which catches a pre-graduation transfer to an alt wallet. It also
///             starts forfeited if the creator holds under 0.1% of supply: no holdings,
///             no fee.
///           * Opening price is `max(curve marginal, raw real ratio)`. Marginal is what
///             GraduatorV3 uses (no cliff for the last curve buyer); taking the max means
///             ETH is always the limiting side of the LP add, so ETH can never strand the
///             way it did with the 2026-07-30 V7 graduator, whatever the curve params.
///             Unused tokens are burned.
///
/// @dev    Constructor runs a pre-flight check that the hook address carries the exact
///         permission bits FairHookHost needs, so a mis-mined or stale hook address
///         fails at deploy, not at the first graduation.
contract FairGraduator is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    error FairGraduator__NotPoolManager();
    error FairGraduator__EthMismatch(uint256 sent, uint256 expected);
    error FairGraduator__ZeroAmount();
    error FairGraduator__NotAuthorizedCurve(address caller, address expected);
    error FairGraduator__NotOwner();
    error FairGraduator__ZeroAddress();
    error FairGraduator__HookConfigMismatch();
    error FairGraduator__NothingToClaim();
    error FairGraduator__BadHookFlags(address hook, uint160 flags);
    error FairGraduator__FactoryAlreadySet();

    event Graduated(
        address indexed token,
        address indexed hook,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        address creator,
        uint256 creatorBaseline,
        bool forfeited
    );
    event ExcessBurned(address indexed token, uint256 amount);
    event RefundCredited(address indexed token, address indexed launcher, uint256 amount);
    event RefundClaimed(address indexed launcher, address indexed recipient, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event OwnerSet(address indexed oldOwner, address indexed newOwner);
    event FactorySet(address indexed factory);

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// beforeInitialize | beforeAddLiquidity | beforeSwap | afterSwap | afterSwapReturnsDelta.
    uint160 public constant REQUIRED_HOOK_FLAGS = 0x28C4;
    uint160 internal constant FLAG_MASK = 0x3FFF;
    /// "No holdings, no fee": a creator holding less than 0.1% of supply at graduation
    /// starts forfeited. Zero or dust balances never earn creator fees.
    uint16 public constant MIN_CREATOR_HOLD_BPS = 10;
    /// Gas budget for pushing the creator's batch share at graduation.
    uint256 internal constant CREATOR_CLAIM_GAS = 400_000;

    IPoolManager public immutable poolManager;
    IHooks public immutable hook;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    /// Anti-sniper revert gate passed to every pool. Lane default is 0 (the tax replaces it).
    uint32 public immutable antiSniperSeconds;

    /// FairLaunchFactory. Set once (the factory needs this graduator's address at its own
    /// construction, so one side has to be wired after deploy).
    IFairFactoryLookup public factory;
    address public owner;
    mapping(address launcher => uint256 amount) public claimableRefunds;
    uint256 public totalClaimable;

    modifier onlyOwner() {
        if (msg.sender != owner) revert FairGraduator__NotOwner();
        _;
    }

    constructor(
        IPoolManager _poolManager,
        IHooks _hook,
        uint24 _fee,
        int24 _tickSpacing,
        uint32 _antiSniperSeconds,
        address _owner
    ) {
        if (_owner == address(0) || address(_poolManager) == address(0)) revert FairGraduator__ZeroAddress();
        uint160 flags = uint160(address(_hook)) & FLAG_MASK;
        if (flags != REQUIRED_HOOK_FLAGS) revert FairGraduator__BadHookFlags(address(_hook), flags);
        poolManager = _poolManager;
        hook = _hook;
        fee = _fee;
        tickSpacing = _tickSpacing;
        tickLower = (TickMath.MIN_TICK / _tickSpacing + 1) * _tickSpacing;
        tickUpper = (TickMath.MAX_TICK / _tickSpacing) * _tickSpacing;
        antiSniperSeconds = _antiSniperSeconds;
        owner = _owner;
        emit OwnerSet(address(0), _owner);
    }

    function setFactory(
        address _factory
    ) external onlyOwner {
        if (address(factory) != address(0)) revert FairGraduator__FactoryAlreadySet();
        if (_factory == address(0)) revert FairGraduator__ZeroAddress();
        factory = IFairFactoryLookup(_factory);
        emit FactorySet(_factory);
    }

    function setOwner(
        address newOwner
    ) external onlyOwner {
        if (newOwner == address(0)) revert FairGraduator__ZeroAddress();
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
    }

    /// Safety net for ETH a future math regression might leave here. Never touches the
    /// pull-refund ledger.
    function sweep(
        address payable to
    ) external onlyOwner {
        if (to == address(0)) revert FairGraduator__ZeroAddress();
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
        if (recipient == address(0)) revert FairGraduator__ZeroAddress();
        _claimTo(recipient);
    }

    function _claimTo(
        address recipient
    ) private {
        uint256 amount = claimableRefunds[msg.sender];
        if (amount == 0) revert FairGraduator__NothingToClaim();
        claimableRefunds[msg.sender] = 0;
        totalClaimable -= amount;
        SafeTransferLib.safeTransferETH(recipient, amount);
        emit RefundClaimed(msg.sender, recipient, amount);
    }

    /// Opening price (ETH per whole token, 1e18 fixed point) for a graduation. Exposed so
    /// tests and the UI can check it against the curve's last price.
    function openingPrice(
        uint256 virtEth,
        uint256 virtTok,
        uint256 ethAmount,
        uint256 tokenAmount
    ) public pure returns (uint256) {
        uint256 marginal = ((virtEth + ethAmount) * 1e18) / (virtTok + tokenAmount);
        uint256 raw = (ethAmount * 1e18) / tokenAmount;
        return marginal > raw ? marginal : raw;
    }

    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        address launcher,
        bool creatorSold
    ) external payable {
        address authorized = factory.curveFor(token);
        if (msg.sender != authorized) revert FairGraduator__NotAuthorizedCurve(msg.sender, authorized);
        if (ethAmount == 0 || tokenAmount == 0) revert FairGraduator__ZeroAmount();
        if (msg.value != ethAmount) revert FairGraduator__EthMismatch(msg.value, ethAmount);

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);

        IFairCurveReserves curve = IFairCurveReserves(msg.sender);
        uint256 price = openingPrice(curve.virtualEthReserve(), curve.virtualTokenReserve(), ethAmount, tokenAmount);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hook
        });
        PoolId poolId = key.toId();

        // Deliver the creator's unclaimed opening-batch share first, so the baseline
        // counts it. Otherwise a creator could leave the share in the batch, graduate
        // with a small baseline, then claim and dump the share without forfeiting.
        // Best effort: a creator that never deposited (or already claimed, or rejects
        // the ETH refund) just reverts inside the try and is skipped. Gas is capped so a
        // creator contract cannot burn the graduating buyer's gas and brick graduation.
        if (launcher != address(0)) {
            address batch = factory.batchFor(token);
            if (batch != address(0) && IOpeningBatchCreator(batch).tokensBought() > 0) {
                try IOpeningBatchCreator(batch).claimFor{gas: CREATOR_CLAIM_GAS}(launcher) {} catch {}
            }
        }
        (uint256 baseline, bool forfeited) = _creatorState(token, launcher, creatorSold);
        IFairHookConfig cfg = IFairHookConfig(address(hook));
        cfg.setPoolConfig(poolId, launcher, baseline, forfeited, antiSniperSeconds);
        _verifyHookConfig(cfg, poolId, launcher, baseline, forfeited);

        // v4 price = wei_token / wei_ETH = 1e18 / price; sqrtPriceX96 = 1e9 * 2^96 / sqrt(price).
        uint160 sqrtPriceX96 = uint160((uint256(1e9) << 96) / FixedPointMathLib.sqrt(price));
        poolManager.initialize(key, sqrtPriceX96);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), ethAmount, tokenAmount
        );
        poolManager.unlock(abi.encode(key, uint256(liquidity)));

        uint256 residual = _balanceOf(token, address(this));
        if (residual > 0) {
            SafeTransferLib.safeTransfer(token, BURN_ADDRESS, residual);
            emit ExcessBurned(token, residual);
        }
        uint256 ethResidual = address(this).balance - totalClaimable;
        if (ethResidual > 0 && launcher != address(0)) {
            claimableRefunds[launcher] += ethResidual;
            totalClaimable += ethResidual;
            emit RefundCredited(token, launcher, ethResidual);
        }

        emit Graduated(token, address(hook), ethAmount, tokenAmount, sqrtPriceX96, liquidity, launcher, baseline, forfeited);
    }

    /// Creator baseline + start-forfeited flag. `expected` is what the launch wallet got
    /// from this lane (curve buys to itself + its opening-batch share, claimed or not).
    function _creatorState(
        address token,
        address launcher,
        bool creatorSold
    ) private view returns (uint256 baseline, bool forfeited) {
        if (launcher == address(0)) return (0, creatorSold);
        uint256 expected = IFairCurveReserves(msg.sender).creatorBought();
        address batch = factory.batchFor(token);
        if (batch != address(0)) expected += IOpeningBatchCreator(batch).entitlement(launcher);
        uint256 bal = _balanceOf(token, launcher);
        baseline = bal > expected ? bal : expected;
        uint256 floor = (expected * (10_000 - uint256(IFairHookConfig(address(hook)).forfeitDropBps()))) / 10_000;
        uint256 minHold = (_totalSupply(token) * MIN_CREATOR_HOLD_BPS) / 10_000;
        forfeited = creatorSold || bal < floor || bal < minHold;
    }

    function _verifyHookConfig(
        IFairHookConfig cfg,
        PoolId poolId,
        address launcher,
        uint256 baseline,
        bool forfeitedAtStart
    ) private view {
        (,,, uint32 gate,,, bool configured, bool forfeited, uint256 storedBaseline) = cfg.pools(poolId);
        (, address storedCreator,,,,,,,) = cfg.pools(poolId);
        if (
            !configured || storedCreator != launcher || storedBaseline != baseline || forfeited != forfeitedAtStart
                || gate != antiSniperSeconds
        ) revert FairGraduator__HookConfigMismatch();
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert FairGraduator__NotPoolManager();
        (PoolKey memory key, uint256 liquidity) = abi.decode(data, (PoolKey, uint256));

        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = int128(int256(BalanceDelta.unwrap(callerDelta) >> 128));
        int128 delta1 = int128(int256(BalanceDelta.unwrap(callerDelta)));

        if (delta0 < 0) {
            poolManager.settle{value: uint256(uint128(-delta0))}();
        } else if (delta0 > 0) {
            poolManager.take(key.currency0, address(this), uint256(uint128(delta0)));
        }
        if (delta1 < 0) {
            poolManager.sync(key.currency1);
            SafeTransferLib.safeTransfer(Currency.unwrap(key.currency1), address(poolManager), uint256(uint128(-delta1)));
            poolManager.settle();
        } else if (delta1 > 0) {
            poolManager.take(key.currency1, address(this), uint256(uint128(delta1)));
        }
        return "";
    }

    function _totalSupply(
        address token
    ) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    function _balanceOf(
        address token,
        address account
    ) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    receive() external payable {}
}
