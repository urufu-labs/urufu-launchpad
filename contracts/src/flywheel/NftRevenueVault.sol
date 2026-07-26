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
    /// Epoch published with `merkleRoot == 0`. The zero root doubles as the
    /// "epoch doesn't exist" sentinel in `claim`, so accepting it would create
    /// a permanently-unclaimable epoch that also silently consumed balance
    /// headroom via `totalCommitted`.
    error NftRevenueVault__ZeroRoot();
    /// Epoch overcommit — adding `totalAmount` would bring `totalCommitted`
    /// above the vault's current ETH balance. Blocks the double-commit bug
    /// where two live epochs each claim rights to more ETH than exists.
    error NftRevenueVault__OverCommit(uint256 committed, uint256 available);
    /// setDistributionSink timelock guard for the sweep escape hatch.
    error NftRevenueVault__NothingToSweep();

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

    /// Running sum of unclaimed balances across ALL live epochs. New `addEpoch`
    /// calls check that adding `totalAmount` keeps this <= vault balance. Prevents
    /// the double-commit bug where two 100-ETH epochs pass individually against
    /// a 100-ETH deposit but drain balance below the second batch of claimers.
    uint256 public totalCommitted;

    event Swept(address indexed to, uint256 amount);

    constructor(
        address initialOwner
    ) {
        _initializeOwner(initialOwner);
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Publish a merkle root for a new epoch. `totalAmount` is the ETH sum the tree
    ///         hands out across all leaves; the vault must have at least this balance.
    function addEpoch(
        bytes32 merkleRoot,
        uint256 totalAmount
    ) external onlyOwner {
        if (totalAmount == 0) revert NftRevenueVault__ZeroAmount();
        if (merkleRoot == bytes32(0)) revert NftRevenueVault__ZeroRoot();
        uint256 newCommitted = totalCommitted + totalAmount;
        // Reject epochs that would over-commit the vault. Was a HIGH audit
        // finding: two consecutive addEpoch(100 ETH) each individually passed
        // `balance >= 100` against a 100-ETH deposit, but the second epoch's
        // claimers would eventually hit safeTransferETH reverts.
        if (address(this).balance < newCommitted) {
            revert NftRevenueVault__OverCommit(newCommitted, address(this).balance);
        }
        uint256 id = nextEpochId++;
        epochs[id] = Epoch({merkleRoot: merkleRoot, totalAmount: totalAmount, unclaimed: totalAmount});
        totalCommitted = newCommitted;
        emit EpochAdded(id, merkleRoot, totalAmount);
    }

    /// Owner sweeps ETH that isn't backing an unclaimed epoch. Useful when a
    /// published root has an off-by-N `totalAmount` (dust residue), a merkle
    /// leaf's holder is dead-wallet + unrecoverable, or an epoch's holders
    /// never fully claim before a snapshot window closes. Bounded to the
    /// dust surplus so live claims can't be starved.
    function sweepDust(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert NftRevenueVault__InvalidProof(); // reuse zero-address err
        uint256 bal = address(this).balance;
        if (bal <= totalCommitted) revert NftRevenueVault__NothingToSweep();
        uint256 amount = bal - totalCommitted;
        SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    /// @notice Claim an epoch's per-holder allocation. Proof leaves are
    ///         `keccak256(abi.encodePacked(holder, epochId, amount))`.
    function claim(
        uint256 epochId,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        Epoch storage e = epochs[epochId];
        if (e.merkleRoot == bytes32(0)) revert NftRevenueVault__EpochUnknown(epochId);
        if (_claimed[epochId][msg.sender]) revert NftRevenueVault__AlreadyClaimed(epochId, msg.sender);
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, epochId, amount));
        if (!MerkleProofLib.verifyCalldata(proof, e.merkleRoot, leaf)) revert NftRevenueVault__InvalidProof();

        _claimed[epochId][msg.sender] = true;
        e.unclaimed -= amount;
        // Also drop from the running commitment total so sweepDust reflects
        // freed headroom as claims land.
        totalCommitted -= amount;
        SafeTransferLib.safeTransferETH(msg.sender, amount);
        emit Claimed(epochId, msg.sender, amount);
    }

    function isClaimed(
        uint256 epochId,
        address holder
    ) external view returns (bool) {
        return _claimed[epochId][holder];
    }
}
