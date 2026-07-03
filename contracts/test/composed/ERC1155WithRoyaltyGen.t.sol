// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC1155WithRoyaltyGen} from "src/templates/composed/ERC1155WithRoyaltyGen.sol";

contract ERC1155WithRoyaltyGenTest is Test {
    ERC1155WithRoyaltyGen internal impl;
    ERC1155WithRoyaltyGen internal token;

    address internal owner = makeAddr("owner");
    address internal receiver = makeAddr("receiver");

    uint96 internal constant FEE_BPS = 500;

    function setUp() public {
        impl = new ERC1155WithRoyaltyGen();
        token = ERC1155WithRoyaltyGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(receiver, FEE_BPS);
        bytes memory initData = abi.encode(owner, "Roy", "ROY", "ipfs://{id}.json", moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresRoyalty() public view {
        assertEq(token.royaltyReceiver(), receiver);
        assertEq(token.royaltyFeeBps(), FEE_BPS);
    }

    function test_RoyaltyInfo_ComputesCorrectly() public view {
        (address recv, uint256 amount) = token.royaltyInfo(1, 1 ether);
        assertEq(recv, receiver);
        assertEq(amount, 0.05 ether);
    }

    function test_RoyaltyInfo_ScalesLinearly() public view {
        (, uint256 amount) = token.royaltyInfo(42, 10 ether);
        assertEq(amount, 0.5 ether);
    }

    function test_SupportsInterface_AdvertisesERC2981() public view {
        // ERC-2981 interface id.
        assertTrue(token.supportsInterface(0x2a55205a));
    }

    function test_SupportsInterface_DelegatesToSuperForOthers() public view {
        assertTrue(token.supportsInterface(0xd9b67a26)); // ERC-1155 interface id (from Solady)
    }

    function test_Init_RevertsOnZeroReceiver() public {
        ERC1155WithRoyaltyGen fresh = ERC1155WithRoyaltyGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(address(0), FEE_BPS);
        bytes memory initData = abi.encode(owner, "R", "R", "", moduleData);
        vm.expectRevert(ERC1155WithRoyaltyGen.ERC2981Royalty1155__ZeroReceiver.selector);
        fresh.initialize(initData);
    }

    function test_Init_RevertsOnFeeTooHigh() public {
        ERC1155WithRoyaltyGen fresh = ERC1155WithRoyaltyGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(receiver, uint96(1001)); // over 10% cap
        bytes memory initData = abi.encode(owner, "R", "R", "", moduleData);
        vm.expectRevert(abi.encodeWithSelector(ERC1155WithRoyaltyGen.ERC2981Royalty1155__FeeTooHigh.selector, 1001));
        fresh.initialize(initData);
    }
}
