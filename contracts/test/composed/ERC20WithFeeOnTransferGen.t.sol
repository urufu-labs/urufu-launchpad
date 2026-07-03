// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";

contract ERC20WithFeeOnTransferGenTest is Test {
    ERC20WithFeeOnTransferGen internal impl;
    ERC20WithFeeOnTransferGen internal token;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    uint16 internal constant FEE_BPS = 500; // 5%
    uint16 internal constant BURN_BPS = 4000; // 40% of fee burned
    uint16 internal constant TREASURY_BPS = 6000; // 60% of fee → treasury
    uint256 internal constant INITIAL_SUPPLY = 10_000 ether;

    function setUp() public {
        impl = new ERC20WithFeeOnTransferGen();
        token = ERC20WithFeeOnTransferGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(FEE_BPS, BURN_BPS, TREASURY_BPS, treasury);
        bytes memory initData = abi.encode(owner, "FoT Token", "FOT", INITIAL_SUPPLY, alice, moduleData);
        token.initialize(initData);
    }

    // =========================================================
    // Init
    // =========================================================

    function test_Init_SetsFeeConfig() public view {
        (uint16 feeBps, uint16 burnBps, uint16 treasuryBps) = token.feeOnTransferBps();
        assertEq(feeBps, FEE_BPS);
        assertEq(burnBps, BURN_BPS);
        assertEq(treasuryBps, TREASURY_BPS);
        assertEq(token.feeOnTransferTreasury(), treasury);
    }

    function test_Init_ExcludesOwnerAndTreasury() public view {
        assertTrue(token.feeOnTransferIsExcluded(owner));
        assertTrue(token.feeOnTransferIsExcluded(treasury));
        assertFalse(token.feeOnTransferIsExcluded(alice));
    }

    function test_Init_MintsFullSupply() public view {
        assertEq(token.balanceOf(alice), INITIAL_SUPPLY);
        assertEq(token.totalSupply(), INITIAL_SUPPLY);
    }

    function test_Init_RevertsOnZeroFee() public {
        ERC20WithFeeOnTransferGen fresh = ERC20WithFeeOnTransferGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(uint16(0), BURN_BPS, TREASURY_BPS, treasury);
        bytes memory data = abi.encode(owner, "n", "s", uint256(0), address(0), bad);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithFeeOnTransferGen.FeeOnTransfer__InvalidFeeBps.selector, uint16(0))
        );
        fresh.initialize(data);
    }

    function test_Init_RevertsOnFeeAbove30Pct() public {
        ERC20WithFeeOnTransferGen fresh = ERC20WithFeeOnTransferGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(uint16(3001), BURN_BPS, TREASURY_BPS, treasury);
        bytes memory data = abi.encode(owner, "n", "s", uint256(0), address(0), bad);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithFeeOnTransferGen.FeeOnTransfer__InvalidFeeBps.selector, uint16(3001))
        );
        fresh.initialize(data);
    }

    function test_Init_RevertsOnBadSplits() public {
        ERC20WithFeeOnTransferGen fresh = ERC20WithFeeOnTransferGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(FEE_BPS, uint16(1000), uint16(1000), treasury); // sum != 10000
        bytes memory data = abi.encode(owner, "n", "s", uint256(0), address(0), bad);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20WithFeeOnTransferGen.FeeOnTransfer__InvalidSplits.selector, uint16(1000), uint16(1000)
            )
        );
        fresh.initialize(data);
    }

    function test_Init_RevertsOnZeroTreasuryWhenTreasuryBpsPositive() public {
        ERC20WithFeeOnTransferGen fresh = ERC20WithFeeOnTransferGen(LibClone.clone(address(impl)));
        bytes[] memory bad = new bytes[](1);
        bad[0] = abi.encode(FEE_BPS, BURN_BPS, TREASURY_BPS, address(0));
        bytes memory data = abi.encode(owner, "n", "s", uint256(0), address(0), bad);
        vm.expectRevert(ERC20WithFeeOnTransferGen.FeeOnTransfer__ZeroTreasury.selector);
        fresh.initialize(data);
    }

    // =========================================================
    // Fee mechanics on transfer
    // =========================================================

    function test_Transfer_TakesFeeFromRecipient() public {
        uint256 amount = 1000 ether;
        uint256 fee = amount * FEE_BPS / 10_000; // 50 ether
        uint256 toTreasury = fee * TREASURY_BPS / 10_000; // 30 ether
        uint256 burned = fee - toTreasury; // 20 ether

        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(bob, amount);

        // Bob got amount - fee.
        assertEq(token.balanceOf(bob), amount - fee, "bob should receive amount - fee");
        // Alice paid full amount.
        assertEq(token.balanceOf(alice), INITIAL_SUPPLY - amount, "alice paid full amount");
        // Treasury got its slice.
        assertEq(token.balanceOf(treasury), toTreasury, "treasury share");
        // Total supply reduced by burn slice.
        assertEq(token.totalSupply(), supplyBefore - burned, "supply reduced by burn slice");
    }

    function test_Transfer_EmitsFeeTakenEvent() public {
        uint256 amount = 1000 ether;
        uint256 fee = amount * FEE_BPS / 10_000;
        uint256 toTreasury = fee * TREASURY_BPS / 10_000;
        uint256 burned = fee - toTreasury;

        vm.expectEmit(true, true, false, true, address(token));
        emit ERC20WithFeeOnTransferGen.FeeOnTransferTaken(alice, bob, fee, burned, toTreasury);
        vm.prank(alice);
        token.transfer(bob, amount);
    }

    function test_Transfer_ExcludedSender_NoFee() public {
        // Give owner some tokens to send (via alice, who has all).
        vm.prank(alice);
        token.transfer(owner, 100 ether); // this itself pays a fee to bob's role — no, target is owner
        // Actually alice → owner: owner IS excluded, so `to` is excluded → no fee taken.
        // Owner now has 100 ether cleanly.
        uint256 ownerBal = token.balanceOf(owner);
        assertEq(ownerBal, 100 ether, "no fee should be taken when sending to excluded owner");

        // Owner sends to bob: `from` is excluded → no fee.
        vm.prank(owner);
        token.transfer(bob, 40 ether);
        assertEq(token.balanceOf(bob), 40 ether, "no fee when sending FROM excluded owner");
    }

    function test_Transfer_ExcludedRecipient_NoFee() public {
        vm.prank(alice);
        token.transfer(treasury, 100 ether);
        // Treasury is excluded → no fee. Treasury got initial 0 + 100 ether transfer.
        assertEq(token.balanceOf(treasury), 100 ether, "treasury (excluded) received full amount");
    }

    function test_Transfer_ZeroAmountNoFee() public {
        vm.prank(alice);
        token.transfer(bob, 0);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(alice), INITIAL_SUPPLY);
    }

    function test_Transfer_TinyAmountFeeRoundsToZero() public {
        // amount * 500 / 10000 → for amount = 19, fee = 0 (truncates).
        vm.prank(alice);
        token.transfer(bob, 19);
        assertEq(token.balanceOf(bob), 19, "amount below 20 - fee rounds to zero");
    }

    function test_Transfer_LargeAmount_SplitAccuracy() public {
        // Verify no wei is lost across many transfers (rounding sanity).
        uint256 totalBefore = token.totalSupply();
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(alice);
        token.transfer(bob, 1234 ether);

        // Conservation: alice + bob + treasury balances + burn = total starting supply.
        uint256 totalAfter = token.totalSupply();
        uint256 burned = totalBefore - totalAfter;
        assertEq(
            token.balanceOf(alice) + token.balanceOf(bob) + (token.balanceOf(treasury) - treasuryBefore) + burned,
            aliceBefore,
            "no wei lost"
        );
    }

    // =========================================================
    // Recursion safety
    // =========================================================

    function test_Transfer_RecursiveBurnMint_DoNotReCharge() public {
        // A single transfer triggers one _burn(to, fee) and one _mint(treasury, split). Neither of
        // those internal calls should re-trigger the FoT hook (because from == 0 or to == 0 in each).
        // If they did, we'd see extra fees taken → treasury balance would grow more than expected.
        uint256 amount = 1000 ether;
        uint256 expectedFee = amount * FEE_BPS / 10_000;
        uint256 expectedTreasury = expectedFee * TREASURY_BPS / 10_000;

        vm.prank(alice);
        token.transfer(bob, amount);
        // Treasury balance = exactly the expected treasury slice, not double.
        assertEq(token.balanceOf(treasury), expectedTreasury);
    }

    // =========================================================
    // Exclusion admin
    // =========================================================

    function test_SetFeeOnTransferExcluded_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setFeeOnTransferExcluded(bob, true);
    }

    function test_SetFeeOnTransferExcluded_TogglesFlag() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit ERC20WithFeeOnTransferGen.FeeOnTransferExcludedSet(bob, true);
        vm.prank(owner);
        token.setFeeOnTransferExcluded(bob, true);
        assertTrue(token.feeOnTransferIsExcluded(bob));

        vm.prank(owner);
        token.setFeeOnTransferExcluded(bob, false);
        assertFalse(token.feeOnTransferIsExcluded(bob));
    }

    function test_SetFeeOnTransferExcluded_AppliedOnNextTransfer() public {
        vm.prank(owner);
        token.setFeeOnTransferExcluded(bob, true);

        // alice → bob: bob is excluded → no fee.
        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.balanceOf(bob), 100 ether, "excluded bob receives full amount");
    }
}
