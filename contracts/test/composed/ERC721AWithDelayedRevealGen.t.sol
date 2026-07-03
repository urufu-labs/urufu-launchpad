// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721AWithDelayedRevealGen} from "src/templates/composed/ERC721AWithDelayedRevealGen.sol";

contract ERC721AWithDelayedRevealGenTest is Test {
    ERC721AWithDelayedRevealGen internal impl;
    ERC721AWithDelayedRevealGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        impl = new ERC721AWithDelayedRevealGen();
        token = ERC721AWithDelayedRevealGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(string("ipfs://hidden/"));
        bytes memory initData = abi.encode(owner, "Reveal", "RVL", string("ipfs://real/"), uint256(100), moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresHiddenAndNotRevealed() public view {
        assertFalse(token.delayedRevealIsRevealed());
        assertEq(token.delayedRevealHiddenURI(), "ipfs://hidden/");
    }

    function test_TokenURI_ServesHiddenPreReveal() public {
        vm.prank(owner);
        token.mintBatch(alice, 3);
        assertEq(token.tokenURI(1), "ipfs://hidden/1");
    }

    function test_TokenURI_ServesRealPostReveal() public {
        vm.prank(owner);
        token.mintBatch(alice, 3);

        vm.expectEmit(false, false, false, true, address(token));
        emit ERC721AWithDelayedRevealGen.DelayedRevealRevealed("ipfs://real/");
        vm.prank(owner);
        token.reveal();
        assertTrue(token.delayedRevealIsRevealed());

        assertEq(token.tokenURI(1), "ipfs://real/1");
    }

    function test_TokenURI_NonexistentReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ERC721AWithDelayedRevealGen.DelayedReveal__NonexistentToken.selector, uint256(0))
        );
        token.tokenURI(0);
    }

    function test_Reveal_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.reveal();
    }

    function test_Reveal_TwiceReverts() public {
        vm.prank(owner);
        token.reveal();
        vm.expectRevert(ERC721AWithDelayedRevealGen.DelayedReveal__AlreadyRevealed.selector);
        vm.prank(owner);
        token.reveal();
    }
}
