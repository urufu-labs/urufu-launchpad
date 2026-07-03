// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC20Votes} from "solady/tokens/ERC20Votes.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments.
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {VMGovernor} from "src/governance/VMGovernor.sol";

/// @title  ERC20VotesTemplate
/// @notice ERC-5805-compatible ERC-20 base for the VM launchpad. Identical shape to
///         `ERC20Template` but inherits Solady `ERC20Votes` so checkpoint tracking is on
///         every transfer. Chosen as the base for any launch that stacks the `Votes` module
///         (and, downstream, `GovernorBundle`). Splicer marker convention is unchanged.
/// @dev    Storage layout is base-frozen. `_afterTokenTransfer` calls `super._afterTokenTransfer`
///         so vote checkpointing runs BEFORE any spliced after-transfer hooks — modules that
///         also add after-transfer logic (e.g. FeeOnTransfer) run their bodies afterward.
contract ERC20WithGovernorBundleGen is ERC20Votes, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from GovernorBundle.frag.sol ---
    error GovernorBundle__BadQuorum(uint256 numerator);
    // ============================================================

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from GovernorBundle.frag.sol ---
    event GovernorBundleDeployed(address indexed governor, address indexed timelock);

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
    // --- from GovernorBundle.frag.sol ---
    address private _govGovernor;
    address private _govTimelock;
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

        if (initialSupply > 0) {
            address to = initialRecipient == address(0) ? initialOwner : initialRecipient;
            _mint(to, initialSupply);
        }

        emit Initialized(name_, symbol_, initialOwner, initialSupply);

        // ============================================================
        // VM_INJECT_INIT
        // --- from GovernorBundle.frag.sol ---
        {
            (
                uint48 votingDelay_,
                uint32 votingPeriod_,
                uint256 proposalThreshold_,
                uint256 quorumNumerator_,
                uint256 timelockMinDelay_
            ) = abi.decode(moduleData[0], (uint48, uint32, uint256, uint256, uint256));
            if (quorumNumerator_ == 0 || quorumNumerator_ > 100) revert GovernorBundle__BadQuorum(quorumNumerator_);

            address[] memory proposers = new address[](0);
            address[] memory executors = new address[](1);
            executors[0] = address(0); // anyone can execute after delay

            TimelockController tlc = new TimelockController(
                timelockMinDelay_,
                proposers,
                executors,
                address(this) // temp admin so we can grant roles to Governor
            );

            VMGovernor gov = new VMGovernor(
                IVotes(address(this)), tlc, votingDelay_, votingPeriod_, proposalThreshold_, quorumNumerator_
            );

            tlc.grantRole(tlc.PROPOSER_ROLE(), address(gov));
            tlc.grantRole(tlc.CANCELLER_ROLE(), address(gov));
            tlc.renounceRole(tlc.DEFAULT_ADMIN_ROLE(), address(this));

            _govGovernor = address(gov);
            _govTimelock = address(tlc);
            emit GovernorBundleDeployed(address(gov), address(tlc));
        }

        // --- from Votes.frag.sol ---
        {
            moduleData[1];
            emit VotesEnabled();
        }
        // ============================================================
        moduleData;
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
    // --- from GovernorBundle.frag.sol ---
    function governor() external view returns (address) {
        return _govGovernor;
    }

    function timelock() external view returns (address) {
        return _govTimelock;
    }
    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
}
