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
contract ERC20WithFoTPermitGen is ERC20, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from FeeOnTransfer.frag.sol ---
    error FeeOnTransfer__InvalidFeeBps(uint16 feeBps);
    error FeeOnTransfer__InvalidSplits(uint16 burnBps, uint16 treasuryBps);
    error FeeOnTransfer__ZeroTreasury();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from FeeOnTransfer.frag.sol ---
    event FeeOnTransferConfigured(uint16 feeBps, uint16 burnBps, uint16 treasuryBps, address treasury);
    event FeeOnTransferExcludedSet(address indexed who, bool excluded);
    event FeeOnTransferTaken(address indexed from, address indexed to, uint256 fee, uint256 burned, uint256 toTreasury);

    // --- from Permit.frag.sol ---
    event PermitEnabled();
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
    // --- from FeeOnTransfer.frag.sol ---
    uint16 private _fotFeeBps;
    uint16 private _fotBurnBps;
    uint16 private _fotTreasuryBps;
    address private _fotTreasury;
    mapping(address => bool) private _fotExcluded;
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
        // --- from FeeOnTransfer.frag.sol ---
        {
            (uint16 feeBps, uint16 burnBps, uint16 treasuryBps, address treasury) =
                abi.decode(moduleData[0], (uint16, uint16, uint16, address));

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

        // --- from Permit.frag.sol ---
        {
            moduleData[1];
            emit PermitEnabled();
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
        // --- from FeeOnTransfer.frag.sol ---
        // Skip mints, burns, and excluded transfers. Recursive _burn/_mint from below fire with a
        // zero from/to, so this check naturally guards against re-entry.
        if (from != address(0) && to != address(0) && !_fotExcluded[from] && !_fotExcluded[to]) {
            uint256 fee = (amount * _fotFeeBps) / 10_000;
            if (fee > 0) {
                _burn(to, fee);
                uint256 toTreasury = (fee * _fotTreasuryBps) / 10_000;
                if (toTreasury > 0) _mint(_fotTreasury, toTreasury);
                emit FeeOnTransferTaken(from, to, fee, fee - toTreasury, toTreasury);
            }
        }
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from FeeOnTransfer.frag.sol ---
    function setFeeOnTransferExcluded(
        address who,
        bool excluded
    ) external onlyOwner {
        _fotExcluded[who] = excluded;
        emit FeeOnTransferExcludedSet(who, excluded);
    }

    function feeOnTransferBps() external view returns (uint16 feeBps, uint16 burnBps, uint16 treasuryBps) {
        return (_fotFeeBps, _fotBurnBps, _fotTreasuryBps);
    }

    function feeOnTransferTreasury() external view returns (address) {
        return _fotTreasury;
    }

    function feeOnTransferIsExcluded(
        address who
    ) external view returns (bool) {
        return _fotExcluded[who];
    }
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
