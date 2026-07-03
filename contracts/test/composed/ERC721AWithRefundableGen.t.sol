// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721AWithRefundableGen} from "src/templates/composed/ERC721AWithRefundableGen.sol";

contract ERC721AWithRefundableGenTest is Test {
    ERC721AWithRefundableGen internal impl;
    ERC721AWithRefundableGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant PRICE = 0.01 ether;
    uint32 internal constant WINDOW = 100;
    uint256 internal constant MAX_SUPPLY = 100;

    function setUp() public {
        impl = new ERC721AWithRefundableGen();
        token = ERC721AWithRefundableGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(PRICE, WINDOW);
        bytes memory initData = abi.encode(owner, "Refundable", "REF", "ipfs://base/", MAX_SUPPLY, moduleData);
        token.initialize(initData);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_Init_StoresParams() public view {
        assertEq(token.refundablePricePerToken(), PRICE);
        assertEq(token.refundableWindowBlocks(), WINDOW);
    }

    function test_Mint_HappyPath() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE * 3}(3);
        assertEq(token.balanceOf(alice), 3);
        assertEq(token.ownerOf(0), alice);
        assertEq(token.refundableMintBlockOf(0), block.number);
        assertEq(token.refundableMintBlockOf(2), block.number);
    }

    function test_Mint_RevertsOnWrongPrice() public {
        vm.expectRevert(
            abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__WrongPrice.selector, PRICE * 2, PRICE * 3)
        );
        vm.prank(alice);
        token.refundableMint{value: PRICE * 2}(3);
    }

    function test_Mint_RevertsOnZeroQty() public {
        vm.expectRevert(ERC721AWithRefundableGen.Refundable__ZeroQuantity.selector);
        vm.prank(alice);
        token.refundableMint{value: 0}(0);
    }

    function test_Refund_HappyPath() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE * 2}(2);
        uint256 balBefore = alice.balance;

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        vm.prank(alice);
        token.refund(ids);

        assertEq(alice.balance, balBefore + PRICE * 2);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_Refund_RevertsAfterWindow() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);

        vm.roll(block.number + WINDOW + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__WindowExpired.selector, 0));
        vm.prank(alice);
        token.refund(ids);
    }

    function test_Refund_RevertsIfNotOwner() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__NotOwner.selector, 0, bob));
        vm.prank(bob);
        token.refund(ids);
    }

    function test_Withdraw_HappyPath() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE * 2}(2);

        vm.roll(block.number + WINDOW + 1);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        vm.prank(owner);
        token.refundableWithdraw(owner, ids);
        assertEq(owner.balance, PRICE * 2);
    }

    function test_Withdraw_RevertsWhileWindowOpen() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__WindowStillOpen.selector, 0));
        vm.prank(owner);
        token.refundableWithdraw(owner, ids);
    }

    function test_Withdraw_OnlyOwner() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);
        vm.roll(block.number + WINDOW + 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.expectRevert();
        vm.prank(bob);
        token.refundableWithdraw(bob, ids);
    }

    function test_Withdraw_CannotDoubleSweep() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);
        vm.roll(block.number + WINDOW + 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.prank(owner);
        token.refundableWithdraw(owner, ids);

        // Second sweep on same token should fail (mintBlock cleared).
        vm.expectRevert(abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__WindowExpired.selector, 0));
        vm.prank(owner);
        token.refundableWithdraw(owner, ids);
    }

    function test_Refund_RevertsIfAlreadySwept() public {
        vm.prank(alice);
        token.refundableMint{value: PRICE}(1);
        vm.roll(block.number + WINDOW + 1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.prank(owner);
        token.refundableWithdraw(owner, ids);

        // Alice no longer owns the token (still exists but she can't refund past-window anyway).
        vm.expectRevert(abi.encodeWithSelector(ERC721AWithRefundableGen.Refundable__WindowExpired.selector, 0));
        vm.prank(alice);
        token.refund(ids);
    }
}
