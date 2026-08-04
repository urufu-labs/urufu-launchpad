// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract StubERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "STUB";
    }

    function symbol() public pure override returns (string memory) {
        return "STUB";
    }

    function mint(
        address to,
        uint256 amt
    ) external {
        _mint(to, amt);
    }
}

/// @title  GovernanceTimelocksTest — URU-A06 + URU-A11 (round 3 gap coverage)
/// @notice The auditor flagged that URU-A06 stale-publisher revert and URU-A11
///         propose/activate/cancel flows on NftRevenueVault, UruDepositSink,
///         and UruBuybackVault were implemented but had no automated tests.
///         This suite covers the untested revert selectors + happy paths.
contract GovernanceTimelocksTest is Test {
    NftRevenueVault internal vault;
    UruBuybackVault internal buyback;
    UruDepositSink internal sink;
    StubERC20 internal uru;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal swapTarget = makeAddr("swapTarget");
    address internal distSink = makeAddr("distSink");

    uint256 internal constant TIMELOCK = 2 days;

    function setUp() public {
        // NftRevenueVault under real timelock.
        vault = new NftRevenueVault(admin, TIMELOCK);

        // Uru stack under real timelock. Sink needs a real token address for
        // the uru() invariant read; use the same StubERC20 for both.
        uru = new StubERC20();
        // UruBuybackVault(admin, uru, distributionSink, minConfigDelay)
        buyback = new UruBuybackVault(admin, address(uru), distSink, TIMELOCK);
        sink = new UruDepositSink(admin, address(uru), distSink, TIMELOCK);
    }

    // =============================================================
    // URU-A06 — stale publisher gets UnexpectedEpochId
    // =============================================================

    function test_URU_A06_ProposeEpoch_StaleIdReverts() public {
        // Fund the vault so overcommit doesn't fire first.
        vm.deal(address(vault), 10 ether);
        // nextEpochId starts at 0. Propose against id=5 → revert.
        vm.expectRevert(abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__UnexpectedEpochId.selector, 5, 0));
        vm.prank(admin);
        vault.proposeEpoch(5, keccak256("root"), 1 ether);
    }

    function test_URU_A06_AddEpoch_DisabledUnderTimelock() public {
        vm.deal(address(vault), 10 ether);
        // With minConfigDelay > 0, addEpoch is disabled outright.
        vm.expectRevert(NftRevenueVault.NftRevenueVault__DirectAddEpochDisabled.selector);
        vm.prank(admin);
        vault.addEpoch(0, keccak256("root"), 1 ether);
    }

    // =============================================================
    // URU-A11 — NftRevenueVault propose/activate/cancel flow
    // =============================================================

    function test_URU_A11_NftVault_ProposeThenActivate_Full() public {
        vm.deal(address(vault), 10 ether);
        bytes32 root = keccak256("epoch-root");

        // Propose.
        vm.prank(admin);
        vault.proposeEpoch(0, root, 1 ether);
        (uint256 expectedId, bytes32 pendingRoot, uint256 pendingAmt, uint64 readyAt) = vault.pendingEpoch();
        assertEq(expectedId, 0);
        assertEq(pendingRoot, root);
        assertEq(pendingAmt, 1 ether);
        assertEq(readyAt, uint64(block.timestamp + TIMELOCK));

        // Activate too early.
        vm.expectRevert(abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__PendingEpochNotReady.selector, readyAt));
        vm.prank(admin);
        vault.activateEpoch();

        // Warp past timelock and activate.
        vm.warp(readyAt + 1);
        vm.prank(admin);
        vault.activateEpoch();

        // Effects: nextEpochId incremented, pending cleared, totalCommitted set.
        assertEq(vault.nextEpochId(), 1);
        (, bytes32 stillPending,, uint64 stillReady) = vault.pendingEpoch();
        assertEq(stillPending, bytes32(0), "pending root not cleared");
        assertEq(stillReady, 0, "pending readyAt not cleared");
        assertEq(vault.totalCommitted(), 1 ether);
    }

    function test_URU_A11_NftVault_StackedProposalReverts() public {
        vm.deal(address(vault), 10 ether);
        vm.prank(admin);
        vault.proposeEpoch(0, keccak256("r1"), 1 ether);

        vm.expectRevert(NftRevenueVault.NftRevenueVault__PendingEpochExists.selector);
        vm.prank(admin);
        vault.proposeEpoch(0, keccak256("r2"), 1 ether);
    }

    function test_URU_A11_NftVault_CancelClearsPending() public {
        vm.deal(address(vault), 10 ether);
        vm.prank(admin);
        vault.proposeEpoch(0, keccak256("r"), 1 ether);

        vm.prank(admin);
        vault.cancelPendingEpoch();

        (, bytes32 root,, uint64 readyAt) = vault.pendingEpoch();
        assertEq(root, bytes32(0));
        assertEq(readyAt, 0);
    }

    function test_URU_A11_NftVault_CancelWithoutProposalReverts() public {
        vm.expectRevert(NftRevenueVault.NftRevenueVault__NoPendingEpoch.selector);
        vm.prank(admin);
        vault.cancelPendingEpoch();
    }

    function test_URU_A11_NftVault_ActivateWithoutProposalReverts() public {
        vm.expectRevert(NftRevenueVault.NftRevenueVault__NoPendingEpoch.selector);
        vm.prank(admin);
        vault.activateEpoch();
    }

    // =============================================================
    // URU-A11 — UruDepositSink keeper/target/rate propose flow
    // =============================================================

    /// Direct `setKeeper` reverts because `_consumeAdminChange` finds no matured
    /// proposal for `keeperChangeId(keeper, allowed)`.
    function test_URU_A11_UruSink_SetKeeper_RequiresProposal() public {
        vm.expectRevert();
        vm.prank(admin);
        sink.setKeeper(keeper, true);
    }

    /// Propose → wait → apply lands cleanly. Proves the whole roundtrip works,
    /// not just the revert path.
    function test_URU_A11_UruSink_ProposeThenApply_SetKeeper() public {
        bytes32 id = sink.keeperChangeId(keeper, true);
        vm.prank(admin);
        sink.proposeAdminChange(id);

        // Before maturity — still reverts.
        vm.expectRevert();
        vm.prank(admin);
        sink.setKeeper(keeper, true);

        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(admin);
        sink.setKeeper(keeper, true);
        assertTrue(sink.isKeeper(keeper));
    }

    function test_URU_A11_UruSink_SetSwapTarget_RequiresProposal() public {
        vm.expectRevert();
        vm.prank(admin);
        sink.setSwapTarget(swapTarget, true);
    }

    function test_URU_A11_UruSink_SetMinEthPerUru_RequiresProposal() public {
        vm.expectRevert();
        vm.prank(admin);
        sink.setMinEthPerUru(1e18);
    }

    // =============================================================
    // URU-A11 — UruBuybackVault keeper/target/rate propose flow
    // =============================================================

    function test_URU_A11_UruBuyback_SetKeeper_RequiresProposal() public {
        vm.expectRevert();
        vm.prank(admin);
        buyback.setKeeper(keeper, true);
    }

    function test_URU_A11_UruBuyback_ProposeThenApply_SetKeeper() public {
        bytes32 id = buyback.keeperChangeId(keeper, true);
        vm.prank(admin);
        buyback.proposeAdminChange(id);
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(admin);
        buyback.setKeeper(keeper, true);
        assertTrue(buyback.isKeeper(keeper));
    }

    function test_URU_A11_UruBuyback_SetSwapTarget_RequiresProposal() public {
        vm.expectRevert();
        vm.prank(admin);
        buyback.setSwapTarget(swapTarget, true);
    }
}
