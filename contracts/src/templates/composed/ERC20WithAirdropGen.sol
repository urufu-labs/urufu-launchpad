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
contract ERC20WithAirdropGen is ERC20, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from Airdrop.frag.sol ---
    error Airdrop__AlreadyClaimed(address recipient);
    error Airdrop__InvalidProof();
    error Airdrop__ZeroAllocation();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from Airdrop.frag.sol ---
    event AirdropConfigured(bytes32 merkleRoot, uint256 totalAllocation);
    event AirdropClaimed(address indexed recipient, uint256 amount);
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
    // --- from Airdrop.frag.sol ---
    bytes32 private _airdropRoot;
    uint256 private _airdropTotalAllocation;
    uint256 private _airdropClaimedTotal;
    mapping(address => bool) private _airdropClaimed;
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

        // Compute the mint destination once, before the mint itself. Modules that need
        // to reserve a slice of the initial supply for post-launch payouts (Airdrop,
        // Vesting, Staking) reference this local via `_transfer(mintTarget, address(this),
        // allocation)` in their VM_INJECT_INIT block — this is what makes reserve-backed
        // modules work on bonding-curve launches WITHOUT breaking the fixed-supply
        // invariant. The transfers happen sequentially so an over-allocation reverts
        // loudly the moment mintTarget runs dry (safety by construction).
        address mintTarget = initialRecipient == address(0) ? initialOwner : initialRecipient;

        if (initialSupply > 0) {
            _mint(mintTarget, initialSupply);
        }

        emit Initialized(name_, symbol_, initialOwner, initialSupply);

        // ============================================================
        // VM_INJECT_INIT
        // --- from Airdrop.frag.sol ---
        {
            (bytes32 root, uint256 totalAllocation_) = abi.decode(moduleData[0], (bytes32, uint256));
            if (totalAllocation_ == 0) revert Airdrop__ZeroAllocation();
            _airdropRoot = root;
            _airdropTotalAllocation = totalAllocation_;
            // Reserve the airdrop pool out of the initial supply. Reverts inside solady's
            // _transfer when mintTarget's balance underflows — safety by construction.
            _transfer(mintTarget, address(this), totalAllocation_);
            emit AirdropConfigured(root, totalAllocation_);
        }
        // ============================================================
        // Modules decode their slice of `moduleData` here and set state. Reserve-
        // backed modules also `_transfer(mintTarget, address(this), allocation)` here.
        moduleData; // silence unused-var warning in the bare template
        mintTarget; // silence unused-var warning when no reserve-backed modules are spliced in
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
    // --- from Airdrop.frag.sol ---
    function airdropClaim(
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        if (_airdropClaimed[msg.sender]) revert Airdrop__AlreadyClaimed(msg.sender);
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProofLib.verifyCalldata(proof, _airdropRoot, leaf)) revert Airdrop__InvalidProof();
        _airdropClaimed[msg.sender] = true;
        _airdropClaimedTotal += amount;
        // Reserve-backed: pay from the pre-allocated pool on address(this), NOT via _mint.
        // Total supply stays fixed. If the launcher misconfigured (merkle sum >
        // totalAllocation) claims eventually revert here when the reserve runs dry.
        _transfer(address(this), msg.sender, amount);
        emit AirdropClaimed(msg.sender, amount);
    }

    function airdropRoot() external view returns (bytes32) {
        return _airdropRoot;
    }

    function airdropTotalAllocation() external view returns (uint256) {
        return _airdropTotalAllocation;
    }

    function airdropClaimedTotal() external view returns (uint256) {
        return _airdropClaimedTotal;
    }

    function airdropHasClaimed(
        address user
    ) external view returns (bool) {
        return _airdropClaimed[user];
    }
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
