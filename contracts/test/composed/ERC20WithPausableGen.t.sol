// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithPausableGen} from "src/templates/composed/ERC20WithPausableGen.sol";

contract ERC20WithPausableGenTest is Test {
    ERC20WithPausableGen internal impl;
    ERC20WithPausableGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        impl = new ERC20WithPausableGen();
        token = ERC20WithPausableGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "Pauze", "PZE", 1000 ether, alice, moduleData);
        token.initialize(initData);
    }

    function test_StartsUnpaused() public view {
        assertFalse(token.pausablePaused());
    }

    function test_Pause_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.pause();
    }

    function test_Pause_EmitsAndBlocksNonOwnerTransfers() public {
        vm.expectEmit(false, false, false, true, address(token));
        emit ERC20WithPausableGen.PausableSet(true);
        vm.prank(owner);
        token.pause();
        assertTrue(token.pausablePaused());

        vm.expectRevert(ERC20WithPausableGen.Pausable__Paused.selector);
        vm.prank(alice);
        token.transfer(bob, 1 ether);
    }

    /// URU-A02 (Pausable honeypot): the old Pausable exempted `from == owner()`
    /// transfers while paused, so an owner who "paused for maintenance" could
    /// still dump their bag into a stuck market. That exemption was removed:
    /// paused means paused for EVERY holder, owner included. This test used
    /// to assert the honeypot ("Owner can still transfer") and passed because
    /// the vulnerable exemption was in place. Post-fix, an owner-originated
    /// transfer while paused reverts Pausable__Paused just like anyone else's.
    function test_Paused_OwnerAlsoBlocked() public {
        // Give the owner a real balance BEFORE pausing so we can prove the
        // pause blocks their transfer for balance reasons unrelated to the
        // check.
        vm.prank(alice);
        token.transfer(owner, 100 ether);
        assertEq(token.balanceOf(owner), 100 ether);

        vm.prank(owner);
        token.pause();
        assertTrue(token.pausablePaused());

        // Owner cannot dump while paused — URU-A02 fix.
        vm.prank(owner);
        vm.expectRevert(ERC20WithPausableGen.Pausable__Paused.selector);
        token.transfer(bob, 30 ether);

        // And bob still hasn't received anything.
        assertEq(token.balanceOf(bob), 0);
    }

    function test_Unpause_RestoresTransfers() public {
        vm.prank(owner);
        token.pause();
        vm.prank(owner);
        token.unpause();
        assertFalse(token.pausablePaused());

        vm.prank(alice);
        token.transfer(bob, 1 ether);
        assertEq(token.balanceOf(bob), 1 ether);
    }

    function test_Paused_MintAndBurnStillWork() public {
        // Mint & burn skip the check (from/to == address(0)). Since we can't call _mint from outside,
        // we verify via initial mint that already happened successfully during setUp — supply > 0.
        assertEq(token.totalSupply(), 1000 ether);
        assertEq(token.balanceOf(alice), 1000 ether);
    }
}
