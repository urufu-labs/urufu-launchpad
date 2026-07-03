// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Soulbound
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC721A
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Non-transferable after mint. Every non-mint, non-burn transfer reverts. Owner cannot bypass —
// soulbound is by construction. Mint (from == 0) and burn (to == 0) still work.
//
// Params: none.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Soulbound__NonTransferable();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event SoulboundConfigured();

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    moduleData;
    emit SoulboundConfigured();
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
// ERC-721A hook signature: (from, to, startTokenId, quantity).
if (from != address(0) && to != address(0)) {
    revert Soulbound__NonTransferable();
}
// silence unused-var warnings for token id / quantity
startTokenId; quantity;
