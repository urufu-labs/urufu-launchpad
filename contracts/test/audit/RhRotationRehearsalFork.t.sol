// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {DeployRouter} from "script/DeployRouter.s.sol";
import {ActivateRouter} from "script/ActivateRouter.s.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";

interface IFactoryLike {
    function router() external view returns (address);
    function owner() external view returns (address);
    function setRouter(
        address r
    ) external;
}

/// @title  RhRotationRehearsalForkTest
/// @notice URU-A13 (audit round 4) AC #4 — "Production rehearsal invokes the
///         real scripts and real deployed interfaces."
///
///         The predecessor `RhProductionRotationForkTest` proved the propose/
///         timelock/activate flow works against a FRESH NameRegistry, but it
///         built the rotation by hand (not by invoking `DeployRouter.s.sol` or
///         `ActivateRouter.s.sol`). The auditor rejected that: nothing catches
///         a regression in the actual production scripts.
///
///         This rewrite runs the REAL scripts against a live Robinhood fork,
///         with one unavoidable substitution: the LIVE NameRegistry
///         (`0x60b7…118C`) predates the 2-phase rotation API (proven by
///         `RhProductionRotationForkTest.test_LiveRegistry_LacksRotationApi`),
///         so a fresh NameRegistry V2 is deployed inside the fork and every
///         other address stays LIVE. That is the exact substitution any real
///         V8 rotation will require, so exercising it here mirrors production.
///
///         COVERAGE
///           1. DeployRouter.runForTest(...) runs Phase 1 against LIVE
///              CurveFactory + LIVE factories + fresh registry. Post-conditions:
///              new Router deployed, sentinels seeded, retired hashes banned,
///              new Router pre-trusted on CurveFactory (old Router still
///              trusted), pending on fresh registry.
///           2. Old Router remains functional during staging (test hits the
///              LIVE OLD_ROUTER + LIVE registry, which the staging window
///              does not touch).
///           3. Warp past MIN_ROUTER_DELAY.
///           4. ActivateRouter.runForTest(...) runs Phase 2 atomically —
///              factories rewired, fresh registry activated, old Router paused,
///              CurveFactory trust flipped (old off, new on).
///           5. New Router launch: reserves the name on the fresh registry,
///              deploys a bare-ERC20 token through the LIVE ERC20Factory,
///              installs a bonding curve. `CurveInstalled` event asserted via
///              vm.recordLogs.
///           6. Post-activation checks: fresh registry.router == new Router;
///              every factory router-pointer == new Router; old Router loses
///              reserve() rights on the fresh registry; curve trust flipped.
contract RhRotationRehearsalForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    uint256 internal constant MIN_URU_FEE = 1000e18;

    // Live V7 pins (mirror RhLiveStackSnapshot.t.sol + deployment-live-rh.4663.json)
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant OLD_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant LIVE_NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    // The canonical bare-ERC20 configHash — registered on the LIVE ERC20Factory,
    // seeded on every fresh Router by RhConfigManifest.
    bytes32 internal constant CH_BARE = 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb;

    DeployRouter internal deployRouter;
    ActivateRouter internal activateRouter;
    NameRegistry internal freshRegistry;

    function setUp() public {
        // Fork bring-up mirrors RhProductionRotationForkTest / DeployPathRhForkTest.
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
        if (LIVE_NAME_REGISTRY.code.length == 0) vm.skip(true);
        if (CURVE_FACTORY.code.length == 0) vm.skip(true);
        if (OLD_ROUTER.code.length == 0) vm.skip(true);

        // Bootstrap the fresh 2-phase NameRegistry. Owned by DEPLOYER (the
        // same address that owns every LIVE contract we mutate) so ownership
        // checks in DeployRouter + ActivateRouter resolve uniformly under
        // vm.prank(DEPLOYER).
        vm.startPrank(DEPLOYER);
        string[] memory noTickers = new string[](0);
        freshRegistry = new NameRegistry(DEPLOYER, DEPLOYER, noTickers);
        // Seed the fresh registry as if the OLD Router were already wired.
        // Any real rotation flows through proposeRouter/activateRouter, which
        // require router != 0 (else greenfield=true and DeployRouter skips
        // the propose branch entirely).
        freshRegistry.setRouter(OLD_ROUTER);
        vm.stopPrank();

        deployRouter = new DeployRouter();
        activateRouter = new ActivateRouter();
    }

    // -------------------------------------------------------------
    // Phase 1: run the real DeployRouter script against a live fork
    // -------------------------------------------------------------

    function _runPhase1() internal returns (DeployRouter.Deployed memory out) {
        DeployRouter.TestArgs memory a = DeployRouter.TestArgs({
            oldRouter: OLD_ROUTER,
            nameRegistry: address(freshRegistry),
            erc20Factory: ERC20_FACTORY,
            erc721Factory: ERC721A_FACTORY,
            erc1155Factory: ERC1155_FACTORY,
            curveFactory: CURVE_FACTORY,
            feeSplitter: FEE_SPLITTER,
            loyaltyOracle: LOYALTY_ORACLE,
            admin: DEPLOYER,
            uruToken: URU,
            minUruFee: MIN_URU_FEE
        });
        out = deployRouter.runForTest(a);
    }

    function test_Phase1_StagesTheNewRouterCleanly() public {
        DeployRouter.Deployed memory out = _runPhase1();

        // New Router exists + owned by DEPLOYER.
        assertGt(out.routerV2.code.length, 0, "new Router not deployed");
        assertGt(out.uruSink.code.length, 0, "new UruDepositSink not deployed");
        Router newRouter = Router(payable(out.routerV2));
        assertEq(newRouter.owner(), DEPLOYER, "new Router owner drifted");
        assertEq(newRouter.minUruFee(), MIN_URU_FEE, "minUruFee not seeded");
        assertEq(address(newRouter.uru()), URU, "new Router URU token mismatch");
        assertEq(address(newRouter.uruSink()), out.uruSink, "new Router sink mismatch");

        // Manifest sentinels seeded on the new Router.
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            assertTrue(newRouter.moduleCountConfigured(entries[i].configHash), "moduleCount not configured");
            assertTrue(newRouter.flagsConfigured(entries[i].configHash), "flags not configured");
        }
        // Retired hashes banned.
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            assertTrue(newRouter.bannedConfigHash(retired[i]), "retired hash not banned");
        }

        // CurveFactory trust is additive: NEW trusted, OLD still trusted
        // during the staging window.
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        assertTrue(cf.trustedRouters(out.routerV2), "new Router not trusted on CF");
        assertTrue(cf.trustedRouters(OLD_ROUTER), "old Router lost trust during Phase 1");

        // Per-base factories still point at OLD Router during staging.
        assertEq(IFactoryLike(ERC20_FACTORY).router(), OLD_ROUTER, "ERC20 factory rewired too early");
        assertEq(IFactoryLike(ERC721A_FACTORY).router(), OLD_ROUTER, "ERC721A factory rewired too early");
        assertEq(IFactoryLike(ERC1155_FACTORY).router(), OLD_ROUTER, "ERC1155 factory rewired too early");

        // Fresh registry: proposal recorded, timelock set, active router unchanged.
        assertEq(freshRegistry.pendingRouter(), out.routerV2, "pending not recorded on fresh registry");
        assertEq(
            freshRegistry.pendingRouterTs(),
            block.timestamp + freshRegistry.MIN_ROUTER_DELAY(),
            "pending timelock ts wrong"
        );
        assertEq(freshRegistry.router(), OLD_ROUTER, "active router prematurely rotated on fresh registry");
    }

    /// The auditor's staging invariant: during Phase 1's pending window, the
    /// OLD Router keeps taking launches normally. We prove this by hitting
    /// the LIVE OLD_ROUTER (which uses the LIVE registry, untouched by our
    /// fresh registry) with a real ETH-paid bare-ERC20 + curve launch.
    function test_Phase1_OldRouterStillLaunchesDuringStaging() public {
        _runPhase1();

        // Launch a token via OLD Router. Uses the LIVE stack end-to-end.
        Router oldR = Router(payable(OLD_ROUTER));
        address launcher = makeAddr("staging-old-launcher");
        vm.deal(launcher, 5 ether);

        LaunchParams memory p = _bareCurveParams(oldR, "StagingOld", "OSTG");
        uint256 fee = oldR.quote(p);
        vm.prank(launcher);
        address token = oldR.launch{value: fee}(p);
        assertGt(token.code.length, 0, "OLD Router failed to launch during Phase 1 staging window");
    }

    // -------------------------------------------------------------
    // Phase 2: run the real ActivateRouter script + full launch
    // -------------------------------------------------------------

    function _runPhase2(
        address newRouterAddr
    ) internal {
        ActivateRouter.TestArgs memory a = ActivateRouter.TestArgs({
            nameRegistry: address(freshRegistry),
            newRouter: newRouterAddr,
            oldRouter: OLD_ROUTER,
            erc20Factory: ERC20_FACTORY,
            erc721Factory: ERC721A_FACTORY,
            erc1155Factory: ERC1155_FACTORY,
            curveFactory: CURVE_FACTORY,
            admin: DEPLOYER,
            skipPauseOld: false
        });
        activateRouter.runForTest(a);
    }

    function test_Phase2_ActivateEnforcesTimelock() public {
        DeployRouter.Deployed memory out = _runPhase1();

        // No warp — activation must revert with TimelockNotPassed.
        uint256 readyAt = freshRegistry.pendingRouterTs();
        vm.expectRevert(abi.encodeWithSelector(ActivateRouter.ActivateRouter__TimelockNotPassed.selector, readyAt));
        _runPhase2(out.routerV2);
    }

    function test_Phase2_ActivateCutsOverAtomically() public {
        DeployRouter.Deployed memory out = _runPhase1();

        // Warp past MIN_ROUTER_DELAY (2 days). +1 to satisfy the strict `<` check.
        vm.warp(freshRegistry.pendingRouterTs() + 1);

        _runPhase2(out.routerV2);

        // Fresh registry now points at the new Router; pending cleared.
        assertEq(freshRegistry.router(), out.routerV2, "fresh registry did not rotate on activation");
        assertEq(freshRegistry.pendingRouter(), address(0), "pending not cleared after activation");

        // Every factory rewired to the new Router.
        assertEq(IFactoryLike(ERC20_FACTORY).router(), out.routerV2, "ERC20 factory did not rewire");
        assertEq(IFactoryLike(ERC721A_FACTORY).router(), out.routerV2, "ERC721A factory did not rewire");
        assertEq(IFactoryLike(ERC1155_FACTORY).router(), out.routerV2, "ERC1155 factory did not rewire");

        // CurveFactory trust: new on, old off.
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        assertTrue(cf.trustedRouters(out.routerV2), "new Router lost trust after cutover");
        assertFalse(cf.trustedRouters(OLD_ROUTER), "old Router still trusted after cutover");

        // Old Router paused (skipPauseOld=false).
        assertTrue(Router(payable(OLD_ROUTER)).paused(), "old Router not paused after cutover");

        // Old Router can no longer reserve on the fresh registry.
        vm.prank(OLD_ROUTER);
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        freshRegistry.reserve("PostCutoverBlocked", "PCB", address(0xdead), address(0xbeef));
    }

    /// The full auditor deliverable for AC #4: after both scripts have run
    /// against LIVE contracts, a launch through the NEW Router MUST reserve
    /// the name on the fresh registry, deploy a token through the LIVE
    /// ERC20Factory, install a bonding curve, and emit `CurveInstalled`.
    function test_PostActivation_NewRouterCompletesFullLaunch() public {
        DeployRouter.Deployed memory out = _runPhase1();
        vm.warp(freshRegistry.pendingRouterTs() + 1);
        _runPhase2(out.routerV2);

        Router newRouter = Router(payable(out.routerV2));
        address launcher = makeAddr("post-activation-launcher");
        vm.deal(launcher, 5 ether);

        LaunchParams memory p = _bareCurveParams(newRouter, "RotatedLaunch", "ROT");
        uint256 fee = newRouter.quote(p);

        vm.recordLogs();
        vm.prank(launcher);
        address token = newRouter.launch{value: fee}(p);
        assertGt(token.code.length, 0, "post-activation launch returned zero code");

        // Verify (a) CurveInstalled emitted with the launched token, and (b)
        // reservation landed on the FRESH registry (not the live one).
        bytes32 curveInstalledSig = keccak256("CurveInstalled(address,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawCurveInstalled;
        address recordedCurve;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length >= 3 && logs[i].topics[0] == curveInstalledSig && logs[i].emitter == out.routerV2)
            {
                address topicToken = address(uint160(uint256(logs[i].topics[1])));
                if (topicToken == token) {
                    sawCurveInstalled = true;
                    recordedCurve = address(uint160(uint256(logs[i].topics[2])));
                    break;
                }
            }
        }
        assertTrue(sawCurveInstalled, "CurveInstalled(token, curve) not emitted by new Router");
        assertEq(CurveFactory(CURVE_FACTORY).curveFor(token), recordedCurve, "CF.curveFor mismatch with emitted curve");

        // The reservation MUST have landed on the fresh registry (the whole
        // point of this rehearsal — the new Router routes through the fresh
        // 2-phase registry, not the legacy one).
        bytes32 nameHash = keccak256("rotatedlaunch");
        NameRegistry.Reservation memory r = freshRegistry.reservationOf(nameHash);
        assertEq(r.token, token, "reservation not recorded on fresh registry");
        assertEq(r.launchedBy, launcher, "reservation launcher wrong");
    }

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    /// Build a bare-ERC20 + curve LaunchParams shaped for either the LIVE
    /// OLD Router (against the LIVE registry) or the fresh NEW Router
    /// (against the fresh registry). The initialRecipient must be the
    /// Router in question so Router can approve+forward the curve supply.
    function _bareCurveParams(
        Router r,
        string memory name,
        string memory ticker
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name;
        p.ticker = ticker;
        p.configHash = CH_BARE;
        p.initData = abi.encode(CurveFactory(CURVE_FACTORY).defaultCurveSupply(), address(r), new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.installHook = false;
        p.installGovernance = false;
        p.ownership = OwnershipMode.Renounce;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
    }
}
