// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721AWithSvgAndRoyaltyGen} from "src/templates/composed/ERC721AWithSvgAndRoyaltyGen.sol";

/// @notice Two-module composition for the ERC-721A base. Both modules must coexist correctly.
///         Alphabetical splice order: ERC2981Royalty=0, OnChainSVG=1.
contract ERC721AWithSvgAndRoyaltyGenTest is Test {
    ERC721AWithSvgAndRoyaltyGen internal impl;
    ERC721AWithSvgAndRoyaltyGen internal token;

    address internal owner = makeAddr("owner");
    address internal receiver = makeAddr("receiver");
    address internal alice = makeAddr("alice");

    uint96 internal constant FEE_BPS = 500;

    function setUp() public {
        impl = new ERC721AWithSvgAndRoyaltyGen();
        token = ERC721AWithSvgAndRoyaltyGen(LibClone.clone(address(impl)));

        // Alphabetical order: ERC2981Royalty at index 0, OnChainSVG at index 1 (no params).
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(receiver, FEE_BPS);
        moduleData[1] = ""; // OnChainSVG takes no params

        bytes memory initData = abi.encode(owner, "Dual", "DUAL", string(""), uint256(1000), moduleData);
        token.initialize(initData);
    }

    function test_BothModulesConfigured() public view {
        // Royalty
        assertEq(token.royaltyReceiver(), receiver);
        assertEq(token.royaltyBps(), FEE_BPS);
        // OnChainSVG needs a minted token to render — skip content check here (see next test).
    }

    function test_TokenURI_UsesOnChainSVGOverride() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);
        string memory uri = token.tokenURI(1);
        // Should be a base64 data URI, not the plain baseURI + id.
        assertTrue(bytes(uri).length > 100, "onchain SVG URI should be substantial");
    }

    function test_RoyaltyInfo_StillWorks() public view {
        (address r, uint256 amount) = token.royaltyInfo(0, 10 ether);
        assertEq(r, receiver);
        assertEq(amount, 10 ether * FEE_BPS / 10_000);
    }

    function test_SupportsInterface_BothERC721AndERC2981() public view {
        assertTrue(token.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(token.supportsInterface(0x2a55205a), "ERC-2981");
    }

    function test_CrossModuleStateIndependence() public {
        vm.prank(owner);
        token.setRoyaltyReceiver(alice);
        assertEq(token.royaltyReceiver(), alice);
        // OnChainSVG behavior unchanged.
        vm.prank(owner);
        token.mintBatch(alice, 1);
        string memory uri = token.tokenURI(0);
        assertTrue(bytes(uri).length > 100);
    }
}
