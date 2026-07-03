// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";

contract ERC20WithVotesGenTest is Test {
    ERC20WithVotesGen internal impl;
    ERC20WithVotesGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        impl = new ERC20WithVotesGen();
        token = ERC20WithVotesGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "Votes", "VOTE", 1000 ether, alice, moduleData);
        token.initialize(initData);
    }

    function test_Init_EmitsVotesEnabled() public {
        ERC20WithVotesGen fresh = ERC20WithVotesGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "V", "V", 0, address(0), moduleData);
        vm.expectEmit(false, false, false, true, address(fresh));
        emit ERC20WithVotesGen.VotesEnabled();
        fresh.initialize(initData);
    }

    function test_Delegate_SelfActivatesVotingPower() public {
        // Before delegation, votes are zero even though balance is non-zero.
        assertEq(token.getVotes(alice), 0);
        assertEq(token.balanceOf(alice), 1000 ether);

        vm.prank(alice);
        token.delegate(alice);
        assertEq(token.getVotes(alice), 1000 ether);
    }

    function test_Delegate_TransfersVotingPowerOnTransfer() public {
        vm.prank(alice);
        token.delegate(alice);
        vm.prank(bob);
        token.delegate(bob);

        vm.prank(alice);
        token.transfer(bob, 400 ether);

        assertEq(token.getVotes(alice), 600 ether);
        assertEq(token.getVotes(bob), 400 ether);
    }

    function test_Delegates_DefaultsToZero() public view {
        assertEq(token.delegates(alice), address(0));
    }

    function test_GetPastVotes_RevertsOnFuture() public {
        vm.prank(alice);
        token.delegate(alice);
        vm.expectRevert();
        token.getPastVotes(alice, block.timestamp);
    }

    function test_Clock_UsesTimestampByDefault() public view {
        assertEq(uint256(token.clock()), block.timestamp);
    }
}
