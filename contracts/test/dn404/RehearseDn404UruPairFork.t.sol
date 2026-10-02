// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {RehearseDn404UruPair} from "script/RehearseDn404UruPair.s.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20View {
    function balanceOf(
        address who
    ) external view returns (uint256);
}

/// @title  RehearseDn404UruPairForkTest
/// @notice Runs the EXACT rehearsal script that will be broadcast, on a live
///         Robinhood fork, as the real deployer (it holds the URU). Proves,
///         before any real tx:
///           - the deployer can flip the pair allowlist (URU in, USDG out)
///           - a URU-paired DN404 launches and graduates on the LIVE stack
///           - the pool lands on the DN404 host (not the ERC-20 lane's host)
///           - no price cliff: pool slot0 == curve marginal price (<1%)
///           - the buyer's mirror NFT count follows the unit rule
///         Skips cleanly without a reachable RH RPC.
contract RehearseDn404UruPairForkTest is Test {
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// Live deployer = owner of the DN404 allowlist + LF, holds ~947k URU.
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    bytes32 internal constant DN404_GRADUATED_TOPIC0 =
        keccak256("Dn404Graduated(address,address,address,uint256,uint256,uint160,uint128)");

    RehearseDn404UruPair internal script;
    address internal dn404Mhh;
    address internal graduator;
    address internal allowlist;
    /// ERC-20 lane's current host, read from the live book; the rehearsal
    /// pool must NOT land here.
    address internal erc20LaneMhh;

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
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (RH_POOL_MANAGER.code.length == 0) vm.skip(true);

        string memory j = vm.readFile("deployment-dn404.4663.json");
        dn404Mhh = vm.parseJsonAddress(j, ".Dn404MultiHookHost");
        graduator = vm.parseJsonAddress(j, ".Dn404Graduator");
        allowlist = vm.parseJsonAddress(j, ".Dn404PairCurrencyAllowlist");
        erc20LaneMhh = vm.parseJsonAddress(vm.readFile("deployment-live-rh.4663.json"), ".multiHookHost");
        assertGt(erc20LaneMhh.code.length, 0, "live book multiHookHost has no code");
        assertTrue(dn404Mhh != erc20LaneMhh, "book points DN404 host at the ERC-20 lane host");

        // Reproduce the factory state the rehearsal was broadcast against
        // (2026-09-23: virtual 5,000 / target 4,000 URU). Production defaults
        // moved to 8.5M / 5M on 2026-10-01 (tx 0x74eae150…), which the
        // deployer's URU balance can't graduate; Dn404UruDefaultsFork.t.sol
        // covers the production values with a mock 18-dec pair instead.
        Dn404CurveFactory cf = Dn404CurveFactory(vm.parseJsonAddress(j, ".Dn404CurveFactory"));
        uint256 supply = cf.defaultCurveSupply();
        uint256 virtTok = cf.defaultVirtualTokenReserve();
        uint16 feeBps = cf.defaultTradeFeeBps();
        vm.prank(DEPLOYER);
        cf.setDefaults(supply, virtTok, 5000e18, 4000e18, feeBps);

        script = new RehearseDn404UruPair();
    }

    function test_Rehearsal_UruPairPoolLandsOnDn404Host_NoCliff() public {
        uint256 uruBefore = IErc20View(RH_URU).balanceOf(DEPLOYER);

        vm.recordLogs();
        RehearseDn404UruPair.Result memory r = script.runForTest(DEPLOYER);

        // ---- allowlist state after: URU in, USDG out
        Dn404PairCurrencyAllowlist al = Dn404PairCurrencyAllowlist(allowlist);
        assertTrue(al.isAllowed(RH_URU), "URU not allowlisted after rehearsal");
        assertFalse(al.isAllowed(USDG), "USDG still allowlisted after rehearsal");

        // ---- the curve really is URU-paired and graduated
        Dn404BondingCurve c = Dn404BondingCurve(r.curve);
        assertEq(c.pairCurrency(), RH_URU, "curve pair != URU");
        assertTrue(c.graduated(), "not graduated");
        assertEq(c.tokenReserve(), 0, "tokenReserve not zeroed");
        assertEq(c.ethReserve(), 0, "pair reserve not zeroed");

        // ---- pool is on the DN404 host, initialized, with liquidity
        PoolId pid = PoolId.wrap(r.poolId);
        (uint160 slotSqrt,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(pid);
        assertGt(slotSqrt, 0, "pool not initialized");
        assertEq(slotSqrt, r.sqrtPriceX96, "script reported a different sqrtPrice than slot0");
        assertGt(IPoolManager(RH_POOL_MANAGER).getLiquidity(pid), 0, "no liquidity");
        (uint32 launchBlock,,) = MultiHookHost(payable(dn404Mhh)).poolConfig(pid);
        assertGt(launchBlock, 0, "DN404 host did not stamp the pool");
        (uint32 otherLaunchBlock,,) = MultiHookHost(payable(erc20LaneMhh)).poolConfig(pid);
        assertEq(otherLaunchBlock, 0, "pool id also stamped on the ERC-20 lane host?!");

        // ---- graduator event: pull the real reserves it handed over
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
        assertEq(emittedHook, dn404Mhh, "graduator seeded a different hook than the DN404 host");

        // ---- no cliff: pool opening price == curve marginal price
        uint256 curvePriceX18 = ((c.virtualEthReserve() + pairAmount) * 1e18) / (c.virtualTokenReserve() + tokenAmount);
        bool pairIsC0 = r.currency0 == RH_URU;
        assertEq(r.currency1, pairIsC0 ? r.base : RH_URU, "currency ordering inconsistent");
        uint256 sq = uint256(slotSqrt);
        uint256 poolPriceX18 =
            FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(sq, sq, 1 << 96), 1e18, 1 << 96);
        uint256 expectedX18 = pairIsC0 ? (1e36 / curvePriceX18) : curvePriceX18;
        uint256 diff = poolPriceX18 > expectedX18 ? poolPriceX18 - expectedX18 : expectedX18 - poolPriceX18;
        assertLe(diff * 100, expectedX18, "CLIFF: pool opening price != curve marginal price");
        emit log_named_uint("deviation bps", (diff * 10_000) / expectedX18);
        emit log_named_string("token is", pairIsC0 ? "currency1 (inverted seed)" : "currency0 (direct seed)");

        // ---- buyer side: URU spent == fee + buy; NFTs follow the unit rule
        uint256 uruAfter = IErc20View(RH_URU).balanceOf(DEPLOYER);
        assertEq(uruBefore - uruAfter, r.uruFeePaid + r.uruBuyAmount, "URU spent != fee + buy");
        uint256 unitWei = 100_000_000 * 1e18;
        assertEq(
            IErc20View(r.mirror).balanceOf(DEPLOYER),
            IErc20View(r.base).balanceOf(DEPLOYER) / unitWei,
            "mirror NFT count != whole units held"
        );
        assertGt(IErc20View(r.mirror).balanceOf(DEPLOYER), 0, "buyer got no mirror NFTs");

        console2.log("URU spent total (wei)", uruBefore - uruAfter);
        console2.logBytes32(r.poolId);
    }
}
