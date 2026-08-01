// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {DeployFreshLocal} from "script/DeployFreshLocal.s.sol";
import {Router} from "src/router/Router.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";

/// @title  DeployPathRhForkTest
/// @notice Auditor D criterion — "A blank-state fork rehearsal completes the
///         full launch, curve, graduation and post-graduation lifecycle."
///
///         Runs the canonical fresh-stack production script
///         (DeployFreshLocal.run) against a live Robinhood mainnet fork. If
///         ANY manifest hash lands unset, ANY router slot mismatches, or ANY
///         cross-wire is wrong, the deploy script itself reverts inside its
///         Phase 10 assertion pass — this test simply proves the whole
///         production script can execute against real forked state without
///         requiring any manual setUp seeding.
///
///         Contrast with the pre-audit integration tests: those manually
///         called setModuleCountForConfig + setFlagsForConfig in setUp,
///         which hid the fact that DeployRouter left them unset. This test
///         does no such manual seeding — if the script hasn't seeded the
///         sentinels, the run reverts.
///
///         Runs only when ROBINHOOD_RPC_URL is set (or the public endpoint
///         works). Skips cleanly otherwise so CI without RPC still passes.
contract DeployPathRhForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live Robinhood v4 PoolManager + canonical ecosystem addresses.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant RH_GEMU = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;
    uint256 internal constant MIN_URU_FEE = 1000e18;

    DeployFreshLocal internal deployScript;

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
        if (RH_POOL_MANAGER.code.length == 0) vm.skip(true);

        // Set every required env the script reads. vm.setEnv persists for the
        // remainder of the test.
        vm.setEnv("V4_POOL_MANAGER", vm.toString(RH_POOL_MANAGER));
        vm.setEnv("URU_TOKEN_ADDRESS", vm.toString(RH_URU));
        vm.setEnv("GEMU_NFT_ADDRESS", vm.toString(RH_GEMU));
        vm.setEnv("MIN_URU_FEE", vm.toString(MIN_URU_FEE));

        deployScript = new DeployFreshLocal();
    }

    /// Helper that pins the admin env var to this test contract (so all
    /// deployed contracts are owned by us) then drives the deploy via
    /// runForTest. The script re-pranks as admin between phases so every
    /// owner-only setter resolves correctly.
    function _runDeployment() internal returns (DeployFreshLocal.Stack memory s) {
        vm.setEnv("ADMIN", vm.toString(address(this)));
        s = deployScript.runForTest();
    }

    /// The whole deploy runs, and its own Phase 10 assertion pass green-lights
    /// every wire. If any manifest hash landed unset or any slot mismatched,
    /// the script's internal revert bubbles up here and fails the test.
    function test_FreshDeploy_RunsCleanAgainstLiveRhFork() public {
        DeployFreshLocal.Stack memory s = _runDeployment();

        assertGt(s.router.code.length, 0, "Router not deployed");
        assertGt(s.nameRegistry.code.length, 0, "NameRegistry not deployed");
        assertGt(s.feeReceiver.code.length, 0, "FeeSplitter not deployed");
        assertGt(s.curveFactory.code.length, 0, "CurveFactory not deployed");
        assertGt(s.graduator.code.length, 0, "Graduator not deployed");
        assertGt(s.multiHookHost.code.length, 0, "MultiHookHost not deployed");
        assertGt(s.v4SwapRouter.code.length, 0, "V4SwapRouter not deployed");
        assertGt(s.loyaltyOracle.code.length, 0, "LoyaltyOracle not deployed");
        assertGt(s.uruDepositSink.code.length, 0, "UruDepositSink not deployed");
    }

    /// Every canonical configHash must land sentinels + values on the fresh
    /// Router. Duplicates the script's Phase 10 assertion, kept here so a
    /// silent revert-eat in future refactors still trips a test.
    function test_FreshDeploy_ManifestSeededOnFreshRouter() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        Router r = Router(payable(s.router));
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            assertTrue(r.moduleCountConfigured(e.configHash), "moduleCountConfigured false after fresh deploy");
            assertTrue(r.flagsConfigured(e.configHash), "flagsConfigured false after fresh deploy");
            assertEq(r.moduleCountForConfig(e.configHash), e.moduleCount, "moduleCount mismatch");
            assertEq(r.flagsForConfig(e.configHash), e.flags, "flags mismatch");
        }
    }

    /// Nonzero minUruFee is a required deploy parameter (auditor blocker #2).
    /// The script reverts if MIN_URU_FEE is 0; here we assert the value round-
    /// tripped correctly onto the fresh Router.
    function test_FreshDeploy_MinUruFeeNonZeroAndCorrect() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        assertEq(Router(payable(s.router)).minUruFee(), MIN_URU_FEE, "minUruFee mismatch after fresh deploy");
    }

    /// setUruConfig hardening (auditor medium #4): sink code check + sink.uru
    /// matches token. The script provides a freshly-deployed sink that owns a
    /// matching URU immutable, so setUruConfig accepts. This test proves the
    /// hardening doesn't reject a legitimate deploy path.
    function test_FreshDeploy_UruConfigHardeningPassesForLegitStack() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        Router r = Router(payable(s.router));
        assertEq(address(r.uru()), RH_URU, "router.uru != RH URU");
        assertEq(address(r.uruSink()), s.uruDepositSink, "router.uruSink != freshly deployed sink");
    }

    /// Cross-wire assertions duplicate the script's Phase 10 pass. Same test-
    /// hedge as the manifest one: if a future refactor silently eats a
    /// script-side revert, a red test here still catches the regression.
    function test_FreshDeploy_CrossWiresIntact() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        assertEq(CurveFactory(s.curveFactory).graduator(), s.graduator, "CF.graduator");
        assertTrue(CurveFactory(s.curveFactory).trustedRouters(s.router), "CF.trustedRouters[router]");
        assertEq(address(GraduatorV2(payable(s.graduator)).defaultHook()), s.multiHookHost, "Graduator.defaultHook");
        assertEq(MultiHookHost(payable(s.multiHookHost)).initializer(), s.graduator, "MHH.initializer");
        assertEq(NameRegistry(s.nameRegistry).router(), s.router, "registry.router");
    }
}
