// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";

contract NftRevenueVaultTest is Test {
    NftRevenueVault internal vault;

    address internal owner = makeAddr("owner");
    address internal alice;
    address internal bob;
    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;

    function setUp() public {
        vault = new NftRevenueVault(owner, 0);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        vm.deal(address(this), 100 ether);
    }

    function _leaf(
        address holder,
        uint256 epochId,
        uint256 amount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(holder, epochId, amount));
    }

    function test_Receive_LogsIt() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_AddEpoch_HappyPath() public {
        (bool ok,) = address(vault).call{value: 5 ether}("");
        assertTrue(ok);
        // URU-A11: addEpoch is `onlyOwner`. Hoist vault.nextEpochId() out of
        // the argument list so it doesn't consume the vm.prank (which only
        // affects the immediate next external call).
        uint256 nextId = vault.nextEpochId();
        vm.prank(owner);
        vault.addEpoch(nextId, bytes32(uint256(0xdeadbeef)), 3 ether);
        (bytes32 root, uint256 total, uint256 unclaimed) = vault.epochs(0);
        assertEq(root, bytes32(uint256(0xdeadbeef)));
        assertEq(total, 3 ether);
        assertEq(unclaimed, 3 ether);
    }

    function test_AddEpoch_RevertsWithoutBalance() public {
        // Was InsufficientBalance; V4 uses OverCommit which tracks the running
        // sum of live-epoch claims vs current vault balance (see H-2 audit fix).
        uint256 nextId = vault.nextEpochId();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__OverCommit.selector, 1 ether, 0));
        vault.addEpoch(nextId, bytes32(uint256(1)), 1 ether);
    }

    function test_Claim_HappyPath() public {
        // Build a 2-leaf tree: alice=1 ETH, bob=2 ETH
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        bytes32 leafA = _leaf(alice, 0, 1 ether);
        bytes32 leafB = _leaf(bob, 0, 2 ether);
        bytes32 root =
            leafA < leafB ? keccak256(abi.encodePacked(leafA, leafB)) : keccak256(abi.encodePacked(leafB, leafA));

        uint256 nextId = vault.nextEpochId();
        vm.prank(owner);
        vault.addEpoch(nextId, root, 3 ether);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
        assertEq(alice.balance, 1 ether);
    }

    function test_Claim_RevertsOnDoubleClaim() public {
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        bytes32 leafA = _leaf(alice, 0, 1 ether);
        bytes32 leafB = _leaf(bob, 0, 2 ether);
        bytes32 root =
            leafA < leafB ? keccak256(abi.encodePacked(leafA, leafB)) : keccak256(abi.encodePacked(leafB, leafA));

        uint256 nextId = vault.nextEpochId();
        vm.prank(owner);
        vault.addEpoch(nextId, root, 3 ether);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
        vm.expectRevert(
            abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__AlreadyClaimed.selector, uint256(0), alice)
        );
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
    }

    function test_Claim_RevertsOnBadProof() public {
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        uint256 nextId = vault.nextEpochId();
        vm.prank(owner);
        vault.addEpoch(nextId, bytes32(uint256(0xabc)), 3 ether);

        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(1));
        vm.expectRevert(NftRevenueVault.NftRevenueVault__InvalidProof.selector);
        vm.prank(alice);
        vault.claim(0, 1 ether, badProof);
    }

    // -----------------------------------------------------------------------
    // URU-P1-M06: pending epochs must reserve their totalAmount from
    // availableBalance + sweepDust for the entire propose -> activate window.
    // Setup uses a fresh vault with `minConfigDelay = 2 days` so the propose /
    // activate path is required. Fund 5 ETH, propose 4 ETH, and verify:
    //   - pendingCommitted == 4
    //   - availableBalance == 1 (5 - 0 activated - 4 pending)
    //   - sweepDust caps at 1 (owner can only remove the untethered slice)
    //   - after warp + activate, pending clears and totalCommitted == 4 (fully funded)
    // The auditor's acceptance line: "A proposed four-ETH epoch against five ETH
    // reports one ETH available; sweepDust can remove only one ETH; activation
    // remains fully funded."
    // -----------------------------------------------------------------------
    function test_PendingEpochReservesFundsFromSweep() public {
        NftRevenueVault delayed = new NftRevenueVault(owner, 2 days);
        (bool ok,) = address(delayed).call{value: 5 ether}("");
        assertTrue(ok);

        vm.prank(owner);
        delayed.proposeEpoch(0, bytes32(uint256(0x1234)), 4 ether);

        assertEq(delayed.pendingCommitted(), 4 ether, "propose did not reserve");
        assertEq(delayed.availableBalance(), 1 ether, "available did not shrink");

        uint256 before = owner.balance;
        vm.prank(owner);
        delayed.sweepDust(owner);
        assertEq(owner.balance - before, 1 ether, "sweep took more than available");
        assertEq(address(delayed).balance, 4 ether, "vault under-funded after sweep");

        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        delayed.activateEpoch();
        assertEq(delayed.pendingCommitted(), 0, "pending not released on activate");
        assertEq(delayed.totalCommitted(), 4 ether, "activated commitment wrong");
    }

    /// URU-P1-M06: cancelling a proposal releases the entire reservation, so
    /// availableBalance snaps back to the full untethered balance.
    function test_CancellingPendingEpochReleasesReservation() public {
        NftRevenueVault delayed = new NftRevenueVault(owner, 2 days);
        (bool ok,) = address(delayed).call{value: 5 ether}("");
        assertTrue(ok);

        vm.prank(owner);
        delayed.proposeEpoch(0, bytes32(uint256(0x1234)), 4 ether);
        vm.prank(owner);
        delayed.cancelPendingEpoch();

        assertEq(delayed.pendingCommitted(), 0, "cancel did not release reservation");
        assertEq(delayed.availableBalance(), 5 ether, "available not restored");
    }
}
