// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC721A} from "erc721a/ERC721A.sol";
import {Ownable} from "solady/auth/Ownable.sol";
// Imports pre-emptively pulled in for common module fragments. Unused-in-bare-template
// warnings are expected and harmless — imports do not add runtime bytecode.
import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title  ERC721ATemplate
/// @notice Bare ERC-721A base for the VM launchpad, cloneable via EIP-1167. Compile service
///         splices audited module fragments at the `VM_INJECT_*` markers below.
/// @dev    See docs/SPEC-templates.md. Marker convention: every `VM_INJECT_X` marker sits at
///         the BOTTOM of its section — modules append after base content. Storage layout is
///         base-frozen; module state is appended after `_initialized`.
contract ERC721AWithDelayedRevealRefundableGen is ERC721A, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC721ATemplate__AlreadyInitialized();
    error ERC721ATemplate__ZeroOwner();
    error ERC721ATemplate__MaxSupplyExceeded(uint256 requested, uint256 remaining);
    error ERC721ATemplate__ZeroQuantity();

    // ============================================================
    // VM_INJECT_ERRORS
    // --- from DelayedReveal.frag.sol ---
    error DelayedReveal__AlreadyRevealed();
    error DelayedReveal__NonexistentToken(uint256 tokenId);

    // --- from Refundable.frag.sol ---
    error Refundable__WrongPrice(uint256 sent, uint256 expected);
    error Refundable__ZeroQuantity();
    error Refundable__NotOwner(uint256 tokenId, address caller);
    error Refundable__WindowExpired(uint256 tokenId);
    error Refundable__WindowStillOpen(uint256 tokenId);
    error Refundable__EmptyTokenIds();
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 maxSupply);
    event BaseURISet(string oldBaseURI, string newBaseURI);

    // ============================================================
    // VM_INJECT_EVENTS
    // --- from DelayedReveal.frag.sol ---
    event DelayedRevealConfigured(string hiddenURI);
    event DelayedRevealRevealed(string revealedBaseURI);

    // --- from Refundable.frag.sol ---
    event RefundableConfigured(uint256 pricePerToken, uint32 refundWindowBlocks);
    event RefundableMinted(address indexed to, uint256 startTokenId, uint256 quantity, uint256 pricePaid);
    event RefundableRefunded(address indexed to, uint256 tokenId, uint256 amount);
    event RefundableWithdrawn(address indexed to, uint256 amount);
    // ============================================================
    // Modules append events below this marker.

    // ============================================================
    // Base storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _vmName;
    string private _vmSymbol;
    string private _vmBaseURI;
    uint256 private _vmMaxSupply;
    uint8 private _initialized;

    // ============================================================
    // VM_INJECT_STATE
    // --- from DelayedReveal.frag.sol ---
    bool private _drRevealed;
    string private _drHiddenURI;

    // --- from Refundable.frag.sol ---
    uint256 private _refundablePricePerToken;
    uint32 private _refundableWindowBlocks;
    mapping(uint256 => uint256) private _refundableMintBlock;
    // ============================================================
    // Modules append storage variables below this marker.

    // ============================================================
    // VM_INJECT_CONSTANTS
    // ============================================================
    // Modules append constants / immutables below this marker.

    // ============================================================
    // Constructor — impl only. Clones skip this and use `initialize` instead.
    // ============================================================
    constructor() ERC721A("", "") {}

    // ============================================================
    // ERC-721A metadata overrides
    // ============================================================

    function name() public view virtual override returns (string memory) {
        return _vmName;
    }

    function symbol() public view virtual override returns (string memory) {
        return _vmSymbol;
    }

    function _baseURI() internal view virtual override returns (string memory) {
        return _vmBaseURI;
    }

    /// @notice Base URI that gets prepended to `tokenURI(tokenId)`. Full URI = `_vmBaseURI + tokenId`.
    function baseURI() external view returns (string memory) {
        return _vmBaseURI;
    }

    /// @notice Owner-only base URI setter. Modules like `DelayedReveal` bypass this by overriding
    ///         `tokenURI` in their `VM_INJECT_EXTERNAL` section.
    function setBaseURI(
        string calldata newBaseURI
    ) external onlyOwner {
        emit BaseURISet(_vmBaseURI, newBaseURI);
        _vmBaseURI = newBaseURI;
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, name, symbol, baseURI, maxSupply, moduleData)`.
    ///         Factory forces `initialOwner = router` so Router can dispatch to the launcher's
    ///         chosen `OwnershipMode` post-initialize. `maxSupply == 0` means uncapped.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC721ATemplate__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            string memory name_,
            string memory symbol_,
            string memory baseURI_,
            uint256 maxSupply_,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, string, string, string, uint256, bytes[]));

        if (initialOwner == address(0)) revert ERC721ATemplate__ZeroOwner();

        _vmName = name_;
        _vmSymbol = symbol_;
        _vmBaseURI = baseURI_;
        _vmMaxSupply = maxSupply_;
        _initializeOwner(initialOwner);

        emit Initialized(name_, symbol_, initialOwner, maxSupply_);

        // ============================================================
        // VM_INJECT_INIT
        // --- from DelayedReveal.frag.sol ---
        {
            string memory hiddenURI = abi.decode(moduleData[0], (string));
            _drHiddenURI = hiddenURI;
            emit DelayedRevealConfigured(hiddenURI);
        }

        // --- from Refundable.frag.sol ---
        {
            (uint256 pricePerToken_, uint32 refundWindowBlocks_) = abi.decode(moduleData[1], (uint256, uint32));
            _refundablePricePerToken = pricePerToken_;
            _refundableWindowBlocks = refundWindowBlocks_;
            emit RefundableConfigured(pricePerToken_, refundWindowBlocks_);
        }
        // ============================================================
        // Modules decode their slice of `moduleData` here.
        moduleData;
    }

    // ============================================================
    // Owner-mint (bare template shipping default; modules override behavior via markers)
    // ============================================================

    /// @notice Batch-mint `quantity` tokens to `to`. Owner-only in the bare template. Modules like
    ///         `PublicMint` or `AllowlistMint` add unrestricted-caller mint paths via
    ///         `VM_INJECT_EXTERNAL`.
    function mintBatch(
        address to,
        uint256 quantity
    ) external onlyOwner {
        if (quantity == 0) revert ERC721ATemplate__ZeroQuantity();
        if (_vmMaxSupply != 0) {
            uint256 minted = _totalMinted();
            uint256 remaining = _vmMaxSupply > minted ? _vmMaxSupply - minted : 0;
            if (quantity > remaining) revert ERC721ATemplate__MaxSupplyExceeded(quantity, remaining);
        }
        _mint(to, quantity);
    }

    function maxSupply() external view returns (uint256) {
        return _vmMaxSupply;
    }

    function totalMinted() external view returns (uint256) {
        return _totalMinted();
    }

    // ============================================================
    // VM_INJECT_MODIFIERS
    // ============================================================
    // Modules append modifiers below this marker.

    // ============================================================
    // Transfer hooks — module injection points
    // ============================================================

    function _beforeTokenTransfers(
        address from,
        address to,
        uint256 startTokenId,
        uint256 quantity
    ) internal virtual override {
        (from, to, startTokenId, quantity); // silence unused-var warnings
        // ============================================================
        // VM_INJECT_BEFORE_TRANSFER
        // ============================================================
        // Modules append before-transfer hook bodies below this marker.
    }

    function _afterTokenTransfers(
        address from,
        address to,
        uint256 startTokenId,
        uint256 quantity
    ) internal virtual override {
        (from, to, startTokenId, quantity);
        // ============================================================
        // VM_INJECT_AFTER_TRANSFER
        // ============================================================
        // Modules append after-transfer hook bodies below this marker.
    }

    // ============================================================
    // VM_INJECT_EXTERNAL
    // --- from DelayedReveal.frag.sol ---
    function tokenURI(
        uint256 tokenId
    ) public view virtual override returns (string memory) {
        if (!_exists(tokenId)) revert DelayedReveal__NonexistentToken(tokenId);
        string memory base = _drRevealed ? _vmBaseURI : _drHiddenURI;
        return string(abi.encodePacked(base, LibString.toString(tokenId)));
    }

    function reveal() external onlyOwner {
        if (_drRevealed) revert DelayedReveal__AlreadyRevealed();
        _drRevealed = true;
        emit DelayedRevealRevealed(_vmBaseURI);
    }

    function delayedRevealIsRevealed() external view returns (bool) {
        return _drRevealed;
    }

    function delayedRevealHiddenURI() external view returns (string memory) {
        return _drHiddenURI;
    }

    // --- from Refundable.frag.sol ---
    function refundableMint(
        uint256 quantity
    ) external payable {
        if (quantity == 0) revert Refundable__ZeroQuantity();
        uint256 expected = _refundablePricePerToken * quantity;
        if (msg.value != expected) revert Refundable__WrongPrice(msg.value, expected);
        if (_vmMaxSupply != 0) {
            uint256 minted = _totalMinted();
            uint256 remaining = _vmMaxSupply > minted ? _vmMaxSupply - minted : 0;
            if (quantity > remaining) revert ERC721ATemplate__MaxSupplyExceeded(quantity, remaining);
        }
        uint256 start = _nextTokenId();
        uint256 mintBlock = block.number;
        unchecked {
            for (uint256 i; i < quantity; ++i) {
                _refundableMintBlock[start + i] = mintBlock;
            }
        }
        _mint(msg.sender, quantity);
        emit RefundableMinted(msg.sender, start, quantity, expected);
    }

    function refund(
        uint256[] calldata tokenIds
    ) external {
        uint256 n = tokenIds.length;
        if (n == 0) revert Refundable__EmptyTokenIds();
        uint256 total;
        uint256 window = _refundableWindowBlocks;
        uint256 price = _refundablePricePerToken;
        for (uint256 i; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            if (ownerOf(tokenId) != msg.sender) revert Refundable__NotOwner(tokenId, msg.sender);
            uint256 mintBlock = _refundableMintBlock[tokenId];
            if (block.number > mintBlock + window) revert Refundable__WindowExpired(tokenId);
            _burn(tokenId, false);
            delete _refundableMintBlock[tokenId];
            emit RefundableRefunded(msg.sender, tokenId, price);
            unchecked {
                total += price;
            }
        }
        SafeTransferLib.safeTransferETH(msg.sender, total);
    }

    function refundableWithdraw(
        address to,
        uint256[] calldata tokenIds
    ) external onlyOwner {
        uint256 n = tokenIds.length;
        if (n == 0) revert Refundable__EmptyTokenIds();
        uint256 total;
        uint256 window = _refundableWindowBlocks;
        uint256 price = _refundablePricePerToken;
        for (uint256 i; i < n; ++i) {
            uint256 tokenId = tokenIds[i];
            uint256 mintBlock = _refundableMintBlock[tokenId];
            // Zero mintBlock means token wasn't minted via refundableMint (or was already swept).
            if (mintBlock == 0) revert Refundable__WindowExpired(tokenId);
            if (block.number <= mintBlock + window) revert Refundable__WindowStillOpen(tokenId);
            delete _refundableMintBlock[tokenId];
            unchecked {
                total += price;
            }
        }
        emit RefundableWithdrawn(to, total);
        SafeTransferLib.safeTransferETH(to, total);
    }

    function refundablePricePerToken() external view returns (uint256) {
        return _refundablePricePerToken;
    }

    function refundableWindowBlocks() external view returns (uint32) {
        return _refundableWindowBlocks;
    }

    function refundableMintBlockOf(
        uint256 tokenId
    ) external view returns (uint256) {
        return _refundableMintBlock[tokenId];
    }
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
