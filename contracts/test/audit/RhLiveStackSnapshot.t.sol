// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {Router} from "src/router/Router.sol";
import {GraduatorV3} from "src/curve/GraduatorV3.sol";
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
///             4. CF.implementation == BONDING_CURVE_IMPL pin.
///             5. CF.graduator == GRADUATOR pin.
///             6. Graduator.curveFactory == CF pin.
///             7. Graduator.defaultHook == MHH pin.
///             8. MHH.initializer == GRADUATOR pin.
///             9. Every owner matches the deployer pin.
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
    // V10 CurveFactory + BondingCurve impl + Router are unchanged since 2026-08-12.
    // MHH + Graduator rotated later that day: V11 MHH (0x83d6fa59) + GraduatorV3
    // (0xB5aA5Fb4) replaced V10 MHH (0x48C22af8) + V10 Graduator (0xA29Ee1DB).
    // GraduatorV3 seeds the v4 pool at the curve marginal price and burns excess
    // tokens (pump.fun style) so early curve buyers don't see a ~50% cliff when
    // trading opens on Uniswap. Because MHH.setInitializer is one-shot locked,
    // rotating the Graduator required a fresh MHH deployment too.
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x965Aa2420635Ca0431888c6752b9aE8Bbe8d1F05;
    address internal constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address internal constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address internal constant BONDING_CURVE_IMPL = 0x616462099AE1a40DA8327D2af2797c540507DBB2;
    address internal constant MULTI_HOOK_HOST = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;
    address internal constant GRADUATOR = 0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x60835C422a3671b5F01E6806Fd96b27c90941C83;
    address internal constant V4_SWAP_ROUTER = 0xDb3D1C43225faEe04551b663E5aA0969937beEa4;
    address internal constant ERC20_FACTORY = 0xfCfE7Db4F4d4ed6CC2fa6143a8C163Da11246f99;
    address internal constant LOYALTY_ORACLE = 0xDcAd73EB96Bd0573b6ed0Ac3FFA32b1A7e0C0b52;
    address internal constant ROYALTY_ROUTER_FACTORY = 0xd9439BA974108af90E84fABFc206b63f6b70cAF1;
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
        assertGt(ROUTER.code.length, 0, "Router pin has no code");
        assertGt(CURVE_FACTORY.code.length, 0, "CurveFactory pin has no code");
        assertGt(BONDING_CURVE_IMPL.code.length, 0, "BondingCurve impl pin has no code");
        assertGt(MULTI_HOOK_HOST.code.length, 0, "MHH pin has no code");
        assertGt(GRADUATOR.code.length, 0, "Graduator pin has no code");
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager pin has no code");
        assertGt(FEE_SPLITTER.code.length, 0, "FeeSplitter pin has no code");
        assertGt(V4_SWAP_ROUTER.code.length, 0, "V4SwapRouter pin has no code");
        assertGt(ERC20_FACTORY.code.length, 0, "ERC20Factory pin has no code");
    }

    function test_Snapshot_Router_PointsAtCurveFactoryPin() public view {
        assertEq(Router(payable(ROUTER)).curveFactory(), CURVE_FACTORY, "Router.curveFactory != pin");
    }

    function test_Snapshot_CurveFactory_TrustsRouterAndPointsAtGraduatorPin() public view {
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        assertTrue(cf.trustedRouters(ROUTER), "CF trustedRouters[Router] false");
        assertEq(cf.graduator(), GRADUATOR, "CF.graduator != pin");
    }

    /// The 2026-08-12 root cause: V10 CF was deployed correctly but pointed at
    /// a stale (orphaned) BondingCurve impl in an early build. Anchor here so
    /// a future rotation that forgets to redeploy the impl fails loud.
    function test_Snapshot_CurveFactory_ImplementationPinMatches() public view {
        assertEq(CurveFactory(CURVE_FACTORY).implementation(), BONDING_CURVE_IMPL, "CF.implementation != pin");
    }

    function test_Snapshot_Graduator_PointsAtCFAndMhhPins() public view {
        GraduatorV3 g = GraduatorV3(payable(GRADUATOR));
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
        assertEq(Router(payable(ROUTER)).owner(), DEPLOYER, "Router.owner != deployer");
        assertEq(GraduatorV3(payable(GRADUATOR)).owner(), DEPLOYER, "Graduator.owner != deployer");
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
        assertEq(Router(payable(ROUTER)).loyaltyOracle(), LOYALTY_ORACLE, "Router.loyaltyOracle != pin");
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
    /// setting to type(uint256).max as a live DoS mitigation while URU-A10
    /// implementation ships. Fail loud if it ever drifts back to 0.
    function test_Snapshot_MinUruFee_NonZero() public view {
        uint256 floor = Router(payable(ROUTER)).minUruFee();
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
    /// V8 and V9 use the newer `bannedConfigHash` mechanism (not the V6/V7
    /// poison pattern of setting moduleCountForConfig to type(uint256).max).
    /// Both mechanisms achieve the same launch rejection but through different
    /// Router validation paths. `DeployFreshLocal` seeds bans via
    /// `setConfigHashBanned(hash, true)` for every hash in
    /// `RhConfigManifest.retiredAirdropHashes()` (which despite the name
    /// includes the Pausable V1 rug too). Read the ban set dynamically so a
    /// future manifest addition is picked up automatically.
    function test_Snapshot_RetiredAirdropHashesPoisoned() public view {
        Router r = Router(payable(ROUTER));
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
        Router r = Router(payable(ROUTER));
        (bytes32[] memory hashes,) = RhConfigManifest.hashesAndCounts();
        for (uint256 i = 0; i < hashes.length; i++) {
            assertTrue(r.moduleCountConfigured(hashes[i]), "moduleCountConfigured false for canonical hash");
            assertTrue(r.flagsConfigured(hashes[i]), "flagsConfigured false for canonical hash");
        }
    }
}
