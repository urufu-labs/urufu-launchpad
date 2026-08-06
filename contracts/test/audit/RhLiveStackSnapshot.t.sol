// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {Router} from "src/router/Router.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";

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
    // V8 fresh stack, broadcast 2026-08-05.
    // Source of truth: contracts/deployment-fresh.4663.json.
    // DEPLOYER unchanged across rotations (deployer identity, not a rotated slot).
    // ROUTER_V7 kept as a legacy variable name; value is now the V8 Router.
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x7e0f161398eeEa3C46f910f5ca4026a2892705a6;
    address internal constant ROUTER_V7 = 0x9133E9323BD58b95a48a8171a5B451fd67c6BB98;
    address internal constant CURVE_FACTORY = 0xa7CbEec5E06E9AF964B86ce5094BDaeb39Bcceea;
    address internal constant MULTI_HOOK_HOST = 0xcb11Ab6723442f82f3B1016d1Ab96dD0342360c4;
    address internal constant GRADUATOR = 0x5d8270815CF5f0d99F1D854919959F49C41FE843;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x013851d40ed7c2Ed1432bf33A9916CB19A4Dc93F;
    address internal constant V4_SWAP_ROUTER = 0xb30c85F3D7Acdf75fd691a9d498502f7B67Ae699;
    address internal constant ERC20_FACTORY = 0x8Ba5e5D361625BDFBD33a7F5c48AD0A9857ABB31;
    address internal constant LOYALTY_ORACLE = 0x3B0B4e387f56EE69923691AF5C892754280f6142;
    address internal constant ROYALTY_ROUTER_FACTORY = 0x5a004b113b33feD1D9cC71261a482b7E0E874490;
    // Ecosystem tokens (canonical post-2026-07-25 RH migration).
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

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
        assertEq(Router(payable(ROUTER_V7)).curveFactory(), CURVE_FACTORY, "Router.curveFactory != pin");
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
        // GH-9 audit LOW #1: pool params must match what the GH-13 indexer
        // hardcodes for v4 poolId derivation. A future rotation that changed
        // fee or tickSpacing would silently null out every hookPolicy field
        // in the launch-card API. Fail loud instead.
        assertEq(uint256(g.fee()), 3000, "Graduator.fee drifted; indexer launch-card poolId derivation would break");
        assertEq(uint256(int256(g.tickSpacing())), 60, "Graduator.tickSpacing drifted; same reason");
    }

    function test_Snapshot_MHH_InitializerIsGraduatorPin() public view {
        assertEq(MultiHookHost(payable(MULTI_HOOK_HOST)).initializer(), GRADUATOR, "MHH.initializer != pin");
    }

    function test_Snapshot_Owners_AllMatchDeployer() public view {
        assertEq(CurveFactory(CURVE_FACTORY).owner(), DEPLOYER, "CF.owner != deployer");
        assertEq(Router(payable(ROUTER_V7)).owner(), DEPLOYER, "Router.owner != deployer");
        assertEq(GraduatorV2(payable(GRADUATOR)).owner(), DEPLOYER, "Graduator.owner != deployer");
        assertEq(LoyaltyOracle(LOYALTY_ORACLE).owner(), DEPLOYER, "LoyaltyOracle.owner != deployer");
        assertEq(
            RoyaltyRouterFactory(ROYALTY_ROUTER_FACTORY).owner(), DEPLOYER, "RoyaltyRouterFactory.owner != deployer"
        );
    }

    /// LoyaltyOracle must point at post-migration RH URU + GEMU. On 2026-08-01 an
    /// audit caught this pair still holding the pre-migration Base addresses,
    /// silently zeroing every launch-fee discount. Fail loud if it happens again.
    function test_Snapshot_LoyaltyOracle_PointsAtCanonicalEcosystemTokens() public view {
        LoyaltyOracle lo = LoyaltyOracle(LOYALTY_ORACLE);
        assertEq(lo.uruToken(), URU, "LoyaltyOracle.uruToken != canonical RH URU");
        assertEq(lo.gemuNft(), GEMU_NFT, "LoyaltyOracle.gemuNft != canonical RH GEMU");
    }

    /// Router must be wired to the LoyaltyOracle pin. Zero means every launch
    /// runs at full fee even when the caller qualifies for a discount.
    function test_Snapshot_Router_WiredToLoyaltyOracle() public view {
        assertEq(Router(payable(ROUTER_V7)).loyaltyOracle(), LOYALTY_ORACLE, "Router.loyaltyOracle != pin");
    }

    // NOTE: no `trustedDeployer[Router] == true` assertion on RoyaltyRouterFactory.
    // Router does not call the royalty factory today (no atomic royalty-router
    // materialization during launch). Any wallet that owns the freshly launched
    // collection can call `deployFor` post-launch and pass the owner-based auth
    // check without Router needing trusted-deployer status. Add this assertion
    // only if Router is later extended to materialize the clone during launch.

    /// Router.minUruFee must be non-zero. On 2026-08-01 an audit caught this
    /// left at 0 on live production, meaning any URU launch entrypoint would
    /// accept 1 wei of URU (only the amount==0 check remained). Fixed by
    /// setting to 1000 URU. Fail loud if it ever drifts back to 0.
    function test_Snapshot_MinUruFee_NonZero() public view {
        uint256 floor = Router(payable(ROUTER_V7)).minUruFee();
        assertGt(floor, 0, "Router.minUruFee is zero, spam gate wide open");
    }

    /// Retired-Airdrop poison state (broadcast 2026-08-01). The 3 retired
    /// Airdrop configHashes stayed sentineled on Router (setter is one-shot
    /// TRUE-only) and their rugged V1 impls stayed on the ERC20Factory
    /// (registerImpl is one-shot, updateImpl was removed). Live mitigation:
    /// setModuleCountForConfig(hash, type(uint256).max) causes the _quote
    /// fee calc to overflow → any Router.launch reverts before ETH is spent.
    /// This assertion locks in the poison; if anyone ever calls the setter
    /// with a real count for these hashes, the test fails and the attack
    /// path re-opens.
    /// V8 uses the newer `bannedConfigHash` mechanism (not the V6/V7 poison
    /// pattern of setting moduleCountForConfig to type(uint256).max). Both
    /// mechanisms achieve the same launch rejection but through different
    /// Router validation paths. `DeployFreshLocal` seeds bans via
    /// `setConfigHashBanned(hash, true)` for every hash in
    /// `RhConfigManifest.retiredAirdropHashes()` (which despite the name
    /// includes the Pausable V1 rug too). Read the ban set dynamically so a
    /// future manifest addition is picked up automatically.
    function test_Snapshot_RetiredAirdropHashesPoisoned() public view {
        Router r = Router(payable(ROUTER_V7));
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            assertTrue(
                r.bannedConfigHash(retired[i]), "retired hash lost its banned flag (attack path may be reopened)"
            );
        }
    }

    /// Every configHash the compile-service can produce MUST have both
    /// `moduleCountConfigured` and `flagsConfigured` set to true on Router,
    /// or launches via that hash revert closed with Router__ModuleCountMissing
    /// or Router__FlagsMissing. Read the canonical set dynamically from
    /// `RhConfigManifest.hashesAndCounts()` so any manifest addition is
    /// picked up automatically (round-6 added 10 pair combos; V8 seeds all
    /// 20 hashes in DeployFreshLocal). Prior hardcoded 12-hash list mixed
    /// legit canonicals with 3 retired hashes that live under
    /// `retiredAirdropHashes` on V8.
    function test_Snapshot_AllConfigHashesSeededOnRouter() public view {
        Router r = Router(payable(ROUTER_V7));
        (bytes32[] memory hashes,) = RhConfigManifest.hashesAndCounts();
        for (uint256 i = 0; i < hashes.length; i++) {
            assertTrue(r.moduleCountConfigured(hashes[i]), "moduleCountConfigured false for canonical hash");
            assertTrue(r.flagsConfigured(hashes[i]), "flagsConfigured false for canonical hash");
        }
    }
}
