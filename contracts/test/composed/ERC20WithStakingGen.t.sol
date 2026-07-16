// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";

contract ERC20WithStakingGenTest is Test {
    ERC20WithStakingGen internal impl;
    ERC20WithStakingGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant REWARDS_TOTAL = 1000 ether;
    uint32 internal constant DURATION = 30 days;
    uint256 internal constant INITIAL = 10_000 ether;

    function setUp() public {
        impl = new ERC20WithStakingGen();
        token = ERC20WithStakingGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(REWARDS_TOTAL, DURATION);
        bytes memory initData = abi.encode(owner, "Stake", "STK", INITIAL, owner, moduleData);
        token.initialize(initData);

        // Fund alice + bob from owner.
        vm.prank(owner);
        token.transfer(alice, 1000 ether);
        vm.prank(owner);
        token.transfer(bob, 1000 ether);
    }

    function test_Init_ComputesRate() public view {
        uint256 rate = token.stakingRewardRate();
        assertEq(rate, REWARDS_TOTAL / DURATION);
    }

    function test_Stake_MovesTokens() public {
        vm.prank(alice);
        token.stake(100 ether);
        assertEq(token.stakingBalanceOf(alice), 100 ether);
        assertEq(token.stakingTotalStaked(), 100 ether);
        assertEq(token.balanceOf(alice), 900 ether);
        // V2 reserve-backed: address(this) already holds REWARDS_TOTAL from init.
        // After alice stakes 100, it holds REWARDS_TOTAL + 100. _stakeBalance +
        // _stakeTotal tracks the STAKED portion separately so withdraw is bounded.
        assertEq(token.balanceOf(address(token)), REWARDS_TOTAL + 100 ether);
    }

    /// V2 invariant: reward claims transfer from the pre-reserved pool without
    /// growing total supply. Before the refactor, `stakingClaim` called `_mint`
    /// which inflated the supply post-launch — that broke bonding-curve economics.
    function test_Claim_TransfersFromReserveWithoutInflation() public {
        vm.prank(alice);
        token.stake(100 ether);

        // Fast-forward the full period so `earned` equals REWARDS_TOTAL (only alice
        // staking, so she gets everything).
        vm.warp(block.timestamp + DURATION);

        uint256 supplyBefore = token.totalSupply();
        uint256 stakingContractBalBefore = token.balanceOf(address(token));

        vm.prank(alice);
        token.stakingClaim();

        // Supply UNCHANGED — payout came from the reserve, not from _mint.
        assertEq(token.totalSupply(), supplyBefore, "total supply must not grow on claim");
        // Alice got her rewards + still has her original balance (staked pool untouched).
        // Reward is `rate * DURATION` where rate = REWARDS_TOTAL / DURATION (integer div)
        // so a few wei of dust remains unclaimed — that's the classic Synthetix quirk,
        // not a bug in the reserve refactor. Give it a wei-per-second tolerance.
        assertApproxEqAbs(
            token.balanceOf(alice), 900 ether + REWARDS_TOTAL, DURATION, "alice paid from reserve"
        );
        assertApproxEqAbs(
            token.balanceOf(address(token)), stakingContractBalBefore - REWARDS_TOTAL, DURATION,
            "reserve drained by claim"
        );
    }

    /// Safety-by-construction: launcher can't over-allocate. If REWARDS_TOTAL >
    /// initialSupply, init reverts inside solady's _transfer when mintTarget's
    /// balance underflows. No way to launch a token whose reserve exceeds supply.
    function test_Init_RevertsWhenRewardsExceedSupply() public {
        ERC20WithStakingGen fresh = ERC20WithStakingGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(REWARDS_TOTAL, DURATION);
        // Supply < REWARDS_TOTAL → init reverts.
        bytes memory initData = abi.encode(owner, "Stake", "STK", REWARDS_TOTAL - 1, owner, moduleData);
        vm.expectRevert();
        fresh.initialize(initData);
    }

    function test_Stake_RevertsOnZero() public {
        vm.expectRevert(ERC20WithStakingGen.Staking__ZeroAmount.selector);
        vm.prank(alice);
        token.stake(0);
    }

    function test_Withdraw_ReturnsTokens() public {
        vm.prank(alice);
        token.stake(500 ether);
        vm.prank(alice);
        token.stakingWithdraw(200 ether);
        assertEq(token.stakingBalanceOf(alice), 300 ether);
        assertEq(token.balanceOf(alice), 700 ether);
    }

    function test_Withdraw_RevertsOverBalance() public {
        vm.prank(alice);
        token.stake(100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithStakingGen.Staking__InsufficientStake.selector, 200 ether, 100 ether)
        );
        vm.prank(alice);
        token.stakingWithdraw(200 ether);
    }

    function test_Earned_AccruesLinearly() public {
        vm.prank(alice);
        token.stake(100 ether);

        vm.warp(block.timestamp + DURATION / 2);
        uint256 earned = token.stakingEarned(alice);
        // Alice is the only staker → she earns half of total rewards.
        // Allow rounding — rate is truncated to whole tokens/sec.
        uint256 rate = REWARDS_TOTAL / DURATION;
        uint256 expected = rate * (DURATION / 2);
        assertApproxEqAbs(earned, expected, 1e12);
    }

    function test_Earned_ShareBetweenTwoStakers() public {
        vm.prank(alice);
        token.stake(100 ether);
        vm.prank(bob);
        token.stake(100 ether);

        vm.warp(block.timestamp + DURATION);
        uint256 aliceEarned = token.stakingEarned(alice);
        uint256 bobEarned = token.stakingEarned(bob);
        // Equal stakes → roughly equal rewards.
        assertApproxEqRel(aliceEarned, bobEarned, 0.001e18);
    }

    function test_Claim_MintsReward() public {
        vm.prank(alice);
        token.stake(100 ether);
        vm.warp(block.timestamp + DURATION);

        uint256 aliceBalBefore = token.balanceOf(alice);
        vm.prank(alice);
        token.stakingClaim();
        uint256 aliceBalAfter = token.balanceOf(alice);
        assertGt(aliceBalAfter, aliceBalBefore);
    }

    function test_Claim_RevertsOnNothing() public {
        vm.expectRevert(ERC20WithStakingGen.Staking__NothingToClaim.selector);
        vm.prank(alice);
        token.stakingClaim();
    }

    function test_Earned_StopsAtPeriodFinish() public {
        vm.prank(alice);
        token.stake(100 ether);

        vm.warp(block.timestamp + DURATION);
        uint256 atEnd = token.stakingEarned(alice);

        vm.warp(block.timestamp + 30 days);
        uint256 afterEnd = token.stakingEarned(alice);
        assertEq(atEnd, afterEnd);
    }
}
