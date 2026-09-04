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
contract ERC721ATemplate is ERC721A, Ownable {
    // ============================================================
    // Base errors — frozen
    // ============================================================
    error ERC721ATemplate__AlreadyInitialized();
    error ERC721ATemplate__ZeroOwner();
    error ERC721ATemplate__MaxSupplyExceeded(uint256 requested, uint256 remaining);
    error ERC721ATemplate__ZeroQuantity();
    error ERC721ATemplate__NotMinter();

    // ============================================================
    // VM_INJECT_ERRORS
    // ============================================================
    // Modules append custom errors below this marker.

    // ============================================================
    // Base events — frozen
    // ============================================================
    event Initialized(string name, string symbol, address indexed initialOwner, uint256 maxSupply);
    event BaseURISet(string oldBaseURI, string newBaseURI);
    event ContractURISet(string oldContractURI, string newContractURI);
    /// Fired when the minter role is set (once at init) or rotated
    /// (owner-only). Consumers watching for who can mint from this
    /// collection subscribe to this + the mint events.
    event MinterSet(address indexed oldMinter, address indexed newMinter);

    // ============================================================
    // VM_INJECT_EVENTS
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
    /// Collection-level metadata URL. OpenSea + most marketplaces read
    /// `contractURI()` for the collection's cover, description, and
    /// featured image; falls back to an empty string when unset so the
    /// marketplace uses on-chain name/symbol as the only identity.
    string private _vmContractURI;
    /// Address permitted to call `mintBatch`. The mint module is bound
    /// here at initialize time so the *launcher* can hold Ownable owner
    /// (needed for OpenSea's edit flow) while the mint module keeps
    /// exclusive mint rights. Owner can rotate via `setMinter` — useful
    /// if a launcher wants to swap in a new mint module post-launch.
    address public minter;

    // ============================================================
    // VM_INJECT_STATE
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

    /// @notice OpenSea collection-level metadata URL. Returns the empty string
    ///         when unset so marketplaces render an unclaimed collection page
    ///         using on-chain `name()` + `symbol()` only.
    function contractURI() external view returns (string memory) {
        return _vmContractURI;
    }

    /// @notice Owner-only setter for the collection-level metadata URL.
    ///         Mint-module wraps this behind `setCollectionContractURI` so
    ///         the launcher can update it without holding ERC-721 ownership.
    function setContractURI(
        string calldata newContractURI
    ) external onlyOwner {
        emit ContractURISet(_vmContractURI, newContractURI);
        _vmContractURI = newContractURI;
    }

    /// @notice tokenURI = `_baseURI() + tokenId + ".json"`.
    ///         Matches the ERC-721 marketplace norm (OpenSea, Etherscan, and
    ///         nft.storage examples all use the `.json` suffix). Studio and
    ///         most metadata pipelines pin files as `1.json`, `2.json`, etc,
    ///         so appending here removes a per-launcher configuration knob
    ///         that was routinely getting wrong.
    function tokenURI(
        uint256 tokenId
    ) public view virtual override returns (string memory) {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        string memory base = _baseURI();
        // The concatenation result is a URI string returned as-is; it is
        // never hashed on-chain, so a packed-encoding collision between
        // (base, tokenId) pairs (e.g. base=".../a1", id="0" vs.
        // base=".../a", id="10" — both yield ".../a10.json") is not an
        // auth-bypass risk. The detector's true concern is
        // keccak256(abi.encodePacked(dynA, dynB)) which does not apply.
        // slither-disable-next-line encode-packed-collision
        return bytes(base).length == 0 ? "" : string(abi.encodePacked(base, LibString.toString(tokenId), ".json"));
    }

    // ============================================================
    // Initialization — called once by the factory on the clone
    // ============================================================

    /// @notice Initialize the clone. Called exactly once, immediately after `cloneDeterministic`.
    /// @dev    Encoded input: `abi.encode(initialOwner, minter_, name, symbol, baseURI, maxSupply, moduleData)`.
    ///         Factory sets `initialOwner = launcher` (so the launcher owns the
    ///         collection from day one for OpenSea's edit flow) and
    ///         `minter_ = mintModule` (so the mint module retains exclusive
    ///         mint rights via the check in `mintBatch`).
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert ERC721ATemplate__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            address minter_,
            string memory name_,
            string memory symbol_,
            string memory baseURI_,
            uint256 maxSupply_,
            bytes[] memory moduleData
        ) = abi.decode(data, (address, address, string, string, string, uint256, bytes[]));

        if (initialOwner == address(0)) revert ERC721ATemplate__ZeroOwner();
        if (minter_ == address(0)) revert ERC721ATemplate__NotMinter();

        _vmName = name_;
        _vmSymbol = symbol_;
        _vmBaseURI = baseURI_;
        _vmMaxSupply = maxSupply_;
        minter = minter_;
        emit MinterSet(address(0), minter_);
        _initializeOwner(initialOwner);

        // Clones don't run ERC721A's constructor, so its private
        // `_currentIndex` slot stays at 0 while our `_startTokenId()`
        // override returns 1 — this makes `_totalMinted() =
        // _currentIndex - _startTokenId()` underflow to a giant
        // number, tripping every supply-cap check. Poke slot 0 to
        // match `_startTokenId()` so the counter starts consistent.
        //
        // Storage layout: ERC721A declares `uint256 private
        // _currentIndex;` as its FIRST state variable, and Solady's
        // Ownable uses a fixed slot (not sequential), so slot 0 is
        // guaranteed to be `_currentIndex`. If ERC721A ever adds
        // state before it, this poke breaks — regression test in
        // `test_Gap_BaseURI_StoredOnChain_And_FirstTokenIdIsOne`
        // catches it (asserts first mint is token #1).
        uint256 startId = _startTokenId();
        assembly {
            sstore(0, startId)
        }

        emit Initialized(name_, symbol_, initialOwner, maxSupply_);

        // ============================================================
        // VM_INJECT_INIT
        // ============================================================
        // Modules decode their slice of `moduleData` here.
        moduleData;
    }

    // ============================================================
    // Owner-mint (bare template shipping default; modules override behavior via markers)
    // ============================================================

    /// @notice Batch-mint `quantity` tokens to `to`. Callable by the bound
    ///         `minter` (the mint module) OR the `owner()` (the launcher —
    ///         who might want an owner-mint airdrop path). Modules like
    ///         `PublicMint` or `AllowlistMint` add unrestricted-caller mint
    ///         paths via `VM_INJECT_EXTERNAL`.
    function mintBatch(
        address to,
        uint256 quantity
    ) external {
        if (msg.sender != minter && msg.sender != owner()) revert ERC721ATemplate__NotMinter();
        if (quantity == 0) revert ERC721ATemplate__ZeroQuantity();
        if (_vmMaxSupply != 0) {
            uint256 minted = _totalMinted();
            uint256 remaining = _vmMaxSupply > minted ? _vmMaxSupply - minted : 0;
            if (quantity > remaining) revert ERC721ATemplate__MaxSupplyExceeded(quantity, remaining);
        }
        _mint(to, quantity);
    }

    /// @notice Rotate the minter role. Owner-only. Used if the launcher
    ///         ever wants to swap in a new mint module (e.g. graduate from
    ///         priced mint to free public mint) without redeploying the
    ///         ERC-721. Also lets an owner effectively pause future mints
    ///         by setting to `address(this)` or a dead address.
    function setMinter(
        address newMinter
    ) external onlyOwner {
        emit MinterSet(minter, newMinter);
        minter = newMinter;
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
    // Token ID origin — 1-indexed
    // ============================================================

    /// @notice First minted token has id 1 (not ERC721A's default of 0).
    /// @dev    Matches OpenSea/Blur/Magic Eden convention. Combined with
    ///         the `.json` suffix in tokenURI, tokenURI(1) resolves to
    ///         `<baseURI>1.json` — the first intended metadata file for
    ///         every mainstream pipeline (chibi studio, nft.storage,
    ///         pinata's Metaplex-style uploads).
    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

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
    // ============================================================
    // Modules append new external / public functions below this marker.

    // ============================================================
    // VM_INJECT_INTERNAL
    // ============================================================
    // Modules append internal helpers below this marker.
}
