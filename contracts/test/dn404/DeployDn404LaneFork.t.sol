// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {DeployDn404Lane} from "script/DeployDn404Lane.s.sol";
import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404Graduator} from "src/dn404/Dn404Graduator.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @title  DeployDn404LaneForkTest
/// @notice Runs `DeployDn404Lane.runForTest()` against a live Robinhood
///         mainnet fork and asserts the whole stack lands wired. If any
///         setter, mining step, or invariant fails, this test surfaces the
///         revert instead of discovering it during the real broadcast.
///
///         Test skips cleanly when ROBINHOOD_RPC_URL is unset (or the
///         canonical public endpoint refuses the fork) so local CI without
///         RPC access still stays green.
contract DeployDn404LaneForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live RH addresses the deploy script reads from JSON books. Hardcoded
    // here so the test doesn't depend on the JSON files existing at their
    // expected paths — vm.setEnv the ones the script reads via env only.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    DeployDn404Lane internal script;
    /// Deployed stack — populated once in setUp so each test body reads the
    /// same wiring rather than re-invoking runForTest(). The re-invoke
    /// pattern races with sibling fork-test contracts running in parallel
    /// that also `vm.setEnv` on the same process-shared env vars.
    DeployDn404Lane.Deployed internal stack;
    address internal admin;
    address internal keeper;
    address internal treasury;

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

        // Shared labels with sibling Dn404GraduationForkTest so parallel test
        // execution can't race on the process-shared env vars — whichever
        // contract's setUp wins the last `vm.setEnv`, both stacks land with
        // the same known addresses.
        admin = makeAddr("dn404-fork-admin");
        keeper = makeAddr("dn404-fork-keeper");
        treasury = makeAddr("dn404-fork-treasury");

        // Wire every env the script reads. `ADMIN` steers ownership of all
        // fresh contracts; the keeper wallets get baked into
        // Dn404LaunchFactory.taxKeeper / taxKeeperTreasury at deploy.
        vm.setEnv("ADMIN", vm.toString(admin));
        vm.setEnv("URU_TOKEN_ADDRESS", vm.toString(RH_URU));
        vm.setEnv("DN404_TAX_KEEPER", vm.toString(keeper));
        vm.setEnv("DN404_TAX_TREASURY", vm.toString(treasury));

        script = new DeployDn404Lane();
        // Deploy once in setUp so tests aren't racing sibling fork contracts
        // over process-shared env vars.
        stack = script.runForTest();
    }

    // ================================================================
    // Test 1 — the deploy script itself runs clean end-to-end.
    // The script's internal `_assertInvariants` reverts on any wiring
    // mismatch; a green pass here proves the whole flow is producible.
    // ================================================================
    function test_ForkDeploy_RunsCleanAgainstLiveRhFork() public {
        DeployDn404Lane.Deployed memory d = stack;

        // Bytecode present at every address the script returns.
        assertGt(d.pairCurrencyAllowlist.code.length, 0, "pairCurrencyAllowlist no code");
        assertGt(d.taxAllowlist.code.length, 0, "taxAllowlist no code");
        assertGt(d.baseImpl.code.length, 0, "baseImpl no code");
        assertGt(d.mirrorImpl.code.length, 0, "mirrorImpl no code");
        assertGt(d.taxImpl.code.length, 0, "taxImpl no code");
        assertGt(d.bondingCurveImpl.code.length, 0, "bondingCurveImpl no code");
        assertGt(d.curveFactory.code.length, 0, "curveFactory no code");
        assertGt(d.multiHookHost.code.length, 0, "multiHookHost no code");
        assertGt(d.graduator.code.length, 0, "graduator no code");
        assertGt(d.launchFactory.code.length, 0, "launchFactory no code");
    }

    // ================================================================
    // Test 2 — MHH mining lands on an address with the required
    // permission mask baked into its low 14 bits. If it doesn't, v4's
    // PoolManager.initialize would reject the pool at graduation time.
    // ================================================================
    function test_ForkDeploy_MinedMhhAddressHasCorrectPermissionMask() public {
        DeployDn404Lane.Deployed memory d = stack;

        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        uint160 mask = 0x3FFF; // HookMiner.FLAG_MASK
        assertEq(
            uint160(d.multiHookHost) & mask, requiredFlags & mask, "Dn404 MHH address does not match required flags"
        );
    }

    // ================================================================
    // Test 3 — the MHH ↔ Graduator one-shot lock landed correctly.
    // If setInitializer failed silently, this pair would break at the
    // first graduation attempt (MHH would reject sender).
    // ================================================================
    function test_ForkDeploy_MhhInitializerLockedToGraduator() public {
        DeployDn404Lane.Deployed memory d = stack;

        assertEq(
            MultiHookHost(payable(d.multiHookHost)).initializer(),
            d.graduator,
            "MHH.initializer != Dn404Graduator"
        );
        assertEq(
            address(Dn404Graduator(payable(d.graduator)).defaultHook()),
            d.multiHookHost,
            "Dn404Graduator.defaultHook != mined MHH"
        );
    }

    // ================================================================
    // Test 4 — LaunchFactory routing is wired to BOTH curve factories
    // (V10 for ETH, Dn404 for pair-currency) and the tax keeper role
    // separation is in place.
    // ================================================================
    function test_ForkDeploy_LaunchFactoryRoutesBothCurveFactories() public {
        DeployDn404Lane.Deployed memory d = stack;
        Dn404LaunchFactory lf = Dn404LaunchFactory(d.launchFactory);

        assertTrue(address(lf.curveFactory()) != address(0), "V10 CurveFactory unset");
        assertEq(address(lf.dn404CurveFactory()), d.curveFactory, "Dn404CurveFactory route mismatch");
        assertEq(lf.baseImpl(), d.baseImpl, "baseImpl mismatch");
        assertEq(lf.mirrorImpl(), d.mirrorImpl, "mirrorImpl mismatch");
        assertEq(lf.baseTaxImpl(), d.taxImpl, "baseTaxImpl mismatch");

        // Tax role separation: keeper wallet != launch factory owner.
        assertEq(lf.taxKeeper(), keeper, "taxKeeper mismatch");
        assertEq(lf.taxKeeperTreasury(), treasury, "taxKeeperTreasury mismatch");
        assertEq(lf.taxAllowlist(), d.taxAllowlist, "taxAllowlist mismatch");
    }

    // ================================================================
    // Test 5 — Dn404CurveFactory trusts the fresh LaunchFactory. If
    // this isn't set, every non-ETH launch will revert on step 9 of
    // Dn404LaunchFactory.launch (the createCurveWithConfigFor call).
    // ================================================================
    function test_ForkDeploy_Dn404CurveFactoryTrustsLaunchFactory() public {
        DeployDn404Lane.Deployed memory d = stack;
        assertTrue(
            Dn404CurveFactory(d.curveFactory).trustedRouters(d.launchFactory),
            "Dn404 CF must trust Dn404 LaunchFactory"
        );
        assertEq(
            Dn404CurveFactory(d.curveFactory).graduator(),
            d.graduator,
            "Dn404 CF.graduator != Dn404 Graduator"
        );
    }
}
