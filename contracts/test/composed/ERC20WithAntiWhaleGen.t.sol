// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";

contract ERC20WithAntiWhaleGenTest is Test {
    ERC20WithAntiWhaleGen internal impl;
    ERC20WithAntiWhaleGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    uint128 internal constant MAX_WALLET = 1_000_000 ether;
    uint128 internal constant MAX_TX = 100_000 ether;
    uint32 internal constant EXPIRE_AFTER = 1000;
    uint256 internal constant INITIAL_SUPPLY = 10_000_000 ether;
    uint256 internal launchBlock;

    function setUp() public {
        impl = new ERC20WithAntiWhaleGen();
        token = ERC20WithAntiWhaleGen(LibClone.clone(address(impl)));

        vm.roll(1000);
        launchBlock = block.number;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(MAX_WALLET, MAX_TX, EXPIRE_AFTER);
        bytes memory initData = abi.encode(owner, "Whale", "WHL", INITIAL_SUPPLY, alice, moduleData);
        token.initialize(initData);
    }

    function test_Init_SetsConfig() public view {
        (uint128 mw, uint128 mt, uint32 expiry) = token.antiWhaleConfig();
        assertEq(mw, MAX_WALLET);
        assertEq(mt, MAX_TX);
        assertEq(uint256(expiry), launchBlock + EXPIRE_AFTER);
    }

    function test_Init_OwnerExcluded() public view {
        assertTrue(token.antiWhaleIsExcluded(owner));
        assertFalse(token.antiWhaleIsExcluded(alice));
    }

    function test_Transfer_UnderCapsSucceeds() public {
        vm.prank(alice);
        token.transfer(bob, 50_000 ether);
        assertEq(token.balanceOf(bob), 50_000 ether);
    }

    function test_Transfer_ExceedsMaxTxReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithAntiWhaleGen.AntiWhale__MaxTxExceeded.selector, MAX_TX + 1, uint256(MAX_TX))
        );
        token.transfer(bob, uint256(MAX_TX) + 1);
    }

    function test_Transfer_ExceedsMaxWalletReverts() public {
        // First tx puts bob at exactly max wallet.
        vm.prank(alice);
        token.transfer(bob, uint256(MAX_TX));
        // ~10 more max-tx sends until his balance exceeds cap.
        uint256 iters = uint256(MAX_WALLET) / uint256(MAX_TX) - 1;
        for (uint256 i; i < iters; ++i) {
            vm.prank(alice);
            token.transfer(bob, uint256(MAX_TX));
        }
        // Now bob is at MAX_WALLET. One more should exceed.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20WithAntiWhaleGen.AntiWhale__MaxWalletExceeded.selector,
                token.balanceOf(bob) + 1,
                uint256(MAX_WALLET)
            )
        );
        token.transfer(bob, 1);
    }

    function test_Transfer_OwnerExempt() public {
        // Give owner tokens by allowing owner to receive from alice (owner is excluded so no fee).
        vm.prank(alice);
        token.transfer(owner, uint256(MAX_TX));
        // Owner is excluded, so future sends from owner bypass caps.
        vm.prank(owner);
        token.transfer(bob, uint256(MAX_TX));
        // Confirm bob got the tokens.
        assertGt(token.balanceOf(bob), 0);
    }

    function test_Transfer_PostExpiryUnrestricted() public {
        vm.roll(launchBlock + EXPIRE_AFTER + 1);
        assertFalse(token.antiWhaleIsActive());
        // Huge transfer that would have hit maxTx during window.
        vm.prank(alice);
        token.transfer(bob, uint256(MAX_TX) * 20);
        assertEq(token.balanceOf(bob), uint256(MAX_TX) * 20);
    }

    function test_SetExcluded_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setAntiWhaleExcluded(bob, true);
    }

    function test_SetExcluded_TogglesAndAppliesToNextTransfer() public {
        vm.prank(owner);
        token.setAntiWhaleExcluded(bob, true);
        // Now bob can receive above max wallet.
        vm.prank(alice);
        token.transfer(bob, uint256(MAX_TX));
        vm.prank(alice);
        token.transfer(bob, uint256(MAX_TX)); // second — normally caps, but bob excluded
        assertEq(token.balanceOf(bob), uint256(MAX_TX) * 2);
    }
}
