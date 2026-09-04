// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 tax hook
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    per-transfer tax hook mixin for DN404.  extends Dn404Template
 *    with a _transfer override that skims taxBps of every transfer
 *    (subject to exemption list) and routes to launcher-picked
 *    destination.  six modes, from a plain burn to the paired-NFT
 *    floor-support mechanic that (i think) nobody has shipped.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {Dn404Template} from "./Dn404Template.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IDn404TaxAllowlistView {
    function isAllowed(address token) external view returns (bool);
}

/// @title  Dn404TaxTemplate
/// @notice DN404 base ERC-20 with a per-transfer tax hook. Extends
///         Dn404Template — every capability the parent has plus one
///         `_transfer` override that splits every transfer into
///         (net, tax), routes the tax to the launcher-picked
///         destination, and short-circuits when disabled.
///
/// @dev **Firewall:** lives under `contracts/src/dn404/`. Extends
///      Dn404Template without modifying it (no edits to slice-4
///      source). V10 curve stack + Router are untouched. Per
///      feedback_dn404_no_erc20_touch.md.
///
/// @dev **Storage layout (extends Dn404Template's frozen layout):**
///      Solidity appends inherited storage in linearization order, so
///      Dn404Template's slots stay in place and the tax fields land
///      after `_initialized`. Fresh clones of Dn404TaxTemplate get all
///      slots; if a cloned Dn404Template were ever cast to
///      Dn404TaxTemplate, the tax slots would read as zero (safe: taxMode
///      would default to Off, no tax applied). But that cast should
///      never happen in production — factory routes to one impl per
///      launch based on which template was chosen at clone-time.
///
/// @dev **6 destinations:**
///        - `Off` — no tax, hook short-circuits (~2k gas overhead)
///        - `BurnDead` — send `taxBps` to `0x…dEaD` in-tx
///        - `BuybackURU` — accumulate in `this`; keeper sweeps + swaps
///          to URU off-chain (aligns with existing flywheel)
///        - `BuyAllowedToken(target)` — accumulate; keeper swaps to
///          `taxTarget` (an allowlisted ERC-20; USDG, COST, NVDA, etc.)
///        - `AddToLP` — accumulate; keeper pairs with pool base and
///          adds LP on the graduated v4 pool (silent pre-graduation)
///        - `HolderReflections` — accumulate; keeper distributes
///          pro-rata to holders via a merkle drop (avoids on-chain
///          gas blow-up on large collections)
///        - `MirrorFloorSupport` — accumulate; keeper buys mirror
///          NFTs from marketplace floor + burns them (real supply
///          contraction driven by the paired structure — the
///          genuinely-novel destination per SPEC-dn404-hooks.md)
///
/// @dev **Keeper fee:** 5% of every sweep (SPEC decision #4). Split
///      out of the swept amount + transferred to `keeperTreasury` in
///      the same tx as the recipient transfer, emitted transparently
///      in `KeeperSwept`.
///
/// @dev **Post-launch destination change:** owner-only `setTaxDestination`
///      permits switching AMONG the enum values (SPEC decision #1). Since
///      destination is enum-typed, there is no escape outside our
///      approved menu. Tax rate `taxBps` is immutable after init
///      (SPEC decision #2) — no `setTaxBps`.
contract Dn404TaxTemplate is Dn404Template {
    // ============================================================
    // Types
    // ============================================================

    /// Full destination menu. Enum-typed so `setTaxDestination` can
    /// only ever pick one of these values — no arbitrary-address
    /// escape.
    enum TaxMode {
        Off,
        BurnDead,
        BuybackURU,
        BuyAllowedToken,
        AddToLP,
        HolderReflections,
        MirrorFloorSupport
    }

    // ============================================================
    // Constants
    // ============================================================

    /// Standard dead-address sink for BurnDead + skip-list entry.
    address internal constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// Hard cap on `taxBps`. 500 = 5%; enforced at initializeTax to
    /// keep launches from configuring hostile fees. Deep enough into
    /// "rug-shaped territory" that anything higher is almost certainly
    /// an admin typo.
    uint16 public constant MAX_TAX_BPS = 500;

    /// Fraction of every keeper sweep that goes to `keeperTreasury`
    /// instead of the launch's destination. 5% per SPEC decision #4.
    uint16 public constant KEEPER_FEE_BPS = 500;

    // ============================================================
    // Errors
    // ============================================================
    error Dn404TaxTemplate__TaxAlreadyInitialized();
    error Dn404TaxTemplate__TaxBpsTooHigh(uint16 bps, uint16 max);
    error Dn404TaxTemplate__TaxTargetNotAllowed(address target);
    error Dn404TaxTemplate__NotKeeper();
    error Dn404TaxTemplate__InsufficientAccumulated(uint256 requested, uint256 available);
    error Dn404TaxTemplate__ZeroAddress();

    // ============================================================
    // Events
    // ============================================================
    event TaxInitialized(TaxMode indexed mode, uint16 bps, address indexed target, address indexed keeper);
    event TaxDestinationChanged(TaxMode oldMode, TaxMode newMode, address oldTarget, address newTarget);
    event TaxExemptSet(address indexed target, bool exempt);
    event KeeperSet(address indexed oldKeeper, address indexed newKeeper);
    event KeeperTreasurySet(address indexed oldTreasury, address indexed newTreasury);
    /// Emitted for the immediate destinations (BurnDead).
    event TaxApplied(
        address indexed from,
        address indexed to,
        uint256 gross,
        uint256 tax,
        TaxMode mode,
        address destination
    );
    /// Emitted for accumulator destinations (BuybackURU, BuyAllowedToken,
    /// AddToLP, HolderReflections, MirrorFloorSupport). Keeper watches
    /// this event stream to trigger the destination-specific action.
    event TaxAccumulated(
        address indexed from,
        address indexed to,
        uint256 gross,
        uint256 tax,
        TaxMode indexed mode,
        address target
    );
    event KeeperSwept(address indexed recipient, uint256 net, uint256 keeperFee, TaxMode mode);

    // ============================================================
    // Storage — appended after Dn404Template's frozen layout
    // ============================================================

    TaxMode public taxMode;
    /// Immutable after initializeTax — no on-chain path to change.
    uint16 public taxBps;
    /// Only meaningful for `BuyAllowedToken`. For other modes it may
    /// be zero or a hint (e.g. address of URU for BuybackURU convenience);
    /// authoritative destination is derived from `taxMode`.
    address public taxTarget;

    /// Keeper wallet — the only entity allowed to sweep accumulated
    /// tax. Owner (launcher) can rotate via setKeeper.
    address public keeper;
    /// Where the 5% keeper fee goes. Typically the launchpad's shared
    /// keeper-ops treasury.
    address public keeperTreasury;
    /// URU token address — the hardcoded target for BuybackURU. Set
    /// at initializeTax; not otherwise mutable.
    address public uruToken;

    /// Cumulative tax held in `address(this)` awaiting keeper sweep.
    /// Decremented on each successful sweep. Held ON the tax template
    /// itself (skipNFT set at init so no mirror NFTs mint to us).
    uint256 public accumulatedTax;

    /// Reference to the destination allowlist. Only consulted for
    /// `BuyAllowedToken` mode; other modes have implicit targets.
    IDn404TaxAllowlistView public taxAllowlist;

    /// Auto-exempted from tax on either side of a transfer. Factory,
    /// curve, feeSplitter, launcher, DEAD_ADDRESS, address(this).
    mapping(address => bool) public taxExempt;

    /// Guard for tax-hook re-entry — prevents the tax split's own
    /// sub-transfers from re-triggering the hook. Not a full
    /// ReentrancyGuard; scoped to just the _transfer override.
    uint8 private _inTax;

    /// One-shot guard for initializeTax. Distinct from Dn404Template's
    /// `_initialized` since the two init phases are called separately
    /// by the factory.
    uint8 private _taxInitialized;

    // ============================================================
    // Init
    // ============================================================

    /// @notice Second-phase initializer called by the factory after
    ///         `initialize(baseData)`. Sets tax config + auto-exempts
    ///         + skip-lists `this` + `DEAD_ADDRESS`.
    ///
    /// @dev Encoded input:
    ///        `abi.encode(mode, bps, target, keeper, keeperTreasury,
    ///                    taxAllowlist, uruToken, exemptions[])`
    ///      Even for TaxMode.Off launches, factory calls this to set
    ///      the keeper + exemption defaults, so the state is
    ///      well-defined for future setTaxDestination transitions.
    function initializeTax(
        bytes calldata data
    ) external {
        if (_taxInitialized != 0) revert Dn404TaxTemplate__TaxAlreadyInitialized();
        _taxInitialized = 1;

        (
            TaxMode mode_,
            uint16 bps_,
            address target_,
            address keeper_,
            address keeperTreasury_,
            address taxAllowlist_,
            address uruToken_,
            address[] memory exemptions
        ) = abi.decode(
            data,
            (TaxMode, uint16, address, address, address, address, address, address[])
        );

        if (bps_ > MAX_TAX_BPS) revert Dn404TaxTemplate__TaxBpsTooHigh(bps_, MAX_TAX_BPS);
        _validateDestination(mode_, target_, IDn404TaxAllowlistView(taxAllowlist_));

        taxMode = mode_;
        taxBps = bps_;
        taxTarget = target_;
        keeper = keeper_;
        keeperTreasury = keeperTreasury_;
        taxAllowlist = IDn404TaxAllowlistView(taxAllowlist_);
        uruToken = uruToken_;

        // Auto-exempt: the tax template's own address (accumulator
        // sink) + DEAD_ADDRESS (BurnDead sink) + every wallet the
        // factory passes in as pre-known internal (curve, launcher,
        // feeSplitter, factory).
        taxExempt[address(this)] = true;
        taxExempt[DEAD_ADDRESS] = true;
        emit TaxExemptSet(address(this), true);
        emit TaxExemptSet(DEAD_ADDRESS, true);
        for (uint256 i = 0; i < exemptions.length; i++) {
            if (exemptions[i] != address(0)) {
                taxExempt[exemptions[i]] = true;
                emit TaxExemptSet(exemptions[i], true);
            }
        }

        // Skip-list the tax template + DEAD so accumulator transfers +
        // burns don't spam mirror NFTs to those addresses. Uses the
        // parent's owner-only setter which we can call from init since
        // launcher owner is set in the base initialize() step.
        _setSkipNFT(address(this), true);
        _setSkipNFT(DEAD_ADDRESS, true);

        emit TaxInitialized(mode_, bps_, target_, keeper_);
    }

    /// @notice Owner may change tax destination among the enum values
    ///         AT ANY POINT post-launch (SPEC decision #1). Since the
    ///         type is `TaxMode`, only pre-approved menu values are
    ///         reachable — there is no arbitrary-address escape.
    function setTaxDestination(
        TaxMode newMode,
        address newTarget
    ) external onlyOwner {
        _validateDestination(newMode, newTarget, taxAllowlist);
        emit TaxDestinationChanged(taxMode, newMode, taxTarget, newTarget);
        taxMode = newMode;
        taxTarget = newTarget;
    }

    /// @notice Owner may add/remove tax exemptions post-launch. Useful
    ///         for adding a DEX router / bridge / aggregator address
    ///         that would otherwise get taxed and confuse users.
    function setTaxExempt(
        address target,
        bool exempt
    ) external onlyOwner {
        if (target == address(0)) revert Dn404TaxTemplate__ZeroAddress();
        taxExempt[target] = exempt;
        emit TaxExemptSet(target, exempt);
    }

    /// @notice Owner (governance) rotates the keeper wallet. Should be
    ///         the platform-level ops multisig; not the launcher.
    ///         Kept owner-controlled (not launcher-controlled) so a
    ///         compromised launcher can't drain the accumulator by
    ///         pointing it at their own wallet.
    function setKeeper(
        address newKeeper
    ) external onlyOwner {
        if (newKeeper == address(0)) revert Dn404TaxTemplate__ZeroAddress();
        emit KeeperSet(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setKeeperTreasury(
        address newTreasury
    ) external onlyOwner {
        if (newTreasury == address(0)) revert Dn404TaxTemplate__ZeroAddress();
        emit KeeperTreasurySet(keeperTreasury, newTreasury);
        keeperTreasury = newTreasury;
    }

    // ============================================================
    // Hook — the actual per-transfer tax split
    // ============================================================

    /// @dev Override of DN404's internal `_transfer`. Called by both
    ///      `transfer` and `transferFrom`, so hooking here catches
    ///      every ERC-20 flow through the token.
    ///
    ///      Short-circuits when tax is disabled or either side is
    ///      exempt. Otherwise splits `amount` into `(net, tax)`, sends
    ///      `net` to `to`, and routes `tax` to the destination via a
    ///      sub-call to `super._transfer` (safe against recursion —
    ///      `super` is a static dispatch to DN404's _transfer, not
    ///      this override; the `_inTax` guard is belt-and-suspenders).
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        // Fast paths — no tax at all.
        if (
            taxMode == TaxMode.Off
                || taxBps == 0
                || _inTax == 1
                || taxExempt[from]
                || taxExempt[to]
        ) {
            super._transfer(from, to, amount);
            return;
        }

        uint256 tax = (amount * taxBps) / 10_000;
        if (tax == 0) {
            super._transfer(from, to, amount);
            return;
        }

        uint256 net = amount - tax;

        _inTax = 1;
        super._transfer(from, to, net);

        if (taxMode == TaxMode.BurnDead) {
            super._transfer(from, DEAD_ADDRESS, tax);
            emit TaxApplied(from, to, amount, tax, taxMode, DEAD_ADDRESS);
        } else {
            // Every accumulator destination (BuybackURU, BuyAllowedToken,
            // AddToLP, HolderReflections, MirrorFloorSupport) parks the
            // tax on `this` and emits an event the keeper watches. The
            // destination-specific action (swap / LP-add / floor buy /
            // merkle-drop generation) happens off-chain in the keeper.
            super._transfer(from, address(this), tax);
            accumulatedTax += tax;
            emit TaxAccumulated(from, to, amount, tax, taxMode, _resolveTarget(taxMode));
        }
        _inTax = 0;
    }

    /// Resolve the destination target hint emitted alongside a
    /// TaxAccumulated event. Not authoritative — the keeper reads
    /// `taxMode` + `taxTarget` + `uruToken` from state to know what to
    /// actually do — but useful for indexers so they can bucket
    /// accumulated tax by destination without a state read.
    function _resolveTarget(
        TaxMode mode
    ) internal view returns (address) {
        if (mode == TaxMode.BuybackURU) return uruToken;
        if (mode == TaxMode.BuyAllowedToken) return taxTarget;
        // AddToLP / HolderReflections / MirrorFloorSupport all target
        // "the launch itself" — the mirror NFT for MirrorFloorSupport,
        // the launch's holder set for HolderReflections, the launch's
        // curve/pool for AddToLP. Emitted as zero to signal "on-launch".
        return address(0);
    }

    // ============================================================
    // Keeper surface
    // ============================================================

    /// @notice Sweep `amount` of the accumulated tax to `recipient`.
    ///         Splits a 5% keeper fee off to `keeperTreasury` first,
    ///         sends the remainder to `recipient`. Emits `KeeperSwept`
    ///         with both amounts so allocation is transparent.
    ///
    /// @dev Keeper-only. The keeper decides `recipient` — typically an
    ///      external swap router (for BuybackURU/BuyAllowedToken/AddToLP)
    ///      or a merkle-distributor contract (for HolderReflections)
    ///      or a marketplace buy proxy (for MirrorFloorSupport). All
    ///      destination-specific logic lives off-chain in the keeper;
    ///      this contract stays destination-agnostic on the sweep path.
    function sweepAccumulated(
        address recipient,
        uint256 amount
    ) external returns (uint256 net, uint256 fee) {
        if (msg.sender != keeper) revert Dn404TaxTemplate__NotKeeper();
        if (recipient == address(0)) revert Dn404TaxTemplate__ZeroAddress();
        uint256 available = accumulatedTax;
        if (amount > available) revert Dn404TaxTemplate__InsufficientAccumulated(amount, available);
        accumulatedTax = available - amount;

        fee = (amount * KEEPER_FEE_BPS) / 10_000;
        net = amount - fee;

        // Push both. Guard with _inTax so DN404's transfer path doesn't
        // re-apply tax on our sub-transfers (address(this) is exempt
        // anyway; guard is belt-and-suspenders).
        _inTax = 1;
        if (fee > 0) super._transfer(address(this), keeperTreasury, fee);
        super._transfer(address(this), recipient, net);
        _inTax = 0;

        emit KeeperSwept(recipient, net, fee, taxMode);
    }

    // ============================================================
    // Internal
    // ============================================================

    function _validateDestination(
        TaxMode mode,
        address target,
        IDn404TaxAllowlistView allowlist
    ) internal view {
        // Only BuyAllowedToken needs allowlist verification — every other
        // destination has an implicit target (Off/BurnDead have none;
        // BuybackURU targets uruToken hardcoded; AddToLP targets the
        // launch's own curve/pool; HolderReflections/MirrorFloorSupport
        // target the launch itself).
        if (mode == TaxMode.BuyAllowedToken) {
            if (address(allowlist) == address(0) || !allowlist.isAllowed(target)) {
                revert Dn404TaxTemplate__TaxTargetNotAllowed(target);
            }
        }
        // Silence unused-param warnings for the paths that don't check.
        (target); (allowlist);
    }
}
