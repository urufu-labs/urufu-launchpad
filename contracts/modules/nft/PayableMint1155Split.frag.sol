// SPDX-License-Identifier: MIT
// VM_MODULE_ID: PayableMint1155Split
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC1155
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH: PayableMint1155
// VM_MODULE_FLAGGED:
//
// Sibling of `PayableMint1155` that routes a basis-point cut of every mint to the flywheel
// FeeSplitter. Launcher keeps the rest and withdraws via `withdrawPayable`. Enforcement is
// inline: the platform cut is forwarded on each mint, so the launcher can never withdraw
// more than their share.
//
// Params:
//   (uint256[] ids, uint256[] pricesWei, address platformFeeReceiver, uint16 platformFeeBps)
//     ids/prices     — equal-length arrays; ids get the price list; unlisted ids stay owner-only
//     platformFeeReceiver — the `FeeSplitter` address (immutable per collection)
//     platformFeeBps      — the platform share in basis points (must be < 10 000)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error PayableMint1155Split__LengthMismatch(uint256 idsLen, uint256 pricesLen);
error PayableMint1155Split__NotMintable(uint256 id);
error PayableMint1155Split__WrongPrice(uint256 sent, uint256 expected);
error PayableMint1155Split__ZeroQty();
error PayableMint1155Split__ZeroAddress();
error PayableMint1155Split__BadPlatformBps(uint256 bps);
error PayableMint1155Split__ForwardFailed();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event PayableMint1155SplitConfigured(uint256 idsCount, address platformFeeReceiver, uint16 platformFeeBps);
event PayableMintedSplit(address indexed to, uint256 indexed id, uint256 amount, uint256 pricePaid, uint256 platformCut);
event PayableWithdrawnSplit(address indexed to, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
mapping(uint256 => uint256) private _pmsPricePerToken;
mapping(uint256 => bool) private _pmsMintable;
address private _pmsPlatformFeeReceiver;
uint16 private _pmsPlatformFeeBps;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint256[] memory ids_, uint256[] memory prices_, address feeReceiver_, uint16 feeBps_) =
        abi.decode(moduleData, (uint256[], uint256[], address, uint16));
    if (ids_.length != prices_.length) revert PayableMint1155Split__LengthMismatch(ids_.length, prices_.length);
    if (feeReceiver_ == address(0)) revert PayableMint1155Split__ZeroAddress();
    if (feeBps_ == 0 || feeBps_ >= 10_000) revert PayableMint1155Split__BadPlatformBps(feeBps_);

    for (uint256 i; i < ids_.length; ++i) {
        _pmsPricePerToken[ids_[i]] = prices_[i];
        _pmsMintable[ids_[i]] = true;
    }
    _pmsPlatformFeeReceiver = feeReceiver_;
    _pmsPlatformFeeBps = feeBps_;
    emit PayableMint1155SplitConfigured(ids_.length, feeReceiver_, feeBps_);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function mintPayable(uint256 id, uint256 amount) external payable {
    if (amount == 0) revert PayableMint1155Split__ZeroQty();
    if (!_pmsMintable[id]) revert PayableMint1155Split__NotMintable(id);
    uint256 expected = _pmsPricePerToken[id] * amount;
    if (msg.value != expected) revert PayableMint1155Split__WrongPrice(msg.value, expected);

    uint256 platformCut = (msg.value * _pmsPlatformFeeBps) / 10_000;
    if (platformCut > 0) {
        (bool ok,) = _pmsPlatformFeeReceiver.call{value: platformCut}("");
        if (!ok) revert PayableMint1155Split__ForwardFailed();
    }

    _mint(msg.sender, id, amount, "");
    emit PayableMintedSplit(msg.sender, id, amount, msg.value, platformCut);
}

function withdrawPayable(address to) external onlyOwner {
    uint256 amount = address(this).balance;
    SafeTransferLib.safeTransferETH(to, amount);
    emit PayableWithdrawnSplit(to, amount);
}

function priceOf(uint256 id) external view returns (uint256 price, bool mintable) {
    return (_pmsPricePerToken[id], _pmsMintable[id]);
}

function platformFee() external view returns (address receiver, uint16 bps) {
    return (_pmsPlatformFeeReceiver, _pmsPlatformFeeBps);
}

receive() external payable {}
