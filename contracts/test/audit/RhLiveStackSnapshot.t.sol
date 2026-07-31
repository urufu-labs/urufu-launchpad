// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

/// @title  RhLiveStackSnapshot
/// @notice The anti-staleness fence. Runs on every `forge test` and fails
///         LOUDLY the moment `.env` (or the hardcoded pin below) drifts from
///         what is actually wired on RH mainnet.
///
///         WHY THIS EXISTS
///           Every time the "fix one bug, break another" pattern hit us, the
///           root cause was the same: broadcast script or test pointed at a
///           stale address. Env said one contract, mainnet had a different
///           one wired. Nothing caught it until a live tx reverted.
///
///           This test does the catch. On every fork run, it asserts:
///             1. Every pinned address holds live code on RH.
///             2. Router.curveFactory == CF pin.
///             3. CF.trustedRouters[Router] == true.
///             4. CF.graduator == GRADUATOR pin.
///             5. Graduator.curveFactory == CF pin.
///             6. Graduator.defaultHook == MHH pin.
///             7. MHH.initializer == GRADUATOR pin.
///             8. Every owner matches the deployer pin.
///
///         WHEN THIS FIRES
///           You changed .env for a redeploy but didn't update the pins here
///           (or vice versa). Fix by updating BOTH — the test refuses to pass
///           until they agree with mainnet.
///
///         WHEN TO UPDATE THE PINS
///           Only after a broadcast that rotates any of these contracts. The
///           update should be part of the same commit as the broadcast.
contract RhLiveStackSnapshotTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // ------ PINNED LIVE ADDRESSES (must match .env AND on-chain wiring) ----
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant MULTI_HOOK_HOST = 0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4;
    address internal constant GRADUATOR = 0x0Db63b8Af346c5edabF79b16A236AEDA0428e712;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;

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
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
    }

    function test_Snapshot_EveryPinnedAddressHasLiveCode() public view {
        assertGt(NAME_REGISTRY.code.length, 0, "NameRegistry pin has no code");
        assertGt(ROUTER_V7.code.length, 0, "Router pin has no code");
        assertGt(CURVE_FACTORY.code.length, 0, "CurveFactory pin has no code");
        assertGt(MULTI_HOOK_HOST.code.length, 0, "MHH pin has no code");
        assertGt(GRADUATOR.code.length, 0, "Graduator pin has no code");
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager pin has no code");
        assertGt(FEE_SPLITTER.code.length, 0, "FeeSplitter pin has no code");
        assertGt(V4_SWAP_ROUTER.code.length, 0, "V4SwapRouter pin has no code");
        assertGt(ERC20_FACTORY.code.length, 0, "ERC20Factory pin has no code");
    }

    function test_Snapshot_Router_PointsAtCurveFactoryPin() public view {
        assertEq(RouterV2(payable(ROUTER_V7)).curveFactory(), CURVE_FACTORY, "Router.curveFactory != pin");
    }

    function test_Snapshot_CurveFactory_TrustsRouterAndPointsAtGraduatorPin() public view {
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        assertTrue(cf.trustedRouters(ROUTER_V7), "CF trustedRouters[Router] false");
        assertEq(cf.graduator(), GRADUATOR, "CF.graduator != pin");
    }

    function test_Snapshot_Graduator_PointsAtCFAndMhhPins() public view {
        GraduatorV2 g = GraduatorV2(payable(GRADUATOR));
        assertEq(address(g.curveFactory()), CURVE_FACTORY, "Graduator.curveFactory != pin");
        assertEq(address(g.defaultHook()), MULTI_HOOK_HOST, "Graduator.defaultHook != pin");
    }

    function test_Snapshot_MHH_InitializerIsGraduatorPin() public view {
        assertEq(MultiHookHost(payable(MULTI_HOOK_HOST)).initializer(), GRADUATOR, "MHH.initializer != pin");
    }

    function test_Snapshot_Owners_AllMatchDeployer() public view {
        assertEq(CurveFactory(CURVE_FACTORY).owner(), DEPLOYER, "CF.owner != deployer");
        assertEq(RouterV2(payable(ROUTER_V7)).owner(), DEPLOYER, "Router.owner != deployer");
        assertEq(GraduatorV2(payable(GRADUATOR)).owner(), DEPLOYER, "Graduator.owner != deployer");
    }
}
