// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC1155WithSupplyGen} from "src/templates/composed/ERC1155WithSupplyGen.sol";

contract ERC1155WithSupplyGenTest is Test {
    ERC1155WithSupplyGen internal impl;
    ERC1155WithSupplyGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        impl = new ERC1155WithSupplyGen();
        token = ERC1155WithSupplyGen(LibClone.clone(address(impl)));

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory caps = new uint256[](2);
        caps[0] = 100;
        caps[1] = 50;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(ids, caps);
        bytes memory initData = abi.encode(owner, "Cards", "CRD", "ipfs://Qm/{id}.json", moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresCaps() public view {
        (uint256 cap1, bool capped1) = token.supplyCapOf(1);
        (uint256 cap2, bool capped2) = token.supplyCapOf(2);
        (uint256 cap3, bool capped3) = token.supplyCapOf(3);
        assertEq(cap1, 100);
        assertTrue(capped1);
        assertEq(cap2, 50);
        assertTrue(capped2);
        assertEq(cap3, 0);
        assertFalse(capped3);
    }

    function test_Mint_WithinCap() public {
        vm.prank(owner);
        token.mint(alice, 1, 30, "");
        assertEq(token.balanceOf(alice, 1), 30);
        assertEq(token.totalMintedOf(1), 30);
        assertEq(token.remainingSupplyOf(1), 70);
    }

    function test_Mint_RevertsWhenExceedingCap() public {
        vm.prank(owner);
        token.mint(alice, 2, 50, "");
        vm.expectRevert(abi.encodeWithSelector(ERC1155WithSupplyGen.SupplyPerToken1155__ExceedsCap.selector, 2, 1, 0));
        vm.prank(owner);
        token.mint(alice, 2, 1, "");
    }

    function test_Mint_UncappedIdUnlimited() public {
        vm.prank(owner);
        token.mint(alice, 3, 1_000_000, "");
        assertEq(token.balanceOf(alice, 3), 1_000_000);
        assertEq(token.remainingSupplyOf(3), type(uint256).max);
    }

    function test_BatchMint_ChecksEveryId() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 40;
        amounts[1] = 60; // exceeds cap of 50 for id 2

        vm.expectRevert(abi.encodeWithSelector(ERC1155WithSupplyGen.SupplyPerToken1155__ExceedsCap.selector, 2, 60, 50));
        vm.prank(owner);
        token.mintBatch(alice, ids, amounts, "");
    }

    function test_Transfer_NotCountedTowardCap() public {
        address bob = makeAddr("bob");
        vm.prank(owner);
        token.mint(alice, 1, 30, "");
        // Transfer doesn't count toward minted supply (from != address(0))
        vm.prank(alice);
        token.safeTransferFrom(alice, bob, 1, 10, "");
        assertEq(token.totalMintedOf(1), 30, "minted should not change on transfer");
    }
}
