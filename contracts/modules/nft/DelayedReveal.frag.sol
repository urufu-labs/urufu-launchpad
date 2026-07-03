// SPDX-License-Identifier: MIT
// VM_MODULE_ID: DelayedReveal
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC721A
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH: OnChainSVG
// VM_MODULE_FLAGGED:
//
// Placeholder URI until owner calls `reveal()`. Pre-reveal every token points at the hidden
// URI + token id; post-reveal every token points at the base URI + token id.
//
// Overrides `tokenURI(id)` — incompatible with OnChainSVG (which also overrides it).
//
// Params: (string hiddenBaseURI)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error DelayedReveal__AlreadyRevealed();
error DelayedReveal__NonexistentToken(uint256 tokenId);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event DelayedRevealConfigured(string hiddenURI);
event DelayedRevealRevealed(string revealedBaseURI);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
bool private _drRevealed;
string private _drHiddenURI;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    string memory hiddenURI = abi.decode(moduleData, (string));
    _drHiddenURI = hiddenURI;
    emit DelayedRevealConfigured(hiddenURI);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
    if (!_exists(tokenId)) revert DelayedReveal__NonexistentToken(tokenId);
    string memory base = _drRevealed ? _vmBaseURI : _drHiddenURI;
    return string(abi.encodePacked(base, LibString.toString(tokenId)));
}

function reveal() external onlyOwner {
    if (_drRevealed) revert DelayedReveal__AlreadyRevealed();
    _drRevealed = true;
    emit DelayedRevealRevealed(_vmBaseURI);
}

function delayedRevealIsRevealed() external view returns (bool) {
    return _drRevealed;
}

function delayedRevealHiddenURI() external view returns (string memory) {
    return _drHiddenURI;
}
