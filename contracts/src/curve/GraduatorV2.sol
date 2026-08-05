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
    /// URU-A12: read-back views for graduation-time verification.
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

/// The Graduator queries these two view-getters on the calling curve to compute
/// its marginal price at graduation. Both are already `public` on `BondingCurve`
/// so the auto-generated getters satisfy this interface with no curve-side
/// changes required.
interface IBondingCurveReserves {
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
}

/// @title  GraduatorV2
/// @notice Second-generation graduator that opens the v4 pool at the SAME price
///         the curve was trading at when it graduated (rather than at the raw
///         `tokens/ETH` ratio of the real reserves).
///
///         Why: BondingCurve uses virtual reserves for smoother pricing. At
///         graduation, the ratio of REAL reserves the curve hands off doesn't
///         match the marginal price the last buyer paid. The original Graduator
///         opened v4 at that raw ratio, producing a price discontinuity that
///         punished late-curve buyers (up to 500x price drop on low-target
///         curves, ~2-3x on properly-sized ones). This graduator opens the
///         pool at the curve's marginal price instead. Any tokens not consumed
///         by the LP at that price get burned to 0xdead so total supply
///         reflects the actual on-market float.
///
///         The rest of the flow (hook config, creator assignment, unlock+settle
///         dance, full-range concentration) is unchanged from the original.
contract GraduatorV2 is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    error Graduator__NotPoolManager();
    error Graduator__EthMismatch(uint256 sent, uint256 expected);
    error Graduator__ZeroAmount();
    error Graduator__NotAuthorizedCurve(address caller, address expected);
    error Graduator__NotOwner();
    error Graduator__ZeroAddress();
    /// URU-A12: post-`setPoolConfig` read-back showed values other than the
    /// ones the Graduator just wrote. Either the hook silently rejected them
    /// or an attacker pre-planted config before graduation.
    error Graduator__HookConfigMismatch();
    /// URU-A12: post-`setCreator` read-back showed a creator address other
    /// than the launcher. Reverts graduation atomically.
    error Graduator__HookCreatorMismatch(address expected, address actual);
    /// FINDING 6: `claimRefund` / `claimRefundTo` called with a zero
    /// balance in the launcher's ledger entry. Prevents silent no-op claims.
    error Graduator__NothingToClaim();

    event Graduated(
        address indexed token,
        address indexed hook,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );
    /// Emitted when the LP-add doesn't consume every token the curve handed us.
    /// The excess is transferred to `0x000...dEaD`.
    event ExcessBurned(address indexed token, uint256 amount);
    /// Emitted when the LP-add doesn't consume every wei of ETH the curve
    /// handed us (rare, LP amounts are usually tightly matched by the
    /// raw-ratio pricing). The refund is CREDITED to the launcher's
    /// pull-based ledger (`claimableRefunds`) instead of being pushed
    /// synchronously so a contract-wallet launcher that rejects `receive()`
    /// (Safe, DAO treasury, custody solution) can't brick graduation.
    /// The launcher pulls with `claimRefund()` or `claimRefundTo(recipient)`.
    ///
    /// Prevents the 2026-07-30 bug (V7 Graduator opened pool at curve
    /// marginal price, requiring ~10x MORE tokens per ETH than the raw
    /// ratio, leaving ~4 ETH per graduation permanently stranded in the
    /// graduator with no recovery path).
    event RefundCredited(address indexed token, address indexed launcher, uint256 amount);
    /// Emitted when a launcher (or the delegate they name in
    /// `claimRefundTo`) drains their pull-based refund balance.
    event RefundClaimed(address indexed launcher, address indexed recipient, uint256 amount);
    /// Emitted on owner sweep of unallocated ETH — safety net for any future
    /// bug that lets ETH accumulate here. Non-zero only if the LP-add math
    /// regresses; expected balance is 0 after every graduation.
    event Swept(address indexed to, uint256 amount);
    event OwnerSet(address indexed oldOwner, address indexed newOwner);

    /// Well-known burn address. Chosen for readability in explorers and
    /// consistency with the industry convention (Uniswap V2, Pump.fun, etc.).
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    IHooks public immutable defaultHook;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    ICurveFactoryLookup public immutable curveFactory;

    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    /// Owner: recovers accidental ETH that a future LP-math regression might
    /// leave here. Set at construction, transferable via setOwner. The V7
    /// graduator (the buggy one that stranded 4 ETH) had NO owner and NO
    /// sweep — an entire graduation's worth of ETH was permanently stuck.
    /// Never again.
    address public owner;

    /// FINDING 6: pull-based refund ledger. Credited at graduation whenever
    /// the LP-add leaves ETH unallocated; drained by the launcher (or their
    /// delegate) via `claimRefund` / `claimRefundTo`. Pull-based instead of
    /// push so a contract-wallet launcher whose `receive()` reverts cannot
    /// brick graduation.
    mapping(address launcher => uint256 amount) public claimableRefunds;

    /// Sum of every entry in `claimableRefunds`. `sweep()` treats this as
    /// reserved and only lifts the excess so an owner sweep can never
    /// silently drain launcher refunds.
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

    /// Safety net: sweep any ETH sitting on this contract. Expected balance is
    /// ALWAYS zero after every graduation with the raw-ratio pricing (both
    /// amounts are guaranteed to match at the raw ratio, so LP absorbs both
    /// fully). Only fires if a future bug lets ETH accumulate.
    ///
    /// FINDING 6: reserves the outstanding pull-based refund balance
    /// (`totalClaimable`) so the sweep can never silently drain a launcher's
    /// credited refund. Sweeps `balance - totalClaimable`.
    function sweep(
        address payable to
    ) external onlyOwner {
        if (to == address(0)) revert Graduator__ZeroAddress();
        uint256 balance = address(this).balance;
        uint256 reserved = totalClaimable;
        uint256 amount = balance > reserved ? balance - reserved : 0;
        if (amount > 0) {
            SafeTransferLib.safeTransferETH(to, amount);
        }
        emit Swept(to, amount);
    }

    /// FINDING 6: pull the caller's accumulated refund to the caller.
    /// Reverts `Graduator__NothingToClaim` on a zero balance so a UI can
    /// tell "no refund" apart from "claim silently succeeded". Follows CEI:
    /// balance is zeroed before the transfer, so a re-entering recipient
    /// finds an empty entry and reverts.
    function claimRefund() external {
        _claimTo(msg.sender);
    }

    /// FINDING 6: pull the caller's accumulated refund to `recipient`.
    /// Contract-wallet launchers that can't receive ETH themselves (Safe,
    /// custody solutions) use this to route the refund to an EOA or a
    /// receiver contract they control.
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
        // CEI: zero the entry (and the aggregate) before the external call.
        claimableRefunds[msg.sender] = 0;
        totalClaimable -= amount;
        SafeTransferLib.safeTransferETH(recipient, amount);
        emit RefundClaimed(msg.sender, recipient, amount);
    }

    /// @notice Graduate a curve. Same signature as the original Graduator so
    ///         existing BondingCurve.sol works with no changes; only the
    ///         internal pricing logic differs.
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable {
        // Same access control as v1.
        address authorized = curveFactory.curveFor(token);
        if (msg.sender != authorized) revert Graduator__NotAuthorizedCurve(msg.sender, authorized);
        if (ethAmount == 0 || tokenAmount == 0) revert Graduator__ZeroAmount();
        if (msg.value != ethAmount) revert Graduator__EthMismatch(msg.value, ethAmount);

        // Pull tokens from the curve.
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);

        // POST-INCIDENT (2026-07-30): V7 Graduator opened the pool at the
        // curve's MARGINAL price = (virtEth+realEth) / (virtToken+realToken).
        // That price is a factor of ~virtToken/realToken LOWER than the
        // raw-real ratio. Depositing the real amounts (ethAmount, tokenAmount)
        // at that price → tokens are the limiting factor, LP absorbs all
        // tokens but only a fraction of the ETH. The rest (~4 ETH per
        // graduation on the 4-ETH-target config) got stranded permanently
        // in the graduator with no recovery path.
        //
        // Fix: price the pool at the RAW REAL RATIO. That guarantees both
        // amounts are absorbed by the LP with no leftover. The price step
        // vs. the curve's last-buy price is a modest cliff UPWARD (early
        // curve buyers realize a small gain when they sell to the pool),
        // not a catastrophic drop like the original raw-ratio v1 graduator
        // had (which suffered because the graduation target was too small
        // relative to virtual reserves — that config problem is orthogonal
        // to the LP-math bug this contract is solving).
        //
        // We also keep the ETH-refund-to-launcher belt below in case any
        // rounding leaves dust: even a wei of stuck ETH would be a bug we
        // never want to repeat.
        uint256 curveFinalPrice = (ethAmount * 1e18) / tokenAmount;

        // v4 pool config.
        PoolKey memory key;
        key.currency0 = Currency.wrap(address(0));
        key.currency1 = Currency.wrap(token);
        key.fee = fee;
        key.tickSpacing = tickSpacing;
        key.hooks = defaultHook;

        PoolId poolId = key.toId();
        IHookConfig hookCfg = IHookConfig(address(defaultHook));
        // URU-A12: `setPoolConfig` and `setCreator` are MANDATORY. Previously
        // wrapped in try/catch, which let a pool launch without the promised
        // anti-sniper window, without the promised buyback-burn slice, or with
        // an attacker-planted creator address. Now the call reverts if the hook
        // rejects — and we read back the exact values before initialize.
        hookCfg.setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps);

        address creatorForPool = launcher;
        if (creatorForPool == address(0)) {
            // Only the fallback creator read stays best-effort — legacy hooks
            // that don't expose `creator()` are still allowed as long as the
            // launcher explicitly opts out of a creator recipient (rare;
            // launcher == 0 is normally a defensive default in tests, not a
            // production configuration).
            try hookCfg.creator() returns (address fallbackCreator) {
                creatorForPool = fallbackCreator;
            } catch {}
        }
        if (creatorForPool != address(0)) {
            hookCfg.setCreator(poolId, creatorForPool);
        }

        // URU-A12: read back and verify. If setPoolConfig / setCreator landed
        // different values than we wrote (attacker pre-plant, silent partial
        // failure, wrong-hook-address deploy), the graduation reverts before
        // `poolManager.initialize` freezes the config forever.
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

        // Compute sqrtPriceX96 for the CURVE's final price, not the raw
        // token/ETH ratio. Uniswap v4 convention:
        //   v4_price = amount1 / amount0 = wei_token / wei_ETH
        // Curve convention:
        //   curveFinalPrice = 1e18 * (wei_ETH / wei_token)   (fixed-point)
        // So v4_price = 1e18 / curveFinalPrice   (both dimensionless when
        // wei_ETH and wei_token both have 18 decimals — always true for our
        // launchpad tokens).
        //   sqrtPriceX96 = sqrt(v4_price) * 2^96
        //              = sqrt(1e18 / curveFinalPrice) * 2^96
        //              = (sqrt(1e18) * 2^96) / sqrt(curveFinalPrice)
        //              = (1e9 * 2^96) / sqrt(curveFinalPrice)
        //
        // Rearranged to fit uint256 without overflow: multiply the 2^96 in
        // first so we don't multiply a 1e9 constant by a sqrt() output that
        // could be huge on high-priced tokens.
        uint160 sqrtPriceX96 = uint160((uint256(1e9) << 96) / FixedPointMathLib.sqrt(curveFinalPrice));

        poolManager.initialize(key, sqrtPriceX96);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, ethAmount, tokenAmount);

        poolManager.unlock(abi.encode(key, uint256(liquidity), ethAmount, tokenAmount, token));

        // Any tokens NOT consumed by the LP add get burned so total
        // circulating supply reflects the actual on-market float. With
        // raw-ratio pricing this should be near-zero (rounding dust only).
        uint256 residual = _tokenBalance(token);
        if (residual > 0) {
            SafeTransferLib.safeTransfer(token, BURN_ADDRESS, residual);
            emit ExcessBurned(token, residual);
        }

        // POST-INCIDENT safety belt: if ANY ETH ended up unallocated by the
        // LP (should never happen with raw-ratio pricing — both amounts
        // match exactly at the raw-ratio price — but LiquidityAmounts does
        // integer math with truncation, so rounding-dust wei can survive),
        // credit it to the launcher's pull-based refund ledger. The
        // launcher earned this ETH via curve sells; keeping it here would
        // be theft.
        //
        // FINDING 6: pull-based, not push. If launcher is a contract wallet
        // (Safe, DAO treasury, custody solution) whose `receive()` reverts,
        // a synchronous transfer would revert the whole graduation and
        // brick the curve. Credit + claim decouples the two and keeps
        // graduation atomically successful for every launcher shape. The
        // aggregate is tracked so `sweep()` can never take credited funds.
        //
        // NOTE: `address(this).balance` is the right source. It's set by
        // the ETH the launcher's curve sent in via `msg.value == ethAmount`
        // minus whatever settle() took, so it captures rounding dust
        // without accounting for any prior refunds that may still be
        // sitting in the ledger (those are already reserved and are not
        // part of `balance - totalClaimable` from the launcher's view).
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

    /// Tiny helper — avoids importing IERC20 just for a `balanceOf` call.
    function _tokenBalance(
        address token
    ) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    receive() external payable {}
}
