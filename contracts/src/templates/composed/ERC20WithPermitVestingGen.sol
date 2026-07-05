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
contract ERC20WithPermitVestingGen is ERC20, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from Vesting.frag.sol ---
    error Vesting__ZeroBeneficiary();
    error Vesting__ZeroTotal();
    error Vesting__BadSchedule(uint64 cliff, uint64 end);
    error Vesting__NothingToRelease();
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

    // --- from Vesting.frag.sol ---
    event VestingConfigured(
        address indexed beneficiary, uint256 totalAmount, uint64 cliffTimestamp, uint64 endTimestamp
    );
    event VestingReleased(address indexed beneficiary, uint256 amount);
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
    // --- from Vesting.frag.sol ---
    address private _vestBeneficiary;
    uint256 private _vestTotal;
    uint256 private _vestReleased;
    uint64 private _vestCliff;
    uint64 private _vestEnd;
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

        // --- from Vesting.frag.sol ---
        {
            (address beneficiary_, uint256 total_, uint64 cliff_, uint64 end_) =
                abi.decode(moduleData[1], (address, uint256, uint64, uint64));
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
    // --- from Vesting.frag.sol ---
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
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
