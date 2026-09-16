// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 graduator
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    graduator for the DN404 lane.  ports GraduatorV3's marginal
 *    pricing + excess-token burn + pull-refund ledger, adapted so
 *    the v4 pool pairs the launched token against an arbitrary
 *    ERC-20 (USDG, COST, NVDA...) instead of hardcoded ETH.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

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

interface IDn404CurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
}

interface IDn404BondingCurveReserves {
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
    function pairCurrency() external view returns (address);
}

/// @title  Dn404Graduator
/// @notice DN404-lane analog of GraduatorV3. Same marginal-price + excess-
///         burn + pull-refund posture, but the v4 pool pairs the launched
///         token against an arbitrary ERC-20 pair currency (USDG, COST,
///         NVDA, ...) instead of ETH.
///
/// @dev **Firewall:** GraduatorV3 at `contracts/src/curve/GraduatorV3.sol`
///      is never modified. ETH-paired DN404 launches route through V10 →
///      GraduatorV3 unchanged; non-ETH DN404 launches route through
///      Dn404BondingCurve → this contract.
///
/// @dev Notable structural differences vs. GraduatorV3:
///      - execute() is NOT payable — pair currency comes as explicit
///        arg; curve approves both token + pairCurrency to the
///        graduator before calling execute
///      - PoolKey currency ordering respects v4's canonical sort
///        (currency0 < currency1); pair currency lands on whichever
///        side is numerically lower
///      - Refund ledger is 2D — `claimableRefunds[launcher][pairCurrency]`
///        — so a launcher who runs multiple pairs (USDG + NVDA) has
///        their dust bucketed by pair
///      - unlockCallback settles / takes in the correct currency slot
///        based on the pair currency ordering
contract Dn404Graduator is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    error Dn404Graduator__NotPoolManager();
    error Dn404Graduator__ZeroAmount();
    error Dn404Graduator__NotAuthorizedCurve(address caller, address expected);
    error Dn404Graduator__NotOwner();
    error Dn404Graduator__ZeroAddress();
    error Dn404Graduator__HookConfigMismatch();
    error Dn404Graduator__HookCreatorMismatch(address expected, address actual);
    error Dn404Graduator__NothingToClaim();
    /// New vs. V3: pair currency reported by execute() must match the
    /// pair currency the curve was initialized with. Belt-and-suspenders
    /// — curve is the only authorized caller anyway, but if the two
    /// ever disagreed we'd end up creating a pool against the wrong
    /// currency.
    error Dn404Graduator__PairCurrencyMismatch(address expected, address actual);

    event Dn404Graduated(
        address indexed token,
        address indexed pairCurrency,
        address indexed hook,
        uint256 pairAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );
    event ExcessBurned(address indexed token, uint256 amount);
    event RefundCredited(address indexed token, address indexed launcher, address indexed pairCurrency, uint256 amount);
    event RefundClaimed(address indexed launcher, address indexed recipient, address indexed pairCurrency, uint256 amount);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event OwnerSet(address indexed oldOwner, address indexed newOwner);

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IHooks public immutable defaultHook;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IDn404CurveFactoryLookup public immutable curveFactory;

    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    address public owner;

    /// Pair-currency-bucketed refund ledger. A launcher who ran multiple
    /// DN404 launches with different pair currencies gets their dust
    /// tracked separately per pair.
    mapping(address launcher => mapping(address pairCurrency => uint256 amount)) public claimableRefunds;
    /// Per-pair-currency total claimable — used by `sweep(pairCurrency, to)`
    /// to guard against sweeping funds we owe to launchers.
    mapping(address pairCurrency => uint256 amount) public totalClaimable;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Dn404Graduator__NotOwner();
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
        if (_owner == address(0)) revert Dn404Graduator__ZeroAddress();
        poolManager = _poolManager;
        defaultHook = _defaultHook;
        fee = _fee;
        tickSpacing = _tickSpacing;
        curveFactory = IDn404CurveFactoryLookup(_curveFactory);
        tickLower = (TickMath.MIN_TICK / _tickSpacing + 1) * _tickSpacing;
        tickUpper = (TickMath.MAX_TICK / _tickSpacing) * _tickSpacing;
        owner = _owner;
        emit OwnerSet(address(0), _owner);
    }

    function setOwner(
        address newOwner
    ) external onlyOwner {
        if (newOwner == address(0)) revert Dn404Graduator__ZeroAddress();
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Sweep unallocated ERC-20 balance of `pairCurrency` (safety
    ///         net; reserved-aware so pull-refund balances stay intact).
    function sweep(
        address pairCurrency,
        address to
    ) external onlyOwner {
        if (to == address(0)) revert Dn404Graduator__ZeroAddress();
        uint256 balance = _tokenBalance(pairCurrency);
        uint256 reserved = totalClaimable[pairCurrency];
        uint256 amount = balance > reserved ? balance - reserved : 0;
        if (amount > 0) SafeTransferLib.safeTransfer(pairCurrency, to, amount);
        emit Swept(pairCurrency, to, amount);
    }

    function claimRefund(
        address pairCurrency
    ) external {
        _claimTo(pairCurrency, msg.sender);
    }

    function claimRefundTo(
        address pairCurrency,
        address recipient
    ) external {
        if (recipient == address(0)) revert Dn404Graduator__ZeroAddress();
        _claimTo(pairCurrency, recipient);
    }

    function _claimTo(
        address pairCurrency,
        address recipient
    ) private {
        uint256 amount = claimableRefunds[msg.sender][pairCurrency];
        if (amount == 0) revert Dn404Graduator__NothingToClaim();
        claimableRefunds[msg.sender][pairCurrency] = 0;
        totalClaimable[pairCurrency] -= amount;
        SafeTransferLib.safeTransfer(pairCurrency, recipient, amount);
        emit RefundClaimed(msg.sender, recipient, pairCurrency, amount);
    }

    /// @notice Graduate a DN404 curve. Curve MUST have approved this
    ///         graduator for both `token` (tokenAmount) and
    ///         `pairCurrency` (pairAmount) before calling.
    function execute(
        address token,
        address pairCurrency,
        uint256 pairAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external {
        address authorized = curveFactory.curveFor(token);
        if (msg.sender != authorized) revert Dn404Graduator__NotAuthorizedCurve(msg.sender, authorized);
        if (pairAmount == 0 || tokenAmount == 0) revert Dn404Graduator__ZeroAmount();

        // Belt-and-suspenders — cross-check the pair currency reported
        // in execute() against the curve's own pairCurrency() view. If
        // they ever disagreed we'd open a pool against the wrong side.
        address curvePair = IDn404BondingCurveReserves(msg.sender).pairCurrency();
        if (curvePair != pairCurrency) revert Dn404Graduator__PairCurrencyMismatch(curvePair, pairCurrency);

        // Pull both sides from the curve. Curve already approved us for
        // both amounts as part of _graduate().
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);
        SafeTransferLib.safeTransferFrom(pairCurrency, msg.sender, address(this), pairAmount);

        // Curve marginal price. Same formula as GraduatorV3 but the
        // unit is pair currency, not ETH — the math is unit-agnostic.
        //     price18 = (virtPair + realPair) * 1e18 / (virtTok + realTok)
        IDn404BondingCurveReserves curveReserves = IDn404BondingCurveReserves(msg.sender);
        uint256 virtPair = curveReserves.virtualEthReserve(); // pair-currency units (V10-style name retained)
        uint256 virtTok = curveReserves.virtualTokenReserve();
        uint256 curveFinalPrice = ((virtPair + pairAmount) * 1e18) / (virtTok + tokenAmount);

        // v4 PoolKey MUST have currency0 < currency1 numerically. Sort
        // pair currency vs. token so the key is canonical. This affects
        // delta0/delta1 handling in unlockCallback below.
        (address c0, address c1) = pairCurrency < token ? (pairCurrency, token) : (token, pairCurrency);
        bool pairIsCurrency0 = c0 == pairCurrency;

        PoolKey memory key;
        key.currency0 = Currency.wrap(c0);
        key.currency1 = Currency.wrap(c1);
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

        (, uint32 configuredAntiSniper, uint16 configuredBurn) = hookCfg.poolConfig(poolId);
        if (configuredAntiSniper != antiSniperBlocks || configuredBurn != buybackBurnBps) {
            revert Dn404Graduator__HookConfigMismatch();
        }
        if (creatorForPool != address(0)) {
            address configuredCreator = hookCfg.creators(poolId);
            if (configuredCreator != creatorForPool) {
                revert Dn404Graduator__HookCreatorMismatch(creatorForPool, configuredCreator);
            }
        }

        // sqrtPriceX96 for the pool. When pair is currency0, price18 as
        // computed (pair per token) is already price of currency1 in
        // currency0 terms → correct. When token is currency0 we need to
        // invert (currency1 per currency0 → invert to get currency0-per-
        // currency1). Same math as V3 with the invert-when-flipped
        // extension.
        uint256 priceForPool = pairIsCurrency0
            ? curveFinalPrice
            // Invert: 1e36 / price18 gives the reciprocal in the same
            // fixed-point. Safe because price18 has 18 decimals and
            // 1e36 fits comfortably in uint256.
            : (1e36) / curveFinalPrice;
        uint160 sqrtPriceX96 = uint160((uint256(1e9) << 96) / FixedPointMathLib.sqrt(priceForPool));

        poolManager.initialize(key, sqrtPriceX96);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        (uint256 amount0, uint256 amount1) = pairIsCurrency0
            ? (pairAmount, tokenAmount)
            : (tokenAmount, pairAmount);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, amount0, amount1);

        poolManager.unlock(abi.encode(key, uint256(liquidity), token, pairCurrency));

        // Burn any leftover token side (curve marginal pricing typically
        // absorbs all of one side; residual on the other side is dust).
        uint256 residualToken = _tokenBalance(token);
        if (residualToken > 0) {
            SafeTransferLib.safeTransfer(token, BURN_ADDRESS, residualToken);
            emit ExcessBurned(token, residualToken);
        }

        // Any pair-currency dust surviving the LP-add → launcher's
        // pull-refund ledger, bucketed by pair.
        uint256 pairBal = _tokenBalance(pairCurrency);
        uint256 reserved = totalClaimable[pairCurrency];
        uint256 pairResidual = pairBal > reserved ? pairBal - reserved : 0;
        if (pairResidual > 0 && launcher != address(0)) {
            claimableRefunds[launcher][pairCurrency] += pairResidual;
            totalClaimable[pairCurrency] += pairResidual;
            emit RefundCredited(token, launcher, pairCurrency, pairResidual);
        }

        emit Dn404Graduated(token, pairCurrency, address(defaultHook), pairAmount, tokenAmount, sqrtPriceX96, liquidity);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Dn404Graduator__NotPoolManager();
        (PoolKey memory key, uint256 liquidity, address token, address pairCurrency) =
            abi.decode(data, (PoolKey, uint256, address, address));

        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = _amount0(callerDelta);
        int128 delta1 = _amount1(callerDelta);

        // Both sides are ERC-20 (no ETH). Settle by paying into the
        // PoolManager via sync + transfer + settle; take by pull from
        // PoolManager. Same pattern for currency0 and currency1 since
        // neither is native ETH.
        _settleOrTake(key.currency0, Currency.unwrap(key.currency0), delta0);
        _settleOrTake(key.currency1, Currency.unwrap(key.currency1), delta1);

        (token, pairCurrency); // silence unused-var warning; both are recovered from key
        return "";
    }

    /// Helper for the unlockCallback settle-or-take on a single side.
    /// Negative delta = we owe the pool; positive delta = pool owes us.
    function _settleOrTake(
        Currency currency,
        address currencyAddr,
        int128 delta
    ) private {
        if (delta < 0) {
            uint256 owed = uint256(uint128(-delta));
            poolManager.sync(currency);
            SafeTransferLib.safeTransfer(currencyAddr, address(poolManager), owed);
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(currency, address(this), uint256(uint128(delta)));
        }
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
}
