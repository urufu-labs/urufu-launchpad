// SPDX-License-Identifier: MIT
// VM_MODULE_ID: OnChainSVG
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC721A
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Renders each token's metadata as a base64-encoded JSON with an embedded on-chain SVG.
// Overrides ERC-721A's `tokenURI` — the composed contract's `_baseURI()` becomes irrelevant.
//
// The SVG generator here is intentionally minimal: a dark background + centered
// "<name> #<id>" text. Modules with richer visuals (traits, backgrounds, layers) extend by
// overriding `_buildSvg` in a submodule.
//
// Params: none. Behavior is fixed per composition.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error OnChainSVG__NonexistentToken(uint256 tokenId);

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================

/// @notice Full ERC-721 metadata as a data URI. Marketplaces (OpenSea, Blur, Magic Eden) all
///         decode `data:application/json;base64,...` URIs natively.
function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
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
// SECTION: VM_INJECT_INTERNAL
// ============================================================

/// @dev Deterministic SVG generator. Overridable by richer visual modules.
function _buildSvg(uint256 tokenId) internal view virtual returns (string memory) {
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
