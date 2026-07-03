// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Pausable
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED: reduces decentralization — owner can freeze all transfers
//
// Owner can pause all transfers between non-owner addresses. Mint / burn / owner-initiated
// transfers stay unblocked so the team can still ship even when trading is off.
//
// Flagged in the UI — pause is a censorship vector. Recommend timelock or renounced owner.
//
// Params: none.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Pausable__Paused();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event PausableSet(bool paused);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
bool private _pausablePaused;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    // no params — starts unpaused
    moduleData;
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
if (_pausablePaused && from != address(0) && to != address(0) && from != owner()) {
    revert Pausable__Paused();
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function pause() external onlyOwner {
    _pausablePaused = true;
    emit PausableSet(true);
}

function unpause() external onlyOwner {
    _pausablePaused = false;
    emit PausableSet(false);
}

function pausablePaused() external view returns (bool) {
    return _pausablePaused;
}
