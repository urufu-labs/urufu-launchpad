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
    error NftRevenueVault__ZeroAddress();
    /// URU-A06: the on-chain publish contract now requires the publisher to
    /// declare which epoch ID their merkle tree was built for. Stale readers
    /// that saw the same `nextEpochId` as the winning transaction now revert
    /// here instead of silently landing a mismatched root at `nextEpochId + 1`.
    error NftRevenueVault__UnexpectedEpochId(uint256 expected, uint256 actual);
    /// URU-A11 (remainder): production deploys wire a real timelock. When
    /// `minConfigDelay > 0`, `addEpoch` is disabled and the only publication
    /// path is `proposeEpoch` → wait → `activateEpoch`. Test deploys pass
    /// `minConfigDelay = 0` and keep the direct path.
    error NftRevenueVault__DirectAddEpochDisabled();
    error NftRevenueVault__NoPendingEpoch();
    error NftRevenueVault__PendingEpochNotReady(uint256 readyAt);
    /// URU-A11: `proposeEpoch` while another proposal is still pending would
    /// let an owner stack proposals and race the timelock via `cancelPending +
    /// activate`. One at a time.
    error NftRevenueVault__PendingEpochExists();

    event Received(address indexed from, uint256 amount);
    event EpochAdded(uint256 indexed epoch, bytes32 merkleRoot, uint256 totalAmount);
    event Claimed(uint256 indexed epoch, address indexed holder, uint256 amount);
    /// URU-A11: emitted at the propose call; downstream monitoring can
    /// enumerate every pending root before it activates.
    event EpochProposed(uint256 indexed expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint256 readyAt);
    event EpochProposalCancelled(uint256 indexed expectedEpochId);

    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalAmount;
        uint256 unclaimed;
    }

    uint256 public nextEpochId;
    mapping(uint256 => Epoch) public epochs;
    /// epoch → holder → claimed?
    mapping(uint256 => mapping(address => bool)) private _claimed;

    /// Running sum of unclaimed balances across ALL live (activated) epochs.
    /// New `addEpoch` / `_applyEpoch` calls check that adding `totalAmount`
    /// keeps `totalCommitted + pendingCommitted` <= vault balance. Prevents the
    /// double-commit bug where two 100-ETH epochs pass individually against a
    /// 100-ETH deposit but drain balance below the second batch of claimers.
    uint256 public totalCommitted;

    /// URU-P1-M06: ETH reserved by the one pending timelocked epoch. A proposal
    /// is a real financial commitment even before activation: `availableBalance`
    /// and `sweepDust` must not expose these funds as surplus during the delay,
    /// otherwise an owner-key attacker could propose + sweep in parallel and
    /// leave the eventual activation under-funded for claimers.
    uint256 public pendingCommitted;

    /// URU-A11: publication timelock in seconds. Production sets this to a
    /// real value (e.g. 2 days) so `addEpoch` is disabled and every new root
    /// must go through `proposeEpoch` → wait → `activateEpoch`. Test setups
    /// pass 0 to keep the direct `addEpoch` path.
    uint256 public immutable minConfigDelay;

    struct PendingEpoch {
        uint256 expectedEpochId;
        bytes32 merkleRoot;
        uint256 totalAmount;
        uint64 readyAt;
    }

    /// URU-A11: at most one pending publication at a time. Stacking would let
    /// an owner-key attacker pre-arm several roots and burn the timelock once,
    /// then execute all of them post-maturity.
    PendingEpoch public pendingEpoch;

    event Swept(address indexed to, uint256 amount);

    constructor(
        address initialOwner,
        uint256 minConfigDelay_
    ) {
        _initializeOwner(initialOwner);
        minConfigDelay = minConfigDelay_;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Direct publish path (test / bootstrap only). URU-A11 requires
    ///         production to use `proposeEpoch` + `activateEpoch`; this
    ///         function reverts when `minConfigDelay > 0`. URU-A06 adds the
    ///         `expectedEpochId` argument so a stale publisher racing another
    ///         reverts instead of landing at `nextEpochId + 1` with a stale root.
    function addEpoch(
        uint256 expectedEpochId,
        bytes32 merkleRoot,
        uint256 totalAmount
    ) external onlyOwner {
        if (minConfigDelay != 0) revert NftRevenueVault__DirectAddEpochDisabled();
        _applyEpoch(expectedEpochId, merkleRoot, totalAmount);
    }

    /// @notice URU-A11: propose a new epoch root. Publisher's tree MUST have
    ///         been built for `expectedEpochId`; validated here so a stale
    ///         proposal fails before waiting the timelock.
    function proposeEpoch(
        uint256 expectedEpochId,
        bytes32 merkleRoot,
        uint256 totalAmount
    ) external onlyOwner {
        if (pendingEpoch.readyAt != 0) revert NftRevenueVault__PendingEpochExists();
        // Validate NOW (same as `_applyEpoch`) so an invalid proposal doesn't
        // spend two days of pending window before failing at activation.
        if (expectedEpochId != nextEpochId) {
            revert NftRevenueVault__UnexpectedEpochId(expectedEpochId, nextEpochId);
        }
        if (totalAmount == 0) revert NftRevenueVault__ZeroAmount();
        if (merkleRoot == bytes32(0)) revert NftRevenueVault__ZeroRoot();
        // URU-P1-M06: overcommit check now includes ETH already reserved by any
        // currently-pending propose. `pendingCommitted` is guaranteed to be 0
        // when we reach here because `PendingEpochExists` blocks stacking, but
        // sum it in for defensive symmetry with `_applyEpoch`.
        uint256 newCommitted = totalCommitted + pendingCommitted + totalAmount;
        if (address(this).balance < newCommitted) {
            revert NftRevenueVault__OverCommit(newCommitted, address(this).balance);
        }
        uint64 readyAt = uint64(block.timestamp + minConfigDelay);
        // Reserve immediately so a same-block sweepDust cannot skim the funds
        // this proposal is depending on before the timelock elapses.
        pendingCommitted += totalAmount;
        pendingEpoch = PendingEpoch({
            expectedEpochId: expectedEpochId, merkleRoot: merkleRoot, totalAmount: totalAmount, readyAt: readyAt
        });
        emit EpochProposed(expectedEpochId, merkleRoot, totalAmount, readyAt);
    }

    /// @notice URU-A11: activate a matured proposed epoch. Revalidates
    ///         `expectedEpochId == nextEpochId` because another epoch could
    ///         have been published (via test-mode addEpoch) between propose
    ///         and activate — in that case the proposed tree is stale and
    ///         must be cancelled.
    function activateEpoch() external onlyOwner {
        PendingEpoch memory p = pendingEpoch;
        if (p.readyAt == 0) revert NftRevenueVault__NoPendingEpoch();
        if (block.timestamp < p.readyAt) revert NftRevenueVault__PendingEpochNotReady(p.readyAt);
        // Move the reservation from pending to active in the same transaction.
        // If `_applyEpoch` reverts, EVM rollback restores both fields — no
        // dangling pending, no lost reservation. `_applyEpoch` bumps
        // `totalCommitted`, so we release `pendingCommitted` here to keep the
        // combined committed sum flat across the transition.
        delete pendingEpoch;
        pendingCommitted -= p.totalAmount;
        _applyEpoch(p.expectedEpochId, p.merkleRoot, p.totalAmount);
    }

    /// @notice URU-A11: safety valve. Owner cancels a proposed epoch — e.g.
    ///         wrong root, wrong amount, snapshot needs rebuilding.
    function cancelPendingEpoch() external onlyOwner {
        PendingEpoch memory p = pendingEpoch;
        if (p.readyAt == 0) revert NftRevenueVault__NoPendingEpoch();
        delete pendingEpoch;
        // URU-P1-M06: release the reserved slice so sweepDust and
        // availableBalance reflect the full untethered balance again.
        pendingCommitted -= p.totalAmount;
        emit EpochProposalCancelled(p.expectedEpochId);
    }

    /// @notice URU-A07: ETH that's not already backing a live epoch. Off-chain
    ///         publishers MUST use this value rather than `address(this).balance`
    ///         when computing the next epoch's `totalAmount`, otherwise
    ///         overlapping epochs revert `OverCommit`.
    function availableBalance() external view returns (uint256) {
        uint256 balance = address(this).balance;
        // URU-P1-M06: pending proposals reserve funds too.
        uint256 committed = totalCommitted + pendingCommitted;
        return balance > committed ? balance - committed : 0;
    }

    /// Internal core — used by both `addEpoch` (test-mode) and `activateEpoch`
    /// (production propose/activate). URU-A06 stale-publisher check.
    function _applyEpoch(
        uint256 expectedEpochId,
        bytes32 merkleRoot,
        uint256 totalAmount
    ) internal {
        uint256 actualEpochId = nextEpochId;
        if (expectedEpochId != actualEpochId) {
            revert NftRevenueVault__UnexpectedEpochId(expectedEpochId, actualEpochId);
        }
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
        nextEpochId = actualEpochId + 1;
        epochs[actualEpochId] = Epoch({merkleRoot: merkleRoot, totalAmount: totalAmount, unclaimed: totalAmount});
        totalCommitted = newCommitted;
        emit EpochAdded(actualEpochId, merkleRoot, totalAmount);
    }

    /// Owner sweeps ETH that isn't backing an unclaimed epoch. Useful when a
    /// published root has an off-by-N `totalAmount` (dust residue), a merkle
    /// leaf's holder is dead-wallet + unrecoverable, or an epoch's holders
    /// never fully claim before a snapshot window closes. Bounded to the
    /// dust surplus so live claims can't be starved.
    function sweepDust(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert NftRevenueVault__ZeroAddress();
        uint256 bal = address(this).balance;
        // URU-P1-M06: cap sweep by activated + pending reservations so an
        // owner can't skim funds that a matured proposal will need at
        // activation time.
        uint256 committed = totalCommitted + pendingCommitted;
        if (bal <= committed) revert NftRevenueVault__NothingToSweep();
        uint256 amount = bal - committed;
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
