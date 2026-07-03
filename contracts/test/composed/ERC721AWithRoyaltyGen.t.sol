// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721AWithRoyaltyGen} from "src/templates/composed/ERC721AWithRoyaltyGen.sol";

contract ERC721AWithRoyaltyGenTest is Test {
    ERC721AWithRoyaltyGen internal impl;
    ERC721AWithRoyaltyGen internal token;

    address internal owner = makeAddr("owner");
    address internal receiver = makeAddr("receiver");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;
    uint96 internal constant FEE_BPS = 500; // 5%

    function setUp() public {
        impl = new ERC721AWithRoyaltyGen();
        token = ERC721AWithRoyaltyGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(receiver, FEE_BPS);

        bytes memory initData = abi.encode(owner, "Royal NFT", "ROYL", string(""), uint256(1000), moduleData);
        token.initialize(initData);
    }

    function test_Init_SetsRoyaltyConfig() public view {
        assertEq(token.royaltyReceiver(), receiver);
        assertEq(token.royaltyBps(), FEE_BPS);
    }

    function test_RoyaltyInfo_ReturnsCorrectAmount() public view {
        uint256 salePrice = 10 ether;
        (address r, uint256 amount) = token.royaltyInfo(0, salePrice);
        assertEq(r, receiver);
        assertEq(amount, salePrice * FEE_BPS / 10_000);
    }

    function test_RoyaltyInfo_ForAnyTokenId_ReturnsSame() public view {
        (address r1, uint256 a1) = token.royaltyInfo(0, 1000);
        (address r2, uint256 a2) = token.royaltyInfo(999_999, 1000);
        assertEq(r1, r2);
        assertEq(a1, a2);
    }

    function test_SupportsInterface_ERC2981() public view {
        assertTrue(token.supportsInterface(0x2a55205a));
    }

    function test_SupportsInterface_StillPropagatesERC721() public view {
        // ERC-721 interface id.
        assertTrue(token.supportsInterface(0x80ac58cd));
    }

    function test_SetRoyaltyReceiver_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setRoyaltyReceiver(alice);
    }

    function test_SetRoyaltyReceiver_UpdatesAndEmits() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit ERC721AWithRoyaltyGen.RoyaltyReceiverUpdated(receiver, alice);
        vm.prank(owner);
        token.setRoyaltyReceiver(alice);
        assertEq(token.royaltyReceiver(), alice);
    }

    function test_SetRoyaltyReceiver_RevertsOnZero() public {
        vm.expectRevert(ERC721AWithRoyaltyGen.ERC2981Royalty__ZeroReceiver.selector);
        vm.prank(owner);
        token.setRoyaltyReceiver(address(0));
    }

    function test_Init_RevertsOnFeeAbove10Pct() public {
        ERC721AWithRoyaltyGen fresh = ERC721AWithRoyaltyGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(receiver, uint96(1001)); // > 1000 bps = > 10%
        bytes memory data = abi.encode(owner, "n", "n", string(""), uint256(0), bad);
        vm.expectRevert(
            abi.encodeWithSelector(ERC721AWithRoyaltyGen.ERC2981Royalty__InvalidFeeBps.selector, uint96(1001))
        );
        fresh.initialize(data);
    }

    function test_Init_RevertsOnZeroReceiver() public {
        ERC721AWithRoyaltyGen fresh = ERC721AWithRoyaltyGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(address(0), FEE_BPS);
        bytes memory data = abi.encode(owner, "n", "n", string(""), uint256(0), bad);
        vm.expectRevert(ERC721AWithRoyaltyGen.ERC2981Royalty__ZeroReceiver.selector);
        fresh.initialize(data);
    }
}
