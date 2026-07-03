// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

/// @title  NftRevenueVault
/// @notice ETH revenue-share pool for urufu gemu NFT holders. FeeSplitter forwards a
///         percentage of every platform fee here. Distribution model: **epoch-based
///         merkle drops**. Admin (or a keeper) publishes a merkle root per epoch,
///         holders claim their per-token slice with a proof.
///
///         Why merkle drops instead of continuous accrual? The gemu NFT is an existing
///         vanilla ERC-721 without transfer hooks or ERC-721Votes — we can't cheaply
///         track per-holder balance changes on-chain. Snapshotting off-chain and
///         publishing a merkle root is the cheapest gas-safe pattern. Same approach
///         we already ship in the `Airdrop` module.
///
///         Leaf format: `keccak256(abi.encodePacked(holder, epochId, amount))`. Off-chain
///         indexer (Ponder) generates snapshots + builds the tree.
///
/// @dev    Vault ACCEPTS ETH continuously via `receive()`. Distribution roots are added
///         one at a time via `addEpoch(root, totalAmount)`. Each claim decrements a
///         per-epoch remainder so no over-claim is possible.
contract NftRevenueVault is Ownable {
    error NftRevenueVault__EpochUnknown(uint256 epoch);
    error NftRevenueVault__AlreadyClaimed(uint256 epoch, address holder);
    error NftRevenueVault__InvalidProof();
    error NftRevenueVault__ZeroAmount();
    error NftRevenueVault__InsufficientBalance(uint256 available, uint256 requested);

    event Received(address indexed from, uint256 amount);
    event EpochAdded(uint256 indexed epoch, bytes32 merkleRoot, uint256 totalAmount);
    event Claimed(uint256 indexed epoch, address indexed holder, uint256 amount);

    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalAmount;
        uint256 unclaimed;
    }

    uint256 public nextEpochId;
    mapping(uint256 => Epoch) public epochs;
    /// epoch → holder → claimed?
    mapping(uint256 => mapping(address => bool)) private _claimed;

    constructor(address initialOwner) {
        _initializeOwner(initialOwner);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Publish a merkle root for a new epoch. `totalAmount` is the ETH sum the tree
    ///         hands out across all leaves; the vault must have at least this balance.
    function addEpoch(bytes32 merkleRoot, uint256 totalAmount) external onlyOwner {
        if (totalAmount == 0) revert NftRevenueVault__ZeroAmount();
        if (address(this).balance < totalAmount) {
            revert NftRevenueVault__InsufficientBalance(address(this).balance, totalAmount);
        }
        uint256 id = nextEpochId++;
        epochs[id] = Epoch({merkleRoot: merkleRoot, totalAmount: totalAmount, unclaimed: totalAmount});
        emit EpochAdded(id, merkleRoot, totalAmount);
    }

    /// @notice Claim an epoch's per-holder allocation. Proof leaves are
    ///         `keccak256(abi.encodePacked(holder, epochId, amount))`.
    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epochId];
        if (e.merkleRoot == bytes32(0)) revert NftRevenueVault__EpochUnknown(epochId);
        if (_claimed[epochId][msg.sender]) revert NftRevenueVault__AlreadyClaimed(epochId, msg.sender);
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, epochId, amount));
        if (!MerkleProofLib.verifyCalldata(proof, e.merkleRoot, leaf)) revert NftRevenueVault__InvalidProof();

        _claimed[epochId][msg.sender] = true;
        e.unclaimed -= amount;
        SafeTransferLib.safeTransferETH(msg.sender, amount);
        emit Claimed(epochId, msg.sender, amount);
    }

    function isClaimed(uint256 epochId, address holder) external view returns (bool) {
        return _claimed[epochId][holder];
    }
}
