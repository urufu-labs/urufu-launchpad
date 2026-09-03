// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 mirror
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    the erc-721 half of a dn404 pair.  storage lives on the base
 *    contract; this mirror is the ergonomic surface marketplaces
 *    (opensea, blur, magic eden) read to render the collection.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {DN404Mirror} from "dn404/DN404Mirror.sol";

interface IDn404BaseContractURI {
    function contractURI() external view returns (string memory);
}

/// @title  Dn404MirrorTemplate
/// @notice ERC-721 mirror half of a DN404 pair. Cloneable via LibClone; the
///         factory is expected to clone this before the base and pass its
///         address into `Dn404Template.initialize` so the base can link
///         atomically in the same tx.
///
/// @dev Two-role model:
///         - `owner()`  → pulled from the base's Solady Ownable via
///                        `pullOwner()` (DN404's _initializeDN404 auto-calls
///                        pullOwner on the mirror when base.owner() is
///                        non-zero at init time). Post-init, anyone can call
///                        pullOwner() to re-sync if the launcher transfers
///                        ownership on the base.
///         - `minter`   → implicit; only the linked base can drive mints
///                        via its own `logTransfer` callback path. There is
///                        no direct mint entrypoint on the mirror.
///
/// This template intentionally adds only one surface on top of DN404Mirror:
/// `contractURI()`, which relays to the base's collection-level metadata URL
/// so OpenSea + friends can render the collection cover / description /
/// featured image without a second storage slot on the mirror side.
///
/// Storage layout: none of our own. All state lives in DN404Mirror's fixed
/// storage slot. Kept deliberately empty so clones cost less to deploy.
contract Dn404MirrorTemplate is DN404Mirror {
    /// @dev The impl deploy is the only time the constructor runs. Clones
    ///      skip it entirely and start with an empty DN404NFTStorage, which
    ///      is exactly what we want — `deployer = address(0)` means the
    ///      "only deployer can link" gate is disabled on clones, and the
    ///      linking is instead protected by the factory doing base + mirror
    ///      clone + initialize atomically in one tx (no frontrunning window).
    constructor() DN404Mirror(address(0)) {}

    /// @notice Collection-level metadata URL, forwarded from the base.
    ///         Marketplaces read this via ERC-721's contractURI convention
    ///         to render the collection cover, description, and featured
    ///         image on the collection page.
    ///
    /// @dev Read-through pattern avoids duplicating the string on the mirror
    ///      side. Returns empty string if the mirror hasn't been linked yet
    ///      or if the base reverts (defensive — should never happen in
    ///      practice because linking happens atomically in initialize).
    function contractURI() external view returns (string memory) {
        address base = _getDN404NFTStorage().baseERC20;
        if (base == address(0)) return "";
        try IDn404BaseContractURI(base).contractURI() returns (string memory uri) {
            return uri;
        } catch {
            return "";
        }
    }
}
