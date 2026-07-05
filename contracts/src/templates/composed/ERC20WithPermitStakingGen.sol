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
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments. Unused-in-bare warnings are harmless.
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

/// @title  ERC20Template
/// @notice Bare ERC-20 base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below. The bare
///         template compiles and passes tests on its own — modules are additive.
/// @dev    See docs/SPEC-templates.md.
///         Marker convention: every `VM_INJECT_X` marker sits at the BOTTOM of its section,
///         so spliced module content is appended after any existing base content. This makes
///         storage layout safe by construction (base storage frozen; module storage appended).
contract ERC20WithPermitStakingGen is ERC20, Ownable {
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
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from Permit.frag.sol ---
    event PermitEnabled();

    // --- from Staking.frag.sol ---
    event StakingConfigured(uint256 rewardsTotal, uint256 durationSeconds, uint256 rewardRate, uint64 periodFinish);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event StakingRewardClaimed(address indexed user, uint256 amount);
    // ============================================================
    // Modules append events below this marker.

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
    // Modules append storage variables below this marker. Solidity assigns slots by
    // declaration order → module slots are strictly after base slots.

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================
    // Modules append constants / immutables below this marker.

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

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, name, symbol, initialSupply, initialRecipient, moduleData)`.
    ///         Factory forces `initialOwner = router` so Router can dispatch to the launcher's
    ///         chosen `OwnershipMode` post-initialize. `moduleData` is opaque to the base and
    ///         gets decoded per-module at `VM_INJECT_INIT`.
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

        if (initialSupply > 0) {
            address to = initialRecipient == address(0) ? initialOwner : initialRecipient;
            _mint(to, initialSupply);
        }

        emit Initialized(name_, symbol_, initialOwner, initialSupply);

        // ============================================================
        // VM_INJECT_INIT
        // --- from Permit.frag.sol ---
        {
            moduleData[0];
            emit PermitEnabled();
        }

        // --- from Staking.frag.sol ---
        {
            (uint256 rewardsTotal_, uint32 duration_) = abi.decode(moduleData[1], (uint256, uint32));
            if (duration_ == 0) revert Staking__ZeroDuration();
            uint256 rate = rewardsTotal_ / duration_;
            _stakeRewardRate = rate;
            _stakeLastUpdate = uint64(block.timestamp);
            _stakePeriodFinish = uint64(block.timestamp + duration_);
            emit StakingConfigured(rewardsTotal_, duration_, rate, _stakePeriodFinish);
        }
        // ============================================================
        // Modules decode their slice of `moduleData` here and set state.
        moduleData; // silence unused-var warning in the bare template
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================
    // Modules append modifiers below this marker.

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount); // silence unused-var warnings in bare template
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // ============================================================
        // Modules append before-transfer hook bodies below this marker.
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        (from, to, amount);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
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
        _mint(msg.sender, reward);
        emit StakingRewardClaimed(msg.sender, reward);
    }

    // ============================================================
    // Modules append new external / public functions below this marker.

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
    // Modules append internal helpers below this marker.
}
