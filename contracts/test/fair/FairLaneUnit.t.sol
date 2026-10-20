// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairGraduator} from "src/fair/FairGraduator.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

import {FairTestBase, IERC20Min} from "./FairTestBase.sol";

/// Unit tests for the Fair launch lane on a local v4 PoolManager.
/// forge-config: default.isolate = true
contract FairLaneUnitTest is FairTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    V4SwapRouter internal swapRouter;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal trader = makeAddr("trader");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
        swapRouter = new V4SwapRouter(pm);
    }

    // ================================================================ factory

    function test_Launch_WiresEverything() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Wire", 0);
        assertEq(factory.curveFor(token), address(curve));
        assertEq(factory.batchFor(token), address(batch));
        assertEq(curve.batch(), address(batch));
        assertEq(curve.launcher(), creator);
        assertEq(batch.curve(), address(curve));
        assertEq(batch.creator(), creator);
        assertEq(batch.closeTs(), uint64(block.timestamp + 60), "D1 window != 60s");
        assertEq(curve.batchCapTokens(), (curve.curveSupply() * 2500) / 10_000, "D2 cap != 25%");
        assertEq(_bal(token, address(curve)), curve.curveSupply(), "curve does not hold the supply");
        assertEq(IERC20Min(token).totalSupply(), curve.curveSupply());
        // Token has no admin.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), address(0), "token still owned");
        (address pt, address pc, address pb) = factory.predictAddresses(creator, "Wire", "FAIR");
        assertEq(pt, token);
        assertEq(pc, address(curve));
        assertEq(pb, address(batch));
    }

    function test_Launch_ClosedByDefaultUntilOwnerOpens() public {
        vm.prank(admin);
        factory.setLaunchesOpen(false);
        vm.prank(creator);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__LaunchesClosed.selector);
        factory.launch("Closed", "C");
    }

    function test_Launch_NameTakenPerLauncher() public {
        _launch("Dup", 0);
        vm.prank(creator);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__NameTaken.selector);
        factory.launch("Dup", "FAIR");
    }

    function test_SetDefaults_RejectsCapThatGraduates() public {
        // 50% cap on a curve whose target is barely above the cap cost.
        vm.prank(admin);
        vm.expectRevert();
        factory.setDefaults(800_000_000e18, 800_000_000e18, 17 ether, 5 ether, 100, 60, 5000, 0);
    }

    function test_SetDefaults_RejectsBadWindow() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FairLaunchFactory.FairLaunchFactory__InvalidWindow.selector, uint32(5)));
        factory.setDefaults(800_000_000e18, 800_000_000e18, 17 ether, 10 ether, 100, 5, 2500, 0);
    }

    // ================================================================ deposits + window

    function test_DirectTradeLockedDuringWindow() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Locked", 0);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(FairBondingCurve.FairCurve__BatchWindowOpen.selector, uint256(batch.closeTs()))
        );
        curve.buy{value: 0.1 ether}(0);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(FairBondingCurve.FairCurve__BatchWindowOpen.selector, uint256(batch.closeTs()))
        );
        curve.sell(1, 0);
        token;
    }

    function test_DepositAfterWindowReverts() public {
        (,, OpeningBatch batch) = _launch("Late", 0);
        _warpPast(batch);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(OpeningBatch.OpeningBatch__WindowClosed.selector, uint256(batch.closeTs()))
        );
        batch.deposit{value: 1 ether}();
    }

    function test_DepositForIsFactoryOnly() public {
        (,, OpeningBatch batch) = _launch("DepFor", 0);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OpeningBatch.OpeningBatch__NotFactory.selector, alice));
        batch.depositFor{value: 1 ether}(bob);
    }

    function test_SettleBeforeWindowEndReverts() public {
        (,, OpeningBatch batch) = _launch("Early", 0);
        vm.expectRevert(
            abi.encodeWithSelector(OpeningBatch.OpeningBatch__WindowStillOpen.selector, uint256(batch.closeTs()))
        );
        batch.settle();
    }

    // ================================================================ pro-rata math

    function test_ProRata_TwoDepositors() public {
        (address token,, OpeningBatch batch) = _launch("ProRata", 0);
        _deposit(batch, alice, 0.1 ether);
        _deposit(batch, bob, 0.3 ether);
        _warpPast(batch);
        batch.settle();
        uint256 bought = batch.tokensBought();
        assertGt(bought, 0);
        assertEq(batch.ethSpent(), 0.4 ether, "under cap: all ETH spent");

        vm.prank(alice);
        (uint256 ta, uint256 ra) = batch.claim();
        vm.prank(bob);
        (uint256 tb, uint256 rb) = batch.claim();
        assertEq(ra, 0);
        assertEq(rb, 0);
        assertEq(ta, (bought * 0.1 ether) / 0.4 ether);
        assertEq(tb, (bought * 0.3 ether) / 0.4 ether);
        // Same price: tokens per wei identical up to 1 wei of rounding.
        assertApproxEqAbs(ta * 3, tb, 3, "alice and bob paid different prices");
        assertLe(bought - ta - tb, 1, "dust > 1 wei");
        assertEq(_bal(token, alice), ta);
        assertEq(_bal(token, bob), tb);
    }

    function test_Oversubscription_FillsCapAndRefundsProRata() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Hot", 0);
        _deposit(batch, alice, 4 ether);
        _deposit(batch, bob, 6 ether);
        (uint256 qTok, uint256 qUsed, uint256 qRefund) = batch.quote();
        _warpPast(batch);
        batch.settle();
        uint256 cap = curve.batchCapTokens();
        assertEq(batch.tokensBought(), cap, "oversubscribed batch did not fill exactly the cap");
        assertEq(qTok, cap, "quote tokens");
        uint256 spent = batch.ethSpent();
        assertEq(qUsed, spent, "quote spent");
        assertEq(qRefund, 10 ether - spent, "quote refund");
        assertLt(spent, 10 ether);
        assertGt(spent, 0.5 ether);
        assertFalse(curve.graduated(), "a hot minute graduated the token");

        uint256 aEth = alice.balance;
        vm.prank(alice);
        (uint256 ta, uint256 ra) = batch.claim();
        vm.prank(bob);
        (uint256 tb, uint256 rb) = batch.claim();
        assertEq(ta, (cap * 4) / 10);
        assertEq(tb, (cap * 6) / 10);
        assertEq(ra, ((10 ether - spent) * 4) / 10);
        assertEq(rb, ((10 ether - spent) * 6) / 10);
        assertEq(alice.balance - aEth, ra);
        assertLe((10 ether - spent) - ra - rb, 1, "refund dust > 1 wei");
        assertEq(_bal(token, alice), ta);
    }

    function test_Rounding_DustStaysAndSweepNeverTouchesUnclaimed() public {
        (address token,, OpeningBatch batch) = _launch("Dust", 0);
        _deposit(batch, alice, 1 ether + 1);
        _deposit(batch, bob, 2 ether + 3);
        _deposit(batch, carol, 7);
        _warpPast(batch);
        batch.settle();
        uint256 bought = batch.tokensBought();

        vm.prank(alice);
        (uint256 ta,) = batch.claim();
        vm.prank(carol);
        (uint256 tc,) = batch.claim();

        vm.expectRevert();
        batch.sweepDust();
        vm.warp(uint256(batch.closeTs()) + batch.SWEEP_DELAY());
        batch.sweepDust();

        // Bob never claimed before the sweep; he still gets his exact share after it.
        uint256 expectBob = (bought * (2 ether + 3)) / batch.totalDeposited();
        vm.prank(bob);
        (uint256 tb,) = batch.claim();
        assertEq(tb, expectBob, "sweep ate an unclaimed share");
        assertLe(bought - ta - tb - tc, 3, "more than 1 wei dust per depositor");
        assertLe(_bal(token, address(batch)), 3);
    }

    function test_ClaimTwiceReverts() public {
        (,, OpeningBatch batch) = _launch("Twice", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        vm.startPrank(alice);
        batch.claim();
        vm.expectRevert(OpeningBatch.OpeningBatch__NothingToClaim.selector);
        batch.claim();
        vm.stopPrank();
    }

    function test_ClaimFor_PushesToUserNotCaller() public {
        (address token,, OpeningBatch batch) = _launch("Push", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        vm.prank(bob);
        (uint256 t,) = batch.claimFor(alice);
        assertEq(_bal(token, alice), t);
        assertEq(_bal(token, bob), 0);
    }

    function test_CreatorFirstDeposit_SamePriceAsEveryone() public {
        (address token,, OpeningBatch batch) = _launch("Creator", 0.5 ether);
        assertEq(batch.deposits(creator), 0.5 ether, "launch did not deposit for creator");
        _deposit(batch, alice, 0.5 ether);
        _warpPast(batch);
        batch.settle();
        vm.prank(creator);
        (uint256 tCreator,) = batch.claim();
        vm.prank(alice);
        (uint256 tAlice,) = batch.claim();
        assertEq(tCreator, tAlice, "creator got a dev-first edge");
        token;
    }

    // ================================================================ settle trigger

    function test_FirstDirectBuySettlesTheBatch() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Trigger", 0);
        _deposit(batch, alice, 0.3 ether);
        _warpPast(batch);
        assertFalse(batch.settled());
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 got = curve.buy{value: 0.1 ether}(0);
        assertTrue(batch.settled(), "direct buy did not settle");
        assertTrue(curve.batchSettled());
        assertGt(batch.tokensBought(), 0);
        assertEq(_bal(token, trader), got);
        // Batch filled first, at the lower price: alice paid 3x and got > 3x the tokens.
        vm.prank(alice);
        (uint256 ta,) = batch.claim();
        assertGt(ta, got * 3, "batch did not fill before the direct buy");
    }

    function test_FirstDirectSellPathAlsoSettles() public {
        (, FairBondingCurve curve, OpeningBatch batch) = _launch("SellTrigger", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        // Nobody holds tokens yet, so the sell itself fails on transferFrom, but the
        // revert must come from the token, not from the window lock.
        vm.prank(trader);
        vm.expectRevert();
        curve.sell(1, 0);
        assertFalse(batch.settled(), "reverted tx must not persist");
    }

    function test_NoDeposits_SettleJustOpensCurve() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Empty", 0);
        _warpPast(batch);
        batch.settle();
        assertTrue(curve.batchSettled());
        assertEq(batch.tokensBought(), 0);
        assertEq(_bal(token, address(batch)), 0);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        curve.buy{value: 0.1 ether}(0);
    }

    function test_SettleIsIdempotent() public {
        (,, OpeningBatch batch) = _launch("Idem", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        uint256 bought = batch.tokensBought();
        batch.settle();
        vm.prank(bob);
        batch.settle();
        assertEq(batch.tokensBought(), bought);
    }

    function test_CurveBatchBuyOnlyFromBatch() public {
        (, FairBondingCurve curve,) = _launch("OnlyBatch", 0);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(FairBondingCurve.FairCurve__NotBatch.selector, trader));
        curve.batchBuy{value: 1 ether}();
    }

    // ================================================================ graduation + hook

    function test_Graduation_OpensPoolWithConfig() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Grad", 0.2 ether);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        (uint160 sq,,,) = pm.getSlot0(id);
        assertGt(sq, 0);
        assertGt(pm.getLiquidity(id), 0);
        (address pToken, address pCreator, uint64 launchTs,,,, bool configured, bool forfeited, uint256 baseline) =
            hook.pools(id);
        assertEq(pToken, token);
        assertEq(pCreator, creator);
        assertEq(launchTs, uint64(block.timestamp));
        assertTrue(configured);
        assertFalse(forfeited);
        // Graduator pushed the creator's unclaimed batch share before reading the baseline.
        assertTrue(batch.claimed(creator), "creator share not auto-claimed at graduation");
        assertEq(baseline, _bal(token, creator));
        assertGt(baseline, 0);
        assertEq(address(graduator).balance, graduator.totalClaimable(), "graduator kept unallocated ETH");
    }

    function test_Graduation_NoCliffForLastBuyer_NoStrandedEth() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("NoCliff", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        uint256 vE = curve.virtualEthReserve();
        uint256 vT = curve.virtualTokenReserve();
        vm.recordLogs();
        PoolKey memory key = _graduate(curve);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 ethAmt;
        uint256 tokAmt;
        bytes32 topic = keccak256("Graduated(address,address,uint256,uint256,uint160,uint128,address,uint256,bool)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(graduator) && logs[i].topics[0] == topic) {
                (ethAmt, tokAmt) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        assertGt(ethAmt, 0, "Graduated not seen");
        (uint160 sq,,,) = pm.getSlot0(key.toId());
        // Pool price, ETH per token (1e18 fixed point) = 2^192 / sq^2 * 1e18.
        uint256 tokPerEthX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(uint256(sq), uint256(sq), 1 << 96), 1e18, 1 << 96
        );
        uint256 poolPrice = 1e36 / tokPerEthX18;
        uint256 marginal = ((vE + ethAmt) * 1e18) / (vT + tokAmt);
        uint256 diff = poolPrice > marginal ? poolPrice - marginal : marginal - poolPrice;
        assertLe(diff * 1000, marginal, "graduation cliff > 0.1%");
        // ETH limited: all ETH in the LP, nothing stranded, unused tokens burned.
        assertEq(address(graduator).balance, graduator.totalClaimable(), "unallocated ETH in graduator");
        assertLe(graduator.totalClaimable(), 1e9, "more than dust refunded: LP was not ETH-limited");
        assertEq(_bal(token, address(graduator)), 0, "tokens left in graduator");
        assertGt(_bal(token, DEAD), 0, "excess tokens not burned");
    }

    function test_TaxDecay_LinearTo0Over5Min() public {
        (, FairBondingCurve curve,) = _launch("Decay", 0);
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        uint256 t0 = vm.getBlockTimestamp(); // not block.timestamp: via-ir re-reads it after warps
        assertEq(hook.currentTaxBps(id), 2000, "D3 start != 20%");
        vm.warp(t0 + 60);
        assertEq(hook.currentTaxBps(id), 1600);
        vm.warp(t0 + 150);
        assertEq(hook.currentTaxBps(id), 1000);
        vm.warp(t0 + 299);
        assertEq(hook.currentTaxBps(id), 6);
        assertEq(hook.taxSecondsLeft(id), 1);
        vm.warp(t0 + 300);
        assertEq(hook.currentTaxBps(id), 0);
        vm.warp(t0 + 10_000);
        assertEq(hook.currentTaxBps(id), 0);
    }

    function test_BuyTax_BurnedInTokens() public {
        (address token, FairBondingCurve curve,) = _launch("BuyTax", 0.2 ether);
        PoolKey memory key = _graduate(curve);
        vm.warp(block.timestamp + 150); // 10% tax
        uint256 deadBefore = _bal(token, DEAD);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 out = swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, trader, block.timestamp);
        uint256 burned = _bal(token, DEAD) - deadBefore;
        // out = gross * (1 - 2% fee - 10% tax) ; burned = gross * 10%
        uint256 gross = (out * 10_000) / 8800;
        assertApproxEqRel(burned, gross / 10, 1e14, "buy tax != 10% of gross output");
        assertApproxEqRel(hook.owed(Currency.wrap(token), platform), gross / 100, 1e14, "platform fee != 1%");
    }

    function test_SellTax_BankedThenBurned() public {
        (address token, FairBondingCurve curve,) = _launch("SellTax", 0);
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        // Buy after the tax window so the trader gets clean tokens.
        vm.warp(block.timestamp + 301);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.2 ether}(key, 0, trader, block.timestamp);
        assertEq(hook.bankedEth(id), 0, "no tax after window");

        // A fresh pool to sell into during its tax window.
        (address token2, FairBondingCurve curve2,) = _launch("SellTax2", 0.2 ether);
        PoolKey memory key2 = _graduate(curve2);
        PoolId id2 = key2.toId();
        address seller = makeAddr("fair-grad-whale"); // whale holds curve2 tokens
        uint256 sellAmt = _bal(token2, seller) / 100;
        vm.startPrank(seller);
        IERC20Min(token2).approve(address(swapRouter), sellAmt);
        uint256 ethOut = swapRouter.swapExactTokenForETH(key2, sellAmt, 0, seller, block.timestamp);
        vm.stopPrank();
        uint256 banked = hook.bankedEth(id2);
        assertGt(banked, 0, "sell tax not banked");
        uint256 gross = (ethOut * 10_000) / 7800; // 2% fee + 20% tax at t0
        assertApproxEqRel(banked, gross / 5, 1e14, "sell tax != 20% of gross ETH");
        assertEq(hook.totalBanked(), banked);
        _assertHookSolvent(token2, creator);

        vm.warp(block.timestamp + 1); // the guard refuses in the same second as the sell
        uint256 supplyDeadBefore = _bal(token2, DEAD);
        address keeper = makeAddr("keeper");
        uint256 burned;
        while (hook.bankedEth(id2) > 0) {
            vm.warp(block.timestamp + 1);
            vm.prank(keeper);
            burned += hook.burnBank(id2, 1);
        }
        assertGt(burned, 0);
        assertEq(_bal(token2, DEAD) - supplyDeadBefore, burned, "bank tokens not sent to dead");
        assertEq(hook.bankedEth(id2), 0);
        assertEq(hook.totalBanked(), 0);
        _assertHookSolvent(token2, creator);

        vm.expectRevert(abi.encodeWithSelector(FairHookHost.FairHookHost__NothingBanked.selector, id2));
        hook.burnBank(id2, 0);
        token;
        bought;
    }

    function test_BurnBank_SlippageGuard() public {
        (address token, FairBondingCurve curve,) = _launch("BankSlip", 0.2 ether);
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        address seller = makeAddr("fair-grad-whale");
        uint256 sellAmt = _bal(token, seller) / 50;
        vm.startPrank(seller);
        IERC20Min(token).approve(address(swapRouter), sellAmt);
        swapRouter.swapExactTokenForETH(key, sellAmt, 0, seller, block.timestamp);
        vm.stopPrank();
        uint256 banked = hook.bankedEth(id);
        vm.expectRevert();
        hook.burnBank(id, type(uint256).max);
        assertEq(hook.bankedEth(id), banked, "failed burn must keep the bank");
    }

    function test_AfterWindow_NoTax_NormalFees() public {
        (address token, FairBondingCurve curve,) = _launch("NoTax", 0.2 ether);
        PoolKey memory key = _graduate(curve);
        vm.warp(block.timestamp + 300);
        uint256 deadBefore = _bal(token, DEAD);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 out = swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, trader, block.timestamp);
        assertEq(_bal(token, DEAD), deadBefore, "tax after window");
        uint256 gross = (out * 10_000) / 9800;
        assertApproxEqAbs(hook.owed(Currency.wrap(token), platform), gross / 100, gross / 1e12 + 2);
        assertApproxEqAbs(_creatorEarned(token, false), gross / 100, gross / 1e12 + 2);
    }

    // ================================================================ forfeit

    function _graduateWithCreatorHolding(
        string memory name
    ) internal returns (address token, PoolKey memory key) {
        FairBondingCurve curve;
        OpeningBatch batch;
        (token, curve, batch) = _launch(name, 0.5 ether);
        _warpPast(batch);
        batch.settle();
        key = _graduate(curve);
        vm.warp(block.timestamp + 300); // past the tax so fee math is clean
    }

    function _buy(
        PoolKey memory key,
        uint256 eth
    ) internal returns (uint256) {
        vm.deal(trader, trader.balance + eth);
        vm.prank(trader);
        return swapRouter.swapExactETHForToken{value: eth}(key, 0, trader, block.timestamp);
    }

    function test_Forfeit_CreatorTransferToFreshWalletForfeits() public {
        (address token, PoolKey memory key) = _graduateWithCreatorHolding("Forfeit");
        PoolId id = key.toId();
        Currency tok = Currency.wrap(token);
        _buy(key, 0.1 ether);
        // A later check confirms the pending fee while the creator still holds.
        hook.pokeForfeit(id);
        uint256 owedBefore = _creatorClaimable(token, false);
        assertGt(owedBefore, 0, "creator earned nothing while holding");
        assertFalse(hook.isForfeited(id));

        // Move 11% to a fresh wallet: more than 10% below baseline.
        uint256 bal = _bal(token, creator);
        address fresh = makeAddr("fresh-wallet");
        vm.prank(creator);
        IERC20Min(token).transfer(fresh, (bal * 11) / 100);
        assertTrue(hook.isForfeited(id), "view should report forfeit");

        uint256 deadBefore = _bal(token, DEAD);
        vm.expectEmit(true, true, false, false, address(hook));
        emit FairHookHost.CreatorFeeForfeited(id, creator, 0, 0);
        uint256 out = _buy(key, 0.1 ether);
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited);
        assertEq(_creatorEarned(token, false), owedBefore, "creator still accruing after forfeit");
        uint256 gross = (out * 10_000) / 9800;
        assertApproxEqAbs(_bal(token, DEAD) - deadBefore, gross / 100, gross / 1e12 + 2, "creator share not burned");

        // Permanence: moving the tokens back does not undo it.
        vm.prank(fresh);
        IERC20Min(token).transfer(creator, (bal * 11) / 100);
        _buy(key, 0.1 ether);
        assertEq(_creatorEarned(token, false), owedBefore, "forfeit was not permanent");
        // Fees confirmed before the forfeit stay claimable.
        uint256 before = _bal(token, creator);
        hook.claimCreatorFees(id);
        assertEq(_bal(token, creator) - before, owedBefore);
        assertEq(_creatorEarned(token, false), 0);
        tok;
        _assertHookSolvent(token, creator);
    }

    function test_Forfeit_NineteenPercentDropDoesNot_TenPointOneDoes() public {
        (address token, PoolKey memory key) = _graduateWithCreatorHolding("Edge");
        PoolId id = key.toId();
        (,,,,,,,, uint256 baseline) = hook.pools(id);
        address fresh = makeAddr("edge-fresh");
        // Exactly 10% down: still at the floor, no forfeit.
        uint256 tenPct = baseline - (baseline * 9000) / 10_000;
        vm.prank(creator);
        IERC20Min(token).transfer(fresh, tenPct);
        _buy(key, 0.01 ether);
        assertFalse(hook.isForfeited(id), "exactly 10% must not forfeit");
        // One more wei below the floor flips it.
        vm.prank(creator);
        IERC20Min(token).transfer(fresh, 1);
        assertTrue(hook.pokeForfeit(id), "poke did not flip");
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited);
    }

    function test_Forfeit_EthSideShareGoesToBank() public {
        (address token, PoolKey memory key) = _graduateWithCreatorHolding("EthSide");
        PoolId id = key.toId();
        uint256 half = _bal(token, creator) / 2;
        address x = makeAddr("x");
        vm.prank(creator);
        IERC20Min(token).transfer(x, half);
        hook.pokeForfeit(id);
        // A sell takes fees in ETH; the creator half must land in the bank.
        _buy(key, 0.2 ether);
        uint256 amt = _bal(token, trader) / 2;
        vm.startPrank(trader);
        IERC20Min(token).approve(address(swapRouter), amt);
        uint256 ethOut = swapRouter.swapExactTokenForETH(key, amt, 0, trader, block.timestamp);
        vm.stopPrank();
        uint256 gross = (ethOut * 10_000) / 9800;
        assertApproxEqAbs(hook.bankedEth(id), gross / 100, gross / 1e12 + 2, "ETH creator share not banked");
        assertEq(_creatorEarned(token, true), 0);
        _assertHookSolvent(token, creator);
    }

    function test_Forfeit_PreGraduationCurveSellForfeitsFromStart() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("PreSell", 0.5 ether);
        _warpPast(batch);
        batch.settle();
        vm.startPrank(creator);
        (uint256 t,) = batch.claim();
        IERC20Min(token).approve(address(curve), t / 10);
        curve.sell(t / 10, 0);
        vm.stopPrank();
        assertTrue(curve.creatorSold());
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "pre-grad dump did not forfeit");
        vm.warp(block.timestamp + 300);
        _buy(key, 0.1 ether);
        assertEq(_creatorEarned(token, false), 0, "forfeited creator accrued");
    }

    function test_Forfeit_NonCreatorSellDoesNotFlag() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("OtherSell", 0);
        _deposit(batch, alice, 1 ether);
        _warpPast(batch);
        batch.settle();
        vm.startPrank(alice);
        (uint256 t,) = batch.claim();
        IERC20Min(token).approve(address(curve), t);
        curve.sell(t, 0);
        vm.stopPrank();
        assertFalse(curve.creatorSold());
    }

    // ================================================================ graduator guards

    function test_Graduator_OnlyFactoryCurve() public {
        (address token,,) = _launch("Auth", 0);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        vm.expectRevert();
        graduator.execute{value: 1 ether}(token, 1 ether, 1e18, trader, false);
    }

    function test_Graduator_BadHookFlagsRejectedAtDeploy() public {
        vm.expectRevert();
        new FairGraduator(pm, FairHookHost(payable(address(0x1234))), FEE, TICK_SPACING, 0, admin);
    }

    function test_Hook_OnlyGraduatorCanInitialize() public {
        (address token,,) = _launch("Rogue", 0);
        PoolKey memory key = _key(token);
        vm.expectRevert();
        pm.initialize(key, 79_228_162_514_264_337_593_543_950_336);
    }

    function test_Hook_SetPoolConfigOnlyInitializer() public {
        vm.expectRevert(abi.encodeWithSelector(FairHookHost.FairHookHost__NotInitializer.selector, address(this)));
        hook.setPoolConfig(PoolId.wrap(bytes32(uint256(1))), address(this), 1, false, 0);
    }

    function test_Graduator_OwnerSweepNeverTouchesRefunds() public {
        vm.deal(address(graduator), 1 ether);
        address payable to = payable(makeAddr("sweep-to"));
        vm.prank(admin);
        graduator.sweep(to);
        assertEq(to.balance, 1 ether);
        vm.prank(trader);
        vm.expectRevert(FairGraduator.FairGraduator__NotOwner.selector);
        graduator.sweep(to);
    }
}
