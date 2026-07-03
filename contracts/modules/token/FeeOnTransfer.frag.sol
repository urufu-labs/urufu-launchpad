// SPDX-License-Identifier: MIT
// VM_MODULE_ID: FeeOnTransfer
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Take a percentage fee on every real transfer. Fee is split between burn (reduces total supply)
// and treasury (transferred to a fixed address). Excluded addresses (owner, LP pool, treasury
// itself) bypass the fee.
//
// Implementation: on `_afterTokenTransfer(from, to, amount)`, if this is a real user-to-user
// transfer (from != 0, to != 0, neither is excluded), take fee from the RECIPIENT via `_burn` and
// re-mint the treasury portion. The burn slice stays burned (net supply reduction). Recipient
// effectively receives `amount - fee`.
//
// Recursion safety: the `_burn(to, fee)` and `_mint(treasury, split)` calls fire the hooks again
// with either `from == 0` or `to == 0`, so this module's own hook checks (`from != 0 && to != 0`)
// naturally exclude those recursive calls. No explicit guard needed.
//
// Not compilable on its own — spliced into `ERC20Template` by the compile service.

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error FeeOnTransfer__InvalidFeeBps(uint16 feeBps);
error FeeOnTransfer__InvalidSplits(uint16 burnBps, uint16 treasuryBps);
error FeeOnTransfer__ZeroTreasury();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event FeeOnTransferConfigured(uint16 feeBps, uint16 burnBps, uint16 treasuryBps, address treasury);
event FeeOnTransferExcludedSet(address indexed who, bool excluded);
event FeeOnTransferTaken(address indexed from, address indexed to, uint256 fee, uint256 burned, uint256 toTreasury);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint16 private _fotFeeBps;
uint16 private _fotBurnBps;
uint16 private _fotTreasuryBps;
address private _fotTreasury;
mapping(address => bool) private _fotExcluded;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint16 feeBps, uint16 burnBps, uint16 treasuryBps, address treasury) =
        abi.decode(moduleData, (uint16, uint16, uint16, address));

    if (feeBps == 0 || feeBps > 3000) revert FeeOnTransfer__InvalidFeeBps(feeBps);
    if (uint256(burnBps) + uint256(treasuryBps) != 10_000) {
        revert FeeOnTransfer__InvalidSplits(burnBps, treasuryBps);
    }
    if (treasuryBps > 0 && treasury == address(0)) revert FeeOnTransfer__ZeroTreasury();

    _fotFeeBps = feeBps;
    _fotBurnBps = burnBps;
    _fotTreasuryBps = treasuryBps;
    _fotTreasury = treasury;

    // Exclude owner and treasury from fees so team ops and treasury sweeps don't self-tax.
    _fotExcluded[initialOwner] = true;
    if (treasury != address(0)) _fotExcluded[treasury] = true;

    emit FeeOnTransferConfigured(feeBps, burnBps, treasuryBps, treasury);
}

// ============================================================
// SECTION: VM_INJECT_AFTER_TRANSFER
// ============================================================
// Skip mints, burns, and excluded transfers. Recursive _burn/_mint from below fire with a
// zero from/to, so this check naturally guards against re-entry.
if (from != address(0) && to != address(0) && !_fotExcluded[from] && !_fotExcluded[to]) {
    uint256 fee = (amount * _fotFeeBps) / 10_000;
    if (fee > 0) {
        _burn(to, fee);
        uint256 toTreasury = (fee * _fotTreasuryBps) / 10_000;
        if (toTreasury > 0) _mint(_fotTreasury, toTreasury);
        emit FeeOnTransferTaken(from, to, fee, fee - toTreasury, toTreasury);
    }
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function setFeeOnTransferExcluded(address who, bool excluded) external onlyOwner {
    _fotExcluded[who] = excluded;
    emit FeeOnTransferExcludedSet(who, excluded);
}

function feeOnTransferBps() external view returns (uint16 feeBps, uint16 burnBps, uint16 treasuryBps) {
    return (_fotFeeBps, _fotBurnBps, _fotTreasuryBps);
}

function feeOnTransferTreasury() external view returns (address) {
    return _fotTreasury;
}

function feeOnTransferIsExcluded(address who) external view returns (bool) {
    return _fotExcluded[who];
}
