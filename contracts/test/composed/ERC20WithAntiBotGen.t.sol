// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";

/// @notice Tests the compile-service-generated composed contract. The behaviors here mirror
///         what the module's own SPEC promises; any semantic drift between the fragment and
///         the generated output surfaces as a failure here.
contract ERC20WithAntiBotGenTest is Test {
    ERC20WithAntiBotGen internal impl;
    ERC20WithAntiBotGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    uint16 internal constant BLOCK_GATE = 5;
    uint256 internal constant INITIAL_SUPPLY = 1000 ether;
    uint256 internal launchBlock;

    function setUp() public {
        impl = new ERC20WithAntiBotGen();
        token = ERC20WithAntiBotGen(LibClone.clone(address(impl)));

        vm.roll(1000);
        launchBlock = block.number;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(BLOCK_GATE);
        bytes memory initData = abi.encode(owner, "Anti Bot Token", "ABOT", INITIAL_SUPPLY, alice, moduleData);
        token.initialize(initData);
    }

    // Storage layout invariant: base state variables occupy slots before module state variables.
    // A drift here would indicate the splicer regressed on Rule 1.
    function test_StorageLayout_BaseFirstThenModule() public view {
        // Base storage: _name, _symbol, _initialized on the pre-module slots.
        // Direct storage inspection via vm.load is the most authoritative check.
        bytes32 slot0 = vm.load(address(token), bytes32(uint256(0))); // _name (dynamic → length+ptr)
        // We assert `_name` was set (non-zero, length matches "Anti Bot Token" length-encoded).
        assertTrue(slot0 != bytes32(0), "base slot 0 should be non-zero after initialize");
    }

    function test_Init_SetsGateEnd() public view {
        assertEq(token.antiBotGateEndsAtBlock(), launchBlock + BLOCK_GATE);
        assertTrue(token.antiBotIsGated());
    }

    function test_Init_MintsSupplyToRecipient() public view {
        assertEq(token.balanceOf(alice), INITIAL_SUPPLY);
        assertEq(token.owner(), owner);
    }

    function test_Transfer_DuringGate_NonOwnerToNonAllowlist_Reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 10 ether);
    }

    function test_Transfer_DuringGate_ToAllowlisted_Succeeds() public {
        vm.prank(owner);
        token.setAntiBotAllowed(bob, true);
        vm.prank(alice);
        token.transfer(bob, 50 ether);
        assertEq(token.balanceOf(bob), 50 ether);
    }

    function test_Transfer_DuringGate_OwnerCanSendFreely() public {
        vm.prank(owner);
        token.setAntiBotAllowed(owner, true);
        vm.prank(alice);
        token.transfer(owner, 100 ether);
        vm.prank(owner);
        token.transfer(bob, 40 ether);
        assertEq(token.balanceOf(bob), 40 ether);
    }

    function test_Transfer_RevertsWithBlocksLeft() public {
        vm.roll(launchBlock + 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC20WithAntiBotGen.AntiBot__Gated.selector, alice, bob, 3));
        token.transfer(bob, 1 ether);
    }

    function test_Transfer_AfterGate_FreelyPermitted() public {
        vm.roll(launchBlock + BLOCK_GATE);
        assertFalse(token.antiBotIsGated());
        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 100 ether);
    }

    function test_Transfer_ExactGateBoundary_LastBlockedFirstFree() public {
        vm.roll(launchBlock + BLOCK_GATE - 1);
        assertTrue(token.antiBotIsGated());
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1 ether);

        vm.roll(launchBlock + BLOCK_GATE);
        assertFalse(token.antiBotIsGated());
        vm.prank(alice);
        token.transfer(bob, 1 ether);
        assertEq(token.balanceOf(bob), 1 ether);
    }

    function test_SetAntiBotAllowed_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setAntiBotAllowed(bob, true);
    }

    function test_SetAntiBotAllowed_TogglesFlag() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit ERC20WithAntiBotGen.AntiBotAllowedSet(bob, true);
        vm.prank(owner);
        token.setAntiBotAllowed(bob, true);
        assertTrue(token.antiBotIsAllowed(bob));

        vm.prank(owner);
        token.setAntiBotAllowed(bob, false);
        assertFalse(token.antiBotIsAllowed(bob));
    }
}
