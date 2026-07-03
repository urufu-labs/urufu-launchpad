// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721AWithSoulboundGen} from "src/templates/composed/ERC721AWithSoulboundGen.sol";

contract ERC721AWithSoulboundGenTest is Test {
    ERC721AWithSoulboundGen internal impl;
    ERC721AWithSoulboundGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        impl = new ERC721AWithSoulboundGen();
        token = ERC721AWithSoulboundGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "Soul", "SOUL", string("ipfs://s/"), uint256(100), moduleData);
        token.initialize(initData);
    }

    function test_Mint_Works() public {
        vm.prank(owner);
        token.mintBatch(alice, 3);
        assertEq(token.balanceOf(alice), 3);
    }

    function test_Transfer_RevertsAfterMint() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);
        vm.expectRevert(ERC721AWithSoulboundGen.Soulbound__NonTransferable.selector);
        vm.prank(alice);
        token.transferFrom(alice, bob, 0);
    }

    function test_SafeTransfer_AlsoReverts() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);
        vm.expectRevert(ERC721AWithSoulboundGen.Soulbound__NonTransferable.selector);
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, 0);
    }

    function test_OwnerCannotBypass() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);
        // Owner can't force alice's tokens to move.
        vm.expectRevert();
        vm.prank(owner);
        token.transferFrom(alice, bob, 0);
    }

    function test_ApprovalDoesNotHelp() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);
        vm.prank(alice);
        token.approve(bob, 0);
        vm.expectRevert(ERC721AWithSoulboundGen.Soulbound__NonTransferable.selector);
        vm.prank(bob);
        token.transferFrom(alice, bob, 0);
    }
}
