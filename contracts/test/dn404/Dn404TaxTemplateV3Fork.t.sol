// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404TaxTemplate} from "src/dn404/Dn404TaxTemplate.sol";
import {Dn404TaxTemplateV2} from "src/dn404/Dn404TaxTemplateV2.sol";
import {Dn404TaxTemplateV3} from "src/dn404/Dn404TaxTemplateV3.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20 {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

interface IDn404Skip {
    function setSkipNFT(
        bool
    ) external returns (bool);
}

interface IV10Curve {
    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256);
    function graduated() external view returns (bool);
    function graduationTargetEth() external view returns (uint256);
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
}

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

interface IHookLedger {
    function owed(
        Currency currency,
        address account
    ) external view returns (uint256);
    function platform() external view returns (address);
    function creator() external view returns (address);
    function creators(
        PoolId id
    ) external view returns (address);
}

/// Robinhood's Universal Router decodes the NEWER v4-periphery struct, with
/// `minHopPriceX36` between amountOutMinimum and hookData
/// (reference_v4_ur_struct_divergence memory; web/src/lib/v4Erc20Swap.ts).
struct RhExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// @title  Dn404TaxTemplateV3ForkTest
/// @notice Proves Dn404TaxTemplateV3 (V2 + untaxed transfers INTO the v4
///         PoolManager) on the LIVE Robinhood stack: V3 is deployed in-test and
///         bound to the live Dn404LaunchFactory via setBaseTaxImpl (pranked as
///         its owner). Uniswap-app-style sells (Universal Router normal order,
///         Permit2 pays the pool straight from the user) now succeed and are
///         untaxed; buys and wallet transfers stay taxed.
///
///         Gas: Robinhood caps a tx at 32,000,000 gas; the graduating whale opts
///         out of NFTs and every user-facing call asserts < 32M.
contract Dn404TaxTemplateV3ForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant MAX_TX_GAS = 32_000_000;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes32 internal constant GRADUATED_V3_TOPIC0 =
        keccak256("Graduated(address,address,uint256,uint256,uint160,uint128)");
    bytes32 internal constant DN404_GRADUATED_TOPIC0 =
        keccak256("Dn404Graduated(address,address,address,uint256,uint256,uint160,uint128)");

    Dn404LaunchFactory internal lf;
    Dn404CurveFactory internal dn404Cf;
    address internal gradEth;
    address internal gradPair;
    address internal hookEth;
    address internal hookPair;
    Dn404TaxTemplateV3 internal v3;

    address internal launcher;
    address internal whale; // graduating buyer, NFTs off
    address internal trader; // post-grad user, NFTs on
    address internal keeper;

    function setUp() public {
        // The deployment-*.json address books are gitignored, so CI (and any fresh
        // clone) has none. Skip there instead of failing setUp; run these locally.
        if (
            !vm.exists("deployment-dn404.4663.json") || !vm.exists("deployment-live-rh.4663.json")
                || !vm.exists("deployment-flywheel.4663.json") || !vm.exists("deployment.4663.json")
                || !vm.exists("deployment-nft.4663.json")
        ) {
            vm.skip(true);
            return;
        }
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != 4663) vm.skip(true);

        string memory j = vm.readFile("deployment-dn404.4663.json");
        lf = Dn404LaunchFactory(vm.parseJsonAddress(j, ".Dn404LaunchFactory"));
        dn404Cf = Dn404CurveFactory(vm.parseJsonAddress(j, ".Dn404CurveFactory"));
        gradPair = vm.parseJsonAddress(j, ".Dn404Graduator");
        hookPair = vm.parseJsonAddress(j, ".Dn404MultiHookHost");
        string memory live = vm.readFile("deployment-live-rh.4663.json");
        gradEth = vm.parseJsonAddress(live, ".graduator");
        hookEth = vm.parseJsonAddress(live, ".multiHookHost");

        v3 = new Dn404TaxTemplateV3(gradEth, gradPair, hookEth, hookPair, PM);
        vm.prank(DEPLOYER);
        lf.setBaseTaxImpl(address(v3), keccak256(address(v3).code));
        assertEq(lf.baseTaxImpl(), address(v3));

        keeper = lf.taxKeeper();
        launcher = makeAddr("v3-launcher");
        whale = makeAddr("v3-whale");
        trader = makeAddr("v3-trader");
        assertTrue(launcher != keeper, "launcher must not be the keeper for these tests");

        vm.prank(DEPLOYER);
        IErc20(URU).transfer(launcher, 50_000e18);
    }

    // ================================================================ helpers

    function _launch(
        string memory name,
        address pair,
        Dn404TaxTemplate.TaxMode mode
    ) internal returns (address base, address curve) {
        uint256 fee = lf.minUruFeeFor(launcher);
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = name;
        p.ticker = "TAXV3";
        p.baseURI = "ipfs://v3/";
        p.contractURI = "ipfs://v3/collection.json";
        p.collectionSize = 8000;
        p.unit = 100_000;
        p.pairCurrency = pair;
        p.taxMode = uint8(mode);
        p.taxBps = 100;
        p.uruAmount = fee;
        vm.startPrank(launcher);
        IErc20(URU).approve(address(lf), fee);
        (base,, curve) = lf.launch(p);
        vm.stopPrank();
        assertEq(Dn404TaxTemplateV3(payable(base)).POOL_MANAGER(), PM, "clone not on V3 impl");
        assertEq(Dn404TaxTemplateV3(payable(base)).GRADUATOR_ETH(), gradEth, "V3 lost V2 graduator exemption");
    }

    function _key(
        address a,
        address b,
        address hook
    ) internal pure returns (PoolKey memory k) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        k = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3000, tickSpacing: 60, hooks: IHooks(hook)
        });
    }

    function _approveUr(
        address who,
        address token
    ) internal {
        vm.startPrank(who);
        IErc20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(token, UR, type(uint160).max, uint48(block.timestamp + 30 days));
        vm.stopPrank();
    }

    function _swapParams(
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn
    ) internal pure returns (bytes memory) {
        return abi.encode(
            RhExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
    }

    /// Normal exact-in order: SWAP(amountIn), SETTLE_ALL(in), TAKE_ALL(out).
    function _normalSwap(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn,
        uint256 value
    ) internal returns (uint256 gasUsed) {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        Currency cout = zeroForOne ? key.currency1 : key.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = _swapParams(key, zeroForOne, uint128(amountIn));
        params[1] = abi.encode(cin, amountIn);
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        vm.prank(who);
        uint256 g = gasleft();
        IUniversalRouter(UR).execute{value: value}(hex"10", inputs, block.timestamp + 60);
        gasUsed = g - gasleft();
    }

    /// Fee-on-transfer-safe exact-in order: SETTLE(in, amount, payerIsUser)
    /// first so the PoolManager credits what ACTUALLY arrived, then swap the
    /// open credit (amountIn = OPEN_DELTA = 0), then TAKE_ALL(out).
    function _fotSell(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256 gasUsed) {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        Currency cout = zeroForOne ? key.currency1 : key.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(cin, amountIn, true);
        params[1] = _swapParams(key, zeroForOne, 0);
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"0b060f", params);
        vm.prank(who);
        uint256 g = gasleft();
        IUniversalRouter(UR).execute(hex"10", inputs, block.timestamp + 60);
        gasUsed = g - gasleft();
    }

    function _assertHookSolvent(
        address hook,
        address token,
        PoolKey memory key
    ) internal view {
        IHookLedger h = IHookLedger(hook);
        address creatorAddr = h.creators(key.toId());
        if (creatorAddr == address(0)) creatorAddr = h.creator();
        uint256 owedTotal = h.owed(Currency.wrap(token), h.platform()) + h.owed(Currency.wrap(token), creatorAddr);
        assertGt(owedTotal, 0, "hook booked no token fee (test not exercising the take path)");
        assertGe(IErc20(token).balanceOf(hook), owedTotal, "hook INSOLVENT in launch token: take() was taxed");
    }

    function _noCliff(
        uint256 virtPair,
        uint256 virtTok,
        uint256 pairAmt,
        uint256 tokAmt,
        bool pairIsC0,
        uint160 sq
    ) internal {
        uint256 curvePriceX18 = ((virtPair + pairAmt) * 1e18) / (virtTok + tokAmt);
        uint256 poolPriceX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(uint256(sq), uint256(sq), 1 << 96), 1e18, 1 << 96
        );
        uint256 expected = pairIsC0 ? (1e36 / curvePriceX18) : curvePriceX18;
        uint256 diff = poolPriceX18 > expected ? poolPriceX18 - expected : expected - poolPriceX18;
        assertLe(diff * 100, expected, "CLIFF at taxed graduation");
        emit log_named_uint("no-cliff deviation bps", (diff * 10_000) / expected);
    }

    function _graduateEth(
        string memory name,
        Dn404TaxTemplate.TaxMode mode
    ) internal returns (address base, PoolKey memory key) {
        address curve;
        (base, curve) = _launch(name, address(0), mode);
        IV10Curve c = IV10Curve(curve);
        uint256 target = c.graduationTargetEth();
        uint256 virtEth = c.virtualEthReserve();
        uint256 virtTok = c.virtualTokenReserve();
        vm.deal(whale, target * 2);
        vm.prank(whale);
        IDn404Skip(base).setSkipNFT(true);
        vm.recordLogs();
        vm.prank(whale);
        uint256 g = gasleft();
        c.buy{value: (target * 125) / 100}(0);
        uint256 gradGas = g - gasleft();
        assertTrue(c.graduated(), "taxed ETH curve did not graduate on V3");
        assertLt(gradGas, MAX_TX_GAS, "graduating buy over Robinhood tx gas cap");
        emit log_named_uint("gas: graduating buy (ETH pair)", gradGas);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 ethAmt;
        uint256 tokAmt;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == gradEth && logs[i].topics[0] == GRADUATED_V3_TOPIC0) {
                (ethAmt, tokAmt,,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint128));
            }
        }
        assertGt(tokAmt, 0, "GraduatorV3 Graduated not seen");
        key = _key(address(0), base, hookEth);
        (uint160 sq,,,) = IPoolManager(PM).getSlot0(key.toId());
        assertGt(sq, 0, "pool not initialized");
        assertGt(IPoolManager(PM).getLiquidity(key.toId()), 0, "no liquidity");
        _noCliff(virtEth, virtTok, ethAmt, tokAmt, true, sq);
    }

    function _graduateUru() internal returns (address base, address curve, PoolKey memory key) {
        uint256 supply = dn404Cf.defaultCurveSupply();
        uint256 virtTok = dn404Cf.defaultVirtualTokenReserve();
        uint16 feeBps = dn404Cf.defaultTradeFeeBps();
        vm.prank(DEPLOYER);
        dn404Cf.setDefaults(supply, virtTok, 5000e18, 4000e18, feeBps);

        (base, curve) = _launch("V3 URU Buyback", URU, Dn404TaxTemplate.TaxMode.BuybackURU);
        Dn404BondingCurve c = Dn404BondingCurve(curve);
        uint256 amt = (c.graduationTargetEth() * 125) / 100;
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(whale, amt);
        vm.startPrank(whale);
        IDn404Skip(base).setSkipNFT(true);
        IErc20(URU).approve(curve, amt);
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(whale);
        uint256 g = gasleft();
        c.buy(amt, 0);
        uint256 gradGas = g - gasleft();
        assertTrue(c.graduated(), "taxed URU curve did not graduate on V3");
        assertLt(gradGas, MAX_TX_GAS);
        emit log_named_uint("gas: graduating buy (URU pair)", gradGas);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 pairAmt;
        uint256 tokAmt;
        address hook;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == gradPair && logs[i].topics[0] == DN404_GRADUATED_TOPIC0) {
                hook = address(uint160(uint256(logs[i].topics[3])));
                (pairAmt, tokAmt,,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint128));
            }
        }
        assertEq(hook, hookPair, "URU graduation not on DN404 host");
        key = _key(base, URU, hookPair);
        (uint160 sq,,,) = IPoolManager(PM).getSlot0(key.toId());
        assertGt(sq, 0, "pool not initialized");
        _noCliff(c.virtualEthReserve(), c.virtualTokenReserve(), pairAmt, tokAmt, URU < base, sq);
    }

    // ================================================================ a + b + c + d: ETH pair, BurnDead

    function test_V3_EthPair_BurnDead_UniswapAppSellWorksUntaxed() public {
        (address base, PoolKey memory key) = _graduateEth("V3 ETH BurnDead", Dn404TaxTemplate.TaxMode.BurnDead);

        // c. Uniswap-app-style BUY (normal order): succeeds and IS taxed (PM -> buyer).
        vm.deal(trader, 1 ether);
        uint256 deadBefore = IErc20(base).balanceOf(DEAD);
        uint256 buyGas = _normalSwap(trader, key, true, 0.001 ether, 0.001 ether);
        uint256 got = IErc20(base).balanceOf(trader);
        assertGt(got, 0, "post-grad buy delivered nothing");
        uint256 burnedOnBuy = IErc20(base).balanceOf(DEAD) - deadBefore;
        assertGt(burnedOnBuy, 0, "buy was not taxed");
        assertApproxEqAbs(burnedOnBuy * 9900, got * 100, got / 1e6 + 1e6, "buy tax != 1% of gross");
        assertLt(buyGas, MAX_TX_GAS);
        emit log_named_uint("gas: UR normal-order BUY (ETH pool)", buyGas);
        _assertHookSolvent(hookEth, base, key);

        // b. Uniswap-app-style SELL (normal order: SWAP, SETTLE_ALL, TAKE_ALL;
        //    Permit2 pays the pool from the user): succeeds and is UNTAXED.
        _approveUr(trader, base);
        uint256 sellAmt = got / 2;
        deadBefore = IErc20(base).balanceOf(DEAD);
        uint256 pmBefore = IErc20(base).balanceOf(PM);
        uint256 ethBefore = trader.balance;
        uint256 sellGas = _normalSwap(trader, key, false, sellAmt, 0);
        assertGt(trader.balance, ethBefore, "normal-order sell paid no ETH");
        assertEq(IErc20(base).balanceOf(DEAD), deadBefore, "normal-order sell was taxed");
        assertEq(IErc20(base).balanceOf(trader), got - sellAmt, "seller lost more than amountIn");
        // Pool received the full input (hook takes its fee on the ETH side for sells).
        assertEq(IErc20(base).balanceOf(PM) - pmBefore, sellAmt, "pool did not receive full input");
        assertLt(sellGas, MAX_TX_GAS);
        emit log_named_uint("gas: UR normal-order SELL (ETH pool)", sellGas);

        // d. The web's settle-first sell still works (and is also untaxed now).
        uint256 rest = IErc20(base).balanceOf(trader) / 2;
        ethBefore = trader.balance;
        deadBefore = IErc20(base).balanceOf(DEAD);
        uint256 fotGas = _fotSell(trader, key, false, rest);
        assertGt(trader.balance, ethBefore, "settle-first sell paid no ETH");
        assertEq(IErc20(base).balanceOf(DEAD), deadBefore, "settle-first sell was taxed");
        emit log_named_uint("gas: UR settle-first SELL (ETH pool)", fotGas);
    }

    // ================================================================ a + b + c + d + e: URU pair, BuybackURU

    function test_V3_UruPair_BuybackUru_UniswapAppSellWorksUntaxed_KeeperSells() public {
        (address base,, PoolKey memory key) = _graduateUru();
        Dn404TaxTemplateV3 t = Dn404TaxTemplateV3(payable(base));
        bool tokenIsC0 = Currency.unwrap(key.currency0) == base;

        // c. BUY (URU -> token), normal order: taxed, accumulates.
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(trader, 1000e18);
        _approveUr(trader, URU);
        uint256 accBefore = t.accumulatedTax();
        uint256 buyGas = _normalSwap(trader, key, !tokenIsC0, 100e18, 0);
        uint256 got = IErc20(base).balanceOf(trader);
        assertGt(got, 0, "post-grad buy delivered nothing");
        assertGt(t.accumulatedTax(), accBefore, "buy was not taxed");
        assertLt(buyGas, MAX_TX_GAS);
        emit log_named_uint("gas: UR normal-order BUY (URU pool)", buyGas);
        _assertHookSolvent(hookPair, base, key);

        // b. Normal-order SELL: succeeds and is untaxed.
        _approveUr(trader, base);
        uint256 sellAmt = got / 2;
        accBefore = t.accumulatedTax();
        uint256 uruBefore = IErc20(URU).balanceOf(trader);
        uint256 sellGas = _normalSwap(trader, key, tokenIsC0, sellAmt, 0);
        assertGt(IErc20(URU).balanceOf(trader), uruBefore, "normal-order sell paid no URU");
        assertEq(t.accumulatedTax(), accBefore, "normal-order sell was taxed");
        assertEq(IErc20(base).balanceOf(trader), got - sellAmt, "seller lost more than amountIn");
        assertLt(sellGas, MAX_TX_GAS);
        emit log_named_uint("gas: UR normal-order SELL (URU pool)", sellGas);

        // d. Settle-first sell still works.
        uint256 rest = IErc20(base).balanceOf(trader) / 2;
        uruBefore = IErc20(URU).balanceOf(trader);
        uint256 fotGas = _fotSell(trader, key, tokenIsC0, rest);
        assertGt(IErc20(URU).balanceOf(trader), uruBefore, "settle-first sell paid no URU");
        assertEq(t.accumulatedTax(), accBefore, "settle-first sell was taxed");
        emit log_named_uint("gas: UR settle-first SELL (URU pool)", fotGas);

        // e. Keeper sweeps (5% fee) and sells with the normal order, untaxed.
        uint256 swept = t.accumulatedTax();
        assertGt(swept, 0, "nothing accrued to sweep");
        address treasury = t.keeperTreasury();
        uint256 treasuryBefore = IErc20(base).balanceOf(treasury);
        uint256 keeperBefore = IErc20(base).balanceOf(keeper);
        vm.prank(keeper);
        (uint256 net, uint256 fee) = t.sweepAccumulated(keeper, swept);
        assertEq(fee, (swept * 500) / 10_000, "keeper fee != 5%");
        if (treasury == keeper) {
            assertEq(IErc20(base).balanceOf(keeper) - keeperBefore, swept);
        } else {
            assertEq(IErc20(base).balanceOf(keeper) - keeperBefore, net);
            assertEq(IErc20(base).balanceOf(treasury) - treasuryBefore, fee);
        }
        _approveUr(keeper, base);
        uint256 keeperUruBefore = IErc20(URU).balanceOf(keeper);
        _normalSwap(keeper, key, tokenIsC0, net, 0);
        assertGt(IErc20(URU).balanceOf(keeper), keeperUruBefore, "keeper sell paid no URU");
        assertEq(t.accumulatedTax(), 0, "keeper sell was taxed");
    }

    // ================================================================ e: wallet transfers still taxed

    function test_V3_WalletTransfer_TaxAndSweepUnchanged() public {
        (address base, address curve) = _launch("V3 Regression", address(0), Dn404TaxTemplate.TaxMode.BuybackURU);
        Dn404TaxTemplateV3 t = Dn404TaxTemplateV3(payable(base));
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        IV10Curve(curve).buy{value: 0.01 ether}(0);
        uint256 bal = IErc20(base).balanceOf(trader);
        assertGt(bal, 0);
        assertEq(t.accumulatedTax(), 0, "curve buy should be untaxed (curve exempt)");

        address other = makeAddr("v3-other");
        uint256 amt = bal / 3;
        vm.prank(trader);
        IErc20(base).transfer(other, amt);
        uint256 tax = (amt * 100) / 10_000;
        assertEq(IErc20(base).balanceOf(other), amt - tax, "net != amount - 1%");
        assertEq(t.accumulatedTax(), tax, "tax did not accumulate");

        vm.prank(keeper);
        (uint256 net, uint256 fee) = t.sweepAccumulated(keeper, tax);
        assertEq(fee, (tax * 500) / 10_000, "keeper fee != 5%");
        assertEq(net + fee, tax);
        assertEq(t.accumulatedTax(), 0);

        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotKeeper.selector);
        t.sweepAccumulated(launcher, 1);
    }

    // ================================================================ f: aggregator-style first hop

    /// Aggregators that first pull the seller's tokens into THEIR OWN contract
    /// (wallet -> router), then pay the pool, are still taxed on that first hop:
    /// the router holds `amount - tax` while it expects `amount`. V3 only fixes
    /// paths that pay the PoolManager directly from the user (Uniswap app /
    /// Universal Router via Permit2). This test pins that boundary.
    function test_V3_AggregatorFirstHopStillTaxed() public {
        (address base,, PoolKey memory key) = _graduateUru();
        Dn404TaxTemplateV3 t = Dn404TaxTemplateV3(payable(base));
        bool tokenIsC0 = Currency.unwrap(key.currency0) == base;
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(trader, 1000e18);
        _approveUr(trader, URU);
        _normalSwap(trader, key, !tokenIsC0, 100e18, 0);
        uint256 amt = IErc20(base).balanceOf(trader) / 2;

        address aggregatorRouter = makeAddr("v3-aggregator-router");
        uint256 accBefore = t.accumulatedTax();
        vm.prank(trader);
        IErc20(base).transfer(aggregatorRouter, amt);
        uint256 tax = (amt * 100) / 10_000;
        assertEq(IErc20(base).balanceOf(aggregatorRouter), amt - tax, "router-held amount should be short by the tax");
        assertEq(t.accumulatedTax() - accBefore, tax, "first hop should be taxed");
        assertTrue(aggregatorRouter != PM);
    }
}
