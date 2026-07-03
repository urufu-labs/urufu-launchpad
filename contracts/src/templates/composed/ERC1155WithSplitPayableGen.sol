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
contract ERC1155WithSplitPayableGen is ERC1155, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC1155Template__AlreadyInitialized();
    error ERC1155Template__ZeroOwner();
    error ERC1155Template__ZeroAmount();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from PayableMint1155Split.frag.sol ---
    error PayableMint1155Split__LengthMismatch(uint256 idsLen, uint256 pricesLen);
    error PayableMint1155Split__NotMintable(uint256 id);
    error PayableMint1155Split__WrongPrice(uint256 sent, uint256 expected);
    error PayableMint1155Split__ZeroQty();
    error PayableMint1155Split__ZeroAddress();
    error PayableMint1155Split__BadPlatformBps(uint256 bps);
    error PayableMint1155Split__ForwardFailed();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, string uri, address indexed initialOwner);
    event URISet(string oldURI, string newURI);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from PayableMint1155Split.frag.sol ---
    event PayableMint1155SplitConfigured(uint256 idsCount, address platformFeeReceiver, uint16 platformFeeBps);
    event PayableMintedSplit(
        address indexed to, uint256 indexed id, uint256 amount, uint256 pricePaid, uint256 platformCut
    );
    event PayableWithdrawnSplit(address indexed to, uint256 amount);
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
    // --- from PayableMint1155Split.frag.sol ---
    mapping(uint256 => uint256) private _pmsPricePerToken;
    mapping(uint256 => bool) private _pmsMintable;
    address private _pmsPlatformFeeReceiver;
    uint16 private _pmsPlatformFeeBps;

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
        // --- from PayableMint1155Split.frag.sol ---
        {
            (uint256[] memory ids_, uint256[] memory prices_, address feeReceiver_, uint16 feeBps_) =
                abi.decode(moduleData[0], (uint256[], uint256[], address, uint16));
            if (ids_.length != prices_.length) {
                revert PayableMint1155Split__LengthMismatch(ids_.length, prices_.length);
            }
            if (feeReceiver_ == address(0)) revert PayableMint1155Split__ZeroAddress();
            if (feeBps_ == 0 || feeBps_ >= 10_000) revert PayableMint1155Split__BadPlatformBps(feeBps_);

            for (uint256 i; i < ids_.length; ++i) {
                _pmsPricePerToken[ids_[i]] = prices_[i];
                _pmsMintable[ids_[i]] = true;
            }
            _pmsPlatformFeeReceiver = feeReceiver_;
            _pmsPlatformFeeBps = feeBps_;
            emit PayableMint1155SplitConfigured(ids_.length, feeReceiver_, feeBps_);
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
    // --- from PayableMint1155Split.frag.sol ---
    function mintPayable(
        uint256 id,
        uint256 amount
    ) external payable {
        if (amount == 0) revert PayableMint1155Split__ZeroQty();
        if (!_pmsMintable[id]) revert PayableMint1155Split__NotMintable(id);
        uint256 expected = _pmsPricePerToken[id] * amount;
        if (msg.value != expected) revert PayableMint1155Split__WrongPrice(msg.value, expected);

        uint256 platformCut = (msg.value * _pmsPlatformFeeBps) / 10_000;
        if (platformCut > 0) {
            (bool ok,) = _pmsPlatformFeeReceiver.call{value: platformCut}("");
            if (!ok) revert PayableMint1155Split__ForwardFailed();
        }

        _mint(msg.sender, id, amount, "");
        emit PayableMintedSplit(msg.sender, id, amount, msg.value, platformCut);
    }

    function withdrawPayable(
        address to
    ) external onlyOwner {
        uint256 amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
        emit PayableWithdrawnSplit(to, amount);
    }

    function priceOf(
        uint256 id
    ) external view returns (uint256 price, bool mintable) {
        return (_pmsPricePerToken[id], _pmsMintable[id]);
    }

    function platformFee() external view returns (address receiver, uint16 bps) {
        return (_pmsPlatformFeeReceiver, _pmsPlatformFeeBps);
    }

    receive() external payable {}
    // ============================================================

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
}
