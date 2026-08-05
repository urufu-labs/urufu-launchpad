// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    this token was deployed with urufu labs.  once graduation
 *    hits, liquidity locks forever  ❤  and every trade after
 *    that rewards urufu gemu nft holders.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC20Votes} from "solady/tokens/ERC20Votes.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments.
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title  ERC20VotesTemplate
/// @notice ERC-5805-compatible ERC-20 base for the VM launchpad. Identical shape to
///         `ERC20Template` but inherits Solady `ERC20Votes` so checkpoint tracking is on
///         every transfer. Chosen as the base for any launch that stacks the `Votes` module
///         (and, downstream, `GovernorBundle`). Splicer marker convention is unchanged.
/// @dev    Storage layout is base-frozen. `_afterTokenTransfer` calls `super._afterTokenTransfer`
///         so vote checkpointing runs BEFORE any spliced after-transfer hooks — modules that
///         also add after-transfer logic (e.g. FeeOnTransfer) run their bodies afterward.
contract ERC20WithStakingVotesGen is ERC20Votes, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from Staking.frag.sol ---
    error Staking__ZeroAmount();
    error Staking__ZeroDuration();
    error Staking__InsufficientStake(uint256 requested, uint256 available);
    error Staking__NothingToClaim();
    // ============================================================

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from Staking.frag.sol ---
    event StakingConfigured(uint256 rewardsTotal, uint256 durationSeconds, uint256 rewardRate, uint64 periodFinish);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event StakingRewardClaimed(address indexed user, uint256 amount);

    // --- from Votes.frag.sol ---
    event VotesEnabled();
    // ============================================================

    // ============================================================
    // Base storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _name;
    string private _symbol;
    uint8 private _initialized;

    // ============================================================
    // VM_INJECT_STATE
    // --- from Staking.frag.sol ---
    uint256 private _stakeRewardRate; // tokens per second, wei
    uint64 private _stakePeriodFinish;
    uint64 private _stakeLastUpdate;
    uint256 private _stakeRewardPerTokenStored;
    uint256 private _stakeTotal;
    mapping(address => uint256) private _stakeBalance;
    mapping(address => uint256) private _stakeUserRewardPerTokenPaid;
    mapping(address => uint256) private _stakeReward;
    // ============================================================

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================

    // ============================================================
    // ERC-20 metadata
    // ============================================================

    function name() public view virtual override returns (string memory) {
        return _name;
    }

    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC20Template__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            string memory name_,
            string memory symbol_,
            uint256 initialSupply,
            address initialRecipient,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, string, string, uint256, address, bytes[]));

        if (initialOwner == address(0)) revert ERC20Template__ZeroOwner();

        _name = name_;
        _symbol = symbol_;
        _initializeOwner(initialOwner);

        // Compute the mint destination once. Fragments reference `mintTarget` when they
        // need to reserve a slice of the initial supply for post-launch payouts (see
        // ERC20Template.sol for the pattern explanation).
        address mintTarget = initialRecipient == address(0) ? initialOwner : initialRecipient;

        if (initialSupply > 0) {
            _mint(mintTarget, initialSupply);
        }

        emit Initialized(name_, symbol_, initialOwner, initialSupply);

        // ============================================================
        // VM_INJECT_INIT
        // --- from Staking.frag.sol ---
        {
            (uint256 rewardsTotal_, uint32 duration_) = abi.decode(moduleData[0], (uint256, uint32));
            if (duration_ == 0) revert Staking__ZeroDuration();
            uint256 rate = rewardsTotal_ / duration_;
            _stakeRewardRate = rate;
            _stakeLastUpdate = uint64(block.timestamp);
            _stakePeriodFinish = uint64(block.timestamp + duration_);
            // Reserve the reward pool out of the initial supply. Reverts inside solady's
            // _transfer when mintTarget's balance underflows — safety by construction. rate
            // is naturally capped at `rewardsTotal_ / duration`, so total reward payouts
            // over the full window are bounded by `rewardsTotal_`.
            if (rewardsTotal_ > 0) {
                _transfer(mintTarget, address(this), rewardsTotal_);
            }
            emit StakingConfigured(rewardsTotal_, duration_, rate, _stakePeriodFinish);
        }

        // --- from Votes.frag.sol ---
        {
            moduleData[1];
            emit VotesEnabled();
        }
        // ============================================================
        moduleData;
        mintTarget;
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount);
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // ============================================================
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        // ERC20Votes checkpointing must run every transfer — do NOT reorder or drop this.
        super._afterTokenTransfer(from, to, amount);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
    }

    // ============================================================
    // OZ IVotes shim — OZ Governor calls `getPastTotalSupply(t)`; Solady names it
    // `getPastVotesTotalSupply(t)`. Forward one to the other so the token is a drop-in
    // votes source for `VMGovernor`.
    // ============================================================
    function getPastTotalSupply(
        uint256 timepoint
    ) external view returns (uint256) {
        return getPastVotesTotalSupply(timepoint);
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from Staking.frag.sol ---
    function stakingLastTimeApplicable() public view returns (uint64) {
        uint64 nowTs = uint64(block.timestamp);
        return nowTs < _stakePeriodFinish ? nowTs : _stakePeriodFinish;
    }

    function stakingRewardPerToken() public view returns (uint256) {
        if (_stakeTotal == 0) return _stakeRewardPerTokenStored;
        uint256 elapsed = stakingLastTimeApplicable() - _stakeLastUpdate;
        return _stakeRewardPerTokenStored + (elapsed * _stakeRewardRate * 1e18) / _stakeTotal;
    }

    function stakingEarned(
        address user
    ) public view returns (uint256) {
        return (_stakeBalance[user] * (stakingRewardPerToken() - _stakeUserRewardPerTokenPaid[user])) / 1e18
            + _stakeReward[user];
    }

    function stakingBalanceOf(
        address user
    ) external view returns (uint256) {
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

    function stake(
        uint256 amount
    ) external {
        if (amount == 0) revert Staking__ZeroAmount();
        _stakingUpdateReward(msg.sender);
        _stakeTotal += amount;
        _stakeBalance[msg.sender] += amount;
        _transfer(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function stakingWithdraw(
        uint256 amount
    ) external {
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
        // Reserve-backed: pay from the pre-allocated pool on address(this), NOT via _mint.
        // Total supply stays fixed. Stakers' deposits also live in address(this) but are
        // tracked separately via _stakeBalance so they can't be paid out as rewards.
        _transfer(address(this), msg.sender, reward);
        emit StakingRewardClaimed(msg.sender, reward);
    }

    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // --- from Staking.frag.sol ---
    function _stakingUpdateReward(
        address user
    ) internal {
        _stakeRewardPerTokenStored = stakingRewardPerToken();
        _stakeLastUpdate = stakingLastTimeApplicable();
        if (user != address(0)) {
            _stakeReward[user] = stakingEarned(user);
            _stakeUserRewardPerTokenPaid[user] = _stakeRewardPerTokenStored;
        }
    }
    // ============================================================
}
