// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {RhConfigManifest} from "./manifest/RhConfigManifest.sol";

interface INameRegistry {
    function router() external view returns (address);
    function pendingRouter() external view returns (address);
    function pendingRouterTs() external view returns (uint256);
    function activateRouter() external;
    function owner() external view returns (address);
}

interface IFactoryLike {
    function setRouter(
        address newRouter
    ) external;
    function router() external view returns (address);
    function owner() external view returns (address);
}

interface ICurveFactoryLike {
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function trustedRouters(
        address
    ) external view returns (bool);
    function owner() external view returns (address);
}

/// @title  ActivateRouter — Phase 2 of a Router rotation
/// @notice The atomic cutover that follows `DeployRouter.s.sol` Phase 1 staging.
///         Phase 1 staged the new Router silently: sentinels seeded, retired
///         hashes banned, CurveFactory pre-trusted, `proposeRouter` on
///         NameRegistry (2-day timelock). Factories were NOT touched — the
///         OLD Router keeps taking launches throughout the pending window.
///
///         Phase 2 (this script) does everything else in ONE broadcast so the
///         cutover window is a single block, not two days:
///
///           0. Preflight (all reverts before any state change):
///              - pendingRouter matches env
///              - timelock elapsed
///              - new Router has all 10 manifest sentinels seeded
///              - new Router has all 3 retired-Airdrop hashes banned
///              - new Router owned by broadcaster (setPaused later requires it)
///              - all factories + CurveFactory owned by broadcaster
///
///           1. `factory.setRouter(new)` for ERC20 / ERC721A / ERC1155
///           2. `curveFactory.setTrustedRouter(old, false)` (untrust old)
///           3. `nameRegistry.activateRouter()`
///           4. `oldRouter.setPaused(true)` (best-effort — only if we own it
///              AND `SKIP_PAUSE_OLD_ROUTER != 1`)
///           5. Post-cutover verify: every wire agrees, address book flipped
///              to LIVE. Reverts on drift.
///
///         Recommended execution: broadcast as a single multisig batch. Any
///         intermediate revert unwinds the whole batch, so the split-brain
///         window is exactly the transaction ordering INSIDE one atomic
///         execution — zero user-visible outage.
///
///         Env:
///           ROBINHOOD_NAME_REGISTRY_ADDRESS  (required)
///           ROBINHOOD_ROUTER_ADDRESS         (required — must match pending)
///           ROBINHOOD_OLD_ROUTER_ADDRESS     (required — for pause + untrust)
///           ROBINHOOD_ERC20_FACTORY_ADDRESS     (required)
///           ROBINHOOD_ERC721A_FACTORY_ADDRESS   (required)
///           ROBINHOOD_ERC1155_FACTORY_ADDRESS   (required)
///           ROBINHOOD_CURVE_FACTORY_ADDRESS     (required — WL-aware CF if migrated)
///           SKIP_PAUSE_OLD_ROUTER              "1" to skip pausing (default: pause)
///
///         Run:
///           source .env && bash contracts/deploy.sh ActivateRouter robinhood
contract ActivateRouter is Script {
    /// URU-P1-B02: production `run()` is intentionally disabled. `forge script
    /// --broadcast` emits one transaction per external call, so a mid-batch
    /// revert would leave the launchpad in a half-cut-over state (some
    /// factories rewired, others still pointing at the old Router — a fully
    /// split brain). Operators must build the atomic Safe MultiSendCallOnly
    /// payload via `BuildRouterCutoverSafeBatch.s.sol` and submit it as ONE
    /// Safe delegatecall transaction. `runForTest` remains available for
    /// in-process fork rehearsals only, and hard-reverts on the RH production
    /// chain unless `ALLOW_UNSAFE_CUTOVER=1` is explicitly set.
    error ActivateRouter__UnsafeDirectBroadcastDisabled();
    error ActivateRouter__ProductionChainUnsafe(uint256 chainId);

    /// RH production chain id. `runForTest` refuses to execute against this
    /// chain unless an emergency env override is present.
    uint256 internal constant RH_PROD_CHAIN_ID = 4663;

    // Preflight errors
    error ActivateRouter__NoPendingRouter(address registry);
    error ActivateRouter__PendingMismatch(address expectedRouter, address actualPending);
    error ActivateRouter__TimelockNotPassed(uint256 readyAt);
    error ActivateRouter__ManifestNotSeeded(bytes32 configHash, string what);
    error ActivateRouter__RetiredHashNotBanned(bytes32 configHash);
    error ActivateRouter__NotOwner(address contractAddr, string what);
    error ActivateRouter__OldRouterNotBroadcasterOwned();
    // Post-cutover errors
    error ActivateRouter__PostFactoryMismatch(address factory, address expected);
    error ActivateRouter__PostRegistryMismatch(address expected);
    error ActivateRouter__PostCurveTrustMismatch(address router_, bool expected);

    /// Test-only overrides supplied by `runForTest`. Every env-sourced address
    /// the production `run()` reads has a slot here so a forge test can drive
    /// the full atomic cutover against a live fork without touching env. `admin`
    /// is the address to prank under (must own registry + factories + old
    /// router if skipPauseOld == false). Ignored when `_isTestContext == false`.
    struct TestArgs {
        address nameRegistry;
        address newRouter;
        address oldRouter;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        address admin;
        bool skipPauseOld;
    }

    /// Test-context flag flipped by runForTest(). Swaps vm.startBroadcast for
    /// vm.startPrank(admin). See `test/audit/RhRotationRehearsalFork.t.sol`.
    bool internal _isTestContext;
    TestArgs internal _testArgs;

    /// Production execution is intentionally disabled — see
    /// `ActivateRouter__UnsafeDirectBroadcastDisabled`. Use
    /// `BuildRouterCutoverSafeBatch.s.sol` and submit the generated payload as
    /// one Safe delegatecall to MultiSendCallOnly. `runForTest` remains
    /// available for in-process semantic rehearsals only.
    function run() external pure {
        revert ActivateRouter__UnsafeDirectBroadcastDisabled();
    }

    /// Test-mode entrypoint. Bypasses env reads by passing every address
    /// through TestArgs; swaps vm.startBroadcast for vm.startPrank(admin) so
    /// owner-only cutover setters against LIVE contracts resolve against the
    /// admin the fork already knows. Skips `_flipAddressBookToLive` so the
    /// on-disk `deployment-routerv2.<chainid>.json` isn't clobbered by a fork
    /// run.
    function runForTest(
        TestArgs memory a
    ) external {
        // URU-A17 F7: even in "test" mode, refuse to touch the RH prod chain
        // unless an operator has explicitly set ALLOW_UNSAFE_CUTOVER=1. Guards
        // against forge script --sig 'runForTest((address,...))' --broadcast
        // being used as a bypass around the run()-disabled Safe cutover path.
        if (block.chainid == RH_PROD_CHAIN_ID) {
            if (vm.envOr("ALLOW_UNSAFE_CUTOVER", uint256(0)) != 1) {
                revert ActivateRouter__ProductionChainUnsafe(block.chainid);
            }
        }
        _isTestContext = true;
        _testArgs = a;
        _runInner();
    }

    function _startBroadcastOrPrank(
        address who
    ) internal {
        if (_isTestContext) vm.startPrank(who);
        else vm.startBroadcast();
    }

    function _stopBroadcastOrPrank() internal {
        if (_isTestContext) vm.stopPrank();
        else vm.stopBroadcast();
    }

    function _runInner() internal {
        address registryAddr;
        address expectedRouter;
        address oldRouter;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        address admin;
        bool skipPause;

        if (_isTestContext) {
            TestArgs memory a = _testArgs;
            registryAddr = a.nameRegistry;
            expectedRouter = a.newRouter;
            oldRouter = a.oldRouter;
            erc20Factory = a.erc20Factory;
            erc721Factory = a.erc721Factory;
            erc1155Factory = a.erc1155Factory;
            curveFactory = a.curveFactory;
            admin = a.admin;
            skipPause = a.skipPauseOld;
        } else {
            registryAddr = vm.envAddress("ROBINHOOD_NAME_REGISTRY_ADDRESS");
            expectedRouter = vm.envAddress("ROBINHOOD_ROUTER_ADDRESS");
            oldRouter = vm.envAddress("ROBINHOOD_OLD_ROUTER_ADDRESS");
            erc20Factory = vm.envAddress("ROBINHOOD_ERC20_FACTORY_ADDRESS");
            erc721Factory = vm.envAddress("ROBINHOOD_ERC721A_FACTORY_ADDRESS");
            erc1155Factory = vm.envAddress("ROBINHOOD_ERC1155_FACTORY_ADDRESS");
            curveFactory = vm.envAddress("ROBINHOOD_CURVE_FACTORY_ADDRESS");
            skipPause = vm.envOr("SKIP_PAUSE_OLD_ROUTER", uint256(0)) == 1;
            admin = msg.sender;
        }

        _preflightWithSkip(
            registryAddr,
            expectedRouter,
            oldRouter,
            erc20Factory,
            erc721Factory,
            erc1155Factory,
            curveFactory,
            skipPause,
            admin
        );

        console2.log("---- Phase 2: atomic cutover ----");
        console2.log("  registry     :", registryAddr);
        console2.log("  new router   :", expectedRouter);
        console2.log("  old router   :", oldRouter);
        console2.log("  erc20 factory:", erc20Factory);
        console2.log("  erc721 factry:", erc721Factory);
        console2.log("  erc1155 fact.:", erc1155Factory);
        console2.log("  curve factory:", curveFactory);

        _startBroadcastOrPrank(admin);

        // 1) Rewire per-base factories. Each setRouter is a single-slot
        // overwrite — no rollback if a later step reverts, but the whole
        // multisig batch is atomic if signed as one.
        IFactoryLike(erc20Factory).setRouter(expectedRouter);
        console2.log("  [ok] setRouter on ERC20Factory");
        IFactoryLike(erc721Factory).setRouter(expectedRouter);
        console2.log("  [ok] setRouter on ERC721AFactory");
        IFactoryLike(erc1155Factory).setRouter(expectedRouter);
        console2.log("  [ok] setRouter on ERC1155Factory");

        // 2) Untrust old Router on CurveFactory. New Router was pre-trusted in
        // Phase 1, so cutting off the old one after factory rewire is safe —
        // no in-flight launch depends on the old Router still being trusted.
        ICurveFactoryLike(curveFactory).setTrustedRouter(oldRouter, false);
        console2.log("  [ok] setTrustedRouter(false) on CurveFactory for old Router");

        // 3) Flip NameRegistry pointer. Now every path — reserve() included —
        // routes through the new Router.
        INameRegistry(registryAddr).activateRouter();
        console2.log("  [ok] activateRouter on NameRegistry");

        // 4) Pause the old Router (unless explicitly skipped). Even without
        // factory or registry trust, an unpaused old Router still accepts
        // launch() calls that revert deep in the stack — pausing surfaces a
        // clean revert at the entrypoint instead.
        if (!skipPause) {
            Router(payable(oldRouter)).setPaused(true);
            console2.log("  [ok] setPaused(true) on old Router");
        } else {
            console2.log("  [skip] SKIP_PAUSE_OLD_ROUTER=1 - old Router left unpaused");
        }

        _stopBroadcastOrPrank();

        // 5) Post-cutover verify. Reverts on any wire that didn't land.
        _postCutoverVerify(
            registryAddr, expectedRouter, oldRouter, erc20Factory, erc721Factory, erc1155Factory, curveFactory
        );

        console2.log("");
        console2.log("======================================================");
        console2.log("Phase 2 complete - new Router is LIVE");
        console2.log("======================================================");
        // Skip on-disk address-book flip in test mode — the artifact is
        // shared, a fork rehearsal shouldn't clobber it.
        if (!_isTestContext) _flipAddressBookToLive();
    }

    // -------------------------------------------------------------
    // Preflight — all reverts BEFORE any state change
    // -------------------------------------------------------------

    /// Preflight variant that takes `skipPause` + `admin` explicitly so
    /// runForTest can share the same check surface as the production `run()`
    /// path. The production path resolves `admin = msg.sender` and
    /// `skipPause` from env before calling; test mode passes them through
    /// TestArgs. Callers MUST reach this before any state mutation.
    function _preflightWithSkip(
        address registryAddr,
        address expectedRouter,
        address oldRouter,
        address erc20Factory,
        address erc721Factory,
        address erc1155Factory,
        address curveFactory,
        bool skipPause,
        address admin
    ) internal view {
        // NameRegistry: pending must exist, match, and be past timelock
        INameRegistry reg = INameRegistry(registryAddr);
        address pending = reg.pendingRouter();
        if (pending == address(0)) revert ActivateRouter__NoPendingRouter(registryAddr);
        if (pending != expectedRouter) revert ActivateRouter__PendingMismatch(expectedRouter, pending);
        uint256 readyAt = reg.pendingRouterTs();
        if (block.timestamp < readyAt) revert ActivateRouter__TimelockNotPassed(readyAt);

        // Ownership: broadcaster must own everything Phase 2 mutates
        if (reg.owner() != admin) revert ActivateRouter__NotOwner(registryAddr, "nameRegistry.activateRouter");
        if (IFactoryLike(erc20Factory).owner() != admin) {
            revert ActivateRouter__NotOwner(erc20Factory, "erc20Factory.setRouter");
        }
        if (IFactoryLike(erc721Factory).owner() != admin) {
            revert ActivateRouter__NotOwner(erc721Factory, "erc721Factory.setRouter");
        }
        if (IFactoryLike(erc1155Factory).owner() != admin) {
            revert ActivateRouter__NotOwner(erc1155Factory, "erc1155Factory.setRouter");
        }
        if (ICurveFactoryLike(curveFactory).owner() != admin) {
            revert ActivateRouter__NotOwner(curveFactory, "curveFactory.setTrustedRouter");
        }
        // Old Router pause is best-effort but required by default — if the
        // broadcaster doesn't own it, either set SKIP_PAUSE_OLD_ROUTER=1 or
        // add the ownership handoff before Phase 2.
        if (!skipPause) {
            (bool ok, bytes memory ret) = oldRouter.staticcall(abi.encodeWithSignature("owner()"));
            if (!ok || ret.length < 32) revert ActivateRouter__OldRouterNotBroadcasterOwned();
            if (abi.decode(ret, (address)) != admin) revert ActivateRouter__OldRouterNotBroadcasterOwned();
        }

        // New Router: all manifest sentinels seeded + all retired hashes banned
        Router newRouter = Router(payable(expectedRouter));
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            if (!newRouter.moduleCountConfigured(e.configHash)) {
                revert ActivateRouter__ManifestNotSeeded(e.configHash, "moduleCountConfigured");
            }
            if (!newRouter.flagsConfigured(e.configHash)) {
                revert ActivateRouter__ManifestNotSeeded(e.configHash, "flagsConfigured");
            }
            if (newRouter.moduleCountForConfig(e.configHash) != e.moduleCount) {
                revert ActivateRouter__ManifestNotSeeded(e.configHash, "moduleCount value");
            }
            if (newRouter.flagsForConfig(e.configHash) != e.flags) {
                revert ActivateRouter__ManifestNotSeeded(e.configHash, "flags value");
            }
        }
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            if (!newRouter.bannedConfigHash(retired[i])) revert ActivateRouter__RetiredHashNotBanned(retired[i]);
        }
    }

    // -------------------------------------------------------------
    // Post-cutover verify — reverts on any wire that didn't land
    // -------------------------------------------------------------

    function _postCutoverVerify(
        address registryAddr,
        address expectedRouter,
        address oldRouter,
        address erc20Factory,
        address erc721Factory,
        address erc1155Factory,
        address curveFactory
    ) internal view {
        if (IFactoryLike(erc20Factory).router() != expectedRouter) {
            revert ActivateRouter__PostFactoryMismatch(erc20Factory, expectedRouter);
        }
        if (IFactoryLike(erc721Factory).router() != expectedRouter) {
            revert ActivateRouter__PostFactoryMismatch(erc721Factory, expectedRouter);
        }
        if (IFactoryLike(erc1155Factory).router() != expectedRouter) {
            revert ActivateRouter__PostFactoryMismatch(erc1155Factory, expectedRouter);
        }
        if (INameRegistry(registryAddr).router() != expectedRouter) {
            revert ActivateRouter__PostRegistryMismatch(expectedRouter);
        }
        ICurveFactoryLike cf = ICurveFactoryLike(curveFactory);
        if (!cf.trustedRouters(expectedRouter)) {
            revert ActivateRouter__PostCurveTrustMismatch(expectedRouter, true);
        }
        if (cf.trustedRouters(oldRouter)) {
            revert ActivateRouter__PostCurveTrustMismatch(oldRouter, false);
        }
    }

    function _flipAddressBookToLive() internal {
        string memory chainId = vm.toString(block.chainid);
        string memory outPath = string.concat("deployment-routerv2.", chainId, ".json");
        if (!vm.exists(outPath)) {
            console2.log("  [note] no existing", outPath, "to flip - skipping");
            return;
        }
        string memory obj = "routerv2-live";
        // Preserve prior addresses, overwrite status. We re-read the fields
        // to avoid clobbering keys that other tooling relies on.
        string memory prior = vm.readFile(outPath);
        vm.serializeUint(obj, "chainId", vm.parseJsonUint(prior, ".chainId"));
        vm.serializeAddress(obj, "UruDepositSink", vm.parseJsonAddress(prior, ".UruDepositSink"));
        vm.serializeAddress(obj, "FeeSplitter", vm.parseJsonAddress(prior, ".FeeSplitter"));
        vm.serializeAddress(obj, "RouterV2", vm.parseJsonAddress(prior, ".RouterV2"));
        string memory json = vm.serializeString(obj, "status", "LIVE");
        vm.writeJson(json, outPath);
        console2.log("  [ok] address book flipped to LIVE:", outPath);
    }
}
