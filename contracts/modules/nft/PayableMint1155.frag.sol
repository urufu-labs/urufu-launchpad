// SPDX-License-Identifier: MIT
// VM_MODULE_ID: PayableMint1155
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC1155
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Public payable mint per token ID. Launcher declares a price per id at init; buyers call
// `mintPayable(id, amount)` with `msg.value = price * amount`. Proceeds accumulate on the
// contract; owner withdraws via `withdrawPayable(address)`. Ids without a declared price
// remain owner-only (bare template behavior).
//
// Composes cleanly with `SupplyPerToken1155` — both hooks run in the after-transfer path.
//
// Params: `(uint256[] ids, uint256[] pricesWei)` — equal-length arrays; ids get the price
//         list; unlisted ids are not publicly mintable.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error PayableMint1155__LengthMismatch(uint256 idsLen, uint256 pricesLen);
error PayableMint1155__NotMintable(uint256 id);
error PayableMint1155__WrongPrice(uint256 sent, uint256 expected);
error PayableMint1155__ZeroQty();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event PayableMint1155Configured(uint256 idsCount);
event PayableMinted(address indexed to, uint256 indexed id, uint256 amount, uint256 pricePaid);
event PayableWithdrawn(address indexed to, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
mapping(uint256 => uint256) private _pmPricePerToken;
mapping(uint256 => bool) private _pmMintable;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint256[] memory ids_, uint256[] memory prices_) = abi.decode(moduleData, (uint256[], uint256[]));
    if (ids_.length != prices_.length) revert PayableMint1155__LengthMismatch(ids_.length, prices_.length);
    for (uint256 i; i < ids_.length; ++i) {
        _pmPricePerToken[ids_[i]] = prices_[i];
        _pmMintable[ids_[i]] = true;
    }
    emit PayableMint1155Configured(ids_.length);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function mintPayable(uint256 id, uint256 amount) external payable {
    if (amount == 0) revert PayableMint1155__ZeroQty();
    if (!_pmMintable[id]) revert PayableMint1155__NotMintable(id);
    uint256 expected = _pmPricePerToken[id] * amount;
    if (msg.value != expected) revert PayableMint1155__WrongPrice(msg.value, expected);
    _mint(msg.sender, id, amount, "");
    emit PayableMinted(msg.sender, id, amount, msg.value);
}

function withdrawPayable(address to) external onlyOwner {
    uint256 amount = address(this).balance;
    SafeTransferLib.safeTransferETH(to, amount);
    emit PayableWithdrawn(to, amount);
}

function priceOf(uint256 id) external view returns (uint256 price, bool mintable) {
    return (_pmPricePerToken[id], _pmMintable[id]);
}

receive() external payable {}
