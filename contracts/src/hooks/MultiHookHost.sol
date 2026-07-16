// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  MultiHookHost
/// @notice One deployable hook that hosts every launchpad-side v4 hook feature: LP lock,
///         fee-redirect to platform + creator, optional anti-sniper gate, optional
///         buyback-burn on buys. v4 encodes permissions in the hook ADDRESS and only one
///         hook can attach per pool, so combining behaviours into one contract at one
///         address is required to ship all of them together.
///
/// @dev    Deploy at an address whose low bits match the mask below (HookMiner):
///           BEFORE_INITIALIZE_FLAG           (1 << 13)
///         | BEFORE_REMOVE_LIQUIDITY_FLAG     (1 << 9)
///         | BEFORE_SWAP_FLAG                 (1 << 7)
///         | AFTER_SWAP_FLAG                  (1 << 6)
///         | AFTER_SWAP_RETURNS_DELTA_FLAG    (1 << 2)
///
///         Per-pool config (anti-sniper window + buyback burn bps + creator address)
///         is set via `setPoolConfig` + `setCreator` BEFORE the pool is initialized;
///         once `beforeInitialize` fires, `launchBlock` is stamped and both are frozen
///         for that pool forever.
///
///         Anyone can call `setPoolConfig`/`setCreator` in principle — but in practice
///         the Graduator calls them atomically in the same tx as `initialize`, so
///         there's no window for a front-runner to plant bad config against a real
///         launch.
///
///         Creator revenue is per-pool: each launched token's pool records its own
///         `creators[poolId]` at graduation (== the wallet that called Router.launch).
///         If a pool skips `setCreator` (e.g. a manual init outside the launchpad),
///         the `creator` fallback keeps the creator share from getting stuck.
contract MultiHookHost is BaseHook {
    using PoolIdLibrary for PoolKey;

    // ---- LPLocked ----
    error MultiHookHost__LiquidityLocked();
    event MultiHookHostRemoveAttempt(address indexed sender, PoolKey key);

    // ---- FeeRedirect ----
    error MultiHookHost__BpsTooHigh(uint256 total);
    error MultiHookHost__ZeroAddress();
    error MultiHookHost__NothingToClaim();

    event FeeAccrued(Currency indexed currency, uint256 platformShare, uint256 creatorShare);
    event FeeClaimed(Currency indexed currency, address indexed to, uint256 amount);

    // ---- Per-pool config ----
    error MultiHookHost__ConfigFrozen();
    error MultiHookHost__BurnBpsTooHigh(uint256 bps);
    error MultiHookHost__AntiSniperGate(uint256 launchBlock, uint256 gateBlocks);

    event PoolConfigSet(PoolId indexed poolId, uint32 antiSniperBlocks, uint16 buybackBurnBps);
    event CreatorSet(PoolId indexed poolId, address indexed creator);
    event BuybackBurned(Currency indexed currency, uint256 amount);

    /// Chain-wide caps.
    uint16 public constant MAX_TOTAL_BPS = 3000; // fee-redirect total (platform + creator)
    uint16 public constant MAX_BUYBACK_BPS = 2000; // per-swap buyback burn slice
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable platform;
    /// Fallback creator address for pools that were initialized without calling
    /// `setCreator` first (e.g. manual initialize outside the Graduator). Real
    /// launchpad pools are set via `setCreator(poolId, launcher)` in the same tx as
    /// the Graduator's `initialize` so this fallback rarely fires in practice.
    address public immutable creator;
    uint16 public immutable platformBps;
    uint16 public immutable creatorBps;

    mapping(Currency => mapping(address => uint256)) public owed;

    /// Per-pool creator address — set exactly once by `setCreator` before the pool is
    /// initialized. Once `beforeInitialize` fires, this entry is frozen. If unset at
    /// swap time, the constructor-provided `creator` is used instead.
    mapping(PoolId => address) public creators;

    struct PoolConfig {
        uint32 launchBlock; // set exactly once at beforeInitialize, freezes config
        uint32 antiSniperBlocks; // 0 = disabled; swaps revert before launchBlock + N
        uint16 buybackBurnBps; // 0 = disabled; slice of BUY output tokens sent to BURN_ADDRESS
    }

    mapping(PoolId => PoolConfig) public poolConfig;

    constructor(
        IPoolManager _poolManager,
        address _platform,
        address _creator,
        uint16 _platformBps,
        uint16 _creatorBps
    ) BaseHook(_poolManager) {
        if (_platform == address(0) || _creator == address(0)) revert MultiHookHost__ZeroAddress();
        uint256 total = uint256(_platformBps) + uint256(_creatorBps);
        if (total == 0 || total > MAX_TOTAL_BPS) revert MultiHookHost__BpsTooHigh(total);
        platform = _platform;
        creator = _creator;
        platformBps = _platformBps;
        creatorBps = _creatorBps;
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------- per-pool config

    /// Set per-pool AntiSniper + BuybackBurn config. Must be called BEFORE
    /// `poolManager.initialize(key, ...)` for this poolId — after that,
    /// `beforeInitialize` stamps `launchBlock` and config becomes immutable.
    ///
    /// Callable by anyone. Front-run risk is nil in practice because the Graduator does
    /// setPoolConfig + initialize atomically inside a single `poolManager.unlock` tx.
    function setPoolConfig(
        PoolId id,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external {
        if (poolConfig[id].launchBlock != 0) revert MultiHookHost__ConfigFrozen();
        if (buybackBurnBps > MAX_BUYBACK_BPS) revert MultiHookHost__BurnBpsTooHigh(buybackBurnBps);
        poolConfig[id].antiSniperBlocks = antiSniperBlocks;
        poolConfig[id].buybackBurnBps = buybackBurnBps;
        emit PoolConfigSet(id, antiSniperBlocks, buybackBurnBps);
    }

    /// Assign a creator to a pool BEFORE it initializes. After `beforeInitialize` fires
    /// for this poolId, `launchBlock` is stamped and the creator is frozen — subsequent
    /// calls revert with `ConfigFrozen`. Same anti-front-run rationale as setPoolConfig:
    /// Graduator does this in the same tx as initialize.
    function setCreator(PoolId id, address _creator) external {
        if (poolConfig[id].launchBlock != 0) revert MultiHookHost__ConfigFrozen();
        if (_creator == address(0)) revert MultiHookHost__ZeroAddress();
        creators[id] = _creator;
        emit CreatorSet(id, _creator);
    }

    // ---------------------------------------------------------------- beforeInitialize
    // Stamp the launch block. This is the freeze signal for setPoolConfig + setCreator —
    // they can no longer be updated after this hook fires for a given poolId.
    function beforeInitialize(
        address,
        PoolKey calldata key,
        uint160
    ) external override onlyPoolManager returns (bytes4) {
        poolConfig[key.toId()].launchBlock = uint32(block.number);
        return this.beforeInitialize.selector;
    }

    // ---------------------------------------------------------------- LP lock
    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4) {
        emit MultiHookHostRemoveAttempt(sender, key);
        revert MultiHookHost__LiquidityLocked();
    }

    // ---------------------------------------------------------------- anti-sniper gate
    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolConfig storage cfg = poolConfig[key.toId()];
        if (cfg.antiSniperBlocks > 0) {
            // launchBlock is stamped in beforeInitialize; if for some reason a swap
            // fires before initialize (impossible via v4), launchBlock == 0 and the
            // opensAt computation would be < block.number, letting the swap through.
            uint256 opensAt = uint256(cfg.launchBlock) + uint256(cfg.antiSniperBlocks);
            if (block.number < opensAt) {
                revert MultiHookHost__AntiSniperGate(cfg.launchBlock, cfg.antiSniperBlocks);
            }
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // ---------------------------------------------------------------- fee + buyback
    /// Handles two behaviors on the swap output side:
    ///   1. Fee-redirect (existing): platformBps + creatorBps of the unspecified currency
    ///      accrues to `owed[]` for platform + creator.
    ///   2. Buyback-burn (new, per-pool): on BUYs only (unspecified currency == currency1
    ///      = token), an additional `buybackBurnBps` slice is transferred to BURN_ADDRESS.
    ///
    /// Both slices come from the SAME raw output amount (before hook adjustments). The
    /// `poolManager.take` is load-bearing — v4 credits the hook's currency delta with the
    /// returned int128, and if we don't take the corresponding amount into the hook's
    /// own balance the unlock reverts with `CurrencyNotSettled`.
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);
        if (unspecDelta <= 0) return (this.afterSwap.selector, 0);
        uint256 outAmount = uint128(unspecDelta);

        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 fee = (outAmount * totalBps) / 10_000;

        // Buyback-burn only on BUYs — where the swapper receives the token side.
        // Comparing addresses via `Currency.unwrap` (v4 doesn't overload ==).
        uint256 burn = 0;
        PoolId id = key.toId();
        PoolConfig storage cfg = poolConfig[id];
        if (cfg.buybackBurnBps > 0 && Currency.unwrap(unspecCurrency) == Currency.unwrap(key.currency1)) {
            burn = (outAmount * uint256(cfg.buybackBurnBps)) / 10_000;
        }

        uint256 totalTake = fee + burn;
        if (totalTake == 0) return (this.afterSwap.selector, 0);

        poolManager.take(unspecCurrency, address(this), totalTake);

        if (burn > 0) {
            unspecCurrency.transfer(BURN_ADDRESS, burn);
            emit BuybackBurned(unspecCurrency, burn);
        }
        if (fee > 0) {
            uint256 platformShare = (fee * platformBps) / totalBps;
            uint256 creatorShare = fee - platformShare;
            // Per-pool creator lookup with the constructor-set `creator` as fallback.
            // A pool that skipped setCreator (manual init outside the Graduator)
            // accrues to `creator` so the creator share never becomes stuck in an
            // unclaimable slot.
            address creatorAddr = creators[id];
            if (creatorAddr == address(0)) creatorAddr = creator;
            owed[unspecCurrency][platform] += platformShare;
            owed[unspecCurrency][creatorAddr] += creatorShare;
            emit FeeAccrued(unspecCurrency, platformShare, creatorShare);
        }

        return (this.afterSwap.selector, int128(int256(totalTake)));
    }

    // ---------------------------------------------------------------- claim
    /// Fee tokens already sit in this contract's balance (pulled during afterSwap).
    /// Claim is a plain transfer — no unlock/callback dance needed. Currency.transfer
    /// from v4-core handles both native ETH and ERC-20 recipients.
    function claim(
        Currency currency
    ) external {
        uint256 amount = owed[currency][msg.sender];
        if (amount == 0) revert MultiHookHost__NothingToClaim();
        owed[currency][msg.sender] = 0;
        currency.transfer(msg.sender, amount);
        emit FeeClaimed(currency, msg.sender, amount);
    }

    // ---------------------------------------------------------------- misc
    /// Accept native ETH transfers coming back from `poolManager.take` for the ETH-side
    /// fee accrual (currency0 = 0x0 pools). Without this the take reverts.
    receive() external payable {}

    function _unspecified(
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta
    ) internal pure returns (Currency currency, int128 amount) {
        bool isExactInput = params.amountSpecified < 0;
        if (params.zeroForOne == isExactInput) {
            currency = key.currency1;
            amount = _amount1(delta);
        } else {
            currency = key.currency0;
            amount = _amount0(delta);
        }
    }

    function _amount0(
        BalanceDelta delta
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(delta) >> 128));
    }

    function _amount1(
        BalanceDelta delta
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(delta)));
    }
}
