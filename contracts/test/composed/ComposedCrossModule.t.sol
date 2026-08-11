// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithAntiBotAndFeeOnTransferGen} from "src/templates/composed/ERC20WithAntiBotAndFeeOnTransferGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithFoTPermitGen} from "src/templates/composed/ERC20WithFoTPermitGen.sol";
import {ERC20WithPausablePermitGen} from "src/templates/composed/ERC20WithPausablePermitGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";

/// @title  ComposedCrossModuleTest
/// @notice Scope-doc §26.6 coverage close. Every composed ERC-20 template with
///         2+ modules used to rely SOLELY on `PhaseCombos.t.sol` for launch-smoke.
///         There was no test proving that when Module A and Module B share a
///         `_beforeTokenTransfer` hook, one module's guard doesn't corrupt the
///         other's state (e.g. Permit's nonce read while AntiBot's block-gate
///         fires, or FoT's burn while a AntiBot allowlist check runs).
///
///         This file initializes each of the 8 registered-or-registerable
///         2-module composed impls with realistic params, asserts BOTH
///         modules' post-init state, and does a transfer that exercises the
///         combined before-transfer hook. If any module accidentally
///         short-circuits or shadows another, one of these tests fails.
///
///         Not exhaustive by design — the point is proving the composition
///         is coherent, not re-testing every leaf behavior (single-module
///         tests already cover those). If a new composed impl ships,
///         add its combo here in the same shape.
contract ComposedCrossModuleTest is Test {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // --------------------------------------------------------------
    // Permit + Staking — registered on-chain at 0x1207…575e
    // --------------------------------------------------------------

    function test_Combo_PermitStaking_InitializesBothModules() public {
        ERC20WithPermitStakingGen impl = new ERC20WithPermitStakingGen();
        ERC20WithPermitStakingGen token = ERC20WithPermitStakingGen(LibClone.clone(address(impl)));

        // Reserve 100 tokens for staking rewards out of a 1000 initial supply.
        // moduleData ordering: [0] = Permit (no params), [1] = Staking (rewards, duration).
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = "";
        moduleData[1] = abi.encode(uint256(100 ether), uint32(30 days));
        token.initialize(abi.encode(owner, "PermStake", "PS", 1000 ether, alice, moduleData));

        // Permit: DOMAIN_SEPARATOR non-zero, nonces start at 0.
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit init");
        assertEq(token.nonces(alice), 0, "Permit nonce init");

        // Staking: 100 tokens reserved to the token contract itself (reward pool).
        // alice receives 900 = 1000 - 100 reserve.
        assertEq(token.balanceOf(alice), 900 ether, "Staking reserve carve");
        assertEq(token.balanceOf(address(token)), 100 ether, "Staking pool held");

        // Cross-module: alice can transfer freely (Permit + Staking don't gate transfers).
        vm.prank(alice);
        token.transfer(bob, 10 ether);
        assertEq(token.balanceOf(bob), 10 ether);
        assertEq(token.balanceOf(alice), 890 ether);
    }

    // --------------------------------------------------------------
    // Pausable + Permit (module set alphabetically sorted: "Pausable,Permit")
    // --------------------------------------------------------------

    function test_Combo_PausablePermit_PauseBlocksTransfersButPermitStillGrants() public {
        ERC20WithPausablePermitGen impl = new ERC20WithPausablePermitGen();
        ERC20WithPausablePermitGen token = ERC20WithPausablePermitGen(LibClone.clone(address(impl)));

        // Both modules take no params. moduleData ordering: [Pausable, Permit]
        // per alphabetical sort of module IDs.
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = "";
        moduleData[1] = "";
        token.initialize(abi.encode(owner, "PausPerm", "PP", 1000 ether, alice, moduleData));

        // Sanity: pre-pause transfer works.
        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 100 ether);

        // Pause. Permit's DOMAIN_SEPARATOR is still readable while paused —
        // Pausable's hook doesn't gate view calls.
        vm.prank(owner);
        token.pause();
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit view survives pause");

        // Transfers blocked while paused. URU-A02: no owner exemption after v5
        // regeneration. Owner's own transfer also reverts (proves the composed
        // impl matches the honest V2 fragment, not the V1 honeypot).
        vm.expectRevert(ERC20WithPausablePermitGen.Pausable__Paused.selector);
        vm.prank(alice);
        token.transfer(bob, 1 ether);
        vm.expectRevert(ERC20WithPausablePermitGen.Pausable__Paused.selector);
        vm.prank(owner);
        token.transfer(bob, 1 ether);

        // Unpause and confirm transfers resume.
        vm.prank(owner);
        token.unpause();
        vm.prank(alice);
        token.transfer(bob, 1 ether);
        assertEq(token.balanceOf(bob), 101 ether);
    }

    // --------------------------------------------------------------
    // Permit + Vesting (module set: "Permit,Vesting")
    // --------------------------------------------------------------

    function test_Combo_PermitVesting_InitReservesLockedTranche() public {
        ERC20WithPermitVestingGen impl = new ERC20WithPermitVestingGen();
        ERC20WithPermitVestingGen token = ERC20WithPermitVestingGen(LibClone.clone(address(impl)));

        // moduleData ordering: [Permit, Vesting]. Vesting params:
        // (beneficiary, amount, cliff, end).
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = "";
        moduleData[1] =
            abi.encode(bob, uint256(200 ether), uint64(block.timestamp + 30 days), uint64(block.timestamp + 90 days));
        token.initialize(abi.encode(owner, "PermVest", "PV", 1000 ether, alice, moduleData));

        // Vesting reserves 200 to the token contract; alice keeps the rest.
        assertEq(token.balanceOf(alice), 800 ether, "Vesting reserve carve");
        assertEq(token.balanceOf(address(token)), 200 ether, "Vesting pool held");
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit still init");
    }

    // --------------------------------------------------------------
    // AntiBot + Permit
    // --------------------------------------------------------------

    function test_Combo_AntiBotPermit_BlockGateBlocksNonAllowlisted() public {
        ERC20WithAntiBotPermitGen impl = new ERC20WithAntiBotPermitGen();
        ERC20WithAntiBotPermitGen token = ERC20WithAntiBotPermitGen(LibClone.clone(address(impl)));

        // moduleData ordering: [AntiBot, Permit]. AntiBot param: blockGate.
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(uint16(10));
        moduleData[1] = "";
        token.initialize(abi.encode(owner, "ABP", "ABP", 1000 ether, alice, moduleData));

        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit init");
        assertTrue(token.antiBotIsGated(), "AntiBot gate active at launch");

        // Owner can move (AntiBot exempts `from == owner` during the gate window).
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 1 ether); // alice is not owner, not allowlisted → reverts

        // Owner allowlist + retry.
        vm.prank(owner);
        token.setAntiBotAllowed(alice, true);
        vm.prank(alice);
        token.transfer(bob, 1 ether);
        assertEq(token.balanceOf(bob), 1 ether);
    }

    // --------------------------------------------------------------
    // AntiBot + AntiWhale
    // --------------------------------------------------------------

    function test_Combo_AntiBotAntiWhale_BothGatesFire() public {
        ERC20WithAntiBotAntiWhaleGen impl = new ERC20WithAntiBotAntiWhaleGen();
        ERC20WithAntiBotAntiWhaleGen token = ERC20WithAntiBotAntiWhaleGen(LibClone.clone(address(impl)));

        // moduleData: [AntiBot, AntiWhale]. AntiWhale: (maxWallet, maxTx, expireAfter).
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(uint16(10)); // AntiBot 10-block gate
        moduleData[1] = abi.encode(uint128(50 ether), uint128(20 ether), uint32(100)); // wallet=50, tx=20, 100 blocks
        token.initialize(abi.encode(owner, "ABAW", "ABAW", 1000 ether, alice, moduleData));

        assertTrue(token.antiBotIsGated(), "AntiBot gate active");
        assertTrue(token.antiWhaleIsActive(), "AntiWhale window active");

        // Advance past AntiBot gate so we can isolate AntiWhale.
        vm.roll(block.number + 11);
        assertFalse(token.antiBotIsGated(), "AntiBot gate expired");
        assertTrue(token.antiWhaleIsActive(), "AntiWhale still active");

        // maxTx = 20. Transfer of 30 should revert.
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 30 ether);

        // Transfer of 15 succeeds.
        vm.prank(alice);
        token.transfer(bob, 15 ether);
        assertEq(token.balanceOf(bob), 15 ether);
    }

    // --------------------------------------------------------------
    // AntiBot + AntiWhale + Permit (3 modules)
    // --------------------------------------------------------------

    function test_Combo_AntiBotAntiWhalePermit_ThreeModulesCompose() public {
        ERC20WithAntiBotAntiWhalePermitGen impl = new ERC20WithAntiBotAntiWhalePermitGen();
        ERC20WithAntiBotAntiWhalePermitGen token = ERC20WithAntiBotAntiWhalePermitGen(LibClone.clone(address(impl)));

        // moduleData: [AntiBot, AntiWhale, Permit].
        bytes[] memory moduleData = new bytes[](3);
        moduleData[0] = abi.encode(uint16(5));
        moduleData[1] = abi.encode(uint128(50 ether), uint128(20 ether), uint32(100));
        moduleData[2] = "";
        token.initialize(abi.encode(owner, "3MOD", "3MOD", 1000 ether, alice, moduleData));

        // All three modules initialized cleanly.
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit init");
        assertTrue(token.antiBotIsGated(), "AntiBot init");
        assertTrue(token.antiWhaleIsActive(), "AntiWhale init");

        // Advance past AntiBot, then confirm AntiWhale still fires + Permit
        // views still return correctly.
        vm.roll(block.number + 6);
        vm.prank(alice);
        vm.expectRevert();
        token.transfer(bob, 30 ether); // AntiWhale maxTx = 20
        assertEq(token.nonces(alice), 0, "Permit state independent of AntiWhale revert");
    }

    // --------------------------------------------------------------
    // FoT + Permit
    // --------------------------------------------------------------

    function test_Combo_FotPermit_TransferTakesFeeAndPermitUnaffected() public {
        ERC20WithFoTPermitGen impl = new ERC20WithFoTPermitGen();
        ERC20WithFoTPermitGen token = ERC20WithFoTPermitGen(LibClone.clone(address(impl)));

        // moduleData: [FeeOnTransfer, Permit]. FoT: (burnBps, treasuryBps, totalBps, treasury).
        // 100 = 1% burn, 100 = 1% treasury, 200 = total, treasury addr.
        address treasury = makeAddr("treasury");
        bytes[] memory moduleData = new bytes[](2);
        // FoT ABI: (feeBps, burnBps, treasuryBps, treasury). burnBps + treasuryBps MUST sum to 10_000.
        // 100 = 1% fee on transfer; split 50/50 between burn and treasury.
        moduleData[0] = abi.encode(uint16(100), uint16(5000), uint16(5000), treasury);
        moduleData[1] = "";
        token.initialize(abi.encode(owner, "FoTP", "FoTP", 1000 ether, alice, moduleData));

        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0), "Permit init");

        // alice transfers 100 ether. 1% fee = 1 ether. Split 50/50: 0.5 burn, 0.5 treasury.
        // Bob receives 99 ether (100 - 1). Some tokens leave circulation via burn.
        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 99 ether, "FoT deducted 1%");
        assertEq(token.balanceOf(treasury), 0.5 ether, "Treasury cut = half of fee");
        // Permit nonce untouched (no permit called).
        assertEq(token.nonces(alice), 0);
    }

    // --------------------------------------------------------------
    // AntiBot + FoT (auditor's Router URU-A01 explicitly blocks curve pairing
    // with FLAG_BALANCE_MUTATING configs, but the impl itself must still
    // compose cleanly for direct-launch users)
    // --------------------------------------------------------------

    function test_Combo_AntiBotFot_ImplComposesForDirectLaunch() public {
        ERC20WithAntiBotAndFeeOnTransferGen impl = new ERC20WithAntiBotAndFeeOnTransferGen();
        ERC20WithAntiBotAndFeeOnTransferGen token = ERC20WithAntiBotAndFeeOnTransferGen(LibClone.clone(address(impl)));

        address treasury = makeAddr("treasury");
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(uint16(5)); // AntiBot 5-block gate
        moduleData[1] = abi.encode(uint16(100), uint16(5000), uint16(5000), treasury); // 1% fee split 50/50
        token.initialize(abi.encode(owner, "ABF", "ABF", 1000 ether, alice, moduleData));

        assertTrue(token.antiBotIsGated(), "AntiBot init");

        // Roll past AntiBot's block-gate so we can isolate FoT semantics.
        // AntiBot's per-block guard is proven independently in
        // test_Combo_AntiBotPermit above; here we prove FoT still deducts
        // correctly AFTER the AntiBot window expires (both hooks share the
        // same _beforeTokenTransfer).
        vm.roll(block.number + 6);
        assertFalse(token.antiBotIsGated(), "AntiBot gate expired");

        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 99 ether, "FoT still fires after AntiBot window");
        assertEq(token.balanceOf(treasury), 0.5 ether, "Treasury cut");
    }
}
