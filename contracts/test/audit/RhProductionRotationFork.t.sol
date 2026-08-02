// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";

interface IFactoryLike {
    function router() external view returns (address);
    function setRouter(
        address
    ) external;
    function owner() external view returns (address);
}

interface ICurveFactoryLike {
    function trustedRouters(
        address
    ) external view returns (bool);
    function setTrustedRouter(
        address,
        bool
    ) external;
    function owner() external view returns (address);
}

/// @title  RhProductionRotationForkTest
/// @notice Auditor round 2 v5 required test: exercises the REAL two-phase
///         production rotation sequence.
///
///         Replicates the exact operations `DeployRouter.s.sol` (Phase 1
///         staging) and `ActivateRouter.s.sol` (Phase 2 atomic cutover)
///         perform — same setter calls in the same order.
///
///         Coverage matches every bullet in the auditor's "Required
///         production-rotation test" list:
///
///           1. Old Router continues quoting during the pending window
///           2. New Router cannot reserve() while proposal is pending
///           3. All 3 retired hashes banned on new Router before it goes live
///           4. Each retired hash reverts through all 4 launch entrypoints
///              on the new Router
///           5. Canonical ETH launch quote succeeds on new Router post-cutover
///           6. Factory pointers, CurveFactory trust, old-Router pause state
///              all consistent after cutover
///           7. NameRegistry.pendingRouter flow: proposal → timelock →
///              activate flip cleanly (validated in a fresh-registry sub-test)
///
///         LIVE-STATE CAVEAT
///         The deployed RH NameRegistry (0x60b7…118C) pre-dates the
///         `proposeRouter` / `activateRouter` two-phase mechanism (it only
///         has the legacy single-step `setRouter`, which rejects rotation
///         once `router != 0`). This means:
///           • Any real V8 Router rotation on RH must ALSO include a fresh
///             NameRegistry deploy + reservation migration.
///           • Against the live registry, `_runPhase1RotationLegs()` skips
///             the `proposeRouter` call and asserts only what's live-safe.
///           • The `test_FreshRegistry_RotationFlow_*` sub-tests deploy a
///             fresh 2-phase registry and drive the full source-level
///             rotation there — this is what actually validates the
///             DeployRouter + ActivateRouter code.
///
///         Skips cleanly when ROBINHOOD_RPC_URL isn't set / chain isn't RH.
contract RhProductionRotationForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live V7 pins (mirror RhLiveStackSnapshot.t.sol)
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant OLD_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    uint256 internal constant MIN_URU_FEE_STAGE = 1000e18;
    bytes32 internal constant HASH_BARE = 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb;

    address internal erc721AFactory;
    address internal erc1155Factory;

    Router internal oldRouter;
    Router internal newRouter;
    UruDepositSink internal newSink;

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
        if (OLD_ROUTER.code.length == 0) vm.skip(true);

        oldRouter = Router(payable(OLD_ROUTER));
        erc721AFactory = oldRouter.factories(BaseType.ERC721A);
        erc1155Factory = oldRouter.factories(BaseType.ERC1155);
    }

    // -------------------------------------------------------------
    // Phase 1 helper — mirrors DeployRouter.s.sol staging, minus the
    // proposeRouter call that the live single-step registry doesn't
    // support. The proposeRouter path IS tested separately via
    // _runPhase1WithFreshRegistry / the FreshRegistry tests below.
    // -------------------------------------------------------------
    function _runPhase1LiveRegistry() internal {
        uint256 erc20Fee = oldRouter.fees(BaseType.ERC20);
        uint256 nftFee = oldRouter.fees(BaseType.ERC721A);
        uint256 erc1155Fee = oldRouter.fees(BaseType.ERC1155);
        uint256 moduleAddOn = oldRouter.moduleAddOnFee();
        uint256 hookAddOn = oldRouter.hookAddOnFee();
        uint256 govAddOn = oldRouter.governanceAddOnFee();

        vm.startPrank(DEPLOYER);

        newSink = new UruDepositSink(DEPLOYER, URU, FEE_SPLITTER, 2 days);
        // New Router points at the LIVE (single-step) registry — same as any
        // real rotation would if we DIDN'T migrate the registry. Reserves via
        // this Router would revert with NotRouter (live.router == OLD_ROUTER),
        // which is exactly the split-brain condition the auditor flagged.
        newRouter = new Router(
            DEPLOYER,
            NameRegistry(NAME_REGISTRY),
            IFeeReceiver(FEE_SPLITTER),
            erc20Fee,
            nftFee,
            erc1155Fee,
            moduleAddOn,
            hookAddOn,
            govAddOn
        );
        newRouter.setUruConfig(URU, address(newSink));
        newRouter.setMinUruFee(MIN_URU_FEE_STAGE);
        newRouter.setFactory(BaseType.ERC20, ERC20_FACTORY);
        newRouter.setFactory(BaseType.ERC721A, erc721AFactory);
        newRouter.setFactory(BaseType.ERC1155, erc1155Factory);
        newRouter.setCurveFactory(CURVE_FACTORY);
        newRouter.setLoyaltyOracle(LOYALTY_ORACLE);

        (bytes32[] memory hashes, uint256[] memory counts) = RhConfigManifest.hashesAndCounts();
        (, uint256[] memory flags) = RhConfigManifest.hashesAndFlags();
        newRouter.setModuleCountForConfigBatch(hashes, counts);
        newRouter.setFlagsForConfigBatch(hashes, flags);

        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            newRouter.setConfigHashBanned(retired[i], true);
        }

        ICurveFactoryLike(CURVE_FACTORY).setTrustedRouter(address(newRouter), true);

        vm.stopPrank();
    }

    /// Phase 2 subset that works against the live registry — no
    /// activateRouter (registry doesn't support 2-phase). Factory rewires +
    /// CurveFactory trust flip + old-Router pause still validate the
    /// atomic-cutover ordering from ActivateRouter.s.sol.
    function _runPhase2LiveRegistry() internal {
        vm.startPrank(DEPLOYER);
        IFactoryLike(ERC20_FACTORY).setRouter(address(newRouter));
        IFactoryLike(erc721AFactory).setRouter(address(newRouter));
        IFactoryLike(erc1155Factory).setRouter(address(newRouter));
        ICurveFactoryLike(CURVE_FACTORY).setTrustedRouter(OLD_ROUTER, false);
        oldRouter.setPaused(true);
        vm.stopPrank();
    }

    // -------------------------------------------------------------
    // 1. Old Router keeps quoting during pending window (no outage)
    // -------------------------------------------------------------
    function test_PendingWindow_OldRouterStillQuotes() public {
        _runPhase1LiveRegistry();
        LaunchParams memory p = _bareParams("Old Path", "OLDP1");
        uint256 fee = oldRouter.quote(p);
        assertGt(fee, 0, "old Router quote should still succeed during pending window");
    }

    /// The critical outage-guard invariant: factories must STILL be wired to
    /// old Router during the pending window. Auditor's blocker #2.
    function test_PendingWindow_FactoriesStillPointAtOldRouter() public {
        _runPhase1LiveRegistry();
        assertEq(IFactoryLike(ERC20_FACTORY).router(), OLD_ROUTER, "ERC20Factory rewired prematurely");
        assertEq(IFactoryLike(erc721AFactory).router(), OLD_ROUTER, "ERC721AFactory rewired prematurely");
        assertEq(IFactoryLike(erc1155Factory).router(), OLD_ROUTER, "ERC1155Factory rewired prematurely");
    }

    /// CurveFactory trust must be ADDITIVE during Phase 1.
    function test_PendingWindow_BothRoutersTrustedOnCurveFactory() public {
        _runPhase1LiveRegistry();
        ICurveFactoryLike cf = ICurveFactoryLike(CURVE_FACTORY);
        assertTrue(cf.trustedRouters(OLD_ROUTER), "old Router un-trusted prematurely");
        assertTrue(cf.trustedRouters(address(newRouter)), "new Router not pre-trusted");
    }

    // -------------------------------------------------------------
    // 2. All 3 retired hashes banned on new Router BEFORE going live
    // -------------------------------------------------------------
    function test_PendingWindow_AllRetiredHashesBannedOnNewRouter() public {
        _runPhase1LiveRegistry();
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            assertTrue(
                newRouter.bannedConfigHash(retired[i]), "retired hash not banned on new Router before activation"
            );
        }
        assertTrue(newRouter.moduleCountConfigured(HASH_BARE), "bare hash sentinel missing");
        assertTrue(newRouter.flagsConfigured(HASH_BARE), "bare flags sentinel missing");
    }

    // -------------------------------------------------------------
    // 3. Each retired hash reverts on all 4 entrypoints of new Router
    //     (post-cutover — factories now point at new Router)
    // -------------------------------------------------------------
    function test_RetiredHashRevertsAllFourEntrypoints() public {
        _runPhase1LiveRegistry();
        _runPhase2LiveRegistry();

        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            _assertBanRevertsAllEntrypoints(retired[i]);
        }
    }

    function _assertBanRevertsAllEntrypoints(
        bytes32 bannedHash
    ) internal {
        LaunchParams memory p = _bareParams("Ban Test", "BANX");
        p.configHash = bannedHash;

        address launcher = makeAddr("ban-test-launcher");
        vm.deal(launcher, 100 ether);

        // 1) launch()
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, bannedHash));
        vm.prank(launcher, launcher);
        newRouter.launch{value: 1 ether}(p);

        // 2) launchWithURU()
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, bannedHash));
        vm.prank(launcher, launcher);
        newRouter.launchWithURU(p, MIN_URU_FEE_STAGE);

        // 3) launchWithWhitelist()
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, bannedHash));
        vm.prank(launcher, launcher);
        newRouter.launchWithWhitelist{value: 1 ether}(p, _wl());

        // 4) launchWithURUAndWhitelist()
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, bannedHash));
        vm.prank(launcher, launcher);
        newRouter.launchWithURUAndWhitelist(p, MIN_URU_FEE_STAGE, _wl());
    }

    // -------------------------------------------------------------
    // 4. Canonical ETH launch quote succeeds on new Router after cutover
    // -------------------------------------------------------------
    function test_PostCutover_CanonicalEthQuoteWorks() public {
        _runPhase1LiveRegistry();
        _runPhase2LiveRegistry();

        LaunchParams memory p = _bareParams("Post Cutover", "PSTC");
        uint256 fee = newRouter.quote(p);
        assertGt(fee, 0, "post-cutover canonical quote must succeed");
    }

    // -------------------------------------------------------------
    // 5. Full cross-wire consistency after cutover
    // -------------------------------------------------------------
    function test_PostCutover_AllWiresPointAtNewRouter() public {
        _runPhase1LiveRegistry();
        _runPhase2LiveRegistry();

        assertEq(IFactoryLike(ERC20_FACTORY).router(), address(newRouter), "ERC20Factory not rewired");
        assertEq(IFactoryLike(erc721AFactory).router(), address(newRouter), "ERC721AFactory not rewired");
        assertEq(IFactoryLike(erc1155Factory).router(), address(newRouter), "ERC1155Factory not rewired");
        ICurveFactoryLike cf = ICurveFactoryLike(CURVE_FACTORY);
        assertFalse(cf.trustedRouters(OLD_ROUTER), "old Router still trusted");
        assertTrue(cf.trustedRouters(address(newRouter)), "new Router lost trust");
        assertTrue(oldRouter.paused(), "old Router not paused");
    }

    function test_PostCutover_RetiredHashesStillBanned() public {
        _runPhase1LiveRegistry();
        _runPhase2LiveRegistry();

        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            assertTrue(newRouter.bannedConfigHash(retired[i]), "ban lost across activation");
        }
    }

    /// Zero-outage invariant: quotes must always resolve somewhere.
    function test_ZeroOutage_QuoteAvailableThroughoutRotation() public {
        LaunchParams memory p = _bareParams("Continuous", "CONT");
        assertGt(oldRouter.quote(p), 0, "quote fails before Phase 1");

        _runPhase1LiveRegistry();
        assertGt(oldRouter.quote(p), 0, "quote fails during pending window");

        _runPhase2LiveRegistry();
        assertGt(newRouter.quote(p), 0, "quote fails post-cutover on new Router");
        assertTrue(oldRouter.paused(), "old Router not paused post-cutover");
    }

    // ================================================================
    // Fresh-registry sub-tests: the LIVE registry pre-dates
    // proposeRouter / activateRouter, so the full source-level rotation
    // flow (with 2-day timelock) is validated against a fresh registry
    // deployed here. This is what a future V8 rotation with a registry
    // migration would look like end-to-end.
    // ================================================================

    /// Deploys a fresh 2-phase NameRegistry (owned by DEPLOYER), plus a fresh
    /// old Router wired to it. Returns (freshRegistry, freshOldRouter, freshNewRouter).
    /// The fresh old Router simulates "the currently-live Router" for the
    /// purposes of exercising proposeRouter → activateRouter.
    function _bootstrapFreshRegistryPair() internal returns (NameRegistry reg, Router freshOld, Router freshNew) {
        vm.startPrank(DEPLOYER);
        string[] memory noTickers = new string[](0);
        reg = new NameRegistry(DEPLOYER, DEPLOYER, noTickers);

        freshOld = new Router(
            DEPLOYER,
            reg,
            IFeeReceiver(FEE_SPLITTER),
            oldRouter.fees(BaseType.ERC20),
            oldRouter.fees(BaseType.ERC721A),
            oldRouter.fees(BaseType.ERC1155),
            oldRouter.moduleAddOnFee(),
            oldRouter.hookAddOnFee(),
            oldRouter.governanceAddOnFee()
        );
        // Greenfield setRouter wires the fresh old Router as active.
        reg.setRouter(address(freshOld));

        // Deploy the fresh NEW Router pointing at the same fresh registry.
        freshNew = new Router(
            DEPLOYER,
            reg,
            IFeeReceiver(FEE_SPLITTER),
            oldRouter.fees(BaseType.ERC20),
            oldRouter.fees(BaseType.ERC721A),
            oldRouter.fees(BaseType.ERC1155),
            oldRouter.moduleAddOnFee(),
            oldRouter.hookAddOnFee(),
            oldRouter.governanceAddOnFee()
        );
        vm.stopPrank();
    }

    function test_FreshRegistry_ProposeThenTimelock() public {
        (NameRegistry reg, Router freshOld, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));

        assertEq(reg.pendingRouter(), address(freshNew), "proposal not recorded");
        assertEq(reg.router(), address(freshOld), "router prematurely rotated");
        assertEq(reg.pendingRouterTs(), block.timestamp + reg.MIN_ROUTER_DELAY(), "timelock ts wrong");

        // Attempt to activate too early: reverts with RouterDelayNotPassed.
        // NOTE: order matters — vm.expectRevert MUST come BEFORE vm.prank so
        // the prank applies to the reg.activateRouter() call, not the
        // vm.expectRevert cheatcode itself.
        uint256 readyAt = reg.pendingRouterTs();
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__RouterDelayNotPassed.selector, readyAt));
        vm.prank(DEPLOYER);
        reg.activateRouter();
    }

    function test_FreshRegistry_ActivateAfterTimelock() public {
        (NameRegistry reg, Router freshOld, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));
        vm.warp(reg.pendingRouterTs() + 1);

        vm.prank(DEPLOYER);
        reg.activateRouter();

        assertEq(reg.router(), address(freshNew), "router did not rotate on activation");
        assertEq(reg.pendingRouter(), address(0), "pending not cleared");
        // Old Router loses the ability to reserve — proof cutover completed.
        vm.prank(address(freshOld));
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        reg.reserve("Attempted", "OLDX", address(0xdead), address(0xbeef));
    }

    function test_FreshRegistry_PendingRouterCannotReserve() public {
        (NameRegistry reg,, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));
        // During the pending window, only the CURRENT router can reserve.
        vm.prank(address(freshNew));
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        reg.reserve("Should Fail", "NEWX", address(0xdead), address(0xbeef));
    }

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    function _bareParams(
        string memory name,
        string memory ticker
    ) internal pure returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name;
        p.ticker = ticker;
        p.configHash = HASH_BARE;
        p.initData = "";
        p.installBondingCurve = false;
        p.installHook = false;
        p.installGovernance = false;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.ownership = OwnershipMode.KeepEOA;
        p.ownerTargetIfMultisig = address(0);
    }

    function _wl() internal view returns (BondingCurve.WhitelistInit memory) {
        return BondingCurve.WhitelistInit({
            root: bytes32(0),
            reservedTokens: 0,
            maxWlPerAddress: 0,
            fallbackTs: uint64(block.timestamp + 1 hours),
            sourceTokenAddress: address(0),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 0
        });
    }
}
