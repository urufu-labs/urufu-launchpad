// SPDX-License-Identifier: MIT
// VM_MODULE_ID: Staking
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES:
// VM_MODULE_INCOMPATIBLE_WITH: FeeOnTransfer
// VM_MODULE_FLAGGED:
//
// Single-asset staking pool inlined into the token. Users transfer tokens into the
// contract to stake; rewards (denominated in the same token, lazy-minted) accrue linearly
// over `durationSeconds` starting at init. Classic Synthetix-style `rewardPerToken`
// accumulator — no compounding, no unbonding.
//
// Incompatible with `FeeOnTransfer` (fees would corrupt the staked balance accounting).
//
// Params: (uint256 rewardsTotal, uint32 durationSeconds)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error Staking__ZeroAmount();
error Staking__ZeroDuration();
error Staking__InsufficientStake(uint256 requested, uint256 available);
error Staking__NothingToClaim();

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event StakingConfigured(uint256 rewardsTotal, uint256 durationSeconds, uint256 rewardRate, uint64 periodFinish);
event Staked(address indexed user, uint256 amount);
event Withdrawn(address indexed user, uint256 amount);
event StakingRewardClaimed(address indexed user, uint256 amount);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
uint256 private _stakeRewardRate;      // tokens per second, wei
uint64 private _stakePeriodFinish;
uint64 private _stakeLastUpdate;
uint256 private _stakeRewardPerTokenStored;
uint256 private _stakeTotal;
mapping(address => uint256) private _stakeBalance;
mapping(address => uint256) private _stakeUserRewardPerTokenPaid;
mapping(address => uint256) private _stakeReward;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (uint256 rewardsTotal_, uint32 duration_) = abi.decode(moduleData, (uint256, uint32));
    if (duration_ == 0) revert Staking__ZeroDuration();
    uint256 rate = rewardsTotal_ / duration_;
    _stakeRewardRate = rate;
    _stakeLastUpdate = uint64(block.timestamp);
    _stakePeriodFinish = uint64(block.timestamp + duration_);
    emit StakingConfigured(rewardsTotal_, duration_, rate, _stakePeriodFinish);
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function stakingLastTimeApplicable() public view returns (uint64) {
    uint64 nowTs = uint64(block.timestamp);
    return nowTs < _stakePeriodFinish ? nowTs : _stakePeriodFinish;
}

function stakingRewardPerToken() public view returns (uint256) {
    if (_stakeTotal == 0) return _stakeRewardPerTokenStored;
    uint256 elapsed = stakingLastTimeApplicable() - _stakeLastUpdate;
    return _stakeRewardPerTokenStored + (elapsed * _stakeRewardRate * 1e18) / _stakeTotal;
}

function stakingEarned(address user) public view returns (uint256) {
    return (_stakeBalance[user] * (stakingRewardPerToken() - _stakeUserRewardPerTokenPaid[user])) / 1e18
        + _stakeReward[user];
}

function stakingBalanceOf(address user) external view returns (uint256) {
    return _stakeBalance[user];
}

function stakingTotalStaked() external view returns (uint256) {
    return _stakeTotal;
}

function stakingRewardRate() external view returns (uint256) {
    return _stakeRewardRate;
}

function stakingPeriodFinish() external view returns (uint64) {
    return _stakePeriodFinish;
}

function stake(uint256 amount) external {
    if (amount == 0) revert Staking__ZeroAmount();
    _stakingUpdateReward(msg.sender);
    _stakeTotal += amount;
    _stakeBalance[msg.sender] += amount;
    _transfer(msg.sender, address(this), amount);
    emit Staked(msg.sender, amount);
}

function stakingWithdraw(uint256 amount) external {
    if (amount == 0) revert Staking__ZeroAmount();
    uint256 bal = _stakeBalance[msg.sender];
    if (amount > bal) revert Staking__InsufficientStake(amount, bal);
    _stakingUpdateReward(msg.sender);
    _stakeTotal -= amount;
    _stakeBalance[msg.sender] = bal - amount;
    _transfer(address(this), msg.sender, amount);
    emit Withdrawn(msg.sender, amount);
}

function stakingClaim() external {
    _stakingUpdateReward(msg.sender);
    uint256 reward = _stakeReward[msg.sender];
    if (reward == 0) revert Staking__NothingToClaim();
    _stakeReward[msg.sender] = 0;
    _mint(msg.sender, reward);
    emit StakingRewardClaimed(msg.sender, reward);
}

// ============================================================
// SECTION: VM_INJECT_INTERNAL
// ============================================================
function _stakingUpdateReward(address user) internal {
    _stakeRewardPerTokenStored = stakingRewardPerToken();
    _stakeLastUpdate = stakingLastTimeApplicable();
    if (user != address(0)) {
        _stakeReward[user] = stakingEarned(user);
        _stakeUserRewardPerTokenPaid[user] = _stakeRewardPerTokenStored;
    }
}
