// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";

import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

import {FairTestBase, IERC20Min, ReentrantClaimer, LiquidityAdder} from "./FairTestBase.sol";

/// Creator wallet that burns all forwarded gas when it receives ETH.
contract GasBurnerCreator {
    function launch(
        address factory,
        string calldata name
    ) external payable returns (address token, address curve, address batch) {
        (bool ok, bytes memory ret) =
            factory.call{value: msg.value}(abi.encodeWithSignature("launch(string,string)", name, "GAS"));
        require(ok, "launch");
        (token, curve, batch) = abi.decode(ret, (address, address, address));
    }

    receive() external payable {
        while (true) {}
    }
}

/// Creator wallet that rejects ETH outright.
contract EthRejectingCreator {
    function launch(
        address factory,
        string calldata name
    ) external payable returns (address token, address curve, address batch) {
        (bool ok, bytes memory ret) =
            factory.call{value: msg.value}(abi.encodeWithSignature("launch(string,string)", name, "REJ"));
        require(ok, "launch");
        (token, curve, batch) = abi.decode(ret, (address, address, address));
    }
}

/// Adversarial tests for the Fair launch lane (spec "Tests" section).
/// forge-config: default.isolate = true
contract FairLaneAdversarialTest is FairTestBase {
    using PoolIdLibrary for PoolKey;

    address internal honest = makeAddr("honest");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
    }

    // ================================================================ bundling

    function _bundleRun(
        string memory name,
        uint256 bankroll,
        uint256 wallets,
        uint256 honestEth
    ) internal returns (uint256 bundlerTokens, uint256 bundlerEth, uint256 honestTokens, uint256 honestRefund) {
        (address token,, OpeningBatch batch) = _launch(name, 0);
        uint256 each = bankroll / wallets;
        _deposit(batch, honest, honestEth);
        for (uint256 i = 0; i < wallets; i++) {
            _deposit(batch, address(uint160(uint256(keccak256(abi.encode(name, i))))), each);
        }
        _warpPast(batch);
        batch.settle();
        for (uint256 i = 0; i < wallets; i++) {
            address w = address(uint160(uint256(keccak256(abi.encode(name, i)))));
            uint256 before = w.balance;
            vm.prank(w);
            (uint256 t, uint256 r) = batch.claim();
            assertEq(_bal(token, w), t);
            assertEq(w.balance - before, r);
            bundlerTokens += t;
            bundlerEth += r;
        }
        vm.prank(honest);
        (honestTokens, honestRefund) = batch.claim();
    }

    function test_Bundle50Wallets_SameAsOneWallet_UnderCap() public {
        (uint256 t1, uint256 e1, uint256 h1,) = _bundleRun("SoloUnder", 0.5 ether, 1, 0.1 ether);
        (uint256 t50, uint256 e50, uint256 h50,) = _bundleRun("BundleUnder", 0.5 ether, 50, 0.1 ether);
        assertEq(h1, h50, "honest depositor affected by bundling");
        assertLe(t1 - t50, 50, "bundle earned more or lost more than rounding");
        assertGe(t1, t50, "50 wallets beat 1 wallet");
        assertEq(e1, 0);
        assertEq(e50, 0);
    }

    function test_Bundle50Wallets_SameAsOneWallet_Oversubscribed() public {
        (uint256 t1, uint256 e1, uint256 h1, uint256 hr1) = _bundleRun("SoloOver", 5 ether, 1, 1 ether);
        (uint256 t50, uint256 e50, uint256 h50, uint256 hr50) = _bundleRun("BundleOver", 5 ether, 50, 1 ether);
        assertEq(h1, h50, "honest tokens changed");
        assertEq(hr1, hr50, "honest refund changed");
        assertGe(t1, t50);
        assertLe(t1 - t50, 50);
        assertGe(e1, e50);
        assertLe(e1 - e50, 50);
    }

    /// Fuzz: any split of a bankroll gets at most what one wallet gets, and never
    /// more than 1 wei per extra wallet less.
    function testFuzz_SplitNeverBeatsSingle(
        uint96 bankroll,
        uint8 walletsRaw,
        uint96 honestEth
    ) public {
        uint256 wallets = bound(walletsRaw, 2, 30);
        uint256 b = bound(bankroll, wallets * 1e12, 20 ether);
        b -= b % wallets;
        uint256 h = bound(honestEth, 1e12, 5 ether);
        (uint256 t1, uint256 e1, uint256 h1, uint256 hr1) = _bundleRun("FuzzSolo", b, 1, h);
        (uint256 tn, uint256 en, uint256 hn, uint256 hrn) = _bundleRun("FuzzSplit", b, wallets, h);
        assertEq(h1, hn);
        assertEq(hr1, hrn);
        assertGe(t1, tn);
        assertLe(t1 - tn, wallets);
        assertGe(e1, en);
        assertLe(e1 - en, wallets);
    }

    /// Fuzz: total claims never exceed what the batch bought / refunds.
    function testFuzz_ClaimsNeverExceedBatch(
        uint96 a,
        uint96 b,
        uint96 c
    ) public {
        uint256 da = bound(a, 1, 10 ether);
        uint256 db = bound(b, 1, 10 ether);
        uint256 dc = bound(c, 1, 10 ether);
        (address token,, OpeningBatch batch) = _launch("FuzzClaims", 0);
        _deposit(batch, address(0xA1), da);
        _deposit(batch, address(0xB2), db);
        _deposit(batch, address(0xC3), dc);
        _warpPast(batch);
        batch.settle();
        uint256 sumT;
        uint256 sumR;
        address[3] memory us = [address(0xA1), address(0xB2), address(0xC3)];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(us[i]);
            (uint256 t, uint256 r) = batch.claim();
            sumT += t;
            sumR += r;
        }
        assertLe(sumT, batch.tokensBought());
        assertLe(sumR, batch.totalDeposited() - batch.ethSpent());
        assertLe(batch.tokensBought() - sumT, 3);
        assertEq(_bal(token, address(batch)), batch.tokensBought() - sumT);
    }

    // ================================================================ creator games

    function test_CreatorTransferToFreshWallet_Forfeits_AndFreshWalletDumpIsNotFree() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Alt", 0.5 ether);
        _warpPast(batch);
        batch.settle();
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        vm.warp(block.timestamp + 301);
        uint256 bal = _bal(token, creator);
        address alt = makeAddr("creator-alt");
        vm.prank(creator);
        IERC20Min(token).transfer(alt, bal);
        // Alt dumps through an aggregator. The swap itself flips the forfeit.
        vm.startPrank(alt);
        IERC20Min(token).approve(address(agg), bal / 4);
        agg.swap(key, false, -int256(bal / 4), bal / 4);
        vm.stopPrank();
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "transfer to alt did not forfeit");
        assertEq(_creatorEarned(token, true), 0, "creator earned on the dump");
        assertGt(hook.bankedEth(id), 0, "forfeited ETH share not banked");
        _assertHookSolvent(token, creator);
    }

    function test_CreatorLeavesBatchShareUnclaimed_StillCountsInBaseline() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Unclaimed", 0.5 ether);
        _warpPast(batch);
        batch.settle();
        (uint256 share,) = batch.pending(creator);
        PoolKey memory key = _graduate(curve);
        (,,,,,,,, uint256 baseline) = hook.pools(key.toId());
        assertEq(baseline, share, "baseline missed the unclaimed batch share");
        assertEq(_bal(token, creator), share);
        // Creator cannot later claim-and-dump: nothing left to claim.
        vm.prank(creator);
        vm.expectRevert(OpeningBatch.OpeningBatch__NothingToClaim.selector);
        batch.claim();
    }

    function test_GasBurningCreatorCannotBrickGraduation() public {
        GasBurnerCreator gc = new GasBurnerCreator();
        vm.deal(address(this), 1 ether);
        (address token, address c, address b) = gc.launch{value: 0.5 ether}(address(factory), "GasGrief");
        FairBondingCurve curve = FairBondingCurve(payable(c));
        OpeningBatch batch = OpeningBatch(payable(b));
        // Oversubscribe so the creator's claim includes an ETH refund (the gas trap).
        _deposit(batch, honest, 3 ether);
        _warpPast(batch);
        batch.settle();
        PoolKey memory key = _graduate(curve);
        assertTrue(curve.graduated(), "gas-burning creator bricked graduation");
        (,,,,,, bool configured,,) = hook.pools(key.toId());
        assertTrue(configured);
        // The claim now always lands: tokens delivered, the ETH refund parked for a pull.
        assertTrue(batch.claimed(address(gc)), "creator share not delivered");
        assertGt(_bal(token, address(gc)), 0);
        assertGt(batch.refundOwed(address(gc)), 0, "refund not parked");
        (,,,,,,, bool forfeited,) = hook.pools(key.toId());
        assertFalse(forfeited, "parked refund must not count as a dump");
    }

    function test_EthRejectingCreator_GraduationStillWorks() public {
        EthRejectingCreator rc = new EthRejectingCreator();
        vm.deal(address(this), 1 ether);
        (, address c, address b) = rc.launch{value: 0.5 ether}(address(factory), "Reject");
        _deposit(OpeningBatch(payable(b)), honest, 3 ether);
        _warpPast(OpeningBatch(payable(b)));
        OpeningBatch(payable(b)).settle();
        _graduate(FairBondingCurve(payable(c)));
        assertTrue(FairBondingCurve(payable(c)).graduated());
        OpeningBatch batch = OpeningBatch(payable(b));
        uint256 owed = batch.refundOwed(address(rc));
        assertGt(owed, 0, "rejected refund not parked");
        // The creator pulls it to a wallet that accepts ETH.
        address payout = makeAddr("reject-payout");
        vm.prank(address(rc));
        batch.withdrawRefund(payout);
        assertEq(payout.balance, owed);
        assertEq(batch.totalRefundOwed(), 0);
        vm.prank(address(rc));
        vm.expectRevert(OpeningBatch.OpeningBatch__NoRefundOwed.selector);
        batch.withdrawRefund(payout);
    }

    // ================================================================ audit fixes (2026-10-20)

    /// A creator who moves tokens to an alt BEFORE graduation used to slip past the
    /// forfeit (baseline was just the balance left). Now the pool starts forfeited.
    function test_PreGradTransferToAlt_ForfeitsFromStart() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("PreAlt", 0.5 ether);
        _warpPast(batch);
        batch.settle();
        vm.prank(creator);
        (uint256 share,) = batch.claim();
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        uint256 bought = curve.buy{value: 0.2 ether}(0);
        assertEq(curve.creatorBought(), bought);
        address alt = makeAddr("pre-alt");
        uint256 moved = ((share + bought) * 11) / 100;
        vm.prank(creator);
        IERC20Min(token).transfer(alt, moved);
        PoolKey memory key = _graduate(curve);
        (,,,,,,, bool forfeited, uint256 baseline) = hook.pools(key.toId());
        assertTrue(forfeited, "pre-grad move to alt did not forfeit");
        assertEq(baseline, share + bought, "baseline should be what the lane gave the creator");
    }

    function test_PreGradSmallTransfer_UnderAllowance_NotForfeited() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("PreSmall", 0.5 ether);
        _warpPast(batch);
        batch.settle();
        vm.prank(creator);
        (uint256 share,) = batch.claim();
        address alt = makeAddr("pre-small");
        vm.prank(creator);
        IERC20Min(token).transfer(alt, share / 20); // 5%
        PoolKey memory key = _graduate(curve);
        (,,,,,,, bool forfeited,) = hook.pools(key.toId());
        assertFalse(forfeited, "5% move must not forfeit");
    }

    /// Range orders were a way around the sniper tax: add ETH just above the price
    /// and let buyers convert it to tokens tax free. Third-party adds are locked
    /// until the tax ends.
    function test_ThirdPartyLiquidityLockedDuringTax() public {
        (, FairBondingCurve curve,) = _launch("LpLock", 0);
        PoolKey memory key = _graduate(curve);
        LiquidityAdder lp = new LiquidityAdder(pm);
        vm.deal(address(lp), 10 ether);
        vm.expectRevert();
        lp.addEthAbovePrice(key, 1e15);
        vm.warp(block.timestamp + 299);
        vm.expectRevert();
        lp.addEthAbovePrice(key, 1e15);
        vm.warp(block.timestamp + 1);
        lp.addEthAbovePrice(key, 1e15);
    }

    function test_SweepDustReservesParkedRefunds() public {
        EthRejectingCreator rc = new EthRejectingCreator();
        vm.deal(address(this), 1 ether);
        (,, address b) = rc.launch{value: 0.5 ether}(address(factory), "ParkSweep");
        OpeningBatch batch = OpeningBatch(payable(b));
        _deposit(batch, honest, 3 ether);
        _warpPast(batch);
        batch.settle();
        batch.claimFor(address(rc));
        uint256 owed = batch.refundOwed(address(rc));
        assertGt(owed, 0);
        vm.warp(uint256(batch.closeTs()) + batch.SWEEP_DELAY());
        batch.sweepDust();
        vm.prank(address(rc));
        batch.withdrawRefund(honest);
        vm.prank(honest);
        batch.claim();
    }

    // ================================================================ settle griefing

    function test_SettleGriefing_DonationsAndDustCannotBlock() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("Grief", 0);
        _deposit(batch, honest, 0.2 ether);
        // ETH sent straight to the curve is ignored by its accounting.
        vm.deal(attacker, 10 ether);
        vm.prank(attacker);
        (bool ok,) = address(curve).call{value: 1 ether}("");
        assertTrue(ok);
        // ETH sent straight to the batch is refused.
        vm.prank(attacker);
        (ok,) = address(batch).call{value: 1 ether}("");
        assertFalse(ok, "batch accepted stray ETH");
        // Many dust deposits.
        for (uint256 i = 0; i < 20; i++) {
            address d = address(uint160(0xD00D + i));
            _deposit(batch, d, 1);
        }
        _warpPast(batch);
        // Attacker settles first; honest settle is then a no-op, not a revert.
        vm.prank(attacker);
        batch.settle();
        vm.prank(honest);
        batch.settle();
        assertTrue(curve.batchSettled());
        assertEq(curve.ethReserve(), batch.ethSpent() - (batch.ethSpent() * curve.tradeFeeBps()) / 10_000);
        vm.prank(honest);
        (uint256 t,) = batch.claim();
        assertGt(t, 0);
        // Dust depositors claim 0 tokens without reverting the batch for anyone.
        vm.prank(address(uint160(0xD00D)));
        batch.claim();
        token;
    }

    function test_SettleGriefing_OneWeiBatchRefundsAndOpens() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("OneWei", 0);
        // With the live 1-wei virtual token reserve, 1 wei of ETH still buys tokens, so
        // the zero-fill path is only reachable on curves with a large virtual token side.
        // Either way settle must not revert and the curve must open.
        _deposit(batch, attacker, 1);
        _warpPast(batch);
        batch.settle();
        assertTrue(curve.batchSettled());
        uint256 before = attacker.balance;
        vm.prank(attacker);
        (uint256 t, uint256 r) = batch.claim();
        assertEq(t + r > 0 || batch.tokensBought() == 0, true);
        assertEq(attacker.balance - before, r);
        token;
    }

    function test_SettleGriefing_TokenDonationToBatchIgnored() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("TokDonate", 0);
        _deposit(batch, honest, 0.1 ether);
        _warpPast(batch);
        batch.settle();
        // Someone buys and donates tokens to the batch: pro-rata math must not change.
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        uint256 got = curve.buy{value: 0.1 ether}(0);
        IERC20Min(token).transfer(address(batch), got);
        vm.stopPrank();
        vm.prank(honest);
        (uint256 t,) = batch.claim();
        assertEq(t, batch.tokensBought(), "donation changed the split");
    }

    // ================================================================ reentrancy

    function test_ClaimReentrancy_Blocked() public {
        (address token,, OpeningBatch batch) = _launch("Reenter", 0);
        ReentrantClaimer r = new ReentrantClaimer(batch);
        vm.deal(address(r), 0);
        vm.deal(address(this), 10 ether);
        r.deposit{value: 3 ether}(); // oversubscribed: claim sends an ETH refund
        _deposit(batch, honest, 3 ether);
        _warpPast(batch);
        batch.settle();
        r.claim();
        assertTrue(r.reentered(), "refund did not reach the attacker");
        assertFalse(r.reentrySucceeded(), "reentrant claim succeeded");
        (uint256 tHonestExpected, uint256 rHonestExpected) = batch.pending(honest);
        assertEq(_bal(token, address(r)), tHonestExpected, "attacker got more than its share");
        assertEq(address(r).balance, rHonestExpected, "attacker refund != share");
        vm.prank(honest);
        (uint256 tH, uint256 rH) = batch.claim();
        assertEq(tH, tHonestExpected);
        assertEq(rH, rHonestExpected);
    }

    // ================================================================ swap shapes

    /// Exact-in and exact-out, both directions, through an aggregator-style executor,
    /// during the tax window: every combo succeeds and the hook stays solvent.
    function test_AllSwapShapesDuringTax_HookSolvent() public {
        (address token, FairBondingCurve curve,) = _launch("Shapes", 0.2 ether);
        PoolKey memory key = _graduate(curve);
        PoolId id = key.toId();
        address t = makeAddr("shape-trader");
        vm.deal(t, 10 ether);
        vm.warp(block.timestamp + 30);

        uint256 dead0 = _bal(token, DEAD);
        // 1. exact-in buy: tax in tokens, burned now.
        vm.prank(t);
        agg.swap{value: 0.1 ether}(key, true, -0.1 ether, 0.1 ether);
        assertGt(_bal(token, DEAD), dead0, "exact-in buy tax not burned");
        // 2. exact-out buy: tax in ETH input, banked.
        uint256 bank0 = hook.bankedEth(id);
        vm.prank(t);
        agg.swap{value: 1 ether}(key, true, int256(1_000_000e18), 1 ether);
        assertGt(hook.bankedEth(id), bank0, "exact-out buy tax not banked");
        // 3. exact-in sell: tax in ETH output, banked.
        uint256 amt = _bal(token, t) / 4;
        bank0 = hook.bankedEth(id);
        vm.startPrank(t);
        IERC20Min(token).approve(address(agg), type(uint256).max);
        agg.swap(key, false, -int256(amt), amt);
        vm.stopPrank();
        assertGt(hook.bankedEth(id), bank0, "exact-in sell tax not banked");
        // 4. exact-out sell: tax in token input, burned now.
        uint256 dead1 = _bal(token, DEAD);
        uint256 maxIn = _bal(token, t);
        vm.prank(t);
        agg.swap(key, false, int256(0.01 ether), maxIn);
        assertGt(_bal(token, DEAD), dead1, "exact-out sell tax not burned");

        _assertHookSolvent(token, creator);
        // Same second as the swaps above: the sandwich guard refuses...
        vm.expectRevert();
        hook.burnBank(id, 0);
        // ...one second later it runs, capped at ~1% price impact per call.
        vm.warp(block.timestamp + 1);
        while (hook.bankedEth(id) > 0) {
            vm.warp(block.timestamp + 1);
            hook.burnBank(id, 0);
        }
        assertEq(hook.totalBanked(), 0);
        _assertHookSolvent(token, creator);
    }

    function testFuzz_HookSolventAcrossRandomSwaps(
        uint256 seed
    ) public {
        (address token, FairBondingCurve curve,) = _launch("FuzzSolv", 0.2 ether);
        PoolKey memory key = _graduate(curve);
        address t = makeAddr("fuzz-trader");
        vm.deal(t, 100 ether);
        vm.prank(t);
        IERC20Min(token).approve(address(agg), type(uint256).max);
        for (uint256 i = 0; i < 8; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (r % 60));
            bool buy = (r >> 8) % 2 == 0 || _bal(token, t) == 0;
            bool exactIn = (r >> 9) % 2 == 0;
            if (buy) {
                uint256 eth = 1e15 + (r >> 16) % 0.5 ether;
                vm.prank(t);
                if (exactIn) agg.swap{value: eth}(key, true, -int256(eth), eth);
                else agg.swap{value: 2 ether}(key, true, int256(1e18 + (r >> 32) % 1_000_000e18), 2 ether);
            } else {
                uint256 bal = _bal(token, t);
                uint256 amt = bal / 3 + 1;
                vm.prank(t);
                if (exactIn) {
                    agg.swap(key, false, -int256(amt), amt);
                } else {
                    // The executor only holds `bal`; a fill that needs more input reverts
                    // with InsufficientBalance (a sizing miss in the test, not the hook).
                    try agg.swap(key, false, int256(1e12 + (r >> 32) % 1e15), bal) {} catch {}
                }
            }
            _assertHookSolvent(token, creator);
        }
    }

    // ================================================================ token has no tax

    /// User decision 2026-10-19: Fair tokens carry no token tax. Wallet transfers move
    /// the exact amount, before and after graduation, and the token has no owner who
    /// could add one.
    function test_FairToken_HasNoTransferTax() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("NoTax", 0);
        _deposit(batch, honest, 0.2 ether);
        _warpPast(batch);
        batch.settle();
        vm.prank(honest);
        (uint256 t,) = batch.claim();
        address to = makeAddr("no-tax-to");
        vm.prank(honest);
        IERC20Min(token).transfer(to, t / 2);
        assertEq(_bal(token, to), t / 2, "pre-grad transfer taxed");
        _graduate(curve);
        vm.prank(honest);
        IERC20Min(token).transfer(to, t / 4);
        assertEq(_bal(token, to), t / 2 + t / 4, "post-grad transfer taxed");
        (, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        assertEq(abi.decode(ret, (address)), address(0));
    }

    receive() external payable {}
}
