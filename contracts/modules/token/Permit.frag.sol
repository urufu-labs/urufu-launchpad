// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Permit
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// ERC-2612 permit — gasless approvals via EIP-712 signatures. Solady's ERC20 already exposes
// `permit`, `DOMAIN_SEPARATOR`, and `nonces` on every launched token, so this fragment is a
// documentation marker: emits a config event so indexers can flag the token as permit-capable.
//
// Params: none.

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event PermitEnabled();

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    moduleData;
    emit PermitEnabled();
}
