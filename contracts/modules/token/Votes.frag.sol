// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Votes
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// ERC-5805 vote checkpointing (delegate, getVotes, getPastVotes, delegateBySig) via Solady
// `ERC20Votes`. Selecting this module switches the base template from `ERC20Template` to
// `ERC20VotesTemplate` — vote tracking wires into every transfer automatically. This
// fragment itself is a marker: it emits a config event so indexers can flag the token as
// vote-capable and gate the `GovernorBundle` module.
//
// Params: none.

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event VotesEnabled();

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    moduleData;
    emit VotesEnabled();
}
