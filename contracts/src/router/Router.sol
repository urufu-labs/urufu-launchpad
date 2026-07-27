// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
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

/// @title  Router
/// @notice User-facing entry to the launchpad. Collects the launch fee, dispatches to the correct
///         base-type factory, atomically reserves the name in `NameRegistry`, dispatches ownership
///         per the launcher's chosen mode, refunds any excess ETH, and emits `Launched`.
/// @dev    See docs/SPEC-router.md. `nonReentrant` on `launch`; owner is a multisig post-deploy;
///         `paused` is flagged as a censorship vector — mitigations documented in the SPEC.
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
            if (curveIncompatibleConfigHash[params.configHash]) {
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

    // ============================================================
    // Internal
    // ============================================================

    function _quote(
        LaunchParams calldata params
    ) internal view returns (uint256) {
        uint256 baseFee = fees[params.base];
        uint256 extraModules = params.moduleCount > 0 ? params.moduleCount - 1 : 0;
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
}
