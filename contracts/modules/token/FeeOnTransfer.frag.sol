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
// transfer (from != 0, to != 0, neither is excluded), take fee from the RECIPIENT — the burn
// portion via `_burn(to, ...)` and the treasury portion via `_transfer(to, treasury, ...)`.
// Recipient effectively receives `amount - fee`. Net supply change per taxed transfer:
// exactly `-burnPortion` (treasury portion is a transfer, NOT a mint).
//
// Prior version re-minted the treasury portion via `_mint(treasury, split)`, which
// silently increased total supply on every taxed transfer and violated the fixed-supply
// invariant the ERC-20 templates advertise. Fixed by transferring from the recipient
// instead of minting fresh.
//
// Recursion safety: the `_burn(to, ...)` call fires the hooks with `to == address(0)`,
// naturally skipped by this module's `to != address(0)` guard. The `_transfer(to, treasury, ...)`
// call fires with `treasury` as the recipient — treasury is inserted into `_fotExcluded`
// at init, so the hook's `!_fotExcluded[to]` guard also skips it. No explicit re-entry guard needed.
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
        uint256 toTreasury = (fee * _fotTreasuryBps) / 10_000;
        uint256 toBurn = fee - toTreasury;
        // Burn the burn slice first (net supply reduction). Fires the hook
        // recursively with `to == 0`, naturally skipped by our from/to != 0 guard.
        if (toBurn > 0) _burn(to, toBurn);
        // Transfer the treasury slice from the recipient's balance, NOT mint. This
        // preserves the fixed-supply invariant — only the burn portion reduces
        // supply, and the treasury portion is redistributed from recipient. The
        // recursive hook fires with `to = treasury`, skipped by `!_fotExcluded[treasury]`
        // (treasury is added to the excluded set at init).
        if (toTreasury > 0) _transfer(to, _fotTreasury, toTreasury);
        emit FeeOnTransferTaken(from, to, fee, toBurn, toTreasury);
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
