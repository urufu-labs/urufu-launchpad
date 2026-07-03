// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC1155WithPayableGen} from "src/templates/composed/ERC1155WithPayableGen.sol";

contract ERC1155WithPayableGenTest is Test {
    ERC1155WithPayableGen internal impl;
    ERC1155WithPayableGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant PRICE = 0.01 ether;

    function setUp() public {
        impl = new ERC1155WithPayableGen();
        token = ERC1155WithPayableGen(payable(LibClone.clone(address(impl))));

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(ids, prices);
        bytes memory initData = abi.encode(owner, "Pay", "PAY", "ipfs://{id}.json", moduleData);
        token.initialize(initData);

        vm.deal(alice, 5 ether);
    }

    function test_Init_StoresPrices() public view {
        (uint256 price, bool mintable) = token.priceOf(1);
        assertEq(price, PRICE);
        assertTrue(mintable);
        (uint256 price2, bool mintable2) = token.priceOf(2);
        assertEq(price2, 0);
        assertFalse(mintable2);
    }

    function test_MintPayable_HappyPath() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE * 3}(1, 3);
        assertEq(token.balanceOf(alice, 1), 3);
        assertEq(address(token).balance, PRICE * 3);
    }

    function test_MintPayable_RevertsOnWrongPrice() public {
        vm.expectRevert(
            abi.encodeWithSelector(ERC1155WithPayableGen.PayableMint1155__WrongPrice.selector, PRICE * 2, PRICE * 3)
        );
        vm.prank(alice);
        token.mintPayable{value: PRICE * 2}(1, 3);
    }

    function test_MintPayable_RevertsOnUnpricedId() public {
        vm.expectRevert(abi.encodeWithSelector(ERC1155WithPayableGen.PayableMint1155__NotMintable.selector, 2));
        vm.prank(alice);
        token.mintPayable{value: PRICE}(2, 1);
    }

    function test_MintPayable_RevertsOnZeroQty() public {
        vm.expectRevert(ERC1155WithPayableGen.PayableMint1155__ZeroQty.selector);
        vm.prank(alice);
        token.mintPayable{value: 0}(1, 0);
    }

    function test_Withdraw_OwnerSweeps() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE * 5}(1, 5);
        vm.prank(owner);
        token.withdrawPayable(treasury);
        assertEq(treasury.balance, PRICE * 5);
        assertEq(address(token).balance, 0);
    }

    function test_Withdraw_OnlyOwner() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE}(1, 1);
        vm.expectRevert();
        vm.prank(alice);
        token.withdrawPayable(alice);
    }
}
