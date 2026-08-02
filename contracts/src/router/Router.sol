// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface ICurveFactoryLike {
    function createCurve(
        address token
    ) external returns (address curve);
    function createCurveWithConfig(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external returns (address curve);
    /// Router-facing variant that records an explicit launcher address, since msg.sender
    /// on the CurveFactory side is Router — not the human triggering `launch`.
    function createCurveWithConfigFor(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve);
    function defaultCurveSupply() external view returns (uint256);
    /// Address of the Graduator the CurveFactory hands its curves off to. Router reads
    /// this to allowlist the graduator + its downstream PoolManager on the launched
    /// token's per-module gates.
    function graduator() external view returns (address);
}

interface IGraduatorLike {
    function poolManager() external view returns (address);
}

interface IERC20Like {
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

interface ILoyaltyOracleLike {
    function discountBpsFor(
        address holder
    ) external view returns (uint16);
}

/// @notice Called by Router to deploy the actual token contract. Every base-type factory
///         (`ERC20Factory`, `ERC721AFactory`, `ERC1155Factory`) implements this.
interface IVMFactory {
    function deploy(
        string calldata name,
        string calldata ticker,
        bytes32 configHash,
        bytes calldata initData,
        address launcher
    ) external returns (address token);
}

/// @notice Minimal ownership interface. Every launched token must implement it — either via
///         Solady `Ownable` (default) or a compatible surface. Router calls this after the
///         factory returns; template contracts have Router set as owner at initialize time.
interface IOwnable {
    function transferOwnership(
        address newOwner
    ) external;
    function renounceOwnership() external;
}

/// @notice Per-module allowlist / exclusion setters that Router calls best-effort right after
///         installing a bonding curve. Modules gate transfers by allowlist (AntiBot) or per-tx
///         and per-wallet cap (AntiWhale); a curve holding the initial token supply and
///         transferring it to buyers on every buy is not on either list by default, so every
///         buy reverts. Router is still `owner()` at the point these fire (ownership dispatch
///         happens after), so the calls succeed for tokens that include the module and silently
///         no-op for tokens that don't.
interface IModuleAllowanceSetters {
    function setAntiBotAllowed(
        address who,
        bool allowed
    ) external;
    function setAntiWhaleExcluded(
        address who,
        bool excluded
    ) external;
}

/// Whitelist-aware CurveFactory entry. Only reached from the WL launch
/// entrypoints; separate from ICurveFactoryLike so the WL surface stays
/// scoped to those code paths.
interface ICurveFactoryWlLike {
    function createCurveWithConfigForWl(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        BondingCurve.WhitelistInit calldata wl
    ) external returns (address curve);
}

/// @title  Router
/// @notice User-facing entry to the launchpad. Collects the launch fee, dispatches to the correct
///         base-type factory, atomically reserves the name in `NameRegistry`, dispatches ownership
///         per the launcher's chosen mode, refunds any excess ETH, and emits `Launched`.
/// @dev    See docs/SPEC-router.md. `nonReentrant` on `launch`; owner is a multisig post-deploy;
///         `paused` is flagged as a censorship vector — mitigations documented in the SPEC.
///
///         Launch entrypoints (all four flatten into one contract as of 2026-07-31):
///           - `launch(params)` payable — ETH fee → `feeReceiver`
///           - `launchWithURU(params, uruAmount)` — pulls URU into `uruSink`, keeper
///             drains → ETH → `feeReceiver` out of band
///           - `launchWithWhitelist(params, wl)` payable — ETH-pay + WL-enabled curve
///           - `launchWithURUAndWhitelist(params, uruAmount, wl)` — URU-pay + WL curve
///
///         URU + WL surface is inert until the owner calls `setUruConfig(uru, uruSink)`
///         post-deploy. Before that the URU entrypoints revert `Router__UruUnconfigured`.
///         This lets local + unit tests instantiate Router with a 9-arg constructor and
///         skip URU setup entirely; production deploy calls the setter as one extra tx.
///
///         Prior to 2026-07-31 the URU + WL surface lived in a separate `RouterV2`
///         contract inheriting this one. Auditors kept asking why two files; the answer
///         (audit ergonomics on the split) never landed. Flattened into a single Router
///         contract. Any git history on `RouterV2.sol` from before that date is the
///         old superclass shape.
contract Router is Ownable, ReentrancyGuard {
    // ============================================================
    // Errors
    // ============================================================

    error Router__Paused();
    error Router__InsufficientFee(uint256 quoted, uint256 provided);
    error Router__FactoryUnset(BaseType base);
    error Router__EmptyName();
    error Router__EmptyTicker();
    error Router__ZeroAddress();
    error Router__DeployFailed();
    error Router__CurveFactoryUnset();
    error Router__CurveOnlyForERC20();
    /// The chosen module combination (identified by configHash) taxes transfers
    /// (e.g. FeeOnTransfer) and would drift the bonding-curve's accounting on every
    /// trade. Owner maintains the blacklist via `setCurveIncompatibleConfigHash`.
    error Router__CurveIncompatibleModule(bytes32 configHash);
    /// A configHash has no explicit module-count record. Post-fix, the Router
    /// fails CLOSED on any hash whose moduleCountConfigured[hash] is false,
    /// rather than treating a missing record as "zero modules" (which would
    /// silently under-bill add-on fees for a partially-registered hash).
    error Router__ModuleCountMissing(bytes32 configHash);
    /// A configHash has no explicit flags record. Post-fix, the Router fails
    /// CLOSED on any hash whose flagsConfigured[hash] is false, rather than
    /// treating a missing record as "no restricted behavior" (which would
    /// silently allow a balance-mutating impl to be paired with a bonding
    /// curve if the owner had registered the impl on the factory but not
    /// yet called setFlagsForConfig on the Router).
    error Router__FlagsMissing(bytes32 configHash);
    /// URU-pay entrypoint called before the owner ran `setUruConfig`. Live
    /// deploy sets URU immediately; tests can construct Router without URU
    /// and only reach this error if they try to use URU-pay paths without
    /// wiring up the setter first.
    error Router__UruUnconfigured();
    /// URU-pay call with zero amount. Distinct from `Router__InsufficientUru`
    /// so hand-crafted-tx debugging is unambiguous.
    error Router__ZeroURU();
    /// WL variants require `installBondingCurve = true` — there's no curve to
    /// whitelist otherwise.
    error Router__WlRequiresBondingCurve();
    /// URU-pay path — caller didn't approve enough URU to meet the on-chain
    /// minimum (`minUruFee` with loyalty discount applied).
    error Router__InsufficientUru(uint256 required, uint256 provided);
    /// setUruConfig rejected: the passed sink address has no deployed code.
    /// EOAs, unset addresses, and to-be-deployed addresses all fail this
    /// check; the sink must exist on-chain before Router can point at it.
    error Router__UruSinkNoCode(address uruSink);
    /// setUruConfig rejected: the passed sink's `uru()` immutable does not
    /// match the URU token address being wired. Prevents Router forwarding
    /// deposits into a sink that can't process the token (would otherwise
    /// silently strand every URU launch fee).
    error Router__UruSinkTokenMismatch(address expectedUru, address sinkUru);
    /// Launch through a configHash the owner has explicitly banned. Used to
    /// permanently retire a compromised or obsolete impl at a specific hash
    /// without needing a Router redeploy. Setter is `setConfigHashBanned`.
    /// All four launch entrypoints check this bit before any other work, so
    /// banning a hash reverts ETH, URU, WL, and URU+WL launches uniformly.
    error Router__ConfigHashBanned(bytes32 configHash);

    // ============================================================
    // Events
    // ============================================================

    event Launched(
        address indexed token,
        address indexed launchedBy,
        BaseType indexed base,
        bytes32 nameHash,
        bytes32 tickerHash,
        uint256 feePaid,
        bool installedHook,
        bool installedGovernance
    );
    event FactorySet(BaseType indexed base, address indexed factory);
    event FeeSet(BaseType indexed base, uint256 weiAmount);
    event AddOnFeesSet(uint256 moduleAddOn, uint256 hookAddOn, uint256 governanceAddOn);
    event PausedSet(bool paused);
    event Swept(address indexed to, uint256 amount);
    event CurveFactorySet(address indexed factory);
    event CurveInstalled(address indexed token, address indexed curve);
    event LoyaltyOracleSet(address indexed oracle);
    event LoyaltyDiscountApplied(address indexed launcher, uint256 grossFee, uint256 discountBps, uint256 netFee);
    event CurveIncompatibleConfigHashSet(bytes32 indexed configHash, bool blocked);
    event ModuleCountForConfigSet(bytes32 indexed configHash, uint256 count);
    event FlagsForConfigSet(bytes32 indexed configHash, uint256 flags);

    /// Paired 1:1 with the standard `Launched` event; joins on `token`.
    /// `Launched.feePaid` is 0 on URU launches — indexers should read
    /// `uruPaid` from here for those.
    event LaunchedInURU(address indexed token, address indexed launchedBy, uint256 uruPaid);
    event UruConfigSet(address indexed uru, address indexed uruSink);
    event MinUruFeeSet(uint256 amount);
    event ConfigHashBanned(bytes32 indexed configHash, bool banned);

    /// Emitted alongside `Launched` when a whitelist-enabled curve is
    /// created. Same launch = same `token` topic across `Launched`,
    /// `LaunchedInURU` (if URU-paid), and `LaunchedWithWhitelist` (if
    /// WL-enabled). Indexers stitch on `token`.
    event LaunchedWithWhitelist(
        address indexed token,
        address indexed launchedBy,
        bytes32 whitelistRoot,
        uint256 reservedTokens,
        uint256 maxWlPerAddress,
        uint64 fallbackTs,
        address sourceTokenAddress,
        uint32 sourceChainId
    );

    // ============================================================
    // Immutable state
    // ============================================================

    NameRegistry public immutable registry;
    IFeeReceiver public immutable feeReceiver;

    // ============================================================
    // Mutable state
    // ============================================================

    mapping(BaseType => address) public factories;
    mapping(BaseType => uint256) public fees;
    uint256 public moduleAddOnFee;
    uint256 public hookAddOnFee;
    uint256 public governanceAddOnFee;
    address public curveFactory;
    address public loyaltyOracle;
    bool public paused;
    /// configHash values that MUST NOT be installed alongside a bonding curve.
    /// Populated by the owner post-deploy for every FeeOnTransfer / rebasing /
    /// balance-mutating module combination that would drift the curve's
    /// tokenReserve vs actual balance. The frontend also blocks these combos —
    /// the on-chain check is defense against hand-crafted txs bypassing the UI.
    mapping(bytes32 => bool) public curveIncompatibleConfigHash;
    /// Authoritative module count per configHash, set by the owner at impl
    /// registration time. Replaces the caller-controlled `params.moduleCount`
    /// which was previously trusted in fee computation — a launcher could
    /// pass moduleCount=1 for a 5-module config and underpay the module
    /// add-on fee. Now the Router looks up the real count here.
    /// Zero-value fallback: a hash not yet registered is treated as 0
    /// modules, matching the historical params.moduleCount=0 semantic in
    /// _quote (extras = max(count-1, 0)). Owner must register real counts
    /// for every launched configHash for the fee to bill correctly.
    mapping(bytes32 => uint256) public moduleCountForConfig;
    /// Fail-closed sentinel paired with moduleCountForConfig — set to true by
    /// the setter regardless of the count value (even count=0 is a legitimate
    /// explicit configuration, e.g. bare-base tokens). Zero cannot double as
    /// "unregistered marker" because it's also a valid count. Without this
    /// sentinel, a hash with impl registered on the factory but no Router
    /// count-record would silently bill baseFee only.
    mapping(bytes32 => bool) public moduleCountConfigured;
    /// Structural per-config flags set by the owner at registration time.
    /// FLAG_BALANCE_MUTATING is set for any impl whose module set includes
    /// a transfer-tax / rebasing / balance-drifting behavior (currently
    /// just FeeOnTransfer). The Router install path rejects a curve
    /// installation for any config carrying that flag — replaces the
    /// hand-maintained `curveIncompatibleConfigHash` denylist as an
    /// authoritative, structural boundary. The denylist stays as a
    /// belt-and-braces fallback for anything the flags miss.
    mapping(bytes32 => uint256) public flagsForConfig;
    /// Fail-closed sentinel paired with flagsForConfig — flags=0 is a
    /// legitimate value ("no restricted behavior") so we can't infer
    /// "unregistered" from zero alone. Owner MUST call setFlagsForConfig
    /// for every hash — even to explicitly declare "flags = 0" — before
    /// that hash becomes launchable.
    mapping(bytes32 => bool) public flagsConfigured;
    uint256 internal constant FLAG_BALANCE_MUTATING = 1 << 0;

    /// Owner-controlled block-list of configHashes that are permanently
    /// forbidden from launching through this Router — regardless of ETH,
    /// URU, or whitelist path. Introduced 2026-08-01 after audit round 2
    /// showed that the earlier count-poison mitigation (setting
    /// moduleCountForConfig to type(uint256).max) only blocked the ETH
    /// path (which routes through _quote and overflows). URU + WL paths
    /// bypass _quote entirely and were still exploitable through retired
    /// impls whose bytecode remains permanently pinned to the factory
    /// (registerImpl is one-shot; updateImpl was removed by M-1 audit fix).
    /// The banning check runs earliest in every launch entrypoint so a
    /// banned hash cannot deploy under any pricing path.
    mapping(bytes32 => bool) public bannedConfigHash;

    /// URU token + sink for the URU-pay entrypoints. Both start at address(0);
    /// the owner wires them via `setUruConfig(uru_, uruSink_)` post-deploy.
    /// Kept mutable rather than immutable so a fresh Router can be deployed
    /// against a chain that doesn't yet have URU (tests, base chain rollout)
    /// and still be operational for ETH launches. URU-pay entrypoints guard
    /// on `address(uru) == 0` and revert `Router__UruUnconfigured`.
    IERC20Like public uru;
    UruDepositSink public uruSink;
    /// Minimum URU (18 decimals) the caller must approve to launch via a URU
    /// entrypoint. Zero (default) leaves the URU path wide open. Post-deploy
    /// the owner sets a sensible floor — the frontend already quotes fair
    /// ETH-equivalent, this is a hand-crafted-tx spam gate. Loyalty discount
    /// applies to this floor exactly like the ETH path.
    uint256 public minUruFee;
    /// Belt-and-braces cap that Router locally enforces on any discount returned
    /// by the loyalty oracle. Matches LoyaltyOracle.HARD_MAX_DISCOUNT_BPS (8000
    /// = 80%). If the oracle is ever swapped for a broken impl that returns
    /// higher bps, Router still charges at least 20% of the gross fee — no
    /// accidental free launches.
    uint16 internal constant MAX_LOYALTY_DISCOUNT_BPS = 8000;

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address initialOwner,
        NameRegistry _registry,
        IFeeReceiver _feeReceiver,
        uint256 erc20Fee_,
        uint256 nftFee_,
        uint256 erc1155Fee_,
        uint256 moduleAddOn_,
        uint256 hookAddOn_,
        uint256 governanceAddOn_
    ) {
        if (address(_registry) == address(0) || address(_feeReceiver) == address(0)) {
            revert Router__ZeroAddress();
        }
        _initializeOwner(initialOwner);
        registry = _registry;
        feeReceiver = _feeReceiver;

        fees[BaseType.ERC20] = erc20Fee_;
        fees[BaseType.ERC721A] = nftFee_;
        fees[BaseType.ERC1155] = erc1155Fee_;
        moduleAddOnFee = moduleAddOn_;
        hookAddOnFee = hookAddOn_;
        governanceAddOnFee = governanceAddOn_;

        emit FeeSet(BaseType.ERC20, erc20Fee_);
        emit FeeSet(BaseType.ERC721A, nftFee_);
        emit FeeSet(BaseType.ERC1155, erc1155Fee_);
        emit AddOnFeesSet(moduleAddOn_, hookAddOn_, governanceAddOn_);
    }

    // ============================================================
    // Public
    // ============================================================

    /// @notice Launch a new token. Payable — fee is `quote(params)` in wei.
    /// @dev    Ordering: fee forward → factory.deploy → registry.reserve → ownership dispatch →
    ///         refund → emit. Reverts on any failure and unwinds the whole tx.
    function launch(
        LaunchParams calldata params
    ) external payable nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (bannedConfigHash[params.configHash]) revert Router__ConfigHashBanned(params.configHash);

        uint256 fee = _quoteFor(params, msg.sender);
        if (msg.value < fee) revert Router__InsufficientFee(fee, msg.value);

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);

        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        // Interactions.
        feeReceiver.receiveFee{value: fee}(msg.sender, params.base);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // Bonding-curve install runs BEFORE ownership dispatch so Router still holds the
        // curve-supply tokens (as initialRecipient) and can approve the factory. UI sets
        // initialRecipient = address(Router) and initialSupply = curveFactory.defaultCurveSupply()
        // when this flag is on; approve is exact-amount so Router keeps zero balance after.
        if (params.installBondingCurve) {
            if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
            if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
            // Hard-block combos that would drift the curve's accounting. FoT / rebasing /
            // any transfer-taxing module mints a token whose actual balance never matches
            // the arithmetic reserve — every trade priced against phantom liquidity until
            // safeTransfer eventually reverts and bricks the curve.
            if (_isCurveIncompatible(params.configHash)) {
                revert Router__CurveIncompatibleModule(params.configHash);
            }
            uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
            IERC20Like(token).approve(curveFactory, supply);
            // Pass msg.sender explicitly — otherwise CurveFactory would record Router as
            // the launcher, and the post-graduation v4 pool would route the creator
            // share to Router (which can't claim) instead of the actual EOA.
            address curve = ICurveFactoryLike(curveFactory)
                .createCurveWithConfigFor(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender);
            emit CurveInstalled(token, curve);
            _grantCurveModuleAllowances(token, curve);
        }

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            SafeTransferLib.safeTransferETH(msg.sender, refund);
        }

        emit Launched(
            token, msg.sender, params.base, nameHash, tickerHash, fee, params.installHook, params.installGovernance
        );
    }

    /// @notice Preview the fee for a given config. Matches what `launch` charges exactly.
    function quote(
        LaunchParams calldata params
    ) external view returns (uint256) {
        return _quote(params);
    }

    /// @notice Quote for a specific launcher, applying any LoyaltyOracle discount.
    ///         Frontend calls this to preview the ACTUAL fee a user will be charged.
    function quoteFor(
        LaunchParams calldata params,
        address launcher
    ) external view returns (uint256) {
        return _quoteFor(params, launcher);
    }

    /// @notice View for frontends to render the effective URU floor a specific
    ///         wallet would need. Applies the same loyalty discount as the ETH
    ///         path so URU quotes reflect the wallet's holdings.
    function minUruFeeFor(
        address launcher
    ) external view returns (uint256) {
        return _minUruFeeFor(launcher);
    }

    // ============================================================
    // URU-pay + whitelisted-curve launch entrypoints
    // ============================================================

    /// @notice Launch a new token by paying the deploy fee in URU. Caller must
    ///         have approved this Router for at least `uruAmount` of URU first.
    ///         Non-payable — attach zero ETH.
    /// @dev    Mirrors `launch()` — factory dispatch, registry reserve, curve
    ///         install, ownership dispatch — but the fee leg pulls URU into
    ///         `uruSink`. Keeper drains sink → ETH → `feeReceiver` out of band.
    function launchWithURU(
        LaunchParams calldata params,
        uint256 uruAmount
    ) external nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (bannedConfigHash[params.configHash]) revert Router__ConfigHashBanned(params.configHash);
        if (address(uru) == address(0) || address(uruSink) == address(0)) revert Router__UruUnconfigured();
        if (uruAmount == 0) revert Router__ZeroURU();
        // On-chain URU floor with loyalty discount applied — same discount rate
        // as the ETH path so a holder isn't worse off in URU.
        uint256 required = _minUruFeeFor(msg.sender);
        if (uruAmount < required) revert Router__InsufficientUru(required, uruAmount);

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        // Interactions.
        // Pull URU from user directly into the sink — user must have approved THIS Router.
        // Any excess above the "quoted" ETH-equivalent stays in the sink; the flywheel
        // just gets slightly more. No per-user refund on the URU path.
        SafeTransferLib.safeTransferFrom(address(uru), msg.sender, address(uruSink), uruAmount);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // Same bonding-curve install as parent Router.launch. Router still holds the
        // curve-supply tokens (as initialRecipient) and can approve the factory.
        if (params.installBondingCurve) {
            if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
            if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
            // FoT / rebasing / balance-mutating configs would drift the curve's
            // arithmetic reserve vs actual balance. Mirror the block that
            // `launch` has — was missing on this URU-pay path in the V2
            // superclass, making the blacklist bypassable via hand-crafted calls.
            if (_isCurveIncompatible(params.configHash)) {
                revert Router__CurveIncompatibleModule(params.configHash);
            }
            uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
            IERC20Like(token).approve(curveFactory, supply);
            address curve = ICurveFactoryLike(curveFactory)
                .createCurveWithConfigFor(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender);
            emit CurveInstalled(token, curve);
            _grantCurveModuleAllowances(token, curve);
        }

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        // Standard Launched event with feePaid = 0 (no ETH), plus paired URU event.
        _emitLaunched(token, msg.sender, params.base, nameHash, tickerHash, 0, params);
        emit LaunchedInURU(token, msg.sender, uruAmount);
    }

    /// @notice Launch a new token with a whitelisted bonding curve, paying the
    ///         launch fee in ETH. Same flow as `launch` but installs the curve
    ///         via the whitelist-aware factory entry, binding a Merkle root +
    ///         reserved slice.
    /// @dev    Requires `params.installBondingCurve = true`.
    function launchWithWhitelist(
        LaunchParams calldata params,
        BondingCurve.WhitelistInit calldata wl
    ) external payable nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (bannedConfigHash[params.configHash]) revert Router__ConfigHashBanned(params.configHash);
        if (!params.installBondingCurve) revert Router__WlRequiresBondingCurve();

        uint256 fee = _quoteFor(params, msg.sender);
        if (msg.value < fee) revert Router__InsufficientFee(fee, msg.value);

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        feeReceiver.receiveFee{value: fee}(msg.sender, params.base);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // WL curve install — only structural difference from the standard launch flow.
        if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
        if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
        if (_isCurveIncompatible(params.configHash)) {
            revert Router__CurveIncompatibleModule(params.configHash);
        }
        uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
        IERC20Like(token).approve(curveFactory, supply);
        address curve = ICurveFactoryWlLike(curveFactory)
            .createCurveWithConfigForWl(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender, wl);
        emit CurveInstalled(token, curve);
        _grantCurveModuleAllowances(token, curve);

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        uint256 refund = msg.value - fee;
        if (refund > 0) SafeTransferLib.safeTransferETH(msg.sender, refund);

        _emitLaunched(token, msg.sender, params.base, nameHash, tickerHash, fee, params);
        _emitLaunchedWithWhitelist(token, msg.sender, wl);
    }

    /// @notice URU-pay variant of `launchWithWhitelist`.
    function launchWithURUAndWhitelist(
        LaunchParams calldata params,
        uint256 uruAmount,
        BondingCurve.WhitelistInit calldata wl
    ) external nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (bannedConfigHash[params.configHash]) revert Router__ConfigHashBanned(params.configHash);
        if (address(uru) == address(0) || address(uruSink) == address(0)) revert Router__UruUnconfigured();
        if (uruAmount == 0) revert Router__ZeroURU();
        uint256 required = _minUruFeeFor(msg.sender);
        if (uruAmount < required) revert Router__InsufficientUru(required, uruAmount);
        if (!params.installBondingCurve) revert Router__WlRequiresBondingCurve();

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        SafeTransferLib.safeTransferFrom(address(uru), msg.sender, address(uruSink), uruAmount);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
        if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
        if (_isCurveIncompatible(params.configHash)) {
            revert Router__CurveIncompatibleModule(params.configHash);
        }
        uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
        IERC20Like(token).approve(curveFactory, supply);
        address curve = ICurveFactoryWlLike(curveFactory)
            .createCurveWithConfigForWl(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender, wl);
        emit CurveInstalled(token, curve);
        _grantCurveModuleAllowances(token, curve);

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        _emitLaunched(token, msg.sender, params.base, nameHash, tickerHash, 0, params);
        emit LaunchedInURU(token, msg.sender, uruAmount);
        _emitLaunchedWithWhitelist(token, msg.sender, wl);
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================

    function setFactory(
        BaseType base,
        address factory
    ) external onlyOwner {
        if (factory == address(0)) revert Router__ZeroAddress();
        factories[base] = factory;
        emit FactorySet(base, factory);
    }

    function setCurveFactory(
        address factory
    ) external onlyOwner {
        if (factory == address(0)) revert Router__ZeroAddress();
        curveFactory = factory;
        emit CurveFactorySet(factory);
    }

    /// @notice Set the LoyaltyOracle used to apply launch-fee discounts to holders of
    ///         URU + urufu gemu NFTs. Zero disables discounts.
    function setLoyaltyOracle(
        address oracle
    ) external onlyOwner {
        loyaltyOracle = oracle;
        emit LoyaltyOracleSet(oracle);
    }

    /// @notice Mark a configHash as incompatible with the bonding-curve install
    ///         path. Owner maintains this blacklist for every FoT / rebasing /
    ///         balance-mutating module combination. `installBondingCurve = true`
    ///         reverts with `Router__CurveIncompatibleModule` when the launcher's
    ///         chosen configHash is blocked.
    function setCurveIncompatibleConfigHash(
        bytes32 configHash,
        bool blocked
    ) external onlyOwner {
        curveIncompatibleConfigHash[configHash] = blocked;
        emit CurveIncompatibleConfigHashSet(configHash, blocked);
    }

    /// Register the authoritative module count for a configHash. Called by
    /// the owner once per launched configHash — usually right after the
    /// corresponding factory.registerImpl() call. Once set, the Router uses
    /// this value for fee calculation instead of trusting the caller.
    function setModuleCountForConfig(
        bytes32 configHash,
        uint256 count
    ) external onlyOwner {
        moduleCountForConfig[configHash] = count;
        moduleCountConfigured[configHash] = true;
        emit ModuleCountForConfigSet(configHash, count);
    }

    /// Batch variant for the initial post-deploy population when N configs
    /// need to be registered in a single tx.
    function setModuleCountForConfigBatch(
        bytes32[] calldata configHashes,
        uint256[] calldata counts
    ) external onlyOwner {
        if (configHashes.length != counts.length) revert Router__ZeroAddress();
        for (uint256 i = 0; i < configHashes.length; ++i) {
            moduleCountForConfig[configHashes[i]] = counts[i];
            moduleCountConfigured[configHashes[i]] = true;
            emit ModuleCountForConfigSet(configHashes[i], counts[i]);
        }
    }

    /// Set the flag bitset for a configHash. Owner sets FLAG_BALANCE_MUTATING
    /// for any impl that mutates transferred amounts (FoT / rebasing) so the
    /// install path automatically rejects a curve pairing.
    function setFlagsForConfig(
        bytes32 configHash,
        uint256 flags
    ) external onlyOwner {
        flagsForConfig[configHash] = flags;
        flagsConfigured[configHash] = true;
        emit FlagsForConfigSet(configHash, flags);
    }

    function setFlagsForConfigBatch(
        bytes32[] calldata configHashes,
        uint256[] calldata flags
    ) external onlyOwner {
        if (configHashes.length != flags.length) revert Router__ZeroAddress();
        for (uint256 i = 0; i < configHashes.length; ++i) {
            flagsForConfig[configHashes[i]] = flags[i];
            flagsConfigured[configHashes[i]] = true;
            emit FlagsForConfigSet(configHashes[i], flags[i]);
        }
    }

    function setFee(
        BaseType base,
        uint256 weiAmount
    ) external onlyOwner {
        fees[base] = weiAmount;
        emit FeeSet(base, weiAmount);
    }

    function setAddOnFees(
        uint256 module_,
        uint256 hook_,
        uint256 governance_
    ) external onlyOwner {
        moduleAddOnFee = module_;
        hookAddOnFee = hook_;
        governanceAddOnFee = governance_;
        emit AddOnFeesSet(module_, hook_, governance_);
    }

    function setPaused(
        bool p
    ) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Recover ETH stranded in Router (should be effectively never called).
    function sweepStuckETH(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert Router__ZeroAddress();
        uint256 amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    /// @notice Owner wires up URU-pay support. Both `uru_` and `uruSink_` must
    ///         be non-zero. Callable multiple times if URU or sink ever needs
    ///         to be rotated (they stay mutable for that reason). Until this
    ///         is called at least once, every URU entrypoint reverts.
    function setUruConfig(
        address uru_,
        address uruSink_
    ) external onlyOwner {
        if (uru_ == address(0) || uruSink_ == address(0)) revert Router__ZeroAddress();
        // Sink must be a live contract. Blocks EOAs and unset addresses that
        // would silently accept the transferFrom + leave URU stranded.
        if (uruSink_.code.length == 0) revert Router__UruSinkNoCode(uruSink_);
        // Sink's own `uru` immutable must match the token we're wiring. A
        // mismatched pair pushes URU into a sink whose keeper flow was built
        // for a different token, stranding every deposit until manual recovery.
        address sinkUru = address(UruDepositSink(payable(uruSink_)).uru());
        if (sinkUru != uru_) revert Router__UruSinkTokenMismatch(uru_, sinkUru);
        uru = IERC20Like(uru_);
        uruSink = UruDepositSink(payable(uruSink_));
        emit UruConfigSet(uru_, uruSink_);
    }

    /// @notice Owner permanently bans (or un-bans) a configHash from all four
    ///         launch entrypoints. Once true, `launch`, `launchWithURU`,
    ///         `launchWithWhitelist`, and `launchWithURUAndWhitelist` all
    ///         revert with `Router__ConfigHashBanned(hash)` for that hash.
    ///
    ///         Use this to retire a compromised or obsolete impl at a
    ///         specific hash without redeploying Router. Prior to this
    ///         mechanism the only options were pausing the whole Router or
    ///         setting `moduleCountForConfig` to a value that overflows the
    ///         fee-quote math — the latter only blocked the ETH path (URU
    ///         and WL bypass `_quote`), which is the exact hole that
    ///         motivated adding this mapping.
    function setConfigHashBanned(
        bytes32 configHash,
        bool banned
    ) external onlyOwner {
        bannedConfigHash[configHash] = banned;
        emit ConfigHashBanned(configHash, banned);
    }

    /// @notice Owner sets the URU-side minimum fee (18 decimals). Applies to
    ///         both launchWithURU and launchWithURUAndWhitelist. Zero disables
    ///         the floor.
    function setMinUruFee(
        uint256 amount
    ) external onlyOwner {
        minUruFee = amount;
        emit MinUruFeeSet(amount);
    }

    // ============================================================
    // Internal
    // ============================================================

    /// Consolidates the curve-incompatibility check. A config is incompatible
    /// with a bonding curve if EITHER:
    ///   - it carries the structural FLAG_BALANCE_MUTATING bit (any transfer-
    ///     mutating module in the set — set by the owner at registration
    ///     time; primary line of defense), OR
    ///   - the owner has manually blacklisted it via
    ///     curveIncompatibleConfigHash (belt-and-braces fallback for anything
    ///     the flag missed).
    /// Callers use this in place of the raw mapping check so future
    /// mutability-mutating module types automatically flow through the flag
    /// path once registered.
    function _isCurveIncompatible(
        bytes32 configHash
    ) internal view returns (bool) {
        // Fail closed: launch flows that reach this check must have gone
        // through owner-declared flags. If flagsConfigured is false the
        // hash was never explicitly reviewed for balance-mutation risk;
        // treating that as "compatible by default" reopens the exact
        // exploit fix #5 was meant to close (attacker races between
        // impl registration and Router.setFlagsForConfig).
        if (!flagsConfigured[configHash]) revert Router__FlagsMissing(configHash);
        if ((flagsForConfig[configHash] & FLAG_BALANCE_MUTATING) != 0) return true;
        return curveIncompatibleConfigHash[configHash];
    }

    function _quote(
        LaunchParams calldata params
    ) internal view returns (uint256) {
        uint256 baseFee = fees[params.base];
        // Fail closed: an unregistered hash reverts here rather than billing
        // baseFee only. Previously the "factory will reject anyway" fallback
        // was OK as a defense in depth, but the auditor showed that between
        // ERC20Factory.registerImpl (registrar-role) and Router.setModuleCountForConfig
        // (owner-role) there's a real window where a launcher could pay
        // baseFee for an N-module hash and succeed. Fail-closed here blocks
        // that regardless of factory state.
        if (!moduleCountConfigured[params.configHash]) revert Router__ModuleCountMissing(params.configHash);
        uint256 registeredCount = moduleCountForConfig[params.configHash];
        uint256 extraModules = registeredCount > 0 ? registeredCount - 1 : 0;
        return baseFee + moduleAddOnFee * extraModules + (params.installHook ? hookAddOnFee : 0)
            + (params.installGovernance ? governanceAddOnFee : 0);
    }

    /// @dev Applies LoyaltyOracle discount when configured. LoyaltyOracle enforces
    ///      HARD_MAX_DISCOUNT_BPS = 8000 internally; Router clamps to the same
    ///      MAX_LOYALTY_DISCOUNT_BPS as a local defense so a misconfigured or
    ///      swapped-in oracle can't drop the fee below 20% of gross even if it
    ///      returns 9999.
    function _quoteFor(
        LaunchParams calldata params,
        address launcher
    ) internal view returns (uint256) {
        uint256 gross = _quote(params);
        return gross - (gross * _discountBpsFor(launcher)) / 10_000;
    }

    /// Reads the loyalty oracle and clamps the returned bps to Router's local
    /// max. Returns 0 (no discount) when the oracle isn't wired.
    function _discountBpsFor(
        address launcher
    ) internal view returns (uint16 discountBps) {
        address oracle = loyaltyOracle;
        if (oracle == address(0) || launcher == address(0)) return 0;
        discountBps = ILoyaltyOracleLike(oracle).discountBpsFor(launcher);
        if (discountBps > MAX_LOYALTY_DISCOUNT_BPS) discountBps = MAX_LOYALTY_DISCOUNT_BPS;
    }

    function _dispatchOwnership(
        address token,
        OwnershipMode mode,
        address target,
        address launcher
    ) internal {
        IOwnable ownable = IOwnable(token);
        if (mode == OwnershipMode.Renounce) {
            ownable.renounceOwnership();
        } else if (mode == OwnershipMode.TransferToMultisig) {
            ownable.transferOwnership(target);
        } else {
            // KeepEOA
            ownable.transferOwnership(launcher);
        }
    }

    /// Best-effort: allow every contract that will legitimately move the launched
    /// token during the full lifecycle — curve buys, graduation, post-grad pool
    /// operations — to bypass the launched token's per-module transfer gates.
    ///
    /// The gates AntiBot / AntiWhale otherwise reject:
    ///   - `curve.buy() → token.transfer(curve, buyer, N)`   (AntiBot: buyer not allowlisted;
    ///                                                        template check now bypasses if
    ///                                                        `from` is allowlisted too so
    ///                                                        allowlisting the curve is enough)
    ///   - `Graduator.execute → transferFrom(curve, grad, ~800M)` (AntiWhale: 800M > maxTx)
    ///   - `Graduator.unlockCallback → transfer(grad, pm, ~800M)` (AntiWhale: same, from
    ///                                                             becomes graduator)
    ///
    /// We allowlist:
    ///   1. The bonding curve — from-side of every buy + source of graduation transferFrom.
    ///   2. The Graduator — from-side of the transfer INTO the PoolManager during graduation.
    ///   3. The PoolManager — to-side of that transfer + from-side of any post-grad routing.
    ///
    /// Every call is try/catch'd: tokens without the module revert with an unknown
    /// selector, which we swallow (bare ERC20 → no-op). Router is still `owner()`
    /// at this point (ownership dispatch fires after), so the setters succeed for
    /// tokens that DO have the module. Called only when `installBondingCurve` is on.
    ///
    /// Pausable is intentionally NOT auto-toggled: the module has no per-address
    /// exemption and unpausing would defeat the launcher's stated intent. Frontend
    /// warns launchers that Pausable + curve means pausing freezes trades.
    function _grantCurveModuleAllowances(
        address token,
        address curve
    ) internal {
        // Curve: full bypass on BOTH gates. Curve holds the initial supply and
        // moves hundreds of millions of tokens through curve buys + the
        // graduation transferFrom. Neither is bot-like OR whale-like — the
        // launcher chose this mechanic, so curve activity is exempt by design.
        _tryGrantBoth(token, curve);
        // Both external reads are best-effort. Mock CurveFactory / mock Graduator in
        // unit tests may not implement the getter — try/catch keeps launch working
        // for tokens without any module (which is when a mocked-out setup is used).
        address grad;
        try ICurveFactoryLike(curveFactory).graduator() returns (address g) {
            grad = g;
        } catch {}
        if (grad != address(0)) {
            // Graduator: full bypass on both gates. Same rationale — during
            // graduation the Graduator temporarily holds ~800M tokens on the
            // path from curve → v4 pool.
            _tryGrantBoth(token, grad);
            address pm;
            try IGraduatorLike(grad).poolManager() returns (address p) {
                pm = p;
            } catch {}
            if (pm != address(0)) {
                // PoolManager: AntiBot bypass ONLY. Graduation happens once,
                // during the anti-bot window, and moves large amounts INTO the
                // pool — needs AntiBot bypass to succeed. But every post-grad
                // v4 swap ALSO transits tokens through PoolManager for the
                // lifetime of the token; excluding PoolManager from AntiWhale
                // would silently defeat maxTx/maxWallet on the v4 lane while
                // still enforcing them for P2P transfers (v4 whales get a free
                // dump lane; honest users can't send to a friend). AntiWhale
                // callers accept that graduation itself must fit under maxTx
                // (docs already tell launchers to size caps sensibly).
                _tryGrantAntiBot(token, pm);
            }
        }
    }

    /// Both allowlists in one shot — used for curve + Graduator, addresses that
    /// legitimately move large amounts throughout the token lifecycle.
    function _tryGrantBoth(
        address token,
        address who
    ) internal {
        try IModuleAllowanceSetters(token).setAntiBotAllowed(who, true) {} catch {}
        try IModuleAllowanceSetters(token).setAntiWhaleExcluded(who, true) {} catch {}
    }

    /// AntiBot-only bypass — used for PoolManager so post-grad v4 swaps still
    /// respect the launcher's whale caps. Graduation transfers must be sized
    /// under maxTx by construction.
    function _tryGrantAntiBot(
        address token,
        address who
    ) internal {
        try IModuleAllowanceSetters(token).setAntiBotAllowed(who, true) {} catch {}
    }

    /// URU-side min-fee resolver with the launcher's loyalty discount applied.
    /// Used by both the on-chain guard (in launchWithURU) and the external view
    /// (`minUruFeeFor`) that the frontend calls to render quotes.
    function _minUruFeeFor(
        address launcher
    ) internal view returns (uint256) {
        uint256 floor = minUruFee;
        if (floor == 0) return 0;
        uint16 discountBps = _discountBpsFor(launcher);
        return floor - (floor * discountBps) / 10_000;
    }

    /// Extracted so all four launch entrypoints emit the same 8-arg `Launched`
    /// event without every outer function paying the stack cost of inlining.
    /// The extraction was originally forced by `forge coverage --ir-minimum`'s
    /// stack-too-deep threshold on the WL entrypoints; keeping it as one
    /// helper simplifies indexer schemas too (one code path emits it).
    function _emitLaunched(
        address token,
        address launcher,
        BaseType base,
        bytes32 nameHash,
        bytes32 tickerHash,
        uint256 feePaid,
        LaunchParams calldata params
    ) internal {
        emit Launched(
            token, launcher, base, nameHash, tickerHash, feePaid, params.installHook, params.installGovernance
        );
    }

    /// Extracted from both WL entrypoints for the same stack-too-deep reason
    /// as `_emitLaunched`. Struct read from calldata; no runtime cost beyond
    /// the extra JUMP.
    function _emitLaunchedWithWhitelist(
        address token,
        address launcher,
        BondingCurve.WhitelistInit calldata wl
    ) internal {
        emit LaunchedWithWhitelist(
            token,
            launcher,
            wl.root,
            wl.reservedTokens,
            wl.maxWlPerAddress,
            wl.fallbackTs,
            wl.sourceTokenAddress,
            wl.sourceChainId
        );
    }
}
