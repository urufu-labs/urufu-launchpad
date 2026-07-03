// SPDX-License-Identifier: MIT
// VM_MODULE_ID: ERC2981Royalty
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC721A
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// ERC-2981 royalty info. Marketplaces query `royaltyInfo(tokenId, salePrice)` and forward
// the reported percentage to `receiver` on secondary sales. Enforcement is off-chain (respect
// varies by marketplace); on-chain enforcement lives in a Phase 2 hook.
//
// Params: (address receiver, uint96 feeBps) where feeBps in [0, 1000] (10% cap for sanity).

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error ERC2981Royalty__InvalidFeeBps(uint96 feeBps);
error ERC2981Royalty__ZeroReceiver();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event RoyaltyConfigured(address indexed receiver, uint96 feeBps);
event RoyaltyReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
address private _royaltyReceiver;
uint96 private _royaltyBps;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (address receiver, uint96 feeBps) = abi.decode(moduleData, (address, uint96));
    if (feeBps > 1_000) revert ERC2981Royalty__InvalidFeeBps(feeBps);
    if (receiver == address(0)) revert ERC2981Royalty__ZeroReceiver();
    _royaltyReceiver = receiver;
    _royaltyBps = feeBps;
    emit RoyaltyConfigured(receiver, feeBps);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================

/// @notice ERC-2981 royalty info. `tokenId` unused — flat per-collection royalty.
function royaltyInfo(uint256, /* tokenId */ uint256 salePrice)
    external
    view
    returns (address receiver, uint256 royaltyAmount)
{
    receiver = _royaltyReceiver;
    royaltyAmount = (salePrice * uint256(_royaltyBps)) / 10_000;
}

/// @notice ERC-165 support for ERC-2981 (0x2a55205a).
function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
}

/// @notice Rotate the royalty receiver (owner-only). Params like feeBps are fixed at init.
function setRoyaltyReceiver(address newReceiver) external onlyOwner {
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
