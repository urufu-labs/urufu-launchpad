// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    this collection was deployed with urufu labs.  every mint
 *    routes 10% of revenue through the flywheel  ❤  which rewards
 *    urufu gemu nft holders + funds URU buyback+burn.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {ECDSA} from "solady/utils/ECDSA.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

/// @title  NftDiscountVerifier
/// @notice Stateless helper library for NFT mint discount verification.
///
///         Two verification paths, both consumed by `NftMintModule`:
///
///           1. `verifyWalletList` — deployer pastes a list of wallet
///              addresses on the launch form, we merkleize server-side,
///              root is stored on the mint module. At mint time the buyer
///              proves membership. All wallets in the tier get the same
///              fixed discount.
///
///           2. `verifyExternalNftAttestation` — deployer configures a
///              tier that says "holders of this NFT on this chain get
///              X% off per NFT held, up to Y". Since the target NFT may
///              live on a different chain, we can't read its `balanceOf`
///              on-chain. Instead the compile-service backend:
///                a) queries the target chain's RPC for the buyer's
///                   `balanceOf(targetCollection)` at the current block,
///                b) signs `(buyer, ourCollection, targetCollection,
///                   tierId, count, expiry)` with an allowlisted signer,
///                c) hands the signature to the frontend, which passes
///                   it into `mint()`. The mint module recovers the
///                   signer, checks against a stored allowlist, and
///                   applies the discount.
///
///         Attestation shape is namespaced by both `ourCollection` and
///         `targetCollection` so a signature valid for collection A
///         cannot be replayed on collection B, and vice-versa. Expiry
///         is enforced by the caller (mint module), not this library.
/// @dev    Pure library, no state, no owner. Every function is `pure`
///         except the ones that need the caller's `block.timestamp`
///         (which are marked `view` and gate expiry checks).
///
///         Signature format: EIP-191 personal_sign envelope
///         (`"\x19Ethereum Signed Message:\n32" + hash`). Chosen over
///         EIP-712 because (a) the compile-service is signing many
///         short-lived attestations per second and personal_sign's
///         setup cost is zero, and (b) the message is fully
///         deterministic from mint-tx inputs so replay resistance
///         doesn't need EIP-712's domain separator to be strong.
///         Chain-id is baked into the hash directly to prevent
///         cross-chain replay in case attestation-signers are ever
///         shared between chain deployments.
library NftDiscountVerifier {
    /// @notice Verify a merkle proof that `wallet` is in the tier.
    /// @dev    Leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet))))
    ///         which matches the standard OpenZeppelin merkle-tree
    ///         encoding used by the compile-service's tree builder.
    ///         Double-hash prevents second-preimage attacks against
    ///         intermediate-node values.
    function verifyWalletList(
        bytes32 root,
        address wallet,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        // Leaves are addresses only (no amount) — every wallet in a
        // walletList tier gets the same discount, so we don't encode
        // per-wallet amounts in the leaf.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet))));
        return MerkleProofLib.verifyCalldata(proof, root, leaf);
    }

    /// @notice Recover the attestation hash the compile-service signed.
    ///         Kept in the library so on-chain code and off-chain signer
    ///         reference the same recipe.
    /// @param  wallet             the buyer's address
    /// @param  ourCollection      the collection being minted from
    /// @param  targetCollection   the external NFT that grants the discount
    /// @param  targetChainId      the chain the external NFT lives on
    /// @param  tierId             which tier on `ourCollection` this signature
    ///                            applies to (multiple tiers can be configured)
    /// @param  count              number of `targetCollection` NFTs the buyer holds,
    ///                            as read by the compile-service at signing time
    /// @param  expiry             unix seconds after which the attestation is dead
    function attestationHash(
        address wallet,
        address ourCollection,
        address targetCollection,
        uint256 targetChainId,
        uint256 tierId,
        uint256 count,
        uint256 expiry
    ) internal view returns (bytes32) {
        // block.chainid guards against sig reuse if attestation-signer
        // keys are ever shared between chain deployments.
        return keccak256(
            abi.encode(
                "URU_NFT_DISCOUNT_V1",
                block.chainid,
                wallet,
                ourCollection,
                targetCollection,
                targetChainId,
                tierId,
                count,
                expiry
            )
        );
    }

    /// @notice Verify that `sig` was produced by `expectedSigner` over the
    ///         attestation for the given inputs.
    /// @return signer   The recovered signer address. Zero on malformed
    ///                  signature (Solady returns address(0) instead of
    ///                  reverting). Callers MUST compare against
    ///                  `expectedSigner` and reject zero explicitly, since
    ///                  a mis-configured `expectedSigner == 0` combined
    ///                  with a malformed sig would otherwise return true.
    /// @return valid    True iff signer == expectedSigner && signer != 0.
    function verifyExternalNftAttestation(
        address wallet,
        address ourCollection,
        address targetCollection,
        uint256 targetChainId,
        uint256 tierId,
        uint256 count,
        uint256 expiry,
        bytes calldata sig,
        address expectedSigner
    ) internal view returns (address signer, bool valid) {
        bytes32 hash = attestationHash(wallet, ourCollection, targetCollection, targetChainId, tierId, count, expiry);
        // EIP-191 personal_sign envelope.
        bytes32 envelope = ECDSA.toEthSignedMessageHash(hash);
        signer = ECDSA.tryRecoverCalldata(envelope, sig);
        // Explicit zero-check prevents a malformed sig from validating
        // against a mis-configured zero-signer (which would recover to 0
        // and equal a zero expectedSigner). Never authorize on zero.
        valid = signer != address(0) && signer == expectedSigner;
    }
}
