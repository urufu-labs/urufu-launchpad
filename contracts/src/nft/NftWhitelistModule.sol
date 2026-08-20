// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    whitelist module for a launched collection.  three flavors
 *    the deployer picks between at launch:  no-WL, external-NFT
 *    holders (any chain we can attest to), or a paste-in wallet
 *    list  ❤  the mint module reads this to decide who can mint
 *    during the WL-only window.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {ECDSA} from "solady/utils/ECDSA.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

/// @title  NftWhitelistModule
/// @notice Per-collection whitelist. One clone per launched collection;
///         initialized once by `NftLaunchFactory`, then immutable.
///
///         Three eligibility flavors ("flavors" not "types" to keep the
///         Solidity type namespace clear):
///           - `Off`           — no WL; the mint module treats every
///                               wallet as eligible from block 0.
///           - `Holders`       — anyone holding ≥ `holdersMinCount` of
///                               `holdersTarget` on chain
///                               `holdersTargetChainId` is eligible.
///                               Verified by a compile-service
///                               attestation (see `NftDiscountVerifier`
///                               for the attestation shape).
///           - `WalletList`    — merkle root of eligible wallets.
///                               Deployer pastes addresses on the
///                               launch form, we merkleize server-side.
///
///         WL is only enforced during `[deployTimestamp, wlWindowEnd]`;
///         after that window closes the mint module opens to public
///         mints and this module is bypassed.
/// @dev    Not upgradeable. State is set once in `initialize` and
///         cannot be changed afterwards — deployer configures WL at
///         launch time and lives with it. This is deliberate: mutable
///         WL config would let a launcher bait-and-switch buyers who
///         paid to join.
contract NftWhitelistModule {
    // ============================================================
    // Errors
    // ============================================================
    error NftWhitelistModule__AlreadyInitialized();
    error NftWhitelistModule__ZeroAddress();
    error NftWhitelistModule__WalletListRootEmpty();
    error NftWhitelistModule__HoldersTargetEmpty();
    error NftWhitelistModule__AttestationExpired(uint256 expiry, uint256 now_);
    error NftWhitelistModule__BadFlavor();

    // ============================================================
    // Types
    // ============================================================
    enum Flavor {
        Off,           // 0 — no WL, everyone eligible from t=0
        Holders,       // 1 — external-NFT-gated (attestation)
        WalletList     // 2 — merkle-list of wallets
    }

    // ============================================================
    // Events
    // ============================================================
    event Initialized(
        Flavor flavor,
        address holdersTarget,
        uint256 holdersTargetChainId,
        uint256 holdersMinCount,
        bytes32 walletListRoot,
        uint256 wlWindowEnd,
        address attestationSigner
    );

    // ============================================================
    // Immutable-after-init state
    // ============================================================
    uint8 private _initialized;

    Flavor public flavor;
    // Holders-flavor state
    address public holdersTarget;
    uint256 public holdersTargetChainId;
    uint256 public holdersMinCount;
    // WalletList-flavor state
    bytes32 public walletListRoot;
    // Shared state
    uint256 public wlWindowEnd;   // unix seconds; WL ONLY enforced before this
    address public attestationSigner;
    address public ourCollection; // the collection this WL is bound to (namespaces the attestation)

    // ============================================================
    // Init
    // ============================================================

    /// @notice Called once, by `NftLaunchFactory`, immediately after clone.
    /// @dev    `data` layout matches `LaunchCollectionParams.wl` shape
    ///         in the factory. Reverting `Off` still emits an event so
    ///         indexers can enumerate every WL module ever deployed.
    function initialize(
        bytes calldata data
    ) external {
        if (_initialized != 0) revert NftWhitelistModule__AlreadyInitialized();
        _initialized = 1;

        (
            Flavor flavor_,
            address holdersTarget_,
            uint256 holdersTargetChainId_,
            uint256 holdersMinCount_,
            bytes32 walletListRoot_,
            uint256 wlWindowEnd_,
            address attestationSigner_,
            address ourCollection_
        ) = abi.decode(
            data,
            (Flavor, address, uint256, uint256, bytes32, uint256, address, address)
        );

        if (ourCollection_ == address(0)) revert NftWhitelistModule__ZeroAddress();

        if (flavor_ == Flavor.Holders) {
            if (holdersTarget_ == address(0)) revert NftWhitelistModule__HoldersTargetEmpty();
            if (attestationSigner_ == address(0)) revert NftWhitelistModule__ZeroAddress();
        } else if (flavor_ == Flavor.WalletList) {
            if (walletListRoot_ == bytes32(0)) revert NftWhitelistModule__WalletListRootEmpty();
        } else if (flavor_ != Flavor.Off) {
            // Defensive — enum decode from calldata could carry an
            // out-of-range value if the caller lies about `data`.
            revert NftWhitelistModule__BadFlavor();
        }

        flavor = flavor_;
        holdersTarget = holdersTarget_;
        holdersTargetChainId = holdersTargetChainId_;
        holdersMinCount = holdersMinCount_;
        walletListRoot = walletListRoot_;
        wlWindowEnd = wlWindowEnd_;
        attestationSigner = attestationSigner_;
        ourCollection = ourCollection_;

        emit Initialized(
            flavor_,
            holdersTarget_,
            holdersTargetChainId_,
            holdersMinCount_,
            walletListRoot_,
            wlWindowEnd_,
            attestationSigner_
        );
    }

    // ============================================================
    // Eligibility (called by mint module inside `mint()`)
    // ============================================================

    /// @notice Returns true iff `wallet` is eligible to mint during the
    ///         current WL phase. AFTER `wlWindowEnd` this ALWAYS returns
    ///         true regardless of flavor — public mint has opened.
    ///
    ///         Callers pass whichever of (`proof`, `attestation`) matches
    ///         the flavor. The other argument is ignored:
    ///           - WalletList: pass `proof`, empty `count/expiry/sig`
    ///           - Holders:    pass `count/expiry/sig`, empty `proof`
    ///           - Off:        both ignored
    function isEligible(
        address wallet,
        bytes32[] calldata proof,
        uint256 count,
        uint256 expiry,
        bytes calldata sig
    ) external view returns (bool) {
        // Public phase — bypass entirely.
        if (block.timestamp > wlWindowEnd) return true;
        Flavor f = flavor;
        if (f == Flavor.Off) return true;
        if (f == Flavor.WalletList) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet))));
            return MerkleProofLib.verifyCalldata(proof, walletListRoot, leaf);
        }
        // Holders — verify attestation. Expiry enforcement lives here
        // so callers can trust a plain `true` return unconditionally.
        if (block.timestamp > expiry) return false;
        if (count < holdersMinCount) return false;
        bytes32 hash = _attestationHash(wallet, count, expiry);
        bytes32 envelope = ECDSA.toEthSignedMessageHash(hash);
        address signer = ECDSA.tryRecoverCalldata(envelope, sig);
        // Explicit zero-check prevents a malformed sig from validating
        // against a mis-configured zero signer.
        return signer != address(0) && signer == attestationSigner;
    }

    /// @notice The WL-holders attestation hash. Namespaced by both this
    ///         WL module (`address(this)`) AND the collection it gates
    ///         (`ourCollection`) so a sig for WL of collection A can
    ///         never be reused for WL of collection B.
    function attestationHash(
        address wallet,
        uint256 count,
        uint256 expiry
    ) external view returns (bytes32) {
        return _attestationHash(wallet, count, expiry);
    }

    function _attestationHash(
        address wallet,
        uint256 count,
        uint256 expiry
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                "URU_NFT_WL_V1",
                block.chainid,
                address(this),
                ourCollection,
                holdersTarget,
                holdersTargetChainId,
                wallet,
                count,
                expiry
            )
        );
    }
}
