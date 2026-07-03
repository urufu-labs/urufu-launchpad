// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {BaseType} from "src/types/VMTypes.sol";

contract FeeSplitterTest is Test {
    FeeSplitter internal splitter;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal buyback = makeAddr("buyback");
    address internal nftVault = makeAddr("nftVault");
    address internal caller = makeAddr("caller");

    function setUp() public {
        splitter = new FeeSplitter(owner, treasury, 0);
        vm.deal(caller, 100 ether);
    }

    function test_Init_TreasuryGetsAll() public {
        vm.prank(caller);
        splitter.receiveFee{value: 1 ether}(caller, BaseType.ERC20);
        assertEq(treasury.balance, 1 ether);
    }

    function test_SetConfig_HappyPath() public {
        vm.prank(owner);
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2500);
        assertEq(splitter.uruBuybackSink(), buyback);
        assertEq(splitter.uruBuybackBps(), 4000);
        assertEq(splitter.nftRevenueBps(), 3500);
        assertEq(splitter.treasuryBps(), 2500);
    }

    function test_SetConfig_RevertsIfSumNot10000() public {
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.FeeSplitter__BadSum.selector, 9999));
        vm.prank(owner);
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2499);
    }

    function test_Distribute_SplitsPerBps() public {
        vm.prank(owner);
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2500);

        vm.prank(caller);
        splitter.receiveFee{value: 10 ether}(caller, BaseType.ERC20);

        assertEq(buyback.balance, 4 ether);
        assertEq(nftVault.balance, 3.5 ether);
        assertEq(treasury.balance, 2.5 ether);
    }

    function test_Distribute_UnsetSinkRollsIntoTreasury() public {
        // 40% buyback but buyback sink is zero → rolls into treasury (40 + 25 = 65%)
        vm.prank(owner);
        splitter.setConfig(address(0), nftVault, treasury, 4000, 3500, 2500);

        vm.prank(caller);
        splitter.receiveFee{value: 10 ether}(caller, BaseType.ERC20);

        assertEq(treasury.balance, 6.5 ether, "treasury absorbed buyback slice");
        assertEq(nftVault.balance, 3.5 ether);
    }

    function test_SetConfig_TimelockGate() public {
        splitter = new FeeSplitter(owner, treasury, 1 days);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(FeeSplitter.FeeSplitter__TooSoon.selector, block.timestamp, block.timestamp + 1 days)
        );
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2500);

        vm.warp(block.timestamp + 1 days);
        vm.prank(owner);
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2500);
        assertEq(splitter.uruBuybackSink(), buyback);
    }

    function test_Sweep_OwnerRecoversStuck() public {
        vm.deal(address(splitter), 1 ether);
        vm.prank(owner);
        splitter.sweep(caller);
        assertEq(caller.balance, 100 ether + 1 ether);
    }

    function test_Receive_DistributesToo() public {
        vm.prank(owner);
        splitter.setConfig(buyback, nftVault, treasury, 4000, 3500, 2500);

        vm.prank(caller);
        (bool ok,) = address(splitter).call{value: 10 ether}("");
        assertTrue(ok);

        assertEq(buyback.balance, 4 ether);
        assertEq(nftVault.balance, 3.5 ether);
    }
}
