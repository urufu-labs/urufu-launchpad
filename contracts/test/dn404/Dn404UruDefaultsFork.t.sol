// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {MockPairErc20} from "test/dn404/Dn404GraduationFork.t.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20Approve {
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

/// @title  Dn404UruDefaultsForkTest
/// @notice Proves the URU-scale curve defaults (virtual 8.5M, target 5M,
///         same 1.7 ratio as the ETH lane's 17/10) BEFORE they are
///         broadcast to the live Dn404CurveFactory:
///           - setDefaults accepts them (reachability check passes)
///           - a curve launched on the LIVE stack after the change carries them
///           - buying past the target graduates onto the DN404 host
///           - pool opening price == curve marginal price (no cliff)
///         The pair token is an 18-decimal mock pinned on the live allowlist,
///         because `deal` cannot write URU balances and the deployer holds
///         far less than 5M URU. Same decimals as URU, so the math is the
///         math a real URU launch will see.
contract Dn404UruDefaultsForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant VIRT_PAIR = 8_500_000e18;
    uint256 internal constant GRAD_TARGET = 5_000_000e18;

    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    bytes32 internal constant DN404_GRADUATED_TOPIC0 =
        keccak256("Dn404Graduated(address,address,address,uint256,uint256,uint160,uint128)");

    Dn404CurveFactory internal cf;
    Dn404LaunchFactory internal lf;
    Dn404PairCurrencyAllowlist internal al;
    address internal graduator;
    address internal host;
    uint24 internal gradFee;
    int24 internal gradTickSpacing;

    function setUp() public {
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
        cf = Dn404CurveFactory(vm.parseJsonAddress(j, ".Dn404CurveFactory"));
        lf = Dn404LaunchFactory(vm.parseJsonAddress(j, ".Dn404LaunchFactory"));
        al = Dn404PairCurrencyAllowlist(vm.parseJsonAddress(j, ".Dn404PairCurrencyAllowlist"));
        graduator = vm.parseJsonAddress(j, ".Dn404Graduator");
        host = vm.parseJsonAddress(j, ".Dn404MultiHookHost");
        gradFee = uint24(vm.parseJsonUint(j, ".GradFee"));
        gradTickSpacing = int24(int256(vm.parseJsonUint(j, ".GradTickSpacing")));
    }

    function test_UruDefaults_GraduateOnDn404Host_NoCliff() public {
        // Exactly the call that will be broadcast (supply/virtTok/fee unchanged).
        uint256 supply = cf.defaultCurveSupply();
        uint256 virtTok = cf.defaultVirtualTokenReserve();
        uint16 feeBps = cf.defaultTradeFeeBps();
        vm.prank(DEPLOYER);
        cf.setDefaults(supply, virtTok, VIRT_PAIR, GRAD_TARGET, feeBps);
        assertEq(cf.defaultVirtualPairReserve(), VIRT_PAIR);
        assertEq(cf.defaultGraduationTargetPair(), GRAD_TARGET);

        // 18-dec mock pair at a high address (token sorts as currency0, the
        // same ordering the live REH404 pool landed in).
        address pairAddr = address(0xFFfffFFfFFfffFfFffFFfFfFfFffFfffFFFFFf01);
        deployCodeTo("Dn404GraduationFork.t.sol:MockPairErc20", pairAddr);
        MockPairErc20 pair = MockPairErc20(pairAddr);
        vm.prank(DEPLOYER);
        al.setAllowed(pairAddr, true, "MOCK-URU-SCALE");

        // Launch on the live LF as the deployer, paying the live URU fee.
        uint256 fee = lf.minUruFeeFor(DEPLOYER);
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = "URU Defaults Fork";
        p.ticker = "UDF";
        p.baseURI = "ipfs://udf/";
        p.contractURI = "ipfs://udf/collection.json";
        p.collectionSize = 8;
        p.unit = 100_000_000;
        p.pairCurrency = pairAddr;
        p.uruAmount = fee;
        vm.startPrank(DEPLOYER);
        if (fee > 0) IErc20Approve(RH_URU).approve(address(lf), fee);
        (address base,, address curve) = lf.launch(p);
        vm.stopPrank();

        Dn404BondingCurve c = Dn404BondingCurve(curve);
        assertEq(c.virtualEthReserve(), VIRT_PAIR, "curve did not pick up new virtual reserve");
        assertEq(c.graduationTargetEth(), GRAD_TARGET, "curve did not pick up new target");

        // A small buy first: must NOT graduate, and must mint tokens.
        address buyer = makeAddr("udf-buyer");
        pair.mint(buyer, 10_000_000e18);
        vm.startPrank(buyer);
        pair.approve(curve, type(uint256).max);
        uint256 smallOut = c.buy(1000e18, 0);
        assertGt(smallOut, 0, "small buy returned nothing");
        assertFalse(c.graduated(), "1k buy graduated a 5M-target curve");

        // Then cross the target.
        vm.recordLogs();
        c.buy((GRAD_TARGET * 125) / 100, 0);
        vm.stopPrank();
        assertTrue(c.graduated(), "did not graduate");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 pairAmount;
        uint256 tokenAmount;
        address emittedHook;
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == graduator && logs[i].topics[0] == DN404_GRADUATED_TOPIC0) {
                emittedHook = address(uint160(uint256(logs[i].topics[3])));
                (pairAmount, tokenAmount,,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint128));
                found = true;
                break;
            }
        }
        assertTrue(found, "Dn404Graduated not emitted");
        assertEq(emittedHook, host, "graduated onto a different hook");

        bool pairIsC0 = pairAddr < base;
        (address c0, address c1) = pairIsC0 ? (pairAddr, base) : (base, pairAddr);
        PoolId pid = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: gradFee,
            tickSpacing: gradTickSpacing,
            hooks: IHooks(host)
        }).toId();
        (uint160 sq,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(pid);
        assertGt(sq, 0, "pool not initialized");
        assertGt(IPoolManager(RH_POOL_MANAGER).getLiquidity(pid), 0, "no liquidity");
        (uint32 launchBlock,,) = MultiHookHost(payable(host)).poolConfig(pid);
        assertGt(launchBlock, 0, "host did not stamp pool");

        uint256 curvePriceX18 = ((VIRT_PAIR + pairAmount) * 1e18) / (virtTok + tokenAmount);
        uint256 poolPriceX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(uint256(sq), uint256(sq), 1 << 96), 1e18, 1 << 96
        );
        uint256 expected = pairIsC0 ? (1e36 / curvePriceX18) : curvePriceX18;
        uint256 diff = poolPriceX18 > expected ? poolPriceX18 - expected : expected - poolPriceX18;
        assertLe(diff * 100, expected, "CLIFF: pool opening price != curve marginal price");

        emit log_named_uint("deviation bps", (diff * 10_000) / expected);
        emit log_named_decimal_uint("pair into pool (URU-scale)", pairAmount, 18);
        emit log_named_decimal_uint("tokens into pool", tokenAmount, 18);
        emit log_named_decimal_uint("graduation price (pair per token)", curvePriceX18, 18);
    }
}
