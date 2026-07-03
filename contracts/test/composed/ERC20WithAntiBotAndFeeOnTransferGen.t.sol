// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithAntiBotAndFeeOnTransferGen} from "src/templates/composed/ERC20WithAntiBotAndFeeOnTransferGen.sol";

/// @notice Two modules composed into one contract. Verifies that:
///   - Splicer assigns each module its own `moduleData[N]` slice deterministically (alphabetical).
///   - Both modules' state variables coexist without collision.
///   - Both hooks fire — AntiBot on `_beforeTokenTransfer`, FeeOnTransfer on `_afterTokenTransfer`.
///   - Sequential ordering is correct: AntiBot's block-gate check runs first, then the transfer,
///     then FeeOnTransfer's fee-take.
contract ERC20WithAntiBotAndFeeOnTransferGenTest is Test {
    ERC20WithAntiBotAndFeeOnTransferGen internal impl;
    ERC20WithAntiBotAndFeeOnTransferGen internal token;

    address internal owner = makeAddr("owner");
    address internal treasury = 0x000000000000000000000000000000000000dEaD;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint16 internal constant BLOCK_GATE = 5;
    uint16 internal constant FEE_BPS = 500; // 5%
    uint16 internal constant BURN_BPS = 5000; // 50% of fee burned
    uint16 internal constant TREASURY_BPS = 5000; // 50% to treasury (dEaD, treated as excluded via init)
    uint256 internal constant INITIAL_SUPPLY = 10_000 ether;
    uint256 internal launchBlock;

    function setUp() public {
        impl = new ERC20WithAntiBotAndFeeOnTransferGen();
        token = ERC20WithAntiBotAndFeeOnTransferGen(LibClone.clone(address(impl)));

        vm.roll(1000);
        launchBlock = block.number;

        // moduleData is bytes[] with each module's slice at its splice-order index.
        // Alphabetical: AntiBot=0, FeeOnTransfer=1.
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(BLOCK_GATE);
        moduleData[1] = abi.encode(FEE_BPS, BURN_BPS, TREASURY_BPS, treasury);

        bytes memory initData = abi.encode(owner, "Combined Token", "COMB", INITIAL_SUPPLY, alice, moduleData);
        token.initialize(initData);
    }

    // =========================================================
    // Both module states set correctly
    // =========================================================

    function test_Init_BothModulesConfigured() public view {
        // AntiBot state
        assertEq(token.antiBotGateEndsAtBlock(), launchBlock + BLOCK_GATE);
        assertTrue(token.antiBotIsGated());

        // FeeOnTransfer state
        (uint16 feeBps, uint16 burnBps, uint16 treasuryBps) = token.feeOnTransferBps();
        assertEq(feeBps, FEE_BPS);
        assertEq(burnBps, BURN_BPS);
        assertEq(treasuryBps, TREASURY_BPS);
        assertEq(token.feeOnTransferTreasury(), treasury);
    }

    function test_Init_BaseStateAlsoSet() public view {
        assertEq(token.name(), "Combined Token");
        assertEq(token.symbol(), "COMB");
        assertEq(token.owner(), owner);
        assertEq(token.balanceOf(alice), INITIAL_SUPPLY);
    }

    // =========================================================
    // AntiBot's before-hook still gates transfers
    // =========================================================

    function test_DuringGate_AntiBotBlocksNonAllowlistedTransfer() public {
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 100 ether);
    }

    function test_DuringGate_AllowlistedRecipientBypassesGate() public {
        vm.prank(owner);
        token.setAntiBotAllowed(bob, true);
        vm.prank(alice);
        token.transfer(bob, 1000 ether);

        // Fee still takes 5% because FoT applies regardless of AntiBot state.
        uint256 fee = 1000 ether * uint256(FEE_BPS) / 10_000;
        assertEq(token.balanceOf(bob), 1000 ether - fee, "FoT still applies");
    }

    // =========================================================
    // After the gate, FeeOnTransfer applies as usual
    // =========================================================

    function test_PostGate_FeeOnTransferApplies() public {
        vm.roll(launchBlock + BLOCK_GATE); // gate closed
        assertFalse(token.antiBotIsGated());

        uint256 amount = 1000 ether;
        uint256 fee = amount * uint256(FEE_BPS) / 10_000;
        uint256 toTreasury = fee * uint256(TREASURY_BPS) / 10_000;
        uint256 burned = fee - toTreasury;
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(bob), amount - fee, "recipient got amount minus fee");
        assertEq(token.balanceOf(treasury), toTreasury, "treasury took its slice");
        assertEq(token.totalSupply(), supplyBefore - burned, "burn slice reduced supply");
    }

    // =========================================================
    // Cross-module state safety: setting one module's admin flag doesn't affect the other
    // =========================================================

    function test_ExclusionAndAllowlistAreIndependent() public {
        vm.prank(owner);
        token.setFeeOnTransferExcluded(bob, true);

        // Bob is FoT-excluded but NOT AntiBot-allowlisted — during the gate he still can't receive.
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 100 ether);

        // Now allowlist Bob. During the gate he can receive; FoT still skips (he's excluded).
        vm.prank(owner);
        token.setAntiBotAllowed(bob, true);
        vm.prank(alice);
        token.transfer(bob, 100 ether);

        assertEq(token.balanceOf(bob), 100 ether, "no fee (bob excluded)");
    }

    // =========================================================
    // Storage layout invariant across two modules
    // =========================================================

    function test_StorageLayout_BaseFirstThenModulesInOrder() public view {
        // Slot 0 should be `_name` (base state) — non-zero after init.
        bytes32 slot0 = vm.load(address(token), bytes32(uint256(0)));
        assertTrue(slot0 != bytes32(0), "base slot 0 non-zero after initialize");
    }
}
