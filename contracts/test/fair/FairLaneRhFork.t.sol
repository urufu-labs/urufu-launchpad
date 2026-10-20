// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IV4Router} from "v4-periphery/interfaces/IV4Router.sol";

import {DeployFairLane} from "script/DeployFairLane.s.sol";
import {AllowlistFairRehearsal} from "script/AllowlistFairRehearsal.s.sol";
import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairGraduator} from "src/fair/FairGraduator.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

import {FairTestBase, IERC20Min, AggregatorExecutor, LiquidityAdder} from "./FairTestBase.sol";

interface IPermit2 {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;
}

interface IUniversalRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

interface IV4SwapRouterLive {
    function swapExactETHForToken(
        PoolKey calldata key,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256);
    function swapExactTokenForETH(
        PoolKey calldata key,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256);
}

/// @title  FairLaneRhForkTest
/// @notice Fair lane on a fork of LIVE Robinhood Chain (4663). The lane is stood up by
///         the real deploy script (`DeployFairLane.runForTest`: pre-flight against the
///         live stack, HookMiner + canonical CREATE2 deployer), graduates into the live
///         v4 PoolManager, then is traded the way real users reach it:
///           * Uniswap app: live Universal Router, V4_SWAP with the RH struct
///             (`minHopPriceX36`), Permit2 paying the pool from the user. Exact-in and
///             exact-out, buy and sell.
///           * Aggregator executor: input pulled into the executor first, own unlock.
///             Exact-in and exact-out, buy and sell.
///           * The site's own live V4SwapRouter.
///         Robinhood caps a tx at 32M gas; every user-facing call asserts under it.
/// forge-config: default.isolate = true
contract FairLaneRhForkTest is FairTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant MAX_TX_GAS = 32_000_000;
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant V4_SWAP_ROUTER = 0xDb3D1C43225faEe04551b663E5aA0969937beEa4;
    address internal constant LIVE_MHH = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;

    address internal trader = makeAddr("fork-trader");
    address internal depositor = makeAddr("fork-depositor");

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }

        DeployFairLane script = new DeployFairLane();
        DeployFairLane.Deployed memory d = script.runForTest(admin);
        pm = IPoolManager(PM);
        hook = FairHookHost(payable(d.hook));
        graduator = FairGraduator(payable(d.graduator));
        factory = FairLaunchFactory(d.factory);
        platform = hook.platform();
        feeReceiver = factory.feeReceiver();
        agg = new AggregatorExecutor(pm);

        assertEq(platform, FairHookHost(payable(LIVE_MHH)).platform(), "Fair platform != live FeeSplitter");
        assertFalse(factory.launchesOpen(), "deploy must leave launches closed");
        vm.prank(admin);
        factory.setLaunchesOpen(true);
    }

    // ================================================================ helpers

    function _graduatedPool(
        string memory name
    ) internal returns (address token, PoolKey memory key) {
        FairBondingCurve curve;
        OpeningBatch batch;
        (token, curve, batch) = _launch(name, 0.2 ether);
        _deposit(batch, depositor, 1 ether);
        _warpPast(batch);
        uint256 g = gasleft();
        batch.settle();
        assertLt(g - gasleft(), MAX_TX_GAS, "settle over RH gas cap");
        vm.prank(depositor);
        batch.claim();
        g = gasleft();
        key = _graduate(curve);
        assertLt(g - gasleft(), MAX_TX_GAS, "graduating buy over RH gas cap");
    }

    function _approveUr(
        address who,
        address token
    ) internal {
        vm.startPrank(who);
        IERC20Min(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, UR, type(uint160).max, uint48(block.timestamp + 30 days));
        vm.stopPrank();
    }

    /// Uniswap app exact-in: V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].
    function _urExactIn(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256 gasUsed) {
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(cin, amountIn);
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        vm.prank(who);
        uint256 g = gasleft();
        IUniversalRouter(UR).execute{value: zeroForOne ? amountIn : 0}(hex"10", inputs, block.timestamp + 60);
        gasUsed = g - gasleft();
    }

    /// Uniswap app exact-out: V4_SWAP[SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL], then
    /// SWEEP leftover ETH back to the user on ETH-in swaps (the app's command order).
    function _urExactOut(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountOut,
        uint256 maxIn
    ) internal returns (uint256 gasUsed) {
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactOutputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountOut: uint128(amountOut),
                amountInMaximum: uint128(maxIn),
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(cin, maxIn);
        params[2] = abi.encode(cout, amountOut);
        bytes memory commands = zeroForOne ? bytes(hex"1004") : bytes(hex"10");
        bytes[] memory inputs = new bytes[](zeroForOne ? 2 : 1);
        inputs[0] = abi.encode(hex"080c0f", params);
        if (zeroForOne) inputs[1] = abi.encode(address(0), who, uint256(0));
        vm.prank(who);
        uint256 g = gasleft();
        IUniversalRouter(UR).execute{value: zeroForOne ? maxIn : 0}(commands, inputs, block.timestamp + 60);
        gasUsed = g - gasleft();
    }

    // ================================================================ graduation

    function test_Fork_DeployScriptPreflightAndWiring() public view {
        assertEq(uint160(address(hook)) & 0x3FFF, 0x28C4, "mined hook flags");
        assertEq(hook.initializer(), address(graduator));
        assertEq(address(hook.poolManager()), PM);
        assertEq(hook.taxStartBps(), 2000);
        assertEq(hook.taxDecaySecs(), 300);
        assertEq(hook.forfeitDropBps(), 1000);
        assertEq(hook.platformBps(), FairHookHost(payable(LIVE_MHH)).platformBps(), "platform bps drift vs token lane");
        assertEq(hook.creatorBps(), FairHookHost(payable(LIVE_MHH)).creatorBps(), "creator bps drift vs token lane");
        assertEq(graduator.fee(), 3000);
        assertEq(graduator.tickSpacing(), 60);
        assertEq(feeReceiver, platform, "curve fees and pool fees must both reach FeeSplitter");
    }

    function test_Fork_FullGraduationWithLivePoolManager() public {
        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("ForkGrad", 0.2 ether);
        _deposit(batch, depositor, 0.3 ether);
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
        assertGt(ethAmt, 0, "Graduated not emitted");
        PoolId id = key.toId();
        (uint160 sq,,,) = pm.getSlot0(id);
        assertGt(sq, 0, "pool not initialized on live PoolManager");
        assertGt(pm.getLiquidity(id), 0, "no liquidity");
        uint256 tokPerEthX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(uint256(sq), uint256(sq), 1 << 96), 1e18, 1 << 96
        );
        uint256 poolPrice = 1e36 / tokPerEthX18;
        uint256 marginal = ((vE + ethAmt) * 1e18) / (vT + tokAmt);
        uint256 diff = poolPrice > marginal ? poolPrice - marginal : marginal - poolPrice;
        assertLe(diff * 1000, marginal, "graduation cliff > 0.1%");
        emit log_named_uint("graduation cliff (ppm)", (diff * 1e6) / marginal);
        assertEq(address(graduator).balance, graduator.totalClaimable(), "unallocated ETH in graduator");
        assertEq(_bal(token, address(graduator)), 0, "tokens left in graduator");
        (,,,,,, bool configured, bool forfeited, uint256 baseline) = hook.pools(id);
        assertTrue(configured);
        assertFalse(forfeited);
        assertEq(baseline, _bal(token, creator), "baseline != creator balance");
        assertGt(baseline, 0);
    }

    // ================================================================ Uniswap app (Universal Router)

    function test_Fork_UniswapApp_ExactIn_BuyAndSell_DuringTax() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkUrIn");
        PoolId id = key.toId();
        vm.warp(block.timestamp + 60); // 16% tax
        vm.deal(trader, 5 ether);

        uint256 dead0 = _bal(token, DEAD);
        uint256 gBuy = _urExactIn(trader, key, true, 0.05 ether);
        uint256 got = _bal(token, trader);
        assertGt(got, 0, "UR exact-in buy delivered nothing");
        uint256 burned = _bal(token, DEAD) - dead0;
        // got = gross * (1 - 2% - 16%) ; burned = gross * 16%
        assertApproxEqRel(burned * 8200, got * 1600, 1e15, "buy tax != 16% of gross");
        assertLt(gBuy, MAX_TX_GAS);
        emit log_named_uint("gas: UR exact-in BUY", gBuy);

        _approveUr(trader, token);
        uint256 sell = got / 2;
        uint256 eth0 = trader.balance;
        uint256 pm0 = _bal(token, PM);
        uint256 gSell = _urExactIn(trader, key, false, sell);
        assertGt(trader.balance, eth0, "UR exact-in sell paid no ETH");
        assertEq(_bal(token, PM) - pm0, sell, "pool did not receive the full input");
        assertGt(hook.bankedEth(id), 0, "sell tax not banked");
        assertLt(gSell, MAX_TX_GAS);
        emit log_named_uint("gas: UR exact-in SELL", gSell);
        _assertHookSolvent(token, creator);
    }

    function test_Fork_UniswapApp_ExactOut_BuyAndSell_DuringTax() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkUrOut");
        PoolId id = key.toId();
        vm.warp(block.timestamp + 120);
        vm.deal(trader, 5 ether);

        // Exact-out buy: tax comes out of the ETH input and is banked.
        uint256 want = 1_000_000e18;
        uint256 eth0 = trader.balance;
        uint256 gBuy = _urExactOut(trader, key, true, want, 1 ether);
        assertEq(_bal(token, trader), want, "UR exact-out buy delivered wrong amount");
        uint256 spent = eth0 - trader.balance;
        assertLt(spent, 1 ether, "leftover ETH not swept back");
        uint256 banked = hook.bankedEth(id);
        assertGt(banked, 0, "exact-out buy tax not banked");
        assertLt(gBuy, MAX_TX_GAS);
        emit log_named_uint("gas: UR exact-out BUY", gBuy);

        // Exact-out sell: tax comes out of the token input and is burned.
        _approveUr(trader, token);
        uint256 dead0 = _bal(token, DEAD);
        uint256 tok0 = _bal(token, trader);
        eth0 = trader.balance;
        uint256 gSell = _urExactOut(trader, key, false, 0.001 ether, tok0);
        assertEq(trader.balance - eth0, 0.001 ether, "UR exact-out sell paid wrong ETH");
        assertLt(_bal(token, trader), tok0);
        assertGt(_bal(token, DEAD), dead0, "exact-out sell tax not burned");
        assertLt(gSell, MAX_TX_GAS);
        emit log_named_uint("gas: UR exact-out SELL", gSell);
        _assertHookSolvent(token, creator);
    }

    function test_Fork_UniswapApp_AfterTax_NormalFeesOnly() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkUrNoTax");
        vm.warp(block.timestamp + 301);
        vm.deal(trader, 1 ether);
        uint256 dead0 = _bal(token, DEAD);
        _urExactIn(trader, key, true, 0.05 ether);
        assertEq(_bal(token, DEAD), dead0, "tax after window");
        uint256 got = _bal(token, trader);
        uint256 gross = (got * 10_000) / 9800;
        assertApproxEqRel(hook.owed(Currency.wrap(token), platform), gross / 100, 1e15, "platform fee != 1%");
        assertApproxEqRel(_creatorEarned(token, false), gross / 100, 1e15, "creator fee != 1%");
        // FeeSplitter (no claim fn) gets its share via the permissionless push.
        uint256 p0 = _bal(token, platform);
        hook.pushOwed(Currency.wrap(token), platform);
        assertGt(_bal(token, platform), p0, "pushOwed did not reach FeeSplitter");
    }

    // ================================================================ aggregator executor

    function test_Fork_Aggregator_AllFourShapes() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkAgg");
        PoolId id = key.toId();
        vm.warp(block.timestamp + 30);
        vm.deal(trader, 5 ether);

        vm.prank(trader);
        (, uint256 outBuyIn) = agg.swap{value: 0.05 ether}(key, true, -0.05 ether, 0.05 ether);
        assertGt(outBuyIn, 0, "agg exact-in buy");

        uint256 bank0 = hook.bankedEth(id);
        vm.prank(trader);
        (, uint256 outBuyOut) = agg.swap{value: 1 ether}(key, true, int256(500_000e18), 1 ether);
        assertEq(outBuyOut, 500_000e18, "agg exact-out buy amount");
        assertGt(hook.bankedEth(id), bank0, "agg exact-out buy tax not banked");

        vm.prank(trader);
        IERC20Min(token).approve(address(agg), type(uint256).max);
        uint256 sell = _bal(token, trader) / 3;
        uint256 eth0 = trader.balance;
        vm.prank(trader);
        agg.swap(key, false, -int256(sell), sell);
        assertGt(trader.balance, eth0, "agg exact-in sell");

        uint256 dead0 = _bal(token, DEAD);
        eth0 = trader.balance;
        uint256 bal = _bal(token, trader);
        vm.prank(trader);
        agg.swap(key, false, int256(0.0005 ether), bal);
        assertEq(trader.balance - eth0, 0.0005 ether, "agg exact-out sell amount");
        assertGt(_bal(token, DEAD), dead0, "agg exact-out sell tax not burned");
        _assertHookSolvent(token, creator);
    }

    // ================================================================ site router + bank

    function test_Fork_SiteV4SwapRouter_BuySell_ThenBurnBank() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkSite");
        PoolId id = key.toId();
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 got = IV4SwapRouterLive(V4_SWAP_ROUTER).swapExactETHForToken{value: 0.05 ether}(
            key, 0, trader, block.timestamp + 60
        );
        assertGt(got, 0);
        vm.startPrank(trader);
        IERC20Min(token).approve(V4_SWAP_ROUTER, got);
        uint256 out = IV4SwapRouterLive(V4_SWAP_ROUTER).swapExactTokenForETH(key, got, 0, trader, block.timestamp + 60);
        vm.stopPrank();
        assertGt(out, 0);
        uint256 banked = hook.bankedEth(id);
        assertGt(banked, 0, "site sell during tax banked nothing");

        vm.warp(block.timestamp + 1); // burnBank refuses in the same second as a big move
        uint256 dead0 = _bal(token, DEAD);
        address keeper = makeAddr("fork-keeper");
        vm.prank(keeper);
        uint256 g = gasleft();
        uint256 burned = hook.burnBank(id, 1);
        assertLt(g - gasleft(), MAX_TX_GAS);
        assertEq(_bal(token, DEAD) - dead0, burned, "bank burn did not reach 0xdEaD");
        assertEq(hook.bankedEth(id), 0);
        _assertHookSolvent(token, creator);
    }

    function test_Fork_CreatorTransferForfeits_UniswapAppSwapFlipsIt() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkForfeit");
        PoolId id = key.toId();
        vm.warp(block.timestamp + 301);
        uint256 bal = _bal(token, creator);
        address fresh = makeAddr("fork-fresh");
        vm.prank(creator);
        IERC20Min(token).transfer(fresh, bal / 5);
        vm.deal(trader, 1 ether);
        _urExactIn(trader, key, true, 0.01 ether);
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "UR swap after creator transfer did not forfeit");
        uint256 owed = _creatorEarned(token, false);
        _urExactIn(trader, key, true, 0.01 ether);
        assertEq(_creatorEarned(token, false), owed, "creator accrued after forfeit");
    }

    function test_Fork_ThirdPartyLiquidityLockedDuringTax_LivePoolManager() public {
        (, PoolKey memory key) = _graduatedPool("ForkLpLock");
        LiquidityAdder lp = new LiquidityAdder(pm);
        vm.deal(address(lp), 10 ether);
        vm.expectRevert();
        lp.addEthAbovePrice(key, 1e15);
        vm.warp(block.timestamp + 300);
        lp.addEthAbovePrice(key, 1e15);
    }

    /// The Uniswap app pays the pool AFTER the swap (Permit2 in SETTLE_ALL), so the hook
    /// sees the creator's full balance during the dump. The dump's fee must sit pending
    /// and be burned by the next transaction's check, never paid to the creator.
    function test_Fork_CreatorDumpViaUniswapApp_FeeClawedBack() public {
        (address token, PoolKey memory key) = _graduatedPool("ForkClawback");
        PoolId id = key.toId();
        vm.warp(vm.getBlockTimestamp() + 301);
        _approveUr(creator, token);
        _urExactIn(creator, key, false, _bal(token, creator) / 2);
        (uint128 pEth,,,) = hook.creatorFees(id);
        assertGt(pEth, 0, "dump fee should be pending");
        (,,,,,,, bool forfeitedYet,) = hook.pools(id);
        assertFalse(forfeitedYet);

        uint256 bank0 = hook.bankedEth(id);
        vm.deal(trader, 1 ether);
        _urExactIn(trader, key, true, 0.01 ether);
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "dump via Uniswap app not caught");
        assertEq(_creatorEarned(token, true), 0, "dump fee reached the creator");
        assertGe(hook.bankedEth(id) - bank0, pEth, "dump fee not burned");
        _assertHookSolvent(token, creator);
    }

    /// The Uniswap allowlist rehearsal, both phases, on live Robinhood: a tiny pool on
    /// the real deploy's FairHookHost, defaults and the launch gate restored after.
    function test_Fork_AllowlistRehearsal_TwoPhases() public {
        vm.prank(admin);
        factory.setLaunchesOpen(false);
        uint256 target0 = factory.defaultGraduationTargetEth();
        uint32 window0 = factory.batchWindowSecs();
        uint16 cap0 = factory.batchCapBps();

        AllowlistFairRehearsal r = new AllowlistFairRehearsal();
        vm.deal(admin, 1 ether);
        vm.deal(address(r), 1 ether);
        address token = r.phase1ForTest(factory, admin);
        assertEq(factory.defaultGraduationTargetEth(), target0, "target not restored");
        assertEq(factory.batchWindowSecs(), window0, "window not restored");
        assertEq(factory.batchCapBps(), cap0, "cap not restored");
        assertFalse(factory.launchesOpen(), "launch gate not restored");
        assertEq(FairBondingCurve(payable(factory.curveFor(token))).graduationTargetEth(), 0.001 ether);

        // Phase 2 before the window closes must refuse.
        vm.expectRevert(bytes("batch window still open, wait and rerun"));
        r.phase2ForTest(factory, token, admin);

        vm.warp(vm.getBlockTimestamp() + 11);
        PoolId id = r.phase2ForTest(factory, token, admin);
        (uint160 sq,,,) = pm.getSlot0(id);
        assertGt(sq, 0, "rehearsal pool not initialized on the live PoolManager");
        assertGt(pm.getLiquidity(id), 0);
        (address pToken,,,,,, bool configured,,) = hook.pools(id);
        assertEq(pToken, token);
        assertTrue(configured);
        (uint160 refSqrt, uint64 refTs) = hook.priceRef(id);
        assertGt(refSqrt, 0, "post-graduation swap did not reach the hook");
        assertGt(refTs, 0);
    }
}
