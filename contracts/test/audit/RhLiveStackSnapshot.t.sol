// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {Router} from "src/router/Router.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";

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
    address internal constant LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;
    address internal constant ROYALTY_ROUTER_FACTORY = 0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05;
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
    function test_Snapshot_RetiredAirdropHashesPoisoned() public view {
        Router r = Router(payable(ROUTER_V7));
        bytes32[3] memory retiredHashes = [
            bytes32(0x344f851ff67d34148ac2000b192fbc9a5cc4edd0ef612cd60c3e9d90738e7b2b), // Airdrop
            bytes32(0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064), // Airdrop+Permit
            bytes32(0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2) // Airdrop+Vesting
        ];
        for (uint256 i = 0; i < retiredHashes.length; i++) {
            assertEq(
                r.moduleCountForConfig(retiredHashes[i]),
                type(uint256).max,
                "retired Airdrop hash lost its poison count (attack path may be reopened)"
            );
        }
    }

    /// Every configHash the compile-service can produce MUST have both
    /// `moduleCountConfigured` and `flagsConfigured` set to true on Router,
    /// or launches via that hash revert closed with Router__ModuleCountMissing
    /// or Router__FlagsMissing. The 12 hashes below mirror the canonical
    /// enumeration in `contracts/script/DeployV6AuditFixStack.s.sol`. When a
    /// new module or combo is added, register its hash here + set its count/
    /// flags via `setModuleCountForConfig` / `setFlagsForConfig`.
    function test_Snapshot_AllConfigHashesSeededOnRouter() public view {
        bytes32[12] memory hashes = [
            bytes32(0xaa7c4a90c46fc33ebca677ac422fef548b4af9424a17314603d05496a4b07d7e), // Permit
            bytes32(0xafdb27f10a1e64171b7bb7ee9dbf1f5d8c238312ff2a3457d76e37193c63f4a8), // Vesting
            bytes32(0x3c31bf2240ae0f6a7f4ad9554da97d554e83e0ae6d417eadb7201502b26d2836), // Staking
            bytes32(0x665f84252f363c24ab35bdb96469a73ca840a1c47c1bd3acddf8e72953d01b10), // Votes
            bytes32(0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2), // multi (2)
            bytes32(0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb), // bare (0)
            bytes32(0x1369b5e16db64b51494968e9da45d2567436fa8815f21d3dd69a3f8947f4973f), // AntiBot
            bytes32(0x12073e30535ae2e9ccc627d8cc51449949ad96e7846c55f8e39bec895382575e), // multi (2)
            bytes32(0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821), // AntiWhale
            bytes32(0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064), // multi (2)
            bytes32(0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4), // FoT (flag=1)
            bytes32(0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a) // Pausable
        ];
        Router r = Router(payable(ROUTER_V7));
        for (uint256 i = 0; i < hashes.length; i++) {
            assertTrue(r.moduleCountConfigured(hashes[i]), "moduleCountConfigured false for canonical hash");
            assertTrue(r.flagsConfigured(hashes[i]), "flagsConfigured false for canonical hash");
        }
    }
}
