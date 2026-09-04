// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 tax destinations
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    governance-managed allowlist of ERC-20 tokens that DN404 tax
 *    hooks can route the BuyAllowedToken destination toward.  URU,
 *    USDG, canonical robinhood stock tokens, etc.  no launcher can
 *    route tax to a rug they control.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {Ownable} from "solady/auth/Ownable.sol";

/// @title  Dn404TaxAllowlist
/// @notice Governance-managed allowlist of ERC-20 addresses that DN404
///         tax hooks (Dn404TaxHook mixin, to be added in slice C2) may
///         route the `BuyAllowedToken` tax destination toward. Prevents
///         launchers from picking a self-controlled rug token as the
///         swap target for their tax stream.
///
/// @dev Distinct from `Dn404PairCurrencyAllowlist` — that one gates
///      what a curve prices IN, this one gates what a tax stream buys
///      INTO. Two lists so governance can independently rotate them
///      (e.g. a stock token might be safe as a pair currency but not
///      yet as a tax destination if the on-chain buy path isn't liquid
///      enough).
///
/// @dev Other tax destinations (Off, BurnDead, BuybackURU, AddToLP,
///      HolderReflections, MirrorFloorSupport) don't need allowlist
///      gating:
///        - Off / BurnDead / HolderReflections have no target token
///        - BuybackURU targets the ecosystem URU token exclusively
///          (hardcoded in the hook, not runtime-configurable)
///        - AddToLP targets the launch's own pair currency (already
///          allowlisted via Dn404PairCurrencyAllowlist)
///        - MirrorFloorSupport targets the launch's own paired mirror
///          NFT collection (which is the launch itself, so trust-
///          checked by construction)
///
/// @dev Firewall constraint (see feedback_dn404_no_erc20_touch.md):
///      Lives under `contracts/src/dn404/`, called only by the DN404
///      tax hook mixin (slice C2). Invisible to the V10 curve stack
///      + Router.launch flow that continues to serve plain ERC-20
///      launches.
contract Dn404TaxAllowlist is Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404TaxAllowlist__ZeroAddress();
    error Dn404TaxAllowlist__ZeroOwner();
    error Dn404TaxAllowlist__LengthMismatch();

    // ============================================================
    // Events
    // ============================================================
    /// @dev Fires on any add / remove. `label` is a short human-readable
    ///      tag ("URU", "USDG", "NVDA") that lets consumers rebuild the
    ///      full destination dropdown from event log alone — no extra
    ///      chain reads on the underlying tokens.
    event TaxDestinationAllowedSet(address indexed token, bool allowed, string label);

    // ============================================================
    // Storage
    // ============================================================

    /// address → bool. `true` means DN404 tax hooks may swap into this
    /// token as their BuyAllowedToken destination. Missing / `false`
    /// means the launch (or governance) reverts.
    mapping(address token => bool allowed) public isAllowed;

    /// address → short human label ("URU", "USDG", "COST"). Not
    /// authoritative — the actual symbol lives on the token contract.
    /// Kept here so the frontend dropdown can rebuild via one indexer
    /// query on this contract instead of N chain reads on each token.
    mapping(address token => string label) public labelOf;

    // ============================================================
    // Constructor
    // ============================================================

    /// @param initialOwner    Multisig / governance address.
    /// @param initialTokens   Optional seed set of allowed destination
    ///                        tokens. Recommended seed: URU, USDG, plus
    ///                        canonical Robinhood stock tokens already
    ///                        live at deploy time.
    /// @param initialLabels   Parallel array of labels for `initialTokens`.
    constructor(
        address initialOwner,
        address[] memory initialTokens,
        string[] memory initialLabels
    ) {
        if (initialOwner == address(0)) revert Dn404TaxAllowlist__ZeroOwner();
        _initializeOwner(initialOwner);

        if (initialTokens.length != initialLabels.length) revert Dn404TaxAllowlist__LengthMismatch();
        for (uint256 i = 0; i < initialTokens.length; i++) {
            if (initialTokens[i] == address(0)) revert Dn404TaxAllowlist__ZeroAddress();
            isAllowed[initialTokens[i]] = true;
            labelOf[initialTokens[i]] = initialLabels[i];
            emit TaxDestinationAllowedSet(initialTokens[i], true, initialLabels[i]);
        }
    }

    // ============================================================
    // Owner surface
    // ============================================================

    /// @notice Add or remove a token from the tax-destination allowlist.
    ///         New tokens can be added at any time without redeploying
    ///         the tax hook mixin or any factory — every future launch
    ///         reads the current state of this contract at hook-init
    ///         time. Removing an entry does NOT retroactively affect
    ///         launches already made against that destination; their
    ///         hooks stay live and continue routing to the removed
    ///         destination until governance separately migrates them.
    function setAllowed(
        address token,
        bool allowed,
        string calldata label
    ) external onlyOwner {
        if (token == address(0)) revert Dn404TaxAllowlist__ZeroAddress();
        isAllowed[token] = allowed;
        if (allowed) {
            labelOf[token] = label;
        } else {
            delete labelOf[token];
        }
        emit TaxDestinationAllowedSet(token, allowed, label);
    }

    /// @notice Batch add / remove helper for the deploy script's initial
    ///         seed + governance rotations onboarding multiple tokens at
    ///         once. All-or-nothing — reverts on the first bad entry.
    function setAllowedBatch(
        address[] calldata tokens,
        bool[] calldata alloweds,
        string[] calldata labels
    ) external onlyOwner {
        if (tokens.length != alloweds.length || tokens.length != labels.length) {
            revert Dn404TaxAllowlist__LengthMismatch();
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert Dn404TaxAllowlist__ZeroAddress();
            isAllowed[tokens[i]] = alloweds[i];
            if (alloweds[i]) {
                labelOf[tokens[i]] = labels[i];
            } else {
                delete labelOf[tokens[i]];
            }
            emit TaxDestinationAllowedSet(tokens[i], alloweds[i], labels[i]);
        }
    }
}
