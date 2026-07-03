// SPDX-License-Identifier: MIT
// VM_MODULE_ID: ERC2981Royalty1155
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC1155
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// ERC-2981 royalty for ERC-1155. Uniform royalty across every token id in the collection
// (same as ERC2981Royalty for ERC-721A). Marketplaces (OpenSea, Blur, Magic Eden) query
// `royaltyInfo(id, salePrice)` and forward the reported percentage on secondary sales.
// Enforcement is off-chain — this fragment only advertises.
//
// Extends `supportsInterface` to report the ERC-2981 interface id so registry-style
// marketplaces detect royalty support automatically.
//
// Params: `(address receiver, uint96 feeBps)` — same shape as the ERC-721A variant.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error ERC2981Royalty1155__FeeTooHigh(uint96 feeBps);
error ERC2981Royalty1155__ZeroReceiver();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event ERC2981Royalty1155Configured(address receiver, uint96 feeBps);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
address private _royaltyReceiver;
uint96 private _royaltyFeeBps;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (address receiver_, uint96 feeBps_) = abi.decode(moduleData, (address, uint96));
    if (receiver_ == address(0)) revert ERC2981Royalty1155__ZeroReceiver();
    if (feeBps_ > 1000) revert ERC2981Royalty1155__FeeTooHigh(feeBps_); // 10% cap
    _royaltyReceiver = receiver_;
    _royaltyFeeBps = feeBps_;
    emit ERC2981Royalty1155Configured(receiver_, feeBps_);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
    return (_royaltyReceiver, (salePrice * _royaltyFeeBps) / 10_000);
}

function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
}

function royaltyReceiver() external view returns (address) {
    return _royaltyReceiver;
}

function royaltyFeeBps() external view returns (uint96) {
    return _royaltyFeeBps;
}
