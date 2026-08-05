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
contract ERC20WithAntiBotVotesGen is ERC20Votes, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from AntiBot.frag.sol ---
    error AntiBot__Gated(address from, address to, uint256 blocksLeft);
    // ============================================================

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from AntiBot.frag.sol ---
    event AntiBotConfigured(uint16 blockGate, uint256 gateEndsAtBlock);
    event AntiBotAllowedSet(address indexed who, bool allowed);

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
    // --- from AntiBot.frag.sol ---
    uint256 private _abGateEndsAtBlock;
    mapping(address => bool) private _abAllowed;
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
        // --- from AntiBot.frag.sol ---
        // Decode the module's slice: (uint16 blockGate).
        // `_fotBps` etc from OTHER modules would live in their own slices; the compile service concatenates.
        {
            uint16 blockGate = abi.decode(moduleData[0], (uint16));
            _abGateEndsAtBlock = block.number + uint256(blockGate);
            emit AntiBotConfigured(blockGate, _abGateEndsAtBlock);
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
        // --- from AntiBot.frag.sol ---
        // Skip if we're past the gate.
        // Skip mints (from == address(0)) and burns (to == address(0)).
        // Skip if the sender is the owner (team can move tokens freely during launch).
        // Otherwise: allow if EITHER endpoint is on the allowlist. Buyer-only
        // check would revert every curve→buyer trade during the gate (the buyer
        // isn't allowlisted by default). Either-endpoint matches the deployed
        // composed body — regenerating from the buyer-only form would silently
        // break primary-market trading. Same rule catches Graduator + PoolManager
        // during the graduation handoff without pre-registering every counterparty.
        if (block.number < _abGateEndsAtBlock && from != address(0) && to != address(0) && from != owner()) {
            if (!_abAllowed[from] && !_abAllowed[to]) {
                revert AntiBot__Gated(from, to, _abGateEndsAtBlock - block.number);
            }
        }
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
    // --- from AntiBot.frag.sol ---
    function setAntiBotAllowed(
        address who,
        bool allowed
    ) external onlyOwner {
        _abAllowed[who] = allowed;
        emit AntiBotAllowedSet(who, allowed);
    }

    function antiBotIsAllowed(
        address who
    ) external view returns (bool) {
        return _abAllowed[who];
    }

    function antiBotGateEndsAtBlock() external view returns (uint256) {
        return _abGateEndsAtBlock;
    }

    function antiBotIsGated() external view returns (bool) {
        return block.number < _abGateEndsAtBlock;
    }
    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
}
