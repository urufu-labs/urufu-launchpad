// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  MultiHookHost
/// @notice One deployable hook that hosts every launchpad-side v4 hook feature:
///         fee-redirect to platform + creator, optional anti-sniper gate, optional
///         buyback-burn on buys. v4 encodes permissions in the hook ADDRESS and only one
///         hook can attach per pool, so combining behaviours into one contract at one
///         address is required to ship all of them together.
///
///         FINDING 5 (audit round 2): the hook USED to also gate `beforeRemoveLiquidity`
///         to lock the graduation LP. That inadvertently locked EVERY LP on the pool,
///         including third-party positions added post-graduation via the Uniswap UI. The
///         graduation LP is now locked structurally by the Graduator itself (it opens
///         the position via `poolManager.modifyLiquidity` with itself as the position
///         owner, and `GraduatorV2.sol` has no code path that ever calls modifyLiquidity
///         with a negative liquidityDelta) so third-party LPs can add + remove freely.
///
/// @dev    Deploy at an address whose low bits match the mask below (HookMiner):
///           BEFORE_INITIALIZE_FLAG           (1 << 13)
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

    // ---- Init-authorization ----
    /// Someone tried to initialize a pool through this hook without being the wired
    /// Graduator. Blocks the "predictable poolKey griefing" attack where an outsider
    /// front-runs `PoolManager.initialize` on a graduating pool, DoS'ing every future
    /// graduation for that token.
    error MultiHookHost__UnauthorizedInitializer(address sender);
    /// The one-time `setInitializer` was called by a wallet other than the deployer
    /// that constructed this hook, or an initializer address was already set.
    error MultiHookHost__NotDeployer();
    error MultiHookHost__InitializerAlreadySet();
    error MultiHookHost__InitializerNotSet();
    /// URU-A12: `setPoolConfig` and `setCreator` are now restricted to the
    /// authorized Graduator. Previously permissionless, letting anyone plant
    /// a per-pool config that would freeze at initialize.
    error MultiHookHost__NotInitializer(address caller);
    /// URU-A12: launcher-supplied antiSniperBlocks exceeds the hook's cap. A
    /// direct MHH call could otherwise lock a pool's swaps for years.
    error MultiHookHost__AntiSniperTooLong(uint32 provided, uint32 maximum);
    /// GH-9: post-launch attempt to mutate a pool's canonical `poolPolicy`.
    /// The policy is populated + `immutableAfterLaunch`-stamped once, at
    /// `beforeInitialize`; every subsequent write path (including the
    /// initializer's own `setPoolConfig` / `setCreator`) fails closed here
    /// so aggregators can trust the on-chain struct without watching for
    /// silent rewrites.
    error MultiHookHost__PolicyFrozen(PoolId poolId);
    /// URU-P1-M04: buyback-burn is token-denominated. On an exact-output BUY
    /// the unspecified side is ETH input, so applying `buybackBurnBps` there
    /// would silently destroy ETH while claiming token supply was burned.
    /// Reject the mode rather than misreport it — callers can either issue an
    /// exact-input buy (spirit-preserving) or disable buybackBurnBps for the pool.
    error MultiHookHost__ExactOutputBuyUnsupportedWithBurn();

    event PoolConfigSet(PoolId indexed poolId, uint32 antiSniperBlocks, uint16 buybackBurnBps);
    event CreatorSet(PoolId indexed poolId, address indexed creator);
    event InitializerSet(address indexed initializer);
    event BuybackBurned(Currency indexed currency, uint256 amount);
    /// GH-9: canonical per-pool policy emitted exactly once, at the block a
    /// pool is initialized through this hook. Aggregators / block explorers
    /// index this instead of stitching PoolConfigSet + CreatorSet + hook
    /// constants together, and the paired `poolPolicy(poolId)` accessor lets
    /// them verify the emitted values on-chain without trusting the log.
    event HookPolicySet(PoolId indexed poolId, PoolPolicy policy);

    /// Chain-wide caps.
    uint16 public constant MAX_TOTAL_BPS = 3000; // fee-redirect total (platform + creator)
    /// URU-A12: per-pool max anti-sniper window. Mirrors Router.MAX_ANTI_SNIPER_BLOCKS
    /// so a launcher who bypasses Router cannot land a longer freeze here.
    uint32 public constant MAX_ANTI_SNIPER_BLOCKS = 7200;
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

    /// GH-9: canonical per-pool policy consumed by external indexers.
    ///
    /// The existing `PoolConfig` struct is optimized for hot-path reads inside
    /// `beforeSwap` / `afterSwap` — it stores only the fields those callbacks
    /// need. `PoolPolicy` is the OTHER shape: an aggregator-facing snapshot of
    /// every knob a downstream tool needs to render "this pool's rules" without
    /// re-deriving them from constructor immutables + separate events.
    ///
    /// AGGREGATOR NOTE: `HookPolicySet` uses a topic0 that is NOT unique to this
    /// contract — any address could deploy a lookalike hook and emit the same
    /// signature. Consumers reading raw event logs (e.g. custom indexers, non-
    /// Ponder subgraphs) MUST filter by `emitter == expected MHH address` before
    /// trusting the policy payload. Ponder handles this implicitly via per-
    /// contract subscription.
    ///
    /// Field order + widths are load-bearing (auditor-visible): types match the
    /// GH-9 spec so the on-chain layout maps 1:1 to the struct in the
    /// aggregator's ABI. Widths were chosen to pack the struct into two
    /// storage slots:
    ///   Slot 0: 4x uint16 (8B) + address (20B) = 28B
    ///   Slot 1: uint64 (8B) + bool (1B) = 9B
    /// `antiSniperBlocks` is narrowed from the internal `uint32` because
    /// `MAX_ANTI_SNIPER_BLOCKS = 7200` fits safely in a `uint16`. `launchBlock`
    /// is widened from the internal `uint32` because uint16 would overflow
    /// well before mainnet block heights do and the spec asks for uint64.
    struct PoolPolicy {
        uint16 antiSniperBlocks;
        uint16 buybackBurnBps;
        uint16 platformFeeBps;
        uint16 creatorFeeBps;
        address creatorRecipient;
        uint64 launchBlock;
        bool immutableAfterLaunch; // frozen once launchBlock is set
    }

    /// Populated at graduation-time `beforeInitialize`. `poolPolicy(unknownId)`
    /// returns the zero struct — the auto-generated tuple accessor is what
    /// aggregators read.
    mapping(PoolId => PoolPolicy) public poolPolicy;

    /// Wallet allowed to call `setInitializer` exactly once. Stamped at deploy time
    /// and never changes. Not an admin key — after `setInitializer` fires the
    /// deployer has zero authority over this contract.
    address public immutable deployer;

    /// The one contract allowed to call `PoolManager.initialize` for a pool with this
    /// hook. Set by the deployer via `setInitializer` before any pool is initialized
    /// (typically the Graduator, in the same broadcast that deploys it). Once set,
    /// `beforeInitialize` reverts for any other sender — this blocks the "griefer
    /// initializes a graduating token's predictable pool key" DoS attack.
    address public initializer;

    constructor(
        IPoolManager _poolManager,
        address _platform,
        address _creator,
        uint16 _platformBps,
        uint16 _creatorBps,
        address _deployer
    ) BaseHook(_poolManager) {
        if (_platform == address(0) || _creator == address(0) || _deployer == address(0)) {
            revert MultiHookHost__ZeroAddress();
        }
        uint256 total = uint256(_platformBps) + uint256(_creatorBps);
        if (total == 0 || total > MAX_TOTAL_BPS) revert MultiHookHost__BpsTooHigh(total);
        platform = _platform;
        creator = _creator;
        platformBps = _platformBps;
        creatorBps = _creatorBps;
        // Explicit deployer — must be a param because CREATE2-mined hook addresses
        // are constructed through the canonical Create2Deployer, so `msg.sender`
        // inside the constructor is the factory, not the wallet that broadcast the
        // deploy tx. Locked-in permission to call `setInitializer` exactly once —
        // a single-use setup key, not an admin, and useless after step 2.
        deployer = _deployer;
    }

    /// Wire this hook to its authorized Graduator. Callable exactly once, only by
    /// the address that deployed the hook. After this call, `beforeInitialize`
    /// rejects any sender other than the recorded initializer — every future pool
    /// init through this hook must come from the Graduator. Between deploy and this
    /// call the hook is intentionally unusable (see `beforeInitialize`), so an
    /// attacker cannot bootstrap a pool with a rogue configuration.
    function setInitializer(
        address _initializer
    ) external {
        if (msg.sender != deployer) revert MultiHookHost__NotDeployer();
        if (initializer != address(0)) revert MultiHookHost__InitializerAlreadySet();
        if (_initializer == address(0)) revert MultiHookHost__ZeroAddress();
        initializer = _initializer;
        emit InitializerSet(_initializer);
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
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

    /// Set per-pool AntiSniper + BuybackBurn config. URU-A12: restricted to the
    /// wired Graduator so an outsider can no longer plant a config that then
    /// freezes at `beforeInitialize`. `initializer` is the one-shot setter's
    /// target (typically the Graduator) — if it's ever 0, this reverts.
    function setPoolConfig(
        PoolId id,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external {
        if (msg.sender != initializer) revert MultiHookHost__NotInitializer(msg.sender);
        // GH-9: the canonical `poolPolicy` freeze must reject writes here
        // too, or an initializer that survived a re-wire could mutate the
        // legacy PoolConfig while `poolPolicy` continued to report the old
        // (frozen) values to indexers. Fail closed on either freeze.
        if (poolPolicy[id].immutableAfterLaunch) revert MultiHookHost__PolicyFrozen(id);
        if (poolConfig[id].launchBlock != 0) revert MultiHookHost__ConfigFrozen();
        if (antiSniperBlocks > MAX_ANTI_SNIPER_BLOCKS) {
            revert MultiHookHost__AntiSniperTooLong(antiSniperBlocks, MAX_ANTI_SNIPER_BLOCKS);
        }
        if (buybackBurnBps > MAX_BUYBACK_BPS) revert MultiHookHost__BurnBpsTooHigh(buybackBurnBps);
        poolConfig[id].antiSniperBlocks = antiSniperBlocks;
        poolConfig[id].buybackBurnBps = buybackBurnBps;
        emit PoolConfigSet(id, antiSniperBlocks, buybackBurnBps);
    }

    /// Assign a creator to a pool BEFORE it initializes. URU-A12: same
    /// initializer-only gate as `setPoolConfig` so attacker cannot plant a
    /// hostile creator address that then freezes at initialize.
    function setCreator(
        PoolId id,
        address _creator
    ) external {
        if (msg.sender != initializer) revert MultiHookHost__NotInitializer(msg.sender);
        // GH-9: same rationale as `setPoolConfig` — the canonical policy
        // freeze subsumes the legacy `ConfigFrozen` check post-launch.
        if (poolPolicy[id].immutableAfterLaunch) revert MultiHookHost__PolicyFrozen(id);
        if (poolConfig[id].launchBlock != 0) revert MultiHookHost__ConfigFrozen();
        if (_creator == address(0)) revert MultiHookHost__ZeroAddress();
        creators[id] = _creator;
        emit CreatorSet(id, _creator);
    }

    // ---------------------------------------------------------------- beforeInitialize
    // Stamp the launch block AND enforce the initializer gate.
    //
    // `sender` here is the address that called `PoolManager.initialize` — which
    // v4-core passes through as the first arg. For our launchpad it's the Graduator.
    //
    // The gate: any pool initialized through this hook MUST come from the recorded
    // `initializer`. Before setInitializer is called, `initializer == address(0)` and
    // beforeInitialize reverts for everyone (the hook is deliberately unusable) —
    // this closes the window between deploy and setInitializer where a griefer could
    // otherwise front-run the wire-up.
    function beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160
    ) external override onlyPoolManager returns (bytes4) {
        address auth = initializer;
        if (auth == address(0)) revert MultiHookHost__InitializerNotSet();
        if (sender != auth) revert MultiHookHost__UnauthorizedInitializer(sender);
        PoolId id = key.toId();
        PoolConfig storage cfg = poolConfig[id];
        cfg.launchBlock = uint32(block.number);

        // GH-9: stamp + emit the canonical `PoolPolicy` in the same call the
        // legacy `PoolConfig.launchBlock` freezes. Fee bps come from the
        // constructor immutables (chain-wide), the per-pool knobs come from
        // whatever the Graduator wrote via `setPoolConfig` + `setCreator`.
        // `setPoolConfig` caps antiSniperBlocks at MAX_ANTI_SNIPER_BLOCKS (=
        // 7200), so the uint32 -> uint16 cast is provably lossless — a hostile
        // Graduator that skipped the setter cannot land a wider value here
        // because `beforeInitialize` reverts unless the sender is the wired
        // initializer, and every real initializer flow calls `setPoolConfig`
        // first (which enforces the cap).
        address recipient = creators[id];
        if (recipient == address(0)) recipient = creator;
        PoolPolicy memory p = PoolPolicy({
            antiSniperBlocks: uint16(cfg.antiSniperBlocks),
            buybackBurnBps: cfg.buybackBurnBps,
            platformFeeBps: platformBps,
            creatorFeeBps: creatorBps,
            creatorRecipient: recipient,
            launchBlock: uint64(block.number),
            immutableAfterLaunch: true
        });
        poolPolicy[id] = p;
        emit HookPolicySet(id, p);

        return this.beforeInitialize.selector;
    }

    // ---------------------------------------------------------------- anti-sniper gate
    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolConfig storage cfg = poolConfig[key.toId()];
        // URU-P1-M04: reject exact-output BUYs (zeroForOne = true, ETH -> token,
        // `amountSpecified > 0` means "I want exactly N tokens out") whenever
        // buyback-burn is enabled. See error doc for the misreporting rationale.
        // Exact-input BUYs (amountSpecified < 0) and every SELL still fall through.
        if (cfg.buybackBurnBps > 0 && params.zeroForOne && params.amountSpecified > 0) {
            revert MultiHookHost__ExactOutputBuyUnsupportedWithBurn();
        }
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
        // Zero-delta swaps (dust, no-ops) contribute no fee - skip cheaply.
        if (unspecDelta == 0) return (this.afterSwap.selector, 0);

        // Absolute delta - fee applies in both directions.
        //
        // v4 semantics: `hookDeltaUnspecified` (this function's int128 return) is
        // added to the swapper's unspecified-side delta. A positive return means
        // "swapper owes MORE on the unspecified side" - which is exactly what we
        // want in both cases:
        //   * exact-input  (unspecDelta > 0, output side): swapper receives less output
        //   * exact-output (unspecDelta < 0, input side):  swapper pays more input
        //
        // The previous implementation early-returned when unspecDelta <= 0, which
        // meant every exact-output swap paid ZERO platform+creator+burn fees. That
        // was a live fee leak - v4-periphery's exact-output path is trivial to reach.
        // Guard the pathological `type(int128).min` case: `-int128.min`
        // overflows in checked arithmetic and would DoS the whole swap unlock.
        // Practically unreachable at real curve scales (~1.7e38 tokens on the
        // unspecified side), but a hostile hook stack or 30+ decimal token
        // could edge into it. Clamp to uint128 max.
        uint256 absDelta = unspecDelta == type(int128).min
            ? uint256(uint128(type(int128).max)) + 1
            : uint128(unspecDelta < 0 ? -unspecDelta : unspecDelta);

        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 fee = (absDelta * totalBps) / 10_000;

        // URU-P1-M04: buyback-burn is token-denominated and therefore only valid
        // when the unspecified currency is the launched token — i.e. an
        // exact-input BUY (amountSpecified < 0). Exact-output BUYs are rejected
        // in `beforeSwap` above, so the `< 0` check here is defence-in-depth:
        // any exact-output BUY that somehow reaches afterSwap gets zero burn
        // (as opposed to silently destroying ETH input while emitting a token-burn event).
        uint256 burn = 0;
        PoolId id = key.toId();
        PoolConfig storage cfg = poolConfig[id];
        if (cfg.buybackBurnBps > 0 && params.zeroForOne && params.amountSpecified < 0) {
            burn = (absDelta * uint256(cfg.buybackBurnBps)) / 10_000;
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

    /// Permissionless push — transfers `account`'s owed balance to `account`.
    /// Enables the platform slot (typically a contract like `FeeSplitter` that
    /// can't call `claim()` itself) to receive its accumulated fees via any
    /// keeper/caller. `claim` and `pushOwed` share the same accounting, so a
    /// creator can still pull their own share privately via `claim` if they
    /// prefer. Emits the same FeeClaimed event so indexers see one code path.
    function pushOwed(
        Currency currency,
        address account
    ) external {
        uint256 amount = owed[currency][account];
        if (amount == 0) revert MultiHookHost__NothingToClaim();
        owed[currency][account] = 0;
        currency.transfer(account, amount);
        emit FeeClaimed(currency, account, amount);
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
