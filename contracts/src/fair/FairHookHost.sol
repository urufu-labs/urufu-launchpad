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
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

/// @title  FairHookHost
/// @notice v4 hook for Fair launch pools (docs/SPEC-fair-launch.md). Does everything
///         MultiHookHost does for a graduated pool (platform + creator fee taken in
///         `afterSwap` from the unspecified side, initializer gate, frozen per-pool
///         config) plus three Fair-lane rules:
///
///           1. Sniper tax. From the moment the pool initializes, an extra fee starts at
///              `taxStartBps` and decays linearly to zero over `taxDecaySecs`. The tax is
///              never paid to anyone: token-side tax is sent to 0xdEaD in the same swap,
///              ETH-side tax goes into a per-pool burn bank.
///           2. Creator-fee forfeit. At graduation the FairGraduator writes the creator's
///              token balance as `creatorBaseline`. The first swap (or `pokeForfeit`) that
///              sees `balanceOf(creator) < baseline * (1 - forfeitDropBps)` flips the pool
///              to `forfeited = true`, permanently. A pre-graduation curve sell by the
///              creator arrives here already forfeited. After the flip the creator share
///              is burned (token side now, ETH side via the bank). Fees owed before the
///              flip stay claimable.
///           3. Burn bank. `burnBank(poolId, minTokensOut)` swaps the banked ETH for
///              tokens inside this hook's own unlock and sends them to 0xdEaD. The hook
///              is the caller, so v4 skips the hook callbacks for that swap (no fee, no
///              tax, no recursion); only the pool's LP fee applies.
///
///         Why burn instead of donating to the pool: the FairGraduator owns the locked
///         full-range position directly and has no `collect`, so donated value would
///         strand. Burning gives holders the same "snipers pay holders" effect.
///
/// @dev    Address must carry exactly these permission bits (HookMiner):
///           BEFORE_INITIALIZE_FLAG        (1 << 13)
///         | BEFORE_SWAP_FLAG              (1 << 7)
///         | AFTER_SWAP_FLAG               (1 << 6)
///         | AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2)    == 0x20C4
///         Same bits as MultiHookHost; it is a separate contract because MHH holds no
///         per-pool tax / baseline / bank state and its address is already allowlisted
///         for a different behavior set. All windows use `block.timestamp` because on
///         Robinhood Chain `block.number` is the Ethereum L1 block.
contract FairHookHost is BaseHook, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;

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
    event FeeAccrued(PoolId indexed poolId, Currency indexed currency, uint256 platformShare, uint256 creatorShare);
    event FeeClaimed(Currency indexed currency, address indexed to, uint256 amount);
    /// Token-side sniper tax, sent to 0xdEaD in the same swap.
    event SniperTaxBurned(PoolId indexed poolId, uint256 tokenAmount);
    /// ETH-side sniper tax, parked in the burn bank until `burnBank`.
    event SniperTaxBanked(PoolId indexed poolId, uint256 ethAmount);
    /// Creator share after forfeit. Token side is burned now, ETH side is banked.
    event CreatorFeeBurned(PoolId indexed poolId, Currency indexed currency, uint256 amount);
    event CreatorFeeForfeited(PoolId indexed poolId, address indexed creator, uint256 balance, uint256 baseline);
    event BankBurned(PoolId indexed poolId, address indexed caller, uint256 ethIn, uint256 tokensBurned);

    // ============================================================ constants
    uint16 public constant MAX_TOTAL_BPS = 3000;
    uint16 public constant MAX_TAX_BPS = 3000;
    uint32 public constant MAX_TAX_DECAY_SECS = 1 days;
    uint16 public constant MAX_FORFEIT_DROP_BPS = 5000;
    uint32 public constant MAX_ANTI_SNIPER_SECONDS = 600;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

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
        uint256 creatorBaseline; // creator token balance at graduation
    }

    mapping(PoolId => PoolState) public pools;
    /// ETH waiting to be swapped and burned, per pool.
    mapping(PoolId => uint256) public bankedEth;
    /// Sum of every `bankedEth` entry, so solvency is checkable on-chain.
    uint256 public totalBanked;
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

    /// True if the creator share is (or would be on the next swap) burned.
    function isForfeited(
        PoolId id
    ) external view returns (bool) {
        PoolState storage ps = pools[id];
        if (ps.forfeited || ps.creator == address(0)) return true;
        if (ps.creatorBaseline == 0 || ps.token == address(0)) return false;
        return _balanceOf(ps.token, ps.creator) < _forfeitFloor(ps.creatorBaseline);
    }

    // ============================================================ swap callbacks

    /// Optional anti-sniper revert gate. Off by default for this lane (the tax replaces
    /// it); kept so the graduator can turn it on per pool without a new hook.
    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolState storage ps = pools[key.toId()];
        uint256 gate = ps.antiSniperSeconds;
        if (gate > 0) {
            uint256 opensAt = uint256(ps.launchTs) + gate;
            if (block.timestamp < opensAt) revert FairHookHost__AntiSniperGate(opensAt);
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// Takes platform fee + creator fee + sniper tax from the unspecified side of every
    /// swap (output on exact-in, input on exact-out), same delta convention as
    /// MultiHookHost: the positive return is added to what the swapper owes on the
    /// unspecified side, and the hook `take`s exactly that amount.
    ///
    /// Routing of each slice by unspecified currency:
    ///   platform share      -> owed[platform]                (both currencies)
    ///   creator share       -> owed[creator]                 (until forfeit)
    ///                       -> 0xdEaD now / burn bank        (after forfeit)
    ///   sniper tax          -> 0xdEaD now (token) / burn bank (ETH)
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);
        if (unspecDelta == 0) return (this.afterSwap.selector, 0);

        uint256 absDelta = unspecDelta == type(int128).min
            ? uint256(uint128(type(int128).max)) + 1
            : uint128(unspecDelta < 0 ? -unspecDelta : unspecDelta);

        PoolId id = key.toId();
        PoolState storage ps = pools[id];

        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 fee = (absDelta * totalBps) / 10_000;
        uint256 tax = (absDelta * currentTaxBps(id)) / 10_000;
        uint256 totalTake = fee + tax;
        if (totalTake == 0) return (this.afterSwap.selector, 0);

        uint256 platformShare = (fee * platformBps) / totalBps;
        uint256 creatorShare = fee - platformShare;
        uint256 forfeitedShare;
        if (creatorShare > 0 && _checkForfeit(id, ps)) {
            forfeitedShare = creatorShare;
            creatorShare = 0;
        }

        poolManager.take(unspecCurrency, address(this), totalTake);

        if (fee > 0) {
            owed[unspecCurrency][platform] += platformShare;
            if (creatorShare > 0) owed[unspecCurrency][ps.creator] += creatorShare;
            emit FeeAccrued(id, unspecCurrency, platformShare, creatorShare);
        }

        uint256 toBurn = tax + forfeitedShare;
        if (toBurn > 0) {
            if (Currency.unwrap(unspecCurrency) == address(0)) {
                bankedEth[id] += toBurn;
                totalBanked += toBurn;
                if (tax > 0) emit SniperTaxBanked(id, tax);
            } else {
                unspecCurrency.transfer(BURN_ADDRESS, toBurn);
                if (tax > 0) emit SniperTaxBurned(id, tax);
            }
            if (forfeitedShare > 0) emit CreatorFeeBurned(id, unspecCurrency, forfeitedShare);
        }

        return (this.afterSwap.selector, int128(int256(totalTake)));
    }

    // ============================================================ forfeit

    /// Permissionless: flip a pool to forfeited without waiting for a swap (e.g. right
    /// after a creator transfer). No-op when the creator is still above the floor.
    function pokeForfeit(
        PoolId id
    ) external returns (bool forfeited) {
        PoolState storage ps = pools[id];
        if (ps.launchTs == 0) revert FairHookHost__PoolNotLive(id);
        return _checkForfeit(id, ps);
    }

    function _checkForfeit(
        PoolId id,
        PoolState storage ps
    ) internal returns (bool) {
        if (ps.forfeited) return true;
        address c = ps.creator;
        // No creator recorded: nobody to pay, so the share burns.
        if (c == address(0)) return true;
        uint256 baseline = ps.creatorBaseline;
        // Creator held nothing at graduation: there is nothing to dump, so the rule
        // cannot fire. Documented limit on the trade page.
        if (baseline == 0) return false;
        uint256 bal = _balanceOf(ps.token, c);
        if (bal < _forfeitFloor(baseline)) {
            ps.forfeited = true;
            emit CreatorFeeForfeited(id, c, bal, baseline);
            return true;
        }
        return false;
    }

    function _forfeitFloor(
        uint256 baseline
    ) internal view returns (uint256) {
        return (baseline * (10_000 - uint256(forfeitDropBps))) / 10_000;
    }

    // ============================================================ burn bank

    /// Swap a pool's banked ETH for tokens and burn them. Anyone can call (the keeper
    /// does every few minutes). `minTokensOut` is the caller's slippage floor.
    function burnBank(
        PoolId id,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensBurned) {
        PoolState storage ps = pools[id];
        if (ps.launchTs == 0) revert FairHookHost__PoolNotLive(id);
        uint256 amount = bankedEth[id];
        if (amount == 0) revert FairHookHost__NothingBanked(id);
        bankedEth[id] = 0;
        totalBanked -= amount;

        bytes memory ret = poolManager.unlock(abi.encode(id, amount));
        uint256 ethUsed;
        (ethUsed, tokensBurned) = abi.decode(ret, (uint256, uint256));
        if (tokensBurned < minTokensOut) revert FairHookHost__BankSlippage(tokensBurned, minTokensOut);
        // A swap that hit the price limit before spending everything puts the rest back.
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
        (PoolId id, uint256 amount) = abi.decode(data, (PoolId, uint256));
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
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        int128 d0 = _amount0(d);
        int128 d1 = _amount1(d);
        uint256 ethUsed = d0 < 0 ? uint256(uint128(-d0)) : 0;
        uint256 tokensOut = d1 > 0 ? uint256(uint128(d1)) : 0;
        if (ethUsed > 0) poolManager.settle{value: ethUsed}();
        if (tokensOut > 0) poolManager.take(key.currency1, BURN_ADDRESS, tokensOut);
        return abi.encode(ethUsed, tokensOut);
    }

    // ============================================================ claim

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
