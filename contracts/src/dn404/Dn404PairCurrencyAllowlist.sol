// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 pair currency
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    governance-managed registry of ERC-20 addresses that DN404
 *    launches are allowed to use as pair currency.  URU, USDG,
 *    canonical robinhood stock tokens.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {Ownable} from "solady/auth/Ownable.sol";

/// @title  Dn404PairCurrencyAllowlist
/// @notice Governance-managed allowlist of ERC-20 addresses that
///         `Dn404CurveFactory` accepts as the pair-currency side of
///         a DN404 bonding curve. Prevents launchers from picking a
///         self-controlled rug token as the pair.
///
/// @dev **ETH is not on this allowlist and never will be.** By convention
///      `pairCurrency == address(0)` in `Dn404CurveFactory` means
///      "trade against ETH" and bypasses this contract entirely. That
///      keeps ETH launches trivially safe even if the allowlist storage
///      somehow gets corrupted — the ETH path can never revert on an
///      allowlist read that isn't performed.
///
/// @dev Owner is expected to be the same multisig / governance address
///      that manages `Dn404LaunchFactory`, `NftLaunchFactory`, and the
///      URU-A08 code-hash pinning across the launchpad.
///
/// @dev Firewall constraint (see feedback_dn404_no_erc20_touch.md):
///      This contract lives under `contracts/src/dn404/`, is called
///      only by the DN404 curve stack, and is invisible to
///      `Router.launch` / the V10 CurveFactory / the V10 curve stack
///      that continues to serve plain ERC-20 launches.
contract Dn404PairCurrencyAllowlist is Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404PairCurrencyAllowlist__ZeroAddress();
    error Dn404PairCurrencyAllowlist__ZeroOwner();

    // ============================================================
    // Events
    // ============================================================
    /// @dev Emitted whenever the allowlist entry for `token` flips.
    ///      `label` is a short human-readable tag that helps consumers
    ///      surface the change without a second chain read (e.g. the
    ///      frontend dropdown can rebuild from event log alone).
    event PairCurrencyAllowedSet(address indexed token, bool allowed, string label);

    // ============================================================
    // Storage
    // ============================================================

    /// address → bool. `true` means DN404 launches may pick this token
    /// as pair currency. Missing / `false` means the launch reverts.
    mapping(address token => bool allowed) public isAllowed;

    /// address → short human label for the token ("USDG", "COST",
    /// "NVDA"). Not authoritative — the actual symbol lives on the
    /// token contract itself. Kept here so the frontend can render the
    /// dropdown from a single indexer query on this contract instead
    /// of doing N chain reads on the tokens themselves.
    mapping(address token => string label) public labelOf;

    // ============================================================
    // Constructor
    // ============================================================

    /// @param initialOwner    Multisig / governance address.
    /// @param initialTokens   Optional seed set of allowed tokens.
    ///                        Recommended seed: WETH, USDG, plus any
    ///                        canonical Robinhood stock tokens already
    ///                        live at deploy time.
    /// @param initialLabels   Parallel array of labels for `initialTokens`.
    constructor(
        address initialOwner,
        address[] memory initialTokens,
        string[] memory initialLabels
    ) {
        if (initialOwner == address(0)) revert Dn404PairCurrencyAllowlist__ZeroOwner();
        _initializeOwner(initialOwner);

        // Seed the allowlist. Same guard as the setter — reject
        // address(0) so the "ETH = address(0)" bypass semantics
        // in Dn404CurveFactory can never be undermined by an
        // accidental storage entry.
        require(initialTokens.length == initialLabels.length, "length mismatch");
        for (uint256 i = 0; i < initialTokens.length; i++) {
            if (initialTokens[i] == address(0)) revert Dn404PairCurrencyAllowlist__ZeroAddress();
            isAllowed[initialTokens[i]] = true;
            labelOf[initialTokens[i]] = initialLabels[i];
            emit PairCurrencyAllowedSet(initialTokens[i], true, initialLabels[i]);
        }
    }

    // ============================================================
    // Owner surface
    // ============================================================

    /// @notice Add or remove a token from the pair-currency allowlist.
    ///         New tokens can be added at any time without a factory
    ///         redeploy — every future DN404 launch reads the current
    ///         state of this contract at `createCurveWithConfigFor`
    ///         time. Removing an entry does NOT retroactively affect
    ///         launches already made with that pair currency; their
    ///         curves stay live and tradable forever.
    ///
    /// @dev    `address(0)` is rejected because pair-currency of zero
    ///         is the sentinel for "trade against ETH" in
    ///         `Dn404CurveFactory`, which never reads this contract
    ///         for that case.
    function setAllowed(
        address token,
        bool allowed,
        string calldata label
    ) external onlyOwner {
        if (token == address(0)) revert Dn404PairCurrencyAllowlist__ZeroAddress();
        isAllowed[token] = allowed;
        if (allowed) {
            labelOf[token] = label;
        } else {
            delete labelOf[token];
        }
        emit PairCurrencyAllowedSet(token, allowed, label);
    }

    /// @notice Batch-set helper for the deploy script + governance
    ///         rotations. Same rules as `setAllowed` applied to each
    ///         entry; reverts on first bad entry (no partial writes).
    function setAllowedBatch(
        address[] calldata tokens,
        bool[] calldata alloweds,
        string[] calldata labels
    ) external onlyOwner {
        require(tokens.length == alloweds.length && tokens.length == labels.length, "length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert Dn404PairCurrencyAllowlist__ZeroAddress();
            isAllowed[tokens[i]] = alloweds[i];
            if (alloweds[i]) {
                labelOf[tokens[i]] = labels[i];
            } else {
                delete labelOf[tokens[i]];
            }
            emit PairCurrencyAllowedSet(tokens[i], alloweds[i], labels[i]);
        }
    }
}
