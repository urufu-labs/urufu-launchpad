// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Vesting
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Single-beneficiary linear vesting schedule stored on the token. `totalAmount` tokens
// vest linearly from `cliffTimestamp` through `endTimestamp`. Before the cliff nothing is
// releasable. Anyone can trigger `vestingRelease()` — the beneficiary is fixed at init and
// the mint always goes to them. Tokens are lazy-minted at release time (they do not exist
// in supply until claimed), so the launch's initial supply does NOT need to include the
// vesting pool.
//
// Params: (address beneficiary, uint256 totalAmount, uint64 cliffTimestamp, uint64 endTimestamp)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Vesting__ZeroBeneficiary();
error Vesting__ZeroTotal();
error Vesting__BadSchedule(uint64 cliff, uint64 end);
error Vesting__NothingToRelease();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event VestingConfigured(address indexed beneficiary, uint256 totalAmount, uint64 cliffTimestamp, uint64 endTimestamp);
event VestingReleased(address indexed beneficiary, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
address private _vestBeneficiary;
uint256 private _vestTotal;
uint256 private _vestReleased;
uint64 private _vestCliff;
uint64 private _vestEnd;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (address beneficiary_, uint256 total_, uint64 cliff_, uint64 end_) =
        abi.decode(moduleData, (address, uint256, uint64, uint64));
    if (beneficiary_ == address(0)) revert Vesting__ZeroBeneficiary();
    if (total_ == 0) revert Vesting__ZeroTotal();
    if (end_ <= cliff_) revert Vesting__BadSchedule(cliff_, end_);
    _vestBeneficiary = beneficiary_;
    _vestTotal = total_;
    _vestCliff = cliff_;
    _vestEnd = end_;
    emit VestingConfigured(beneficiary_, total_, cliff_, end_);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function vestingReleasable() public view returns (uint256) {
    uint64 nowTs = uint64(block.timestamp);
    if (nowTs < _vestCliff) return 0;
    uint256 vested;
    if (nowTs >= _vestEnd) {
        vested = _vestTotal;
    } else {
        uint256 elapsed = nowTs - _vestCliff;
        uint256 duration = _vestEnd - _vestCliff;
        vested = (_vestTotal * elapsed) / duration;
    }
    return vested - _vestReleased;
}

function vestingRelease() external {
    uint256 amount = vestingReleasable();
    if (amount == 0) revert Vesting__NothingToRelease();
    _vestReleased += amount;
    _mint(_vestBeneficiary, amount);
    emit VestingReleased(_vestBeneficiary, amount);
}

function vestingBeneficiary() external view returns (address) {
    return _vestBeneficiary;
}

function vestingTotal() external view returns (uint256) {
    return _vestTotal;
}

function vestingReleased() external view returns (uint256) {
    return _vestReleased;
}

function vestingCliffTimestamp() external view returns (uint64) {
    return _vestCliff;
}

function vestingEndTimestamp() external view returns (uint64) {
    return _vestEnd;
}
