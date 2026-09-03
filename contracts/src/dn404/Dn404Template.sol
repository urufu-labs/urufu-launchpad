// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 lane
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    this token was deployed with urufu labs.  every whole unit
 *    of the erc-20 backs one nft in the paired mirror collection.
 *    trade fractions on the curve; hold whole units to keep art.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {DN404} from "dn404/DN404.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title  Dn404Template
/// @notice ERC-20 base half of a DN404 pair. Cloneable via LibClone; the
///         factory is expected to clone this alongside a Dn404MirrorTemplate,
///         call `initialize` here (which links the mirror in the same tx),
///         then hand the whole supply to CurveFactory.
///
/// @dev Two-role model matching the ERC-721 lane:
///         - `owner()`  → launcher (Solady Ownable; marketplace edit rights
///                        propagate to the mirror via DN404Mirror.pullOwner())
///         - internal minter is implicit — DN404's own ERC-20 balance
///           transitions are the only path to mint/burn the mirror NFTs
///
/// Skip-list posture at init:
///         - factory (initial supply holder) → auto-skipped by _initializeDN404
///         - curve (predicted address)        → skipped so bonding-curve fills
///                                              don't accumulate NFTs
///         - feeSplitter                      → skipped so ERC-20 fees don't
///                                              accumulate NFTs
///         - graduated v4 pool                → not known at init; owner adds
///                                              post-graduation via
///                                              setSkipNFTFor(pool, true)
///
/// Storage layout: FROZEN. Do not reorder — this is a clone target and any
/// slot movement breaks live launches. Append-only after `_initialized`.
contract Dn404Template is DN404, Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404Template__AlreadyInitialized();
    error Dn404Template__ZeroOwner();
    error Dn404Template__ZeroMirror();
    error Dn404Template__ZeroFactory();
    error Dn404Template__ZeroUnit();

    // ============================================================
    // Events
    // ============================================================
    event Initialized(
        string name,
        string symbol,
        address indexed initialOwner,
        address indexed mirror,
        uint256 totalSupply,
        uint256 unit
    );
    event BaseURISet(string oldBaseURI, string newBaseURI);
    event ContractURISet(string oldContractURI, string newContractURI);
    /// Fired when the owner adds or removes a skip-list entry. Post-graduation
    /// the launcher calls `setSkipNFTFor(pool, true)` and consumers watching
    /// this event get the pool address without scraping graduation calls.
    event SkipNFTForSet(address indexed target, bool skip);

    // ============================================================
    // Storage — FROZEN LAYOUT (do not reorder)
    // ============================================================
    string private _vmName;
    string private _vmSymbol;
    string private _vmBaseURI;
    string private _vmContractURI;
    /// Whole-token unit (in wei) that backs one mirror NFT. Immutable after init.
    uint256 private _vmUnit;
    uint8 private _initialized;

    // ============================================================
    // Constructor — impl only. Clones skip this entirely.
    // ============================================================
    constructor() {}

    // ============================================================
    // Initialization
    // ============================================================

    /// @notice Initialize the clone. Called exactly once by the factory,
    ///         atomically with the mirror clone in the same transaction.
    /// @dev    Encoded input:
    ///         `abi.encode(
    ///             initialOwner, mirror, curve, feeSplitter,
    ///             name, symbol, baseURI, contractURI,
    ///             totalSupply, unit
    ///         )`
    ///
    ///         `initialOwner` = launcher (Ownable owner, propagates to mirror
    ///         via DN404Mirror.pullOwner())
    ///         `mirror`       = paired Dn404MirrorTemplate clone address
    ///         `curve`        = predicted CurveFactory.LibClone.cloneDeterministic
    ///                          address for this token. MUST be skip-listed
    ///                          BEFORE the supply is transferred to it.
    ///         `feeSplitter`  = FeeSplitter address (skip-listed for the same
    ///                          reason — trade fees flow here in the base ERC-20)
    ///         `totalSupply`  = collectionSize * unit (already computed by
    ///                          factory; passed in wei terms directly)
    ///         `unit`         = wei per NFT (e.g. `10_000 * 1e18` for
    ///                          "hold 10,000 $TICK, get an NFT")
    ///
    /// The full supply is minted to `msg.sender` (the factory) so it can
    /// hand off to CurveFactory in the next step of the launch tx.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert Dn404Template__AlreadyInitialized();
        _initialized = 1;

        (
            address initialOwner,
            address mirror,
            address curve,
            address feeSplitter,
            string memory name_,
            string memory symbol_,
            string memory baseURI_,
            string memory contractURI_,
            uint256 totalSupply_,
            uint256 unit_
        ) = abi.decode(
            data,
            (address, address, address, address, string, string, string, string, uint256, uint256)
        );

        if (initialOwner == address(0)) revert Dn404Template__ZeroOwner();
        if (mirror == address(0)) revert Dn404Template__ZeroMirror();
        if (msg.sender == address(0)) revert Dn404Template__ZeroFactory();
        if (unit_ == 0) revert Dn404Template__ZeroUnit();

        _vmName = name_;
        _vmSymbol = symbol_;
        _vmBaseURI = baseURI_;
        _vmContractURI = contractURI_;
        _vmUnit = unit_;

        // Set Ownable owner BEFORE _initializeDN404 so the mirror can pull
        // the launcher as its owner in the same call (DN404 auto-calls
        // pullOwner on the mirror after linking if base.owner() is non-zero).
        _initializeOwner(initialOwner);

        // Mints `totalSupply_` to `msg.sender` (the factory) and auto-skips
        // that address. Also links the mirror in one call.
        _initializeDN404(totalSupply_, msg.sender, mirror);

        // Skip-list the predicted curve address and the fee splitter BEFORE
        // any tokens land there. Zero-address entries are a no-op path
        // (feeSplitter is optional; e.g. a rehearsal launch may pass 0).
        if (curve != address(0)) {
            _setSkipNFT(curve, true);
            emit SkipNFTForSet(curve, true);
        }
        if (feeSplitter != address(0)) {
            _setSkipNFT(feeSplitter, true);
            emit SkipNFTForSet(feeSplitter, true);
        }

        emit Initialized(name_, symbol_, initialOwner, mirror, totalSupply_, unit_);
    }

    // ============================================================
    // DN404 overrides
    // ============================================================

    function name() public view virtual override returns (string memory) {
        return _vmName;
    }

    function symbol() public view virtual override returns (string memory) {
        return _vmSymbol;
    }

    /// @dev Per SPEC decision: deterministic-from-token-id path.
    ///      `tokenURI(N) = baseURI + N + ".json"`. Matches the ERC-721A
    ///      lane's marketplace-standard `.json` suffix, and matches how the
    ///      studio pins mirror metadata (`1.json`, `2.json`, ...).
    function _tokenURI(
        uint256 id
    ) internal view virtual override returns (string memory) {
        if (bytes(_vmBaseURI).length == 0) return "";
        return string(abi.encodePacked(_vmBaseURI, LibString.toString(id), ".json"));
    }

    /// @dev Custom unit set once at init. DN404 requires this to be constant
    ///      after `_initializeDN404`; enforced by never exposing a setter.
    function _unit() internal view virtual override returns (uint256) {
        return _vmUnit;
    }

    // ============================================================
    // Owner surface
    // ============================================================

    /// @notice Owner-only skip-list mutator. Primary use: post-graduation
    ///         skip-list the v4 pool so trade fills don't accumulate NFTs
    ///         in the pool contract. Also usable for future integrations
    ///         (aggregators, MEV protection venues) where NFT accumulation
    ///         on a routing contract would be wasteful.
    ///
    /// @dev    Owner-only by design. A permissionless variant that discovers
    ///         the pool from the pinned Graduator is sketched in the DN404
    ///         SPEC as a v1 fallback if launcher UX complaints arise.
    function setSkipNFTFor(
        address target,
        bool skip
    ) external onlyOwner {
        _setSkipNFT(target, skip);
        emit SkipNFTForSet(target, skip);
    }

    function setBaseURI(
        string calldata newBaseURI
    ) external onlyOwner {
        emit BaseURISet(_vmBaseURI, newBaseURI);
        _vmBaseURI = newBaseURI;
    }

    function setContractURI(
        string calldata newContractURI
    ) external onlyOwner {
        emit ContractURISet(_vmContractURI, newContractURI);
        _vmContractURI = newContractURI;
    }

    // ============================================================
    // View helpers
    // ============================================================

    function baseURI() external view returns (string memory) {
        return _vmBaseURI;
    }

    function contractURI() external view returns (string memory) {
        return _vmContractURI;
    }

    function unit() external view returns (uint256) {
        return _vmUnit;
    }
}
