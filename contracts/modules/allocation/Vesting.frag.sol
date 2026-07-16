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
// the transfer always goes to them.
//
// Reserve-backed: at init the `totalAmount` is transferred from `mintTarget` (Router when
// launching via Router) to `address(this)`, carving the vesting pool out of the initial
// supply BEFORE the curve or direct recipient gets its tokens. Release just moves from the
// reserve to the beneficiary — supply never inflates. Init reverts (via _transfer's
// underflow revert) if the launcher tries to allocate more than mintTarget can spare.
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
    // Reserve the vesting pool out of the initial supply. If the launcher over-allocated
    // (Σ module allocations > initialSupply), this reverts inside solady's _transfer
    // when mintTarget's balance underflows — safety by construction.
    _transfer(mintTarget, address(this), total_);
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
    // Reserve-backed: pay from the pre-allocated pool on address(this), NOT via _mint.
    // Total supply stays at whatever was minted in initialize() — no post-launch inflation.
    _transfer(address(this), _vestBeneficiary, amount);
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
