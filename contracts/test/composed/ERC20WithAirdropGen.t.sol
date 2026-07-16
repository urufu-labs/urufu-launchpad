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
    // V2 reserve-backed airdrop: launcher must pass the total allocation at init.
    // Sum of all leaves — used by init to reserve exactly this much on address(this).
    uint256 internal constant TOTAL_ALLOCATION = ALICE_AMT + BOB_AMT;

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
        moduleData[0] = abi.encode(root, TOTAL_ALLOCATION);
        // Supply must be ≥ TOTAL_ALLOCATION so init can reserve it on address(this).
        // Excess (initialSupply - TOTAL_ALLOCATION) stays with `owner`.
        bytes memory initData = abi.encode(owner, "Drop", "DRP", 1000 ether, owner, moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresRoot() public view {
        assertEq(token.airdropRoot(), root);
        assertEq(token.airdropTotalAllocation(), TOTAL_ALLOCATION, "allocation stored");
        assertEq(token.airdropClaimedTotal(), 0, "no claims yet");
        assertFalse(token.airdropHasClaimed(alice));
        assertFalse(token.airdropHasClaimed(bob));
        // V2 invariant: the airdrop pool sits on address(this), NOT with `owner`.
        assertEq(token.balanceOf(address(token)), TOTAL_ALLOCATION, "reserve funded");
        assertEq(token.balanceOf(owner), 1000 ether - TOTAL_ALLOCATION, "owner keeps excess");
    }

    function test_Claim_HappyPath() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;

        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, proof);

        assertEq(token.balanceOf(alice), ALICE_AMT);
        assertTrue(token.airdropHasClaimed(alice));
    }

    /// V2 semantics: claims move from the reserve to the claimer WITHOUT touching total
    /// supply. This is the whole point of reserve-backed modules — they coexist with
    /// bonding curves without silently minting new tokens post-launch.
    function test_Claim_TransfersFromReserveWithoutInflation() public {
        bytes32[] memory aliceProof = new bytes32[](1);
        aliceProof[0] = bobLeaf;

        bytes32[] memory bobProof = new bytes32[](1);
        bobProof[0] = aliceLeaf;

        uint256 supplyBefore = token.totalSupply();
        uint256 reserveBefore = token.balanceOf(address(token));

        vm.prank(alice);
        token.airdropClaim(ALICE_AMT, aliceProof);
        vm.prank(bob);
        token.airdropClaim(BOB_AMT, bobProof);

        // Total supply UNCHANGED — this is the invariant.
        assertEq(token.totalSupply(), supplyBefore, "total supply must not grow on claim");
        // Balances move from reserve to claimers.
        assertEq(token.balanceOf(address(token)), reserveBefore - ALICE_AMT - BOB_AMT, "reserve drained by claims");
        assertEq(token.balanceOf(alice), ALICE_AMT);
        assertEq(token.balanceOf(bob), BOB_AMT);
        // Tracker matches what came out.
        assertEq(token.airdropClaimedTotal(), ALICE_AMT + BOB_AMT, "claimedTotal tracked");
    }

    /// If the launcher misconfigures totalAllocation < initialSupply, init should
    /// still succeed but the excess stays with owner. This proves the reserve is
    /// carved out, not additive.
    function test_Init_RevertsWhenAllocationExceedsSupply() public {
        ERC20WithAirdropGen fresh = ERC20WithAirdropGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(root, TOTAL_ALLOCATION);
        // Supply LESS than allocation → transfer reverts inside solady's ERC20 when
        // mintTarget's balance underflows. This is safety-by-construction — no way
        // to launch a token whose reserve exceeds its total supply.
        bytes memory initData = abi.encode(owner, "Drop", "DRP", TOTAL_ALLOCATION - 1, owner, moduleData);
        vm.expectRevert(); // solady ERC20 emits InsufficientBalance() or similar
        fresh.initialize(initData);
    }

    function test_Init_RevertsOnZeroAllocation() public {
        ERC20WithAirdropGen fresh = ERC20WithAirdropGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(root, uint256(0));
        bytes memory initData = abi.encode(owner, "Drop", "DRP", 500 ether, owner, moduleData);
        vm.expectRevert(ERC20WithAirdropGen.Airdrop__ZeroAllocation.selector);
        fresh.initialize(initData);
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
