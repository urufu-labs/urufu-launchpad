// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 factory
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    DN404 launch factory. one tx deploys a paired ERC-20 + mirror
 *    ERC-721, skip-lists the (predicted) curve + fee splitter, then
 *    hands the supply to the existing CurveFactory. bypasses Router
 *    entirely, no CurveFactory rotation needed.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20 {
    function balanceOf(
        address who
    ) external view returns (uint256);
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

interface IInitializable {
    function initialize(
        bytes calldata data
    ) external;
}

interface ICurveFactoryLike {
    function implementation() external view returns (address);
    function predictCurveAddress(
        address token
    ) external view returns (address);
    function createCurveWithConfigFor(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve);
}

/// Dn404CurveFactory — same shape as ICurveFactoryLike but every
/// entrypoint takes an explicit `pairCurrency` arg. Route target for
/// non-ETH DN404 launches. See `contracts/src/dn404/Dn404CurveFactory.sol`.
interface IDn404CurveFactoryLike {
    function implementation() external view returns (address);
    function predictCurveAddress(
        address token
    ) external view returns (address);
    function createCurveWithConfigFor(
        address token,
        address pairCurrency,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve);
}

interface INftLaunchFactoryFee {
    function minUruFee() external view returns (uint256);
}

/// @title  Dn404LaunchFactory
/// @notice One-tx DN404 launch. Charges URU launch fee (loyalty-discounted),
///         clones base + mirror templates, initializes them atomically so
///         the mirror links before any transfer, then routes supply into
///         the existing V10 CurveFactory via createCurveWithConfigFor.
///
///         **Pre-flight ops requirement (one-time).** Before this factory
///         can launch, the CurveFactory owner MUST whitelist us as a
///         trusted router:
///
///             CurveFactory(0x...).setTrustedRouter(<this>, true);
///
///         Enables the explicit-launcher path so `launcher` on the resulting
///         curve is the actual EOA and not our factory address. No other
///         change to the curve stack is required.
///
/// @dev    Skip-list-first sequencing prevents NFT accumulation in the
///         curve contract at any point. Order:
///           1. Clone mirror + base
///           2. Predict curve address via CurveFactory.predictCurveAddress
///           3. base.initialize:
///                * mints full supply to `address(this)` (the factory)
///                * auto-skips factory (initialSupplyOwner)
///                * skip-lists predicted curve + feeSplitter EXPLICITLY
///                * links mirror atomically
///           4. Transfer founder pre-mint to launcher (auto-mints NFTs)
///           5. Approve + createCurveWithConfigFor on CurveFactory
///              → CurveFactory pulls remaining supply from factory to curve
///              → curve receives ERC-20 balance but skip-listed so no NFTs
///           6. Assert deployed curve == predicted curve (sanity)
///
///         URU fee floor is seeded at construction as 2× the current
///         NftLaunchFactory fee (SPEC decision #2). Owner can rotate later
///         via setUruConfig.
///
/// @dev    Owner (multisig) manages impl slots + URU config + curve/nft
///         factory references. Impl slots are one-shot (URU-A08 posture)
///         and code-hash pinned — matches NftLaunchFactory + Router
///         V10 stance. Rotation requires deploying a new factory; the
///         previous one keeps serving its already-launched pairs.
contract Dn404LaunchFactory is Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404LaunchFactory__ZeroAddress();
    error Dn404LaunchFactory__AlreadySet();
    error Dn404LaunchFactory__NotAContract();
    error Dn404LaunchFactory__CodeHashMismatch(bytes32 expected, bytes32 actual);
    error Dn404LaunchFactory__CodeHashNotPinned();
    error Dn404LaunchFactory__ImplsNotSet();
    error Dn404LaunchFactory__CurveFactoryNotSet();
    /// New for stock-pair: launcher passed a non-zero pairCurrency but
    /// the Dn404CurveFactory (which handles the non-ETH path) hasn't
    /// been wired via `setDn404CurveFactory` yet.
    error Dn404LaunchFactory__Dn404CurveFactoryNotSet();
    error Dn404LaunchFactory__NameEmpty();
    error Dn404LaunchFactory__TickerEmpty();
    error Dn404LaunchFactory__CollectionSizeZero();
    error Dn404LaunchFactory__UnitZero();
    error Dn404LaunchFactory__FounderPremintBpsTooHigh(uint256 bps, uint256 cap);
    error Dn404LaunchFactory__FounderPremintNftCountExceedsCap(uint256 count, uint256 cap);
    error Dn404LaunchFactory__TotalSupplyOverflow();
    error Dn404LaunchFactory__InsufficientUru(uint256 required, uint256 provided);
    error Dn404LaunchFactory__NameTaken();
    error Dn404LaunchFactory__CurveAddressMismatch(address expected, address actual);

    // ============================================================
    // Events
    // ============================================================
    event ImplsRegistered(address baseImpl, address mirrorImpl);
    event ExpectedCodeHashesSet(bytes32 baseHash, bytes32 mirrorHash);
    event UruConfigSet(address uru, address uruSink, uint256 minUruFee, address loyaltyOracle);
    event FeeSplitterSet(address feeSplitter);
    event CurveFactorySet(address curveFactory);
    event Dn404CurveFactorySet(address dn404CurveFactory);
    event NftFactoryRefSet(address nftFactory);
    event Dn404Launched(
        address indexed base,
        address indexed mirror,
        address indexed curve,
        address launcher,
        /// Pair currency the curve prices in. `address(0)` means ETH
        /// (routed through V10 CurveFactory); any other address is an
        /// allowlisted ERC-20 (routed through Dn404CurveFactory).
        /// Indexers use this to render trade-page prices in the right
        /// unit ("0.02 COST", "0.5 USDG", "0.001 ETH").
        address pairCurrency,
        bytes32 configHash,
        uint256 uruPaid,
        uint256 totalSupply,
        uint256 unit,
        uint256 founderPremint,
        string name,
        string ticker
    );

    // ============================================================
    // Constants
    // ============================================================
    /// SPEC decision #3: founder pre-mint capped at 20% so the curve still
    /// discovers real price. Cannot be raised via owner setter.
    uint256 public constant MAX_FOUNDER_PREMINT_BPS = 2000;

    /// Hard cap on NFTs auto-minted to the launcher during the launch tx.
    /// DN404 transfers cost O(n) gas per whole-unit transition (mint/burn
    /// of the mirror NFT), so a large founder pre-mint can OOG the launch
    /// tx. Launcher-visible: if their (collectionSize * founderPremintBps
    /// / 10_000) exceeds this cap, launch reverts with a specific error so
    /// they can either reduce founderPremintBps or increase unit.
    uint256 public constant MAX_PREMINT_NFT_COUNT = 100;

    /// DN404 stores totalSupply as uint96, so the wei value must fit in 96
    /// bits (2**96 - 1 ≈ 7.9e28). Reject any input that would overflow
    /// with a factory-side error before DN404 reverts with a less obvious
    /// TotalSupplyOverflow selector.
    uint256 private constant _MAX_TOTAL_SUPPLY_WEI = type(uint96).max;

    // ============================================================
    // Impl slots — set once via owner-only setters (URU-A08)
    // ============================================================
    address public baseImpl;
    address public mirrorImpl;
    bytes32 public expectedBaseHash;
    bytes32 public expectedMirrorHash;

    // ============================================================
    // URU fee wiring
    // ============================================================
    IERC20 public uru;
    address public uruSink;
    uint256 public minUruFee;
    ILoyaltyOracleLike public loyaltyOracle;

    address public feeSplitter;
    /// V10 CurveFactory reference. Handles the ETH-paired DN404 launches
    /// (pairCurrency == address(0)). Unchanged by pair-currency support —
    /// per feedback_dn404_no_erc20_touch.md, V10 stays untouched forever.
    ICurveFactoryLike public curveFactory;
    /// Dn404CurveFactory reference. Handles non-ETH DN404 launches
    /// (any allowlisted pair currency). Parallel deployment; V10 code
    /// path never sees this factory.
    IDn404CurveFactoryLike public dn404CurveFactory;

    /// Kept as a reference (not required at launch time) so future
    /// governance can re-seed the URU fee at 2× the NFT fee if the NFT
    /// fee moves. Read once at construction to compute the initial floor.
    address public nftFactory;

    // ============================================================
    // Name uniqueness — namespaced by launcher+name+ticker so two
    // different launchers can pick the same name.
    // ============================================================
    mapping(bytes32 => bool) public nameSaltTaken;

    // ============================================================
    // Constructor
    // ============================================================

    /// @param initialOwner Multisig / governance address for owner-only setters.
    /// @param nftFactory_  Existing NftLaunchFactory. Its `minUruFee` is
    ///                     read at construction and used to seed our floor
    ///                     at 2× that value (SPEC decision #2). Pass
    ///                     `address(0)` to leave the fee unset and rely
    ///                     on a post-deploy setUruConfig call.
    constructor(address initialOwner, address nftFactory_) {
        if (initialOwner == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        _initializeOwner(initialOwner);
        if (nftFactory_ != address(0)) {
            nftFactory = nftFactory_;
            uint256 nftFee = INftLaunchFactoryFee(nftFactory_).minUruFee();
            minUruFee = nftFee * 2;
            emit NftFactoryRefSet(nftFactory_);
        }
    }

    // ============================================================
    // Owner config — one-shot impls, rotatable fee params
    // ============================================================

    function setExpectedCodeHashes(
        bytes32 baseHash,
        bytes32 mirrorHash
    ) external onlyOwner {
        if (expectedBaseHash != bytes32(0)) revert Dn404LaunchFactory__AlreadySet();
        if (baseHash == bytes32(0) || mirrorHash == bytes32(0)) {
            revert Dn404LaunchFactory__CodeHashNotPinned();
        }
        expectedBaseHash = baseHash;
        expectedMirrorHash = mirrorHash;
        emit ExpectedCodeHashesSet(baseHash, mirrorHash);
    }

    function setImpls(
        address baseImpl_,
        address mirrorImpl_
    ) external onlyOwner {
        if (baseImpl != address(0)) revert Dn404LaunchFactory__AlreadySet();
        if (expectedBaseHash == bytes32(0)) revert Dn404LaunchFactory__CodeHashNotPinned();
        if (baseImpl_ == address(0) || mirrorImpl_ == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        if (baseImpl_.code.length == 0 || mirrorImpl_.code.length == 0) revert Dn404LaunchFactory__NotAContract();
        _requireCodeHash(baseImpl_, expectedBaseHash);
        _requireCodeHash(mirrorImpl_, expectedMirrorHash);
        baseImpl = baseImpl_;
        mirrorImpl = mirrorImpl_;
        emit ImplsRegistered(baseImpl_, mirrorImpl_);
    }

    function setUruConfig(
        IERC20 uru_,
        address uruSink_,
        uint256 minUruFee_,
        ILoyaltyOracleLike loyaltyOracle_
    ) external onlyOwner {
        if (address(uru_) == address(0) || uruSink_ == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        uru = uru_;
        uruSink = uruSink_;
        minUruFee = minUruFee_;
        loyaltyOracle = loyaltyOracle_;
        emit UruConfigSet(address(uru_), uruSink_, minUruFee_, address(loyaltyOracle_));
    }

    function setFeeSplitter(
        address feeSplitter_
    ) external onlyOwner {
        if (feeSplitter_ == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        feeSplitter = feeSplitter_;
        emit FeeSplitterSet(feeSplitter_);
    }

    function setCurveFactory(
        ICurveFactoryLike curveFactory_
    ) external onlyOwner {
        if (address(curveFactory_) == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        curveFactory = curveFactory_;
        emit CurveFactorySet(address(curveFactory_));
    }

    /// @notice Set the Dn404CurveFactory reference — required for
    ///         non-ETH pair-currency launches. Rotatable so governance
    ///         can point at a future Dn404 curve stack rev without
    ///         redeploying this factory. Existing launches unaffected
    ///         (each curve pins its own factory at creation).
    function setDn404CurveFactory(
        IDn404CurveFactoryLike dn404CurveFactory_
    ) external onlyOwner {
        if (address(dn404CurveFactory_) == address(0)) revert Dn404LaunchFactory__ZeroAddress();
        dn404CurveFactory = dn404CurveFactory_;
        emit Dn404CurveFactorySet(address(dn404CurveFactory_));
    }

    // ============================================================
    // Views
    // ============================================================

    function minUruFeeFor(
        address launcher
    ) external view returns (uint256) {
        return _minUruFeeFor(launcher);
    }

    /// @notice Preview the total ERC-20 supply that will be minted for the
    ///         given launch params. Frontend uses this for the live
    ///         "totalSupply = collectionSize * unit" preview on /create/dn404
    ///         so launchers don't have to do the math themselves.
    function previewTotalSupply(
        uint256 collectionSize,
        uint256 unit
    ) external pure returns (uint256) {
        return collectionSize * unit * 1e18;
    }

    // ============================================================
    // Launch
    // ============================================================

    /// User-facing launch params.
    struct LaunchParams {
        string name;
        string ticker;
        string baseURI;
        string contractURI;

        /// Number of NFTs in the paired mirror collection. Studio-derived
        /// (matches ERC-721 flow); no hard cap.
        uint256 collectionSize;

        /// Whole tokens required to hold one mirror NFT. Launcher's
        /// headline knob ("hold 10,000 $TICK, get an NFT"). Min 1.
        uint256 unit;

        /// 0..MAX_FOUNDER_PREMINT_BPS. Portion of totalSupply minted
        /// directly to the launcher's wallet at launch. Remainder goes
        /// to the curve as tradable supply.
        uint16 founderPremintBps;

        /// Curve hook config, forwarded to Graduator at graduation.
        uint32 antiSniperBlocks;
        uint16 buybackBurnBps;

        /// Pair currency for the curve.
        ///   `address(0)` — trade against ETH; routed through V10
        ///                  CurveFactory unchanged. Default choice for
        ///                  launches wanting the classic memecoin-vs-ETH
        ///                  bonding curve.
        ///   any ERC-20 — trade against that token (USDG, COST, NVDA...);
        ///                routed through Dn404CurveFactory, which
        ///                validates against Dn404PairCurrencyAllowlist.
        /// The launcher never touches the allowlist directly — passing
        /// an un-allowlisted address reverts inside Dn404CurveFactory
        /// with Dn404CurveFactory__PairCurrencyDisallowed.
        address pairCurrency;

        /// URU launch fee (on-chain recomputed + rejected if too low).
        uint256 uruAmount;
    }

    /// @notice Launch a full DN404 pair in one tx. Returns the base
    ///         ERC-20, the mirror ERC-721, and the freshly-created curve.
    function launch(
        LaunchParams calldata p
    ) external returns (address base, address mirror, address curve) {
        // -- 1. Sanity gates (fail fast before any state change).
        if (baseImpl == address(0)) revert Dn404LaunchFactory__ImplsNotSet();
        if (p.pairCurrency == address(0)) {
            // ETH path — V10 CurveFactory must be wired.
            if (address(curveFactory) == address(0)) revert Dn404LaunchFactory__CurveFactoryNotSet();
        } else {
            // Non-ETH path — Dn404CurveFactory must be wired. The
            // allowlist check happens inside Dn404CurveFactory itself
            // (Dn404CurveFactory__PairCurrencyDisallowed), so we don't
            // duplicate it here — one authoritative check point.
            if (address(dn404CurveFactory) == address(0)) revert Dn404LaunchFactory__Dn404CurveFactoryNotSet();
        }
        if (bytes(p.name).length == 0) revert Dn404LaunchFactory__NameEmpty();
        if (bytes(p.ticker).length == 0) revert Dn404LaunchFactory__TickerEmpty();
        if (p.collectionSize == 0) revert Dn404LaunchFactory__CollectionSizeZero();
        if (p.unit == 0) revert Dn404LaunchFactory__UnitZero();
        if (p.founderPremintBps > MAX_FOUNDER_PREMINT_BPS) {
            revert Dn404LaunchFactory__FounderPremintBpsTooHigh(p.founderPremintBps, MAX_FOUNDER_PREMINT_BPS);
        }

        // -- 2. Compute supplies (revert on overflow before touching state).
        //       Multiplication order matters for overflow-visibility: we
        //       do the (collectionSize * unit) product first because that
        //       is where the launcher-controlled math peaks.
        uint256 unitWei;
        uint256 totalSupplyWei;
        uint256 founderMintWei;
        uint256 premintNftCount;
        unchecked {
            // Guard `unit * 1e18` from overflow. `unit` is in whole tokens
            // (min 1); 1e18 fits comfortably, so this only fires on
            // pathological inputs.
            if (p.unit > type(uint256).max / 1e18) revert Dn404LaunchFactory__TotalSupplyOverflow();
            unitWei = p.unit * 1e18;
            // Guard `collectionSize * unitWei`. `collectionSize` is
            // launcher-controlled up to the DN404 cap; overflow here
            // means the launcher picked an infeasible size × unit combo.
            if (unitWei != 0 && p.collectionSize > type(uint256).max / unitWei) {
                revert Dn404LaunchFactory__TotalSupplyOverflow();
            }
            totalSupplyWei = p.collectionSize * unitWei;
        }
        if (totalSupplyWei > _MAX_TOTAL_SUPPLY_WEI) revert Dn404LaunchFactory__TotalSupplyOverflow();

        founderMintWei = (totalSupplyWei * p.founderPremintBps) / 10_000;
        premintNftCount = (p.collectionSize * p.founderPremintBps) / 10_000;
        if (premintNftCount > MAX_PREMINT_NFT_COUNT) {
            revert Dn404LaunchFactory__FounderPremintNftCountExceedsCap(premintNftCount, MAX_PREMINT_NFT_COUNT);
        }

        // -- 3. URU launch fee.
        uint256 required = _minUruFeeFor(msg.sender);
        if (p.uruAmount < required) revert Dn404LaunchFactory__InsufficientUru(required, p.uruAmount);
        if (p.uruAmount > 0) {
            SafeTransferLib.safeTransferFrom(address(uru), msg.sender, uruSink, p.uruAmount);
        }

        // -- 4. Name-salt uniqueness — namespaced by launcher.
        bytes32 saltKey = keccak256(abi.encode(msg.sender, p.name, p.ticker));
        if (nameSaltTaken[saltKey]) revert Dn404LaunchFactory__NameTaken();
        nameSaltTaken[saltKey] = true;

        // -- 5. Clone mirror first so its address is known for base.initialize.
        //       Both clones share saltKey with a domain separator so no
        //       cross-tenant collision is possible.
        mirror = LibClone.cloneDeterministic(mirrorImpl, keccak256(abi.encode(saltKey, "mirror")));
        base = LibClone.cloneDeterministic(baseImpl, keccak256(abi.encode(saltKey, "base")));

        // -- 6. Predict the curve address. Both CurveFactory variants
        //       use the same salt shape (keccak256(abi.encode(token,
        //       block.chainid))) and expose predictCurveAddress with
        //       the same signature, so we can dispatch to whichever
        //       factory this launch will land on and get the right
        //       predicted address. We use it to skip-list the curve
        //       BEFORE it receives a single wei.
        address predictedCurve = p.pairCurrency == address(0)
            ? curveFactory.predictCurveAddress(base)
            : dn404CurveFactory.predictCurveAddress(base);

        // -- 7. Initialize base. This ALSO links the mirror atomically
        //       via _initializeDN404 (calls mirror.linkMirrorContract in
        //       the same call), so there is no frontrunning window
        //       between clone + link.
        //
        //       initialSupplyOwner = address(this) — the factory receives
        //       the whole supply and hands off in step 8+9 below. DN404
        //       auto-skip-lists the initialSupplyOwner so no NFTs mint to
        //       the factory during the initial mint.
        {
            bytes memory initBase = abi.encode(
                msg.sender,       // launcher — sets Ownable owner, propagates to mirror via pullOwner
                mirror,           // paired mirror address
                predictedCurve,   // curve to skip-list explicitly
                feeSplitter,      // fee splitter to skip-list (may be zero for rehearsal launches)
                p.name,
                p.ticker,
                p.baseURI,
                p.contractURI,
                totalSupplyWei,
                unitWei
            );
            IInitializable(base).initialize(initBase);
        }

        // -- 8. Founder pre-mint. Transfer to launcher — NFTs auto-mint
        //       because launcher is NOT skip-listed. Cap enforced in
        //       step 2 above so this never OOGs the launch tx.
        if (founderMintWei > 0) {
            SafeTransferLib.safeTransfer(base, msg.sender, founderMintWei);
        }

        // -- 9. Hand remaining supply to the appropriate CurveFactory.
        //       Both factories pull IERC20(token).balanceOf(msg.sender) —
        //       our full remaining balance — so approve exactly that
        //       amount to whichever we route to and expect zero residue.
        uint256 curveSupply = totalSupplyWei - founderMintWei;
        if (p.pairCurrency == address(0)) {
            // ETH path — V10 CurveFactory. Existing wire from slice 5,
            // unchanged. `Dn404LaunchFactory` must already be on
            // CurveFactory.trustedRouters (ops setup).
            SafeTransferLib.safeApprove(base, address(curveFactory), curveSupply);
            curve = curveFactory.createCurveWithConfigFor(
                base,
                p.antiSniperBlocks,
                p.buybackBurnBps,
                msg.sender
            );
        } else {
            // Non-ETH path — Dn404CurveFactory. Passes pair currency;
            // Dn404CurveFactory validates against the allowlist before
            // deploying the curve. `Dn404LaunchFactory` must also be
            // on Dn404CurveFactory.trustedRouters (separate ops setup;
            // called out in the deploy script for slice 12).
            SafeTransferLib.safeApprove(base, address(dn404CurveFactory), curveSupply);
            curve = dn404CurveFactory.createCurveWithConfigFor(
                base,
                p.pairCurrency,
                p.antiSniperBlocks,
                p.buybackBurnBps,
                msg.sender
            );
        }

        // -- 10. Sanity: the deployed curve MUST match the address we
        //        skip-listed. Any mismatch means CurveFactory's salt or
        //        implementation shifted mid-tx — a live-stack invariant
        //        break that we surface loudly rather than silently
        //        leaving the curve un-skip-listed.
        if (curve != predictedCurve) {
            revert Dn404LaunchFactory__CurveAddressMismatch(predictedCurve, curve);
        }

        emit Dn404Launched(
            base,
            mirror,
            curve,
            msg.sender,
            p.pairCurrency,
            saltKey,
            p.uruAmount,
            totalSupplyWei,
            unitWei,
            founderMintWei,
            p.name,
            p.ticker
        );
    }

    // ============================================================
    // Internal
    // ============================================================

    function _minUruFeeFor(
        address launcher
    ) internal view returns (uint256) {
        uint256 floor = minUruFee;
        if (floor == 0) return 0;
        ILoyaltyOracleLike oracle = loyaltyOracle;
        if (address(oracle) == address(0)) return floor;
        uint16 discountBps = oracle.discountBpsFor(launcher);
        if (discountBps >= 10_000) return 0;
        return floor - (floor * discountBps) / 10_000;
    }

    function _requireCodeHash(
        address impl,
        bytes32 expected
    ) internal view {
        bytes32 actual = keccak256(impl.code);
        if (actual != expected) revert Dn404LaunchFactory__CodeHashMismatch(expected, actual);
    }
}
