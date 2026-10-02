// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404TaxTemplate} from "src/dn404/Dn404TaxTemplate.sol";
import {Dn404TaxTemplateV2} from "src/dn404/Dn404TaxTemplateV2.sol";
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

/// @title  Dn404TaxTemplateV2ForkTest
/// @notice Proves Dn404TaxTemplateV2 fixes taxed-DN404 graduation and keeps
///         taxed post-graduation trading working, on the LIVE Robinhood stack:
///         V2 is deployed in-test and bound to the live Dn404LaunchFactory via
///         setBaseTaxImpl (pranked as its owner). The launcher is a fresh
///         wallet (NOT the keeper), so launcher-exemption can't mask anything.
///
///         Gas: Robinhood caps a tx at 32,000,000 gas (ArbGasInfo
///         maxTxGasLimit) and each mirror NFT minted costs ~11.5k gas, so the
///         big graduating buyer opts out of NFTs (setSkipNFT) and every
///         user-facing call asserts < 32M.
contract Dn404TaxTemplateV2ForkTest is Test {
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
    Dn404TaxTemplateV2 internal v2;

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

        v2 = new Dn404TaxTemplateV2(gradEth, gradPair, hookEth, hookPair);
        vm.prank(DEPLOYER);
        lf.setBaseTaxImpl(address(v2), keccak256(address(v2).code));
        assertEq(lf.baseTaxImpl(), address(v2));

        keeper = lf.taxKeeper();
        launcher = makeAddr("v2-launcher");
        whale = makeAddr("v2-whale");
        trader = makeAddr("v2-trader");
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
        p.ticker = "TAXV2";
        p.baseURI = "ipfs://v2/";
        p.contractURI = "ipfs://v2/collection.json";
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
        assertEq(Dn404TaxTemplateV2(payable(base)).GRADUATOR_ETH(), gradEth, "clone not on V2 impl");
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

    // ================================================================ a + c: ETH pair, BurnDead

    function test_V2_EthPair_BurnDead_GraduatesAndTrades() public {
        (address base, address curve) = _launch("V2 ETH BurnDead", address(0), Dn404TaxTemplate.TaxMode.BurnDead);
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
        assertTrue(c.graduated(), "taxed ETH curve did not graduate on V2");
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

        PoolKey memory key = _key(address(0), base, hookEth);
        (uint160 sq,,,) = IPoolManager(PM).getSlot0(key.toId());
        assertGt(sq, 0, "pool not initialized");
        assertGt(IPoolManager(PM).getLiquidity(key.toId()), 0, "no liquidity");
        _noCliff(virtEth, virtTok, ethAmt, tokAmt, true, sq);

        // ---- post-grad BUY (ETH -> token) by a non-exempt trader: taxed on PM -> trader.
        vm.deal(trader, 1 ether);
        uint256 deadBefore = IErc20(base).balanceOf(DEAD);
        uint256 buyGas = _normalSwap(trader, key, true, 0.001 ether, 0.001 ether);
        uint256 got = IErc20(base).balanceOf(trader);
        assertGt(got, 0, "post-grad buy delivered nothing");
        uint256 burnedOnBuy = IErc20(base).balanceOf(DEAD) - deadBefore;
        assertGt(burnedOnBuy, 0, "buy was not taxed");
        assertApproxEqAbs(burnedOnBuy * 9900, got * 100, got / 1e6 + 1e6, "buy tax != 1% of gross");
        assertLt(buyGas, MAX_TX_GAS);
        emit log_named_uint("gas: post-grad buy (ETH pool)", buyGas);

        // Hook took its token fee PM -> hook on that buy; it must be solvent.
        _assertHookSolvent(hookEth, base, key);

        // ---- post-grad SELL (token -> ETH), naive order: must revert (settle shortfall).
        _approveUr(trader, base);
        uint256 sellAmt = got / 2;
        vm.expectRevert();
        this.externalNormalSwap(trader, key, false, sellAmt);

        // ---- post-grad SELL, fee-on-transfer-safe order: works, is taxed.
        deadBefore = IErc20(base).balanceOf(DEAD);
        uint256 ethBefore = trader.balance;
        uint256 sellGas = _fotSell(trader, key, false, sellAmt);
        assertGt(trader.balance, ethBefore, "FOT sell paid no ETH");
        assertEq(IErc20(base).balanceOf(DEAD) - deadBefore, (sellAmt * 100) / 10_000, "sell tax != 1%");
        assertLt(sellGas, MAX_TX_GAS);
        emit log_named_uint("gas: post-grad FOT sell (ETH pool)", sellGas);
    }

    /// External wrapper so vm.expectRevert can target exactly one call.
    function externalNormalSwap(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) external {
        _normalSwap(who, key, zeroForOne, amountIn, 0);
    }

    // ================================================================ b + c + d: URU pair, BuybackURU

    function _graduateUru() internal returns (address base, address curve, PoolKey memory key) {
        uint256 supply = dn404Cf.defaultCurveSupply();
        uint256 virtTok = dn404Cf.defaultVirtualTokenReserve();
        uint16 feeBps = dn404Cf.defaultTradeFeeBps();
        vm.prank(DEPLOYER);
        dn404Cf.setDefaults(supply, virtTok, 5000e18, 4000e18, feeBps);

        (base, curve) = _launch("V2 URU Buyback", URU, Dn404TaxTemplate.TaxMode.BuybackURU);
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
        assertTrue(c.graduated(), "taxed URU curve did not graduate on V2");
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

    function test_V2_UruPair_BuybackUru_GraduatesTradesAndKeeperSells() public {
        (address base,, PoolKey memory key) = _graduateUru();
        Dn404TaxTemplateV2 t = Dn404TaxTemplateV2(payable(base));
        bool tokenIsC0 = Currency.unwrap(key.currency0) == base;

        // ---- post-grad BUY (URU -> token): taxed, accumulates.
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(trader, 1000e18);
        _approveUr(trader, URU);
        uint256 accBefore = t.accumulatedTax();
        uint256 buyGas = _normalSwap(trader, key, !tokenIsC0, 100e18, 0);
        uint256 got = IErc20(base).balanceOf(trader);
        assertGt(got, 0, "post-grad buy delivered nothing");
        assertGt(t.accumulatedTax(), accBefore, "buy was not taxed");
        assertLt(buyGas, MAX_TX_GAS);
        emit log_named_uint("gas: post-grad buy (URU pool)", buyGas);
        _assertHookSolvent(hookPair, base, key);

        // ---- naive sell reverts; FOT-safe sell works and is taxed.
        _approveUr(trader, base);
        uint256 sellAmt = got / 2;
        vm.expectRevert();
        this.externalNormalSwap(trader, key, tokenIsC0, sellAmt);

        accBefore = t.accumulatedTax();
        uint256 uruBefore = IErc20(URU).balanceOf(trader);
        uint256 sellGas = _fotSell(trader, key, tokenIsC0, sellAmt);
        assertGt(IErc20(URU).balanceOf(trader), uruBefore, "FOT sell paid no URU");
        assertEq(t.accumulatedTax() - accBefore, (sellAmt * 100) / 10_000, "sell tax != 1%");
        assertLt(sellGas, MAX_TX_GAS);
        emit log_named_uint("gas: post-grad FOT sell (URU pool)", sellGas);

        // ---- d. keeper sweeps to itself and sells with the NORMAL order.
        assertTrue(t.isSystemExempt(keeper), "keeper not exempt");
        uint256 swept = t.accumulatedTax();
        address treasury = t.keeperTreasury();
        uint256 treasuryBefore = IErc20(base).balanceOf(treasury);
        uint256 keeperBefore = IErc20(base).balanceOf(keeper);
        vm.prank(keeper);
        (uint256 net, uint256 fee) = t.sweepAccumulated(keeper, swept);
        assertEq(fee, (swept * 500) / 10_000, "keeper fee != 5%");
        if (treasury == keeper) {
            assertEq(IErc20(base).balanceOf(keeper) - keeperBefore, swept, "keeper+treasury did not get full sweep");
        } else {
            assertEq(IErc20(base).balanceOf(keeper) - keeperBefore, net);
            assertEq(IErc20(base).balanceOf(treasury) - treasuryBefore, fee);
        }
        _approveUr(keeper, base);
        uint256 keeperUruBefore = IErc20(URU).balanceOf(keeper);
        uint256 accBeforeKeeperSell = t.accumulatedTax();
        _normalSwap(keeper, key, tokenIsC0, net, 0);
        assertGt(IErc20(URU).balanceOf(keeper), keeperUruBefore, "keeper sell paid no URU");
        assertEq(t.accumulatedTax(), accBeforeKeeperSell, "keeper sell was taxed");
    }

    // ================================================================ e: V1 behaviour preserved

    function test_V2_WalletTransfer_TaxAndSweepUnchanged() public {
        (address base, address curve) = _launch("V2 Regression", address(0), Dn404TaxTemplate.TaxMode.BuybackURU);
        Dn404TaxTemplateV2 t = Dn404TaxTemplateV2(payable(base));
        // Get tokens to a non-exempt wallet through the (exempt) curve.
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        IV10Curve(curve).buy{value: 0.01 ether}(0);
        uint256 bal = IErc20(base).balanceOf(trader);
        assertGt(bal, 0);
        assertEq(t.accumulatedTax(), 0, "curve buy should be untaxed (curve exempt)");

        address other = makeAddr("v2-other");
        uint256 amt = bal / 3;
        vm.prank(trader);
        IErc20(base).transfer(other, amt);
        uint256 tax = (amt * 100) / 10_000;
        assertEq(IErc20(base).balanceOf(other), amt - tax, "net != amount - 1%");
        assertEq(t.accumulatedTax(), tax, "tax did not accumulate");

        vm.expectEmit(true, false, false, true, base);
        emit Dn404TaxTemplate.KeeperSwept(
            keeper, tax - (tax * 500) / 10_000, (tax * 500) / 10_000, Dn404TaxTemplate.TaxMode.BuybackURU
        );
        vm.prank(keeper);
        t.sweepAccumulated(keeper, tax);
        assertEq(t.accumulatedTax(), 0);

        // Non-keeper still cannot sweep; launcher still cannot rotate the keeper.
        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotKeeper.selector);
        t.sweepAccumulated(launcher, 1);
        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        t.setKeeper(launcher);
    }

    // ================================================================ evidence

    /// Selector of IPoolManager.CurrencyNotSettled().
    bytes4 internal constant CURRENCY_NOT_SETTLED = bytes4(keccak256("CurrencyNotSettled()"));

    function _revertData(
        address who,
        PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (bytes memory err) {
        try this.externalNormalSwap(who, key, zeroForOne, amountIn) {
            revert("naive taxed sell unexpectedly succeeded");
        } catch (bytes memory e) {
            err = e;
        }
    }

    /// The naive order (swap amountIn, then SETTLE_ALL) fails for a taxed seller
    /// specifically because the PoolManager received less than it settled.
    function test_Evidence_NaiveTaxedSellRevertsCurrencyNotSettled() public {
        (address base,, PoolKey memory key) = _graduateUru();
        bool tokenIsC0 = Currency.unwrap(key.currency0) == base;
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(trader, 1000e18);
        _approveUr(trader, URU);
        _normalSwap(trader, key, !tokenIsC0, 100e18, 0);
        _approveUr(trader, base);
        bytes memory err = _revertData(trader, key, tokenIsC0, IErc20(base).balanceOf(trader) / 2);
        emit log_named_bytes("naive sell revert data", err);
        assertEq(bytes4(err), CURRENCY_NOT_SETTLED, "naive sell reverted for a different reason");
    }

    /// Without the HOOK exemption (V2 built with placeholder hook addresses), a
    /// post-grad BUY leaves the hook holding less launch token than it booked
    /// as owed: PoolManager -> hook `take` was taxed. Proves the hook slots are
    /// needed, not decorative.
    function test_Evidence_HookExemptionRequiredForSolvency() public {
        Dn404TaxTemplateV2 noHooks = new Dn404TaxTemplateV2(gradEth, gradPair, address(0xBEEF1), address(0xBEEF2));
        vm.prank(DEPLOYER);
        lf.setBaseTaxImpl(address(noHooks), keccak256(address(noHooks).code));

        (address base, address curve) = _launch("V2 NoHookExempt", address(0), Dn404TaxTemplate.TaxMode.BurnDead);
        IV10Curve c = IV10Curve(curve);
        uint256 target = c.graduationTargetEth();
        vm.deal(whale, target * 2);
        vm.startPrank(whale);
        IDn404Skip(base).setSkipNFT(true);
        c.buy{value: (target * 125) / 100}(0);
        vm.stopPrank();
        assertTrue(c.graduated(), "graduation still needs only the graduator exemption");

        PoolKey memory key = _key(address(0), base, hookEth);
        vm.deal(trader, 1 ether);
        _normalSwap(trader, key, true, 0.001 ether, 0.001 ether);

        IHookLedger h = IHookLedger(hookEth);
        address creatorAddr = h.creators(key.toId());
        if (creatorAddr == address(0)) creatorAddr = h.creator();
        uint256 owedTotal = h.owed(Currency.wrap(base), h.platform()) + h.owed(Currency.wrap(base), creatorAddr);
        uint256 held = IErc20(base).balanceOf(hookEth);
        emit log_named_uint("hook owed (token)", owedTotal);
        emit log_named_uint("hook held (token)", held);
        assertLt(held, owedTotal, "expected insolvency without hook exemption");
    }
}
