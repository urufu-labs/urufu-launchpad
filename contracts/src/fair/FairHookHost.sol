// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseHook} from "../hooks/BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

/// @title  FairHookHost
/// @notice v4 hook for Fair launch pools (docs/SPEC-fair-launch.md). Does everything
///         MultiHookHost does for a graduated pool (platform + creator fee taken in
///         `afterSwap` from the unspecified side, initializer gate, frozen per-pool
///         config) plus the Fair-lane rules:
///
///           1. Sniper tax. From the moment the pool initializes, an extra fee starts at
///              `taxStartBps` and decays linearly to zero over `taxDecaySecs`. The tax is
///              never paid to anyone: token-side tax is sent to 0xdEaD in the same swap,
///              ETH-side tax goes into a per-pool burn bank.
///           2. Creator-fee forfeit. At graduation the FairGraduator writes a creator
///              baseline. A pool flips to `forfeited = true`, permanently, the first time
///              a check sees `balanceOf(creator) < baseline * (1 - forfeitDropBps)`. A
///              creator who sold on the curve, moved tokens away before graduation, or
///              held (almost) nothing at graduation starts forfeited. After the flip the
///              creator share is burned (token side now, ETH side via the bank).
///           3. Pending creator fees. The hook cannot see who is swapping, and a dumping
///              creator's tokens only leave their wallet after the swap callbacks run. So
///              each swap's creator share is held as PENDING. It becomes claimable
///              (confirmed) only when a later transaction checks the creator is still
///              above the floor. If that check finds the creator dumped, the pending fees
///              (their own dump included) are burned instead. Checks run on the first
///              swap of every transaction and inside `pokeForfeit` / `claimCreatorFees`,
///              which refuse to run while the PoolManager is unlocked (mid-swap), so a
///              creator cannot dump and claim before the check sees it.
///           4. Burn bank. `burnBank(poolId, minTokensOut)` swaps banked ETH for tokens
///              inside this hook's own unlock and sends them to 0xdEaD. The hook is the
///              caller, so v4 skips the hook callbacks for that swap. Guarded against
///              sandwiching: it refuses to run if the price has moved more than
///              `BANK_MAX_DEVIATION_BPS` from the price at the start of the current second
///              (a front-run has to happen in the same second), and each call can move
///              the price at most `BANK_MAX_IMPACT_BPS`; the rest stays banked.
///           5. Liquidity lock during the tax window. Until the sniper tax hits zero, only
///              the FairGraduator can add liquidity. Otherwise a sniper could skip the tax
///              by trading through a one-sided range position instead of a swap.
///
///         Why burn instead of donating to the pool: the FairGraduator owns the locked
///         full-range position directly and has no `collect`, so donated value would
///         strand. Burning gives holders the same "snipers pay holders" effect.
///
/// @dev    Address must carry exactly these permission bits (HookMiner):
///           BEFORE_INITIALIZE_FLAG        (1 << 13)
///         | BEFORE_ADD_LIQUIDITY_FLAG     (1 << 11)
///         | BEFORE_SWAP_FLAG              (1 << 7)
///         | AFTER_SWAP_FLAG               (1 << 6)
///         | AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2)    == 0x28C4
///         All windows use `block.timestamp` because on Robinhood Chain `block.number` is
///         the Ethereum L1 block. Uses transient storage (EIP-1153), like v4 itself.
contract FairHookHost is BaseHook, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    // ============================================================ errors
    error FairHookHost__ZeroAddress();
    error FairHookHost__BpsTooHigh(uint256 total);
    error FairHookHost__TaxTooHigh(uint16 bps);
    error FairHookHost__DecayOutOfRange(uint32 secs);
    error FairHookHost__DropOutOfRange(uint16 bps);
    error FairHookHost__AntiSniperTooLong(uint32 provided, uint32 maximum);
    error FairHookHost__NotDeployer();
    error FairHookHost__InitializerAlreadySet();
    error FairHookHost__InitializerNotSet();
    error FairHookHost__NotInitializer(address caller);
    error FairHookHost__UnauthorizedInitializer(address sender);
    error FairHookHost__ConfigFrozen(PoolId poolId);
    error FairHookHost__PoolNotConfigured(PoolId poolId);
    error FairHookHost__NotEthPair();
    error FairHookHost__AntiSniperGate(uint256 opensAt);
    error FairHookHost__NothingToClaim();
    error FairHookHost__NothingBanked(PoolId poolId);
    error FairHookHost__PoolNotLive(PoolId poolId);
    error FairHookHost__BankSlippage(uint256 got, uint256 min);
    /// Third-party liquidity add while the sniper tax is still running.
    error FairHookHost__LiquidityLocked(uint256 opensAt);
    /// Creator check or claim attempted while a PoolManager unlock is in progress.
    error FairHookHost__PoolManagerUnlocked();
    /// burnBank refused: the price moved too far from this second's reference.
    error FairHookHost__BankPriceMoved(uint160 refSqrtPriceX96, uint160 nowSqrtPriceX96);

    // ============================================================ events
    event InitializerSet(address indexed initializer);
    event PoolConfigSet(
        PoolId indexed poolId, address indexed creator, uint256 creatorBaseline, bool forfeited, uint32 antiSniperSeconds
    );
    /// Canonical per-pool policy, emitted once when the pool initializes.
    event FairPoolInitialized(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        uint256 creatorBaseline,
        bool forfeited,
        uint64 launchTs,
        uint16 taxStartBps,
        uint32 taxDecaySecs,
        uint16 forfeitDropBps
    );
    /// `creatorShare` is PENDING until confirmed (see contract notes, point 3).
    event FeeAccrued(PoolId indexed poolId, Currency indexed currency, uint256 platformShare, uint256 creatorShare);
    event FeeClaimed(Currency indexed currency, address indexed to, uint256 amount);
    /// Token-side sniper tax, sent to 0xdEaD in the same swap.
    event SniperTaxBurned(PoolId indexed poolId, uint256 tokenAmount);
    /// ETH-side sniper tax, parked in the burn bank until `burnBank`.
    event SniperTaxBanked(PoolId indexed poolId, uint256 ethAmount);
    /// Creator share burned: either accrued after the forfeit, or pending fees clawed
    /// back when the forfeit fired. Token side is burned now, ETH side is banked.
    event CreatorFeeBurned(PoolId indexed poolId, Currency indexed currency, uint256 amount);
    event CreatorFeeForfeited(PoolId indexed poolId, address indexed creator, uint256 balance, uint256 baseline);
    /// Pending creator fees moved to claimable after a passing check.
    event CreatorFeesConfirmed(PoolId indexed poolId, uint256 ethAmount, uint256 tokenAmount);
    event BankBurned(PoolId indexed poolId, address indexed caller, uint256 ethIn, uint256 tokensBurned);

    // ============================================================ constants
    uint16 public constant MAX_TOTAL_BPS = 3000;
    uint16 public constant MAX_TAX_BPS = 3000;
    uint32 public constant MAX_TAX_DECAY_SECS = 1 days;
    uint16 public constant MAX_FORFEIT_DROP_BPS = 5000;
    uint32 public constant MAX_ANTI_SNIPER_SECONDS = 600;
    /// burnBank refuses if sqrtPrice moved more than 1% (~2% price) this second.
    uint16 public constant BANK_MAX_DEVIATION_BPS = 100;
    /// Each burnBank swap stops once sqrtPrice falls 0.5% (~1% price).
    uint16 public constant BANK_MAX_IMPACT_BPS = 50;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// Transient-storage namespace for "this pool already ran its check this tx".
    bytes32 private constant _CHECKED_TX_SEED = keccak256("urufu.fair.hook.checkedThisTx");

    // ============================================================ immutables
    address public immutable platform;
    uint16 public immutable platformBps;
    uint16 public immutable creatorBps;
    uint16 public immutable taxStartBps;
    uint32 public immutable taxDecaySecs;
    uint16 public immutable forfeitDropBps;
    /// One-shot setup key for `setInitializer`. Explicit param because CREATE2-mined
    /// hooks are deployed through a factory, so `msg.sender` is not the wallet.
    address public immutable deployer;

    // ============================================================ state
    address public initializer;

    struct PoolState {
        address token; // currency1 (currency0 is always native ETH)
        address creator; // fee recipient until forfeit
        uint64 launchTs; // stamped at beforeInitialize; non-zero == frozen
        uint32 antiSniperSeconds; // optional revert gate, 0 = off (lane default)
        uint24 fee; // pool key fields, kept so `burnBank` can rebuild the key
        int24 tickSpacing;
        bool configured;
        bool forfeited; // permanent once true
        uint256 creatorBaseline; // set by the graduator
    }

    struct CreatorFees {
        uint128 pendingEth;
        uint128 pendingToken;
        uint128 claimableEth;
        uint128 claimableToken;
    }

    struct PriceRef {
        uint160 sqrtPriceX96; // pool price before the first swap of `ts`
        uint64 ts;
    }

    mapping(PoolId => PoolState) public pools;
    mapping(PoolId => CreatorFees) public creatorFees;
    mapping(PoolId => PriceRef) public priceRef;
    /// ETH waiting to be swapped and burned, per pool.
    mapping(PoolId => uint256) public bankedEth;
    /// Sum of every `bankedEth` entry, so solvency is checkable on-chain.
    uint256 public totalBanked;
    /// Platform fees (FeeSplitter), per currency.
    mapping(Currency => mapping(address => uint256)) public owed;

    constructor(
        IPoolManager _poolManager,
        address _platform,
        uint16 _platformBps,
        uint16 _creatorBps,
        uint16 _taxStartBps,
        uint32 _taxDecaySecs,
        uint16 _forfeitDropBps,
        address _deployer
    ) BaseHook(_poolManager) {
        if (_platform == address(0) || _deployer == address(0)) revert FairHookHost__ZeroAddress();
        uint256 total = uint256(_platformBps) + uint256(_creatorBps);
        if (total == 0 || total > MAX_TOTAL_BPS) revert FairHookHost__BpsTooHigh(total);
        if (_taxStartBps > MAX_TAX_BPS) revert FairHookHost__TaxTooHigh(_taxStartBps);
        if (_taxDecaySecs == 0 || _taxDecaySecs > MAX_TAX_DECAY_SECS) revert FairHookHost__DecayOutOfRange(_taxDecaySecs);
        if (_forfeitDropBps == 0 || _forfeitDropBps > MAX_FORFEIT_DROP_BPS) {
            revert FairHookHost__DropOutOfRange(_forfeitDropBps);
        }
        platform = _platform;
        platformBps = _platformBps;
        creatorBps = _creatorBps;
        taxStartBps = _taxStartBps;
        taxDecaySecs = _taxDecaySecs;
        forfeitDropBps = _forfeitDropBps;
        deployer = _deployer;
    }

    /// Wire the hook to its FairGraduator. Callable once, by `deployer` only. Until then
    /// `beforeInitialize` reverts for everyone so nobody can bootstrap a rogue pool.
    function setInitializer(
        address _initializer
    ) external {
        if (msg.sender != deployer) revert FairHookHost__NotDeployer();
        if (initializer != address(0)) revert FairHookHost__InitializerAlreadySet();
        if (_initializer == address(0)) revert FairHookHost__ZeroAddress();
        initializer = _initializer;
        emit InitializerSet(_initializer);
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
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

    // ============================================================ per-pool config

    /// Written by the FairGraduator in the same tx as `initialize`. Frozen at init.
    function setPoolConfig(
        PoolId id,
        address creator,
        uint256 creatorBaseline,
        bool forfeited,
        uint32 antiSniperSeconds
    ) external {
        if (msg.sender != initializer) revert FairHookHost__NotInitializer(msg.sender);
        PoolState storage ps = pools[id];
        if (ps.launchTs != 0) revert FairHookHost__ConfigFrozen(id);
        if (antiSniperSeconds > MAX_ANTI_SNIPER_SECONDS) {
            revert FairHookHost__AntiSniperTooLong(antiSniperSeconds, MAX_ANTI_SNIPER_SECONDS);
        }
        ps.creator = creator;
        ps.creatorBaseline = creatorBaseline;
        ps.forfeited = forfeited;
        ps.antiSniperSeconds = antiSniperSeconds;
        ps.configured = true;
        emit PoolConfigSet(id, creator, creatorBaseline, forfeited, antiSniperSeconds);
    }

    function beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160
    ) external override onlyPoolManager returns (bytes4) {
        address auth = initializer;
        if (auth == address(0)) revert FairHookHost__InitializerNotSet();
        if (sender != auth) revert FairHookHost__UnauthorizedInitializer(sender);
        if (Currency.unwrap(key.currency0) != address(0)) revert FairHookHost__NotEthPair();
        PoolId id = key.toId();
        PoolState storage ps = pools[id];
        if (!ps.configured) revert FairHookHost__PoolNotConfigured(id);
        if (ps.launchTs != 0) revert FairHookHost__ConfigFrozen(id);

        ps.token = Currency.unwrap(key.currency1);
        ps.launchTs = uint64(block.timestamp);
        ps.fee = key.fee;
        ps.tickSpacing = key.tickSpacing;
        // A creator with no baseline (held nothing at graduation) never earns: rule 2.
        if (ps.creatorBaseline == 0) ps.forfeited = true;

        emit FairPoolInitialized(
            id,
            ps.token,
            ps.creator,
            ps.creatorBaseline,
            ps.forfeited,
            ps.launchTs,
            taxStartBps,
            taxDecaySecs,
            forfeitDropBps
        );
        if (ps.forfeited) {
            emit CreatorFeeForfeited(id, ps.creator, _balanceOf(ps.token, ps.creator), ps.creatorBaseline);
        }
        return this.beforeInitialize.selector;
    }

    /// Only the graduator (opening the locked LP in the graduation tx) may add liquidity
    /// before the sniper tax ends. See point 5 in the contract notes.
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4) {
        if (sender != initializer) {
            uint256 opensAt = uint256(pools[key.toId()].launchTs) + taxDecaySecs;
            if (block.timestamp < opensAt) revert FairHookHost__LiquidityLocked(opensAt);
        }
        return this.beforeAddLiquidity.selector;
    }

    // ============================================================ views

    /// Sniper tax in bps at the current block time. Zero once the decay window ends.
    function currentTaxBps(
        PoolId id
    ) public view returns (uint256) {
        uint256 launchTs = pools[id].launchTs;
        if (launchTs == 0) return 0;
        uint256 end = launchTs + taxDecaySecs;
        if (block.timestamp >= end) return 0;
        return (uint256(taxStartBps) * (end - block.timestamp)) / taxDecaySecs;
    }

    /// Seconds until the sniper tax hits zero.
    function taxSecondsLeft(
        PoolId id
    ) external view returns (uint256) {
        uint256 launchTs = pools[id].launchTs;
        if (launchTs == 0) return 0;
        uint256 end = launchTs + taxDecaySecs;
        return block.timestamp >= end ? 0 : end - block.timestamp;
    }

    /// True if the creator share is (or would be on the next check) burned.
    function isForfeited(
        PoolId id
    ) external view returns (bool) {
        PoolState storage ps = pools[id];
        if (ps.forfeited || ps.creator == address(0) || ps.creatorBaseline == 0) return true;
        if (ps.token == address(0)) return false;
        return _balanceOf(ps.token, ps.creator) < _forfeitFloor(ps.creatorBaseline);
    }

    // ============================================================ swap callbacks

    /// Records the pool price at the start of each second (for the burn-bank guard) and
    /// runs the optional anti-sniper gate (off by default for this lane).
    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId id = key.toId();
        PoolState storage ps = pools[id];
        uint256 gate = ps.antiSniperSeconds;
        if (gate > 0) {
            uint256 opensAt = uint256(ps.launchTs) + gate;
            if (block.timestamp < opensAt) revert FairHookHost__AntiSniperGate(opensAt);
        }
        PriceRef storage ref = priceRef[id];
        if (ref.ts != uint64(block.timestamp)) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
            ref.sqrtPriceX96 = sqrtPriceX96;
            ref.ts = uint64(block.timestamp);
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// Takes platform fee + creator fee + sniper tax from the unspecified side of every
    /// swap (output on exact-in, input on exact-out), same delta convention as
    /// MultiHookHost: the positive return is added to what the swapper owes on the
    /// unspecified side, and the hook `take`s exactly that amount.
    ///
    ///   platform share -> owed[platform]
    ///   creator share  -> creatorFees.pending (confirmed later), or burned if forfeited
    ///   sniper tax     -> 0xdEaD now (token side) / burn bank (ETH side)
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        PoolId id = key.toId();
        PoolState storage ps = pools[id];

        // First swap of this pool in this tx: every earlier tx has settled, so the
        // creator's balance is final. Confirm or claw back pending creator fees.
        if (!_checkedThisTx(id)) {
            _markCheckedThisTx(id);
            _settleCreator(id, ps);
        }

        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);
        if (unspecDelta == 0) return (this.afterSwap.selector, 0);

        uint256 absDelta = unspecDelta == type(int128).min
            ? uint256(uint128(type(int128).max)) + 1
            : uint128(unspecDelta < 0 ? -unspecDelta : unspecDelta);

        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 fee = (absDelta * totalBps) / 10_000;
        uint256 tax = (absDelta * currentTaxBps(id)) / 10_000;
        uint256 totalTake = fee + tax;
        if (totalTake == 0) return (this.afterSwap.selector, 0);

        uint256 platformShare = (fee * platformBps) / totalBps;
        uint256 creatorShare = fee - platformShare;
        bool isEth = Currency.unwrap(unspecCurrency) == address(0);

        poolManager.take(unspecCurrency, address(this), totalTake);

        uint256 toBurn = tax;
        uint256 burnedCreatorShare;
        if (creatorShare > 0) {
            if (ps.forfeited || ps.creator == address(0)) {
                burnedCreatorShare = creatorShare;
                toBurn += creatorShare;
                creatorShare = 0;
            } else if (isEth) {
                creatorFees[id].pendingEth += uint128(creatorShare);
            } else {
                creatorFees[id].pendingToken += uint128(creatorShare);
            }
        }
        if (fee > 0) {
            owed[unspecCurrency][platform] += platformShare;
            emit FeeAccrued(id, unspecCurrency, platformShare, creatorShare);
        }
        if (toBurn > 0) {
            if (isEth) {
                bankedEth[id] += toBurn;
                totalBanked += toBurn;
                if (tax > 0) emit SniperTaxBanked(id, tax);
            } else {
                unspecCurrency.transfer(BURN_ADDRESS, toBurn);
                if (tax > 0) emit SniperTaxBurned(id, tax);
            }
            if (burnedCreatorShare > 0) emit CreatorFeeBurned(id, unspecCurrency, burnedCreatorShare);
        }

        return (this.afterSwap.selector, int128(int256(totalTake)));
    }

    // ============================================================ creator fees

    /// Permissionless: run the creator check now (e.g. right after a creator transfer).
    /// Confirms pending fees if the creator still holds, otherwise forfeits and burns
    /// them. Refuses mid-swap, when the creator's balance is not final yet.
    function pokeForfeit(
        PoolId id
    ) external returns (bool forfeited) {
        PoolState storage ps = pools[id];
        if (ps.launchTs == 0) revert FairHookHost__PoolNotLive(id);
        if (poolManager.isUnlocked()) revert FairHookHost__PoolManagerUnlocked();
        _settleCreator(id, ps);
        return ps.forfeited;
    }

    /// Pay the creator's confirmed fees for a pool, after running the check. Anyone can
    /// call it; funds always go to the pool's creator. Refuses mid-swap so a creator
    /// cannot dump and claim in one go before the check sees the dump.
    function claimCreatorFees(
        PoolId id
    ) external nonReentrant returns (uint256 ethAmount, uint256 tokenAmount) {
        PoolState storage ps = pools[id];
        if (ps.launchTs == 0) revert FairHookHost__PoolNotLive(id);
        if (poolManager.isUnlocked()) revert FairHookHost__PoolManagerUnlocked();
        _settleCreator(id, ps);
        CreatorFees storage cf = creatorFees[id];
        ethAmount = cf.claimableEth;
        tokenAmount = cf.claimableToken;
        // No revert on an empty claim: the check above may just have flipped the pool to
        // forfeited, and a revert would undo that.
        if (ethAmount == 0 && tokenAmount == 0) return (0, 0);
        cf.claimableEth = 0;
        cf.claimableToken = 0;
        address c = ps.creator;
        if (tokenAmount > 0) {
            Currency.wrap(ps.token).transfer(c, tokenAmount);
            emit FeeClaimed(Currency.wrap(ps.token), c, tokenAmount);
        }
        if (ethAmount > 0) {
            Currency.wrap(address(0)).transfer(c, ethAmount);
            emit FeeClaimed(Currency.wrap(address(0)), c, ethAmount);
        }
    }

    /// Confirm pending creator fees if the creator is still above the floor; otherwise
    /// flip the pool to forfeited and burn everything pending. Claimable (already
    /// confirmed) fees are never touched: they were earned.
    function _settleCreator(
        PoolId id,
        PoolState storage ps
    ) internal {
        CreatorFees storage cf = creatorFees[id];
        uint256 pEth = cf.pendingEth;
        uint256 pTok = cf.pendingToken;
        if (!ps.forfeited) {
            uint256 baseline = ps.creatorBaseline;
            uint256 bal = _balanceOf(ps.token, ps.creator);
            if (ps.creator == address(0) || baseline == 0 || bal < _forfeitFloor(baseline)) {
                ps.forfeited = true;
                emit CreatorFeeForfeited(id, ps.creator, bal, baseline);
            } else {
                if (pEth == 0 && pTok == 0) return;
                cf.pendingEth = 0;
                cf.pendingToken = 0;
                cf.claimableEth += uint128(pEth);
                cf.claimableToken += uint128(pTok);
                emit CreatorFeesConfirmed(id, pEth, pTok);
                return;
            }
        }
        if (pEth == 0 && pTok == 0) return;
        cf.pendingEth = 0;
        cf.pendingToken = 0;
        if (pEth > 0) {
            bankedEth[id] += pEth;
            totalBanked += pEth;
            emit CreatorFeeBurned(id, Currency.wrap(address(0)), pEth);
        }
        if (pTok > 0) {
            Currency.wrap(ps.token).transfer(BURN_ADDRESS, pTok);
            emit CreatorFeeBurned(id, Currency.wrap(ps.token), pTok);
        }
    }

    function _forfeitFloor(
        uint256 baseline
    ) internal view returns (uint256) {
        return (baseline * (10_000 - uint256(forfeitDropBps))) / 10_000;
    }

    function _checkedSlot(
        PoolId id
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(_CHECKED_TX_SEED, id));
    }

    function _checkedThisTx(
        PoolId id
    ) private view returns (bool v) {
        bytes32 slot = _checkedSlot(id);
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _markCheckedThisTx(
        PoolId id
    ) private {
        bytes32 slot = _checkedSlot(id);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    // ============================================================ burn bank

    /// Swap a pool's banked ETH for tokens and burn them. Anyone can call (the keeper
    /// does every few minutes). `minTokensOut` is the caller's own slippage floor; the
    /// hook adds a price-deviation check and a per-call price-impact cap on top.
    function burnBank(
        PoolId id,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensBurned) {
        PoolState storage ps = pools[id];
        if (ps.launchTs == 0) revert FairHookHost__PoolNotLive(id);
        uint256 amount = bankedEth[id];
        if (amount == 0) revert FairHookHost__NothingBanked(id);

        (uint160 nowSqrt,,,) = poolManager.getSlot0(id);
        PriceRef storage ref = priceRef[id];
        if (ref.ts == uint64(block.timestamp)) {
            uint256 r = ref.sqrtPriceX96;
            uint256 diff = nowSqrt > r ? nowSqrt - r : r - nowSqrt;
            if (diff * 10_000 > r * BANK_MAX_DEVIATION_BPS) revert FairHookHost__BankPriceMoved(ref.sqrtPriceX96, nowSqrt);
        } else {
            // First touch this second: pin the reference so repeated burns in the same
            // second also hit the deviation bound (~1-2% total impact per second).
            ref.sqrtPriceX96 = nowSqrt;
            ref.ts = uint64(block.timestamp);
        }

        bankedEth[id] = 0;
        totalBanked -= amount;
        uint160 limit = uint160((uint256(nowSqrt) * (10_000 - BANK_MAX_IMPACT_BPS)) / 10_000);
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;

        bytes memory ret = poolManager.unlock(abi.encode(id, amount, limit));
        uint256 ethUsed;
        (ethUsed, tokensBurned) = abi.decode(ret, (uint256, uint256));
        if (tokensBurned < minTokensOut) revert FairHookHost__BankSlippage(tokensBurned, minTokensOut);
        // The impact cap stops the swap early; whatever was not spent stays banked.
        if (ethUsed < amount) {
            uint256 rest = amount - ethUsed;
            bankedEth[id] += rest;
            totalBanked += rest;
        }
        emit BankBurned(id, msg.sender, ethUsed, tokensBurned);
    }

    function unlockCallback(
        bytes calldata data
    ) external onlyPoolManager returns (bytes memory) {
        (PoolId id, uint256 amount, uint160 limit) = abi.decode(data, (PoolId, uint256, uint160));
        PoolState storage ps = pools[id];
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(ps.token),
            fee: ps.fee,
            tickSpacing: ps.tickSpacing,
            hooks: IHooks(address(this))
        });
        // Caller is the hook itself, so v4 skips beforeSwap/afterSwap for this swap.
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}), ""
        );
        int128 d0 = _amount0(d);
        int128 d1 = _amount1(d);
        uint256 ethUsed = d0 < 0 ? uint256(uint128(-d0)) : 0;
        uint256 tokensOut = d1 > 0 ? uint256(uint128(d1)) : 0;
        if (ethUsed > 0) poolManager.settle{value: ethUsed}();
        if (tokensOut > 0) poolManager.take(key.currency1, BURN_ADDRESS, tokensOut);
        return abi.encode(ethUsed, tokensOut);
    }

    // ============================================================ platform fees

    function claim(
        Currency currency
    ) external nonReentrant {
        uint256 amount = owed[currency][msg.sender];
        if (amount == 0) revert FairHookHost__NothingToClaim();
        owed[currency][msg.sender] = 0;
        currency.transfer(msg.sender, amount);
        emit FeeClaimed(currency, msg.sender, amount);
    }

    /// Permissionless push to `account` (lets a keeper deliver the platform share to
    /// FeeSplitter, which cannot call `claim` itself).
    function pushOwed(
        Currency currency,
        address account
    ) external nonReentrant {
        uint256 amount = owed[currency][account];
        if (amount == 0) revert FairHookHost__NothingToClaim();
        owed[currency][account] = 0;
        currency.transfer(account, amount);
        emit FeeClaimed(currency, account, amount);
    }

    receive() external payable {}

    // ============================================================ internal

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

    function _balanceOf(
        address token,
        address account
    ) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || ret.length < 32) return type(uint256).max; // unreadable: never forfeit on a bad read
        return abi.decode(ret, (uint256));
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
}
