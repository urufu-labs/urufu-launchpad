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

/// @title  ERC20Template
/// @notice Bare ERC-20 base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below. The bare
///         template compiles and passes tests on its own — modules are additive.
/// @dev    See docs/SPEC-templates.md.
///         Marker convention: every `VM_INJECT_X` marker sits at the BOTTOM of its section,
///         so spliced module content is appended after any existing base content. This makes
///         storage layout safe by construction (base storage frozen; module storage appended).
contract ERC20WithAntiWhaleGen is ERC20, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC20Template__AlreadyInitialized();
    error ERC20Template__ZeroOwner();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from AntiWhale.frag.sol ---
    error AntiWhale__MaxTxExceeded(uint256 amount, uint256 cap);
    error AntiWhale__MaxWalletExceeded(uint256 wouldBe, uint256 cap);
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 initialSupply);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from AntiWhale.frag.sol ---
    event AntiWhaleConfigured(uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock);
    event AntiWhaleExcludedSet(address indexed who, bool excluded);
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
    // --- from AntiWhale.frag.sol ---
    uint128 private _awMaxWallet;
    uint128 private _awMaxTx;
    uint32 private _awExpiresAtBlock;
    mapping(address => bool) private _awExcluded;
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
        // --- from AntiWhale.frag.sol ---
        {
            (uint128 maxWallet, uint128 maxTx, uint32 expireAfter) =
                abi.decode(moduleData[0], (uint128, uint128, uint32));
            _awMaxWallet = maxWallet;
            _awMaxTx = maxTx;
            _awExpiresAtBlock = uint32(block.number) + expireAfter;
            _awExcluded[initialOwner] = true;
            emit AntiWhaleConfigured(maxWallet, maxTx, _awExpiresAtBlock);
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
        // --- from AntiWhale.frag.sol ---
        // Skip if past expiry OR mint/burn OR either side excluded.
        if (
            block.number < uint256(_awExpiresAtBlock) && from != address(0) && to != address(0) && !_awExcluded[from]
                && !_awExcluded[to]
        ) {
            if (amount > uint256(_awMaxTx)) {
                revert AntiWhale__MaxTxExceeded(amount, uint256(_awMaxTx));
            }
            uint256 postBalance = balanceOf(to) + amount;
            if (postBalance > uint256(_awMaxWallet)) {
                revert AntiWhale__MaxWalletExceeded(postBalance, uint256(_awMaxWallet));
            }
        }
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
    // --- from AntiWhale.frag.sol ---
    function setAntiWhaleExcluded(
        address who,
        bool excluded
    ) external onlyOwner {
        _awExcluded[who] = excluded;
        emit AntiWhaleExcludedSet(who, excluded);
    }

    function antiWhaleConfig() external view returns (uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock) {
        return (_awMaxWallet, _awMaxTx, _awExpiresAtBlock);
    }

    function antiWhaleIsExcluded(
        address who
    ) external view returns (bool) {
        return _awExcluded[who];
    }

    function antiWhaleIsActive() external view returns (bool) {
        return block.number < uint256(_awExpiresAtBlock);
    }
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
