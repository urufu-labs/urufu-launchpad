// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC1155} from "solady/tokens/ERC1155.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Pre-emptively pulled in for common module fragments. Unused-in-bare warnings are harmless.
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title  ERC1155Template
/// @notice Bare ERC-1155 base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below.
/// @dev    See docs/SPEC-templates.md.
///         Marker convention: every `VM_INJECT_X` marker sits at the BOTTOM of its section —
///         modules append after base content.
contract ERC1155WithRoyaltyGen is ERC1155, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC1155Template__AlreadyInitialized();
    error ERC1155Template__ZeroOwner();
    error ERC1155Template__ZeroAmount();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from ERC2981Royalty1155.frag.sol ---
    error ERC2981Royalty1155__FeeTooHigh(uint96 feeBps);
    error ERC2981Royalty1155__ZeroReceiver();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, string uri, address indexed initialOwner);
    event URISet(string oldURI, string newURI);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from ERC2981Royalty1155.frag.sol ---
    event ERC2981Royalty1155Configured(address receiver, uint96 feeBps);
    // ============================================================
    // Modules append events below this marker.

    // ============================================================
    // Base storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _vmName;
    string private _vmSymbol;
    string private _vmURI;
    uint8 private _initialized;

    // ============================================================
    // VM_INJECT_STATE
    // --- from ERC2981Royalty1155.frag.sol ---
    address private _royaltyReceiver;
    uint96 private _royaltyFeeBps;

    // ============================================================
    // Modules append storage variables below this marker.

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================
    // Modules append constants / immutables below this marker.

    // ============================================================
    // ERC-1155 metadata overrides
    // ============================================================

    /// @notice ERC-1155 URI template. Clients replace `{id}` with the hex-padded token id.
    ///         Same URI returned for every id (canonical ERC-1155 behavior); per-id URIs land
    ///         via a module override in `VM_INJECT_EXTERNAL`.
    function uri(
        uint256 /* id */
    ) public view virtual override returns (string memory) {
        return _vmURI;
    }

    /// @notice Non-standard convenience — many marketplaces display it, so expose it.
    function name() external view returns (string memory) {
        return _vmName;
    }

    function symbol() external view returns (string memory) {
        return _vmSymbol;
    }

    /// @notice Owner-only URI template setter.
    function setURI(
        string calldata newURI
    ) external onlyOwner {
        emit URISet(_vmURI, newURI);
        _vmURI = newURI;
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, name, symbol, uri, moduleData)`.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC1155Template__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            string memory name_,
            string memory symbol_,
            string memory uri_,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, string, string, string, bytes[]));

        if (initialOwner == address(0)) revert ERC1155Template__ZeroOwner();

        _vmName = name_;
        _vmSymbol = symbol_;
        _vmURI = uri_;
        _initializeOwner(initialOwner);

        emit Initialized(name_, symbol_, uri_, initialOwner);

        // ============================================================
        // VM_INJECT_INIT
        // --- from ERC2981Royalty1155.frag.sol ---
        {
            (address receiver_, uint96 feeBps_) = abi.decode(moduleData[0], (address, uint96));
            if (receiver_ == address(0)) revert ERC2981Royalty1155__ZeroReceiver();
            if (feeBps_ > 1000) revert ERC2981Royalty1155__FeeTooHigh(feeBps_); // 10% cap
            _royaltyReceiver = receiver_;
            _royaltyFeeBps = feeBps_;
            emit ERC2981Royalty1155Configured(receiver_, feeBps_);
        }
        // ============================================================
        moduleData;
    }

    // ============================================================
    // Owner-mint (bare template default; modules add public / conditional mint paths)
    // ============================================================

    /// @notice Mint `amount` of token `id` to `to`. Owner-only in the bare template.
    function mint(
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external onlyOwner {
        if (amount == 0) revert ERC1155Template__ZeroAmount();
        _mint(to, id, amount, data);
    }

    /// @notice Batch-mint multiple ids in one call. `ids` and `amounts` must have equal length.
    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external onlyOwner {
        _batchMint(to, ids, amounts, data);
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    /// @dev Enable Solady's before-transfer hook. Required so `_beforeTokenTransfer` actually
    ///      fires — without this override the base skips the call for gas savings.
    function _useBeforeTokenTransfer() internal view virtual override returns (bool) {
        return true;
    }

    /// @dev Enable Solady's after-transfer hook.
    function _useAfterTokenTransfer() internal view virtual override returns (bool) {
        return true;
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal virtual override {
        (from, to, ids, amounts, data);
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // ============================================================
        // Modules append before-transfer hook bodies below this marker.
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal virtual override {
        (from, to, ids, amounts, data);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from ERC2981Royalty1155.frag.sol ---
    function royaltyInfo(
        uint256,
        uint256 salePrice
    ) external view returns (address, uint256) {
        return (_royaltyReceiver, (salePrice * _royaltyFeeBps) / 10_000);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override returns (bool) {
        return interfaceId == 0x2a55205a || super.supportsInterface(interfaceId);
    }

    function royaltyReceiver() external view returns (address) {
        return _royaltyReceiver;
    }

    function royaltyFeeBps() external view returns (uint96) {
        return _royaltyFeeBps;
    }
    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
}
