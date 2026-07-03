// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC721A} from "erc721a/ERC721A.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Imports pre-emptively pulled in for common module fragments. Unused-in-bare-template
// warnings are expected and harmless — imports do not add runtime bytecode.
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";

/// @title  ERC721ATemplate
/// @notice Bare ERC-721A base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below.
/// @dev    See docs/SPEC-templates.md. Marker convention: every `VM_INJECT_X` marker sits at
///         the BOTTOM of its section — modules append after base content. Storage layout is
///         base-frozen; module state is appended after `_initialized`.
contract ERC721AWithSvgAndRoyaltyGen is ERC721A, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC721ATemplate__AlreadyInitialized();
    error ERC721ATemplate__ZeroOwner();
    error ERC721ATemplate__MaxSupplyExceeded(uint256 requested, uint256 remaining);
    error ERC721ATemplate__ZeroQuantity();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from ERC2981Royalty.frag.sol ---
    error ERC2981Royalty__InvalidFeeBps(uint96 feeBps);
    error ERC2981Royalty__ZeroReceiver();

    // --- from OnChainSVG.frag.sol ---
    error OnChainSVG__NonexistentToken(uint256 tokenId);
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 maxSupply);
    event BaseURISet(string oldBaseURI, string newBaseURI);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from ERC2981Royalty.frag.sol ---
    event RoyaltyConfigured(address indexed receiver, uint96 feeBps);
    event RoyaltyReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
    // ============================================================
    // Modules append events below this marker.

    // ============================================================
    // Base storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _vmName;
    string private _vmSymbol;
    string private _vmBaseURI;
    uint256 private _vmMaxSupply;
    uint8 private _initialized;

    // ============================================================
    // VM_INJECT_STATE
    // --- from ERC2981Royalty.frag.sol ---
    address private _royaltyReceiver;
    uint96 private _royaltyBps;
    // ============================================================
    // Modules append storage variables below this marker.

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================
    // Modules append constants / immutables below this marker.

    // ============================================================
    // Constructor — impl only. Clones skip this and use `initialize` instead.
    // ============================================================
    constructor() ERC721A("", "") {}

    // ============================================================
    // ERC-721A metadata overrides
    // ============================================================

    function name() public view virtual override returns (string memory) {
        return _vmName;
    }

    function symbol() public view virtual override returns (string memory) {
        return _vmSymbol;
    }

    function _baseURI() internal view virtual override returns (string memory) {
        return _vmBaseURI;
    }

    /// @notice Base URI that gets prepended to `tokenURI(tokenId)`. Full URI = `_vmBaseURI + tokenId`.
    function baseURI() external view returns (string memory) {
        return _vmBaseURI;
    }

    /// @notice Owner-only base URI setter. Modules like `DelayedReveal` bypass this by overriding
    ///         `tokenURI` in their `VM_INJECT_EXTERNAL` section.
    function setBaseURI(
        string calldata newBaseURI
    ) external onlyOwner {
        emit BaseURISet(_vmBaseURI, newBaseURI);
        _vmBaseURI = newBaseURI;
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, name, symbol, baseURI, maxSupply, moduleData)`.
    ///         Factory forces `initialOwner = router` so Router can dispatch to the launcher's
    ///         chosen `OwnershipMode` post-initialize. `maxSupply == 0` means uncapped.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC721ATemplate__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            string memory name_,
            string memory symbol_,
            string memory baseURI_,
            uint256 maxSupply_,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, string, string, string, uint256, bytes[]));

        if (initialOwner == address(0)) revert ERC721ATemplate__ZeroOwner();

        _vmName = name_;
        _vmSymbol = symbol_;
        _vmBaseURI = baseURI_;
        _vmMaxSupply = maxSupply_;
        _initializeOwner(initialOwner);

        emit Initialized(name_, symbol_, initialOwner, maxSupply_);

        // ============================================================
        // VM_INJECT_INIT
        // --- from ERC2981Royalty.frag.sol ---
        {
            (address receiver, uint96 feeBps) = abi.decode(moduleData[0], (address, uint96));
            if (feeBps > 1000) revert ERC2981Royalty__InvalidFeeBps(feeBps);
            if (receiver == address(0)) revert ERC2981Royalty__ZeroReceiver();
            _royaltyReceiver = receiver;
            _royaltyBps = feeBps;
            emit RoyaltyConfigured(receiver, feeBps);
        }
        // ============================================================
        // Modules decode their slice of `moduleData` here.
        moduleData;
    }

    // ============================================================
    // Owner-mint (bare template shipping default; modules override behavior via markers)
    // ============================================================

    /// @notice Batch-mint `quantity` tokens to `to`. Owner-only in the bare template. Modules like
    ///         `PublicMint` or `AllowlistMint` add unrestricted-caller mint paths via
    ///         `VM_INJECT_EXTERNAL`.
    function mintBatch(
        address to,
        uint256 quantity
    ) external onlyOwner {
        if (quantity == 0) revert ERC721ATemplate__ZeroQuantity();
        if (_vmMaxSupply != 0) {
            uint256 minted = _totalMinted();
            uint256 remaining = _vmMaxSupply > minted ? _vmMaxSupply - minted : 0;
            if (quantity > remaining) revert ERC721ATemplate__MaxSupplyExceeded(quantity, remaining);
        }
        _mint(to, quantity);
    }

    function maxSupply() external view returns (uint256) {
        return _vmMaxSupply;
    }

    function totalMinted() external view returns (uint256) {
        return _totalMinted();
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================
    // Modules append modifiers below this marker.

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfers(
        address from,
        address to,
        uint256 startTokenId,
        uint256 quantity
    ) internal virtual override {
        (from, to, startTokenId, quantity); // silence unused-var warnings
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // ============================================================
        // Modules append before-transfer hook bodies below this marker.
    }

    function _afterTokenTransfers(
        address from,
        address to,
        uint256 startTokenId,
        uint256 quantity
    ) internal virtual override {
        (from, to, startTokenId, quantity);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from ERC2981Royalty.frag.sol ---
    /// @notice ERC-2981 royalty info. `tokenId` unused — flat per-collection royalty.
    function royaltyInfo(
        uint256,
        /* tokenId */
        uint256 salePrice
    ) external view returns (address receiver, uint256 royaltyAmount) {
        receiver = _royaltyReceiver;
        royaltyAmount = (salePrice * uint256(_royaltyBps)) / 10_000;
    }

    /// @notice ERC-165 support for ERC-2981 (0x2a55205a).
    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override returns (bool) {
        return interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
    }

    /// @notice Rotate the royalty receiver (owner-only). Params like feeBps are fixed at init.
    function setRoyaltyReceiver(
        address newReceiver
    ) external onlyOwner {
        if (newReceiver == address(0)) revert ERC2981Royalty__ZeroReceiver();
        emit RoyaltyReceiverUpdated(_royaltyReceiver, newReceiver);
        _royaltyReceiver = newReceiver;
    }

    function royaltyReceiver() external view returns (address) {
        return _royaltyReceiver;
    }

    function royaltyBps() external view returns (uint96) {
        return _royaltyBps;
    }

    // --- from OnChainSVG.frag.sol ---
    /// @notice Full ERC-721 metadata as a data URI. Marketplaces (OpenSea, Blur, Magic Eden) all
    ///         decode `data:application/json;base64,...` URIs natively.
    function tokenURI(
        uint256 tokenId
    ) public view virtual override returns (string memory) {
        if (!_exists(tokenId)) revert OnChainSVG__NonexistentToken(tokenId);

        string memory svg = _buildSvg(tokenId);
        string memory json = string(
            abi.encodePacked(
                '{"name":"',
                _vmName,
                " #",
                LibString.toString(tokenId),
                '","description":"On-chain SVG token from the VM launchpad.","image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(svg)),
                '"}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // --- from OnChainSVG.frag.sol ---
    /// @dev Deterministic SVG generator. Overridable by richer visual modules.
    function _buildSvg(
        uint256 tokenId
    ) internal view virtual returns (string memory) {
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">',
                '<rect width="500" height="500" fill="#0a0a0a"/>',
                '<text x="50%" y="45%" font-family="monospace" font-size="42" fill="#ffffff" text-anchor="middle">',
                _vmName,
                "</text>",
                '<text x="50%" y="60%" font-family="monospace" font-size="64" fill="#4ade80" text-anchor="middle">#',
                LibString.toString(tokenId),
                "</text>",
                "</svg>"
            )
        );
    }
    // ============================================================
    // Modules append internal helpers below this marker.
}
