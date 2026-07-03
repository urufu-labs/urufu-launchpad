// SPDX-License-Identifier: MIT
// VM_MODULE_ID: AntiBot
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Block-gate protection against launch snipers. For the first `blockGate` blocks after
// initialize, any transfer where the sender is NOT the owner (i.e. someone reselling to a
// downstream buyer during the gate window) reverts UNLESS the recipient is on the allowlist.
//
// Not compilable on its own — this file is spliced into `ERC20Template` by the compile
// service. Reference-composed at `contracts/src/templates/composed/ERC20WithAntiBot.sol`.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error AntiBot__Gated(address from, address to, uint256 blocksLeft);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event AntiBotConfigured(uint16 blockGate, uint256 gateEndsAtBlock);
event AntiBotAllowedSet(address indexed who, bool allowed);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint256 private _abGateEndsAtBlock;
mapping(address => bool) private _abAllowed;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
// Decode the module's slice: (uint16 blockGate).
// `_fotBps` etc from OTHER modules would live in their own slices; the compile service concatenates.
{
    uint16 blockGate = abi.decode(moduleData, (uint16));
    _abGateEndsAtBlock = block.number + uint256(blockGate);
    emit AntiBotConfigured(blockGate, _abGateEndsAtBlock);
}

// ============================================================
// SECTION: VM_INJECT_BEFORE_TRANSFER
// ============================================================
// Skip if we're past the gate.
// Skip mints (from == address(0)) and burns (to == address(0)).
// Skip if the sender is the owner (team can move tokens freely during launch).
// Otherwise: require the recipient to be on the allowlist.
if (block.number < _abGateEndsAtBlock && from != address(0) && to != address(0) && from != owner()) {
    if (!_abAllowed[to]) {
        revert AntiBot__Gated(from, to, _abGateEndsAtBlock - block.number);
    }
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function setAntiBotAllowed(address who, bool allowed) external onlyOwner {
    _abAllowed[who] = allowed;
    emit AntiBotAllowedSet(who, allowed);
}

function antiBotIsAllowed(address who) external view returns (bool) {
    return _abAllowed[who];
}

function antiBotGateEndsAtBlock() external view returns (uint256) {
    return _abGateEndsAtBlock;
}

function antiBotIsGated() external view returns (bool) {
    return block.number < _abGateEndsAtBlock;
}
