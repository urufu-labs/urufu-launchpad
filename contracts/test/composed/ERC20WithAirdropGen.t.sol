// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";

contract ERC20WithAirdropGenTest is Test {
    ERC20WithAirdropGen internal impl;
    ERC20WithAirdropGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // Airdrop amounts.
    uint256 internal constant ALICE_AMT = 100 ether;
    uint256 internal constant BOB_AMT = 200 ether;

    bytes32 internal aliceLeaf;
    bytes32 internal bobLeaf;
    bytes32 internal root;

    function setUp() public {
        aliceLeaf = keccak256(abi.encodePacked(alice, ALICE_AMT));
        bobLeaf = keccak256(abi.encodePacked(bob, BOB_AMT));
        root = aliceLeaf < bobLeaf
            ? keccak256(abi.encodePacked(aliceLeaf, bobLeaf))
            : keccak256(abi.encodePacked(bobLeaf, aliceLeaf));

        impl = new ERC20WithAirdropGen();
        token = ERC20WithAirdropGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(root);
        bytes memory initData = abi.encode(owner, "Drop", "DRP", 500 ether, owner, moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresRoot() public view {
        assertEq(token.airdropRoot(), root);
        assertFalse(token.airdropHasClaimed(alice));
        assertFalse(token.airdropHasClaimed(bob));
    }

    function test_Claim_HappyPath() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, proof);

        assertEq(token.balanceOf(alice), ALICE_AMT);
        assertTrue(token.airdropHasClaimed(alice));
    }

    function test_Claim_MintsToClaimer() public {
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = aliceLeaf;

        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, aliceProof);
        vm.prank(bob);
        token.airdropClaim(BOB_AMT, bobProof);

        assertEq(token.totalSupply(), supplyBefore + ALICE_AMT + BOB_AMT);
    }

    function test_Claim_RevertsOnDoubleClaim() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, proof);

        vm.expectRevert(abi.encodeWithSelector(ERC20WithAirdropGen.Airdrop__AlreadyClaimed.selector, alice));
        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, proof);
    }

    function test_Claim_RevertsOnBadProof() public {
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(1));

        vm.expectRevert(ERC20WithAirdropGen.Airdrop__InvalidProof.selector);
        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, badProof);
    }

    function test_Claim_RevertsOnWrongAmount() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        // Alice tries to claim MORE than her leaf entitles.
        vm.expectRevert(ERC20WithAirdropGen.Airdrop__InvalidProof.selector);
        vm.prank(alice);
        token.airdropClaim(ALICE_AMT + 1, proof);
    }

    function test_Claim_RevertsFromNonRecipient() public {
        // Carol isn't in the tree. Even with a valid proof shape she can't spoof someone else's claim.
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        vm.expectRevert(ERC20WithAirdropGen.Airdrop__InvalidProof.selector);
        vm.prank(carol);
        token.airdropClaim(ALICE_AMT, proof);
    }
}
