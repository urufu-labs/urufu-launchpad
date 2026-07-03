// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Refundable
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC721A
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Anti-rug primitive for NFT mints. Buyer pays `pricePerToken` wei per mint and can burn
// the token within `refundWindowBlocks` after mint to reclaim the price. After the window
// elapses, the owner can sweep the tokens' funds. Refund is per-token — a batch mint
// records the same mint block for every token in the batch.
//
// Owner cannot withdraw funds until the per-token window has expired — funds are locked
// while the buyer's option is live. Non-refundable funds (owner sweeps) come out via
// `refundableWithdraw`.
//
// Params: (uint256 pricePerToken, uint32 refundWindowBlocks)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Refundable__WrongPrice(uint256 sent, uint256 expected);
error Refundable__ZeroQuantity();
error Refundable__NotOwner(uint256 tokenId, address caller);
error Refundable__WindowExpired(uint256 tokenId);
error Refundable__WindowStillOpen(uint256 tokenId);
error Refundable__EmptyTokenIds();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event RefundableConfigured(uint256 pricePerToken, uint32 refundWindowBlocks);
event RefundableMinted(address indexed to, uint256 startTokenId, uint256 quantity, uint256 pricePaid);
event RefundableRefunded(address indexed to, uint256 tokenId, uint256 amount);
event RefundableWithdrawn(address indexed to, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint256 private _refundablePricePerToken;
uint32 private _refundableWindowBlocks;
mapping(uint256 => uint256) private _refundableMintBlock;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint256 pricePerToken_, uint32 refundWindowBlocks_) = abi.decode(moduleData, (uint256, uint32));
    _refundablePricePerToken = pricePerToken_;
    _refundableWindowBlocks = refundWindowBlocks_;
    emit RefundableConfigured(pricePerToken_, refundWindowBlocks_);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function refundableMint(uint256 quantity) external payable {
    if (quantity == 0) revert Refundable__ZeroQuantity();
    uint256 expected = _refundablePricePerToken * quantity;
    if (msg.value != expected) revert Refundable__WrongPrice(msg.value, expected);
    if (_vmMaxSupply != 0) {
        uint256 minted = _totalMinted();
        uint256 remaining = _vmMaxSupply > minted ? _vmMaxSupply - minted : 0;
        if (quantity > remaining) revert ERC721ATemplate__MaxSupplyExceeded(quantity, remaining);
    }
    uint256 start = _nextTokenId();
    uint256 mintBlock = block.number;
    unchecked {
        for (uint256 i; i < quantity; ++i) {
            _refundableMintBlock[start + i] = mintBlock;
        }
    }
    _mint(msg.sender, quantity);
    emit RefundableMinted(msg.sender, start, quantity, expected);
}

function refund(uint256[] calldata tokenIds) external {
    uint256 n = tokenIds.length;
    if (n == 0) revert Refundable__EmptyTokenIds();
    uint256 total;
    uint256 window = _refundableWindowBlocks;
    uint256 price = _refundablePricePerToken;
    for (uint256 i; i < n; ++i) {
        uint256 tokenId = tokenIds[i];
        if (ownerOf(tokenId) != msg.sender) revert Refundable__NotOwner(tokenId, msg.sender);
        uint256 mintBlock = _refundableMintBlock[tokenId];
        if (block.number > mintBlock + window) revert Refundable__WindowExpired(tokenId);
        _burn(tokenId, false);
        delete _refundableMintBlock[tokenId];
        emit RefundableRefunded(msg.sender, tokenId, price);
        unchecked { total += price; }
    }
    SafeTransferLib.safeTransferETH(msg.sender, total);
}

function refundableWithdraw(address to, uint256[] calldata tokenIds) external onlyOwner {
    uint256 n = tokenIds.length;
    if (n == 0) revert Refundable__EmptyTokenIds();
    uint256 total;
    uint256 window = _refundableWindowBlocks;
    uint256 price = _refundablePricePerToken;
    for (uint256 i; i < n; ++i) {
        uint256 tokenId = tokenIds[i];
        uint256 mintBlock = _refundableMintBlock[tokenId];
        // Zero mintBlock means token wasn't minted via refundableMint (or was already swept).
        if (mintBlock == 0) revert Refundable__WindowExpired(tokenId);
        if (block.number <= mintBlock + window) revert Refundable__WindowStillOpen(tokenId);
        delete _refundableMintBlock[tokenId];
        unchecked { total += price; }
    }
    emit RefundableWithdrawn(to, total);
    SafeTransferLib.safeTransferETH(to, total);
}

function refundablePricePerToken() external view returns (uint256) {
    return _refundablePricePerToken;
}

function refundableWindowBlocks() external view returns (uint32) {
    return _refundableWindowBlocks;
}

function refundableMintBlockOf(uint256 tokenId) external view returns (uint256) {
    return _refundableMintBlock[tokenId];
}
