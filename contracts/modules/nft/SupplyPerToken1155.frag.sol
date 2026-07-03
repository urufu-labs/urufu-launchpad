// SPDX-License-Identifier: MIT
// VM_MODULE_ID: SupplyPerToken1155
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC1155
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Per-token-ID max supply cap. The launcher declares up to N token IDs at init, each with a
// hard supply ceiling. Every subsequent `mint`/`mintBatch` call checks the running total
// against the ceiling for each id — reverts if any single id would exceed.
//
// This is the "collection" primitive: use it to enforce "1000 of each of 5 items" or similar.
// Ids without a declared cap default to unlimited (matches bare template behavior).
//
// Params: `(uint256[] ids, uint256[] caps)` — must be equal-length; ids are the specific
//         token IDs to cap; caps are the max supply for each. All params are immutable
//         post-init.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error SupplyPerToken1155__LengthMismatch(uint256 idsLen, uint256 capsLen);
error SupplyPerToken1155__ExceedsCap(uint256 id, uint256 requested, uint256 remaining);
error SupplyPerToken1155__ZeroCap(uint256 id);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event SupplyPerToken1155Configured(uint256 idsCount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
mapping(uint256 => uint256) private _sptCap;
mapping(uint256 => uint256) private _sptMinted;
mapping(uint256 => bool) private _sptHasCap;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint256[] memory ids_, uint256[] memory caps_) = abi.decode(moduleData, (uint256[], uint256[]));
    if (ids_.length != caps_.length) revert SupplyPerToken1155__LengthMismatch(ids_.length, caps_.length);
    for (uint256 i; i < ids_.length; ++i) {
        if (caps_[i] == 0) revert SupplyPerToken1155__ZeroCap(ids_[i]);
        _sptCap[ids_[i]] = caps_[i];
        _sptHasCap[ids_[i]] = true;
    }
    emit SupplyPerToken1155Configured(ids_.length);
}

// ============================================================
// SECTION: VM_INJECT_AFTER_TRANSFER
// ============================================================
if (from == address(0)) {
    for (uint256 i; i < ids.length; ++i) {
        if (_sptHasCap[ids[i]]) {
            uint256 minted = _sptMinted[ids[i]] + amounts[i];
            uint256 cap = _sptCap[ids[i]];
            if (minted > cap) revert SupplyPerToken1155__ExceedsCap(ids[i], amounts[i], cap - _sptMinted[ids[i]]);
            _sptMinted[ids[i]] = minted;
        }
    }
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function supplyCapOf(uint256 id) external view returns (uint256 cap, bool capped) {
    return (_sptCap[id], _sptHasCap[id]);
}

function totalMintedOf(uint256 id) external view returns (uint256) {
    return _sptMinted[id];
}

function remainingSupplyOf(uint256 id) external view returns (uint256) {
    if (!_sptHasCap[id]) return type(uint256).max;
    uint256 cap = _sptCap[id];
    uint256 minted = _sptMinted[id];
    return cap > minted ? cap - minted : 0;
}
