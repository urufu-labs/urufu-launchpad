// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";

contract NftRevenueVaultTest is Test {
    NftRevenueVault internal vault;

    address internal owner = makeAddr("owner");
    address internal alice;
    address internal bob;
    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;

    function setUp() public {
        vault = new NftRevenueVault(owner);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        vm.deal(address(this), 100 ether);
    }

    function _leaf(address holder, uint256 epochId, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(holder, epochId, amount));
    }

    function test_Receive_LogsIt() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_AddEpoch_HappyPath() public {
        (bool ok,) = address(vault).call{value: 5 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vault.addEpoch(bytes32(uint256(0xdeadbeef)), 3 ether);
        (bytes32 root, uint256 total, uint256 unclaimed) = vault.epochs(0);
        assertEq(root, bytes32(uint256(0xdeadbeef)));
        assertEq(total, 3 ether);
        assertEq(unclaimed, 3 ether);
    }

    function test_AddEpoch_RevertsWithoutBalance() public {
        vm.expectRevert(abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__InsufficientBalance.selector, 0, 1 ether));
        vm.prank(owner);
        vault.addEpoch(bytes32(uint256(1)), 1 ether);
    }

    function test_Claim_HappyPath() public {
        // Build a 2-leaf tree: alice=1 ETH, bob=2 ETH
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        bytes32 leafA = _leaf(alice, 0, 1 ether);
        bytes32 leafB = _leaf(bob, 0, 2 ether);
        bytes32 root = leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));

        vm.prank(owner);
        vault.addEpoch(root, 3 ether);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
        assertEq(alice.balance, 1 ether);
    }

    function test_Claim_RevertsOnDoubleClaim() public {
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        bytes32 leafA = _leaf(alice, 0, 1 ether);
        bytes32 leafB = _leaf(bob, 0, 2 ether);
        bytes32 root = leafA < leafB
            ? keccak256(abi.encodePacked(leafA, leafB))
            : keccak256(abi.encodePacked(leafB, leafA));

        vm.prank(owner);
        vault.addEpoch(root, 3 ether);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
        vm.expectRevert(abi.encodeWithSelector(NftRevenueVault.NftRevenueVault__AlreadyClaimed.selector, uint256(0), alice));
        vm.prank(alice);
        vault.claim(0, 1 ether, proofA);
    }

    function test_Claim_RevertsOnBadProof() public {
        (bool ok,) = address(vault).call{value: 3 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vault.addEpoch(bytes32(uint256(0xabc)), 3 ether);

        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(1));
        vm.expectRevert(NftRevenueVault.NftRevenueVault__InvalidProof.selector);
        vm.prank(alice);
        vault.claim(0, 1 ether, badProof);
    }
}
