// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";
import {RhConfigManifest} from "./manifest/RhConfigManifest.sol";

interface IFactoryLike {
    function setRouter(
        address newRouter
    ) external;
    function owner() external view returns (address);
    function router() external view returns (address);
}

interface ICurveFactoryLike {
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function owner() external view returns (address);
    function trustedRouters(
        address
    ) external view returns (bool);
}

interface INameRegistryLike {
    function setRouter(
        address newRouter
    ) external;
    function proposeRouter(
        address newRouter
    ) external;
    function activateRouter() external;
    function router() external view returns (address);
    function pendingRouter() external view returns (address);
    function pendingRouterTs() external view returns (uint256);
    function owner() external view returns (address);
    function MIN_ROUTER_DELAY() external view returns (uint256);
}

/// @notice **Phase 1 of a two-phase Router rotation.** Deploys `UruDepositSink`
///         + new `Router`, seeds all fail-closed sentinels, bans the retired
///         Airdrop configHashes, pre-trusts the new Router on CurveFactory
///         (mapping-based, additive — old Router stays trusted), and proposes
///         the new Router on NameRegistry.
///
///         **DOES NOT touch per-base factory Router pointers.** ERC20 /
///         ERC721A / ERC1155 factories keep pointing at the OLD Router so
///         users continue launching normally during the 2-day NameRegistry
///         timelock. `ActivateRouter.s.sol` performs the atomic cutover in
///         Phase 2 (factory rewires + activateRouter + old-Router pause), all
///         in one broadcast (recommended: single multisig batch) so the
///         cutover window is a single block, not two days.
///
///         Greenfield chains (registry.router == address(0)) execute the
///         wire atomically here — no old Router to preserve.
///
///         Reads:
///           - deployment.<chainid>.json           (Phase 1 address book — factories, registry, curve)
///           - deployment-flywheel.<chainid>.json  (FeeSplitter, LoyaltyOracle)
///
///         Env vars:
///           URU_TOKEN_ADDRESS   URU token to accept as fee (required)
///           MIN_URU_FEE         nonzero URU spam-gate floor (18 decimals, required —
///                               script reverts if 0 or unset; matches live RH value 1000e18)
///           ADMIN               initial owner of Router + UruDepositSink (defaults to sender)
///           ERC20_FEE           override fee for ERC20 launches (default: mirrors old Router)
///           NFT_FEE             override fee for ERC721A launches
///           ERC1155_FEE         override fee for ERC1155 launches
///           MODULE_ADDON_FEE    override module add-on fee
///           HOOK_ADDON_FEE      override hook add-on fee
///           GOV_ADDON_FEE       override governance add-on fee
///
///         Address book status:
///           - Greenfield  → status: ACTIVE
///           - Rotation    → status: PENDING_ACTIVATION (front-end + indexer
///             MUST NOT publish this Router until ActivateRouter completes)
///
/// Usage:
///   URU_TOKEN_ADDRESS=0x9fbe...9d24 \
///   MIN_URU_FEE=1000000000000000000000 \
///   bash contracts/deploy.sh Router robinhood
contract DeployRouter is Script {
    error DeployRouter__NoPhase1Book();
    error DeployRouter__NoFlywheelBook();
    /// MIN_URU_FEE env var missing or set to 0. URU launch entrypoints would
    /// accept 1 wei of URU with a zero floor; the audit rejects this outright.
    error DeployRouter__ZeroMinUruFee();
    /// A required owner-only wire (curve-factory trust, NameRegistry propose)
    /// could not be performed because the broadcaster does not own the target
    /// contract. Refuses to write a partial address book.
    error DeployRouter__AuthorizeSkipped(address contractAddr, string what);
    /// Post-broadcast assertion tripped — some manifest hash did not land its
    /// count/flags on the freshly deployed Router.
    error DeployRouter__ManifestSeedFailed(bytes32 configHash, string what);
    /// Post-broadcast assertion tripped — a retired-Airdrop hash isn't banned
    /// on the freshly deployed Router. Blocks the address book from being
    /// written; the auditor's blocker #1 that this script exists to close.
    error DeployRouter__RetiredHashNotBanned(bytes32 configHash);
    /// Post-broadcast assertion tripped — Router state does not match what
    /// the script just wrote. Should be impossible; guards against silent
    /// setter-reverts / RPC nonce anomalies.
    error DeployRouter__PostStateMismatch(string what);

    struct Deployed {
        address uruSink;
        address routerV2;
        address feeSplitter;
    }

    /// Test-only overrides supplied by `runForTest`. Every JSON- and env-sourced
    /// address the production `run()` path reads has a slot here so a forge
    /// test can drive the entire staging script against a live fork without
    /// touching disk or `vm.setEnv`. Ignored when `_isTestContext == false`.
    struct TestArgs {
        address oldRouter;
        address nameRegistry;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        address feeSplitter;
        address loyaltyOracle;
        address admin;
        address uruToken;
        uint256 minUruFee;
    }

    /// Test-context flag flipped by runForTest(). vm.startBroadcast is
    /// script-only; forge tests use vm.startPrank so the owner-context is
    /// controllable + no txs get sent. See `test/audit/RhRotationRehearsalFork.t.sol`.
    bool internal _isTestContext;
    TestArgs internal _testArgs;

    function run() external returns (Deployed memory out) {
        return _runInner();
    }

    /// Test-mode entrypoint. Bypasses JSON reads by passing every address
    /// through TestArgs; swaps vm.startBroadcast for vm.startPrank(admin) so
    /// owner-only setters against LIVE contracts resolve against the admin
    /// the fork already knows. Skips address-book writes so the on-disk
    /// `deployment-routerv2.<chainid>.json` isn't clobbered by a fork run.
    function runForTest(
        TestArgs memory a
    ) external returns (Deployed memory out) {
        _isTestContext = true;
        _testArgs = a;
        return _runInner();
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

    function _runInner() internal returns (Deployed memory out) {
        address oldRouter;
        address registry;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        address feeSplitter;
        address loyaltyOracle;
        address admin;
        address uruToken;
        uint256 minUruFee;
        bool usingCurveFactoryV2;

        if (_isTestContext) {
            TestArgs memory a = _testArgs;
            oldRouter = a.oldRouter;
            registry = a.nameRegistry;
            erc20Factory = a.erc20Factory;
            erc721Factory = a.erc721Factory;
            erc1155Factory = a.erc1155Factory;
            curveFactory = a.curveFactory;
            feeSplitter = a.feeSplitter;
            loyaltyOracle = a.loyaltyOracle;
            admin = a.admin;
            uruToken = a.uruToken;
            minUruFee = a.minUruFee;
            if (minUruFee == 0) revert DeployRouter__ZeroMinUruFee();
        } else {
            string memory chainId = vm.toString(block.chainid);
            string memory phase1Path = string.concat("deployment.", chainId, ".json");
            string memory flywheelPath = string.concat("deployment-flywheel.", chainId, ".json");

            if (!vm.exists(phase1Path)) revert DeployRouter__NoPhase1Book();
            if (!vm.exists(flywheelPath)) revert DeployRouter__NoFlywheelBook();

            string memory phase1 = vm.readFile(phase1Path);
            string memory flywheel = vm.readFile(flywheelPath);

            oldRouter = vm.parseJsonAddress(phase1, ".Router");
            registry = vm.parseJsonAddress(phase1, ".NameRegistry");
            erc20Factory = vm.parseJsonAddress(phase1, ".ERC20Factory");
            erc721Factory = vm.parseJsonAddress(phase1, ".ERC721AFactory");
            erc1155Factory = vm.parseJsonAddress(phase1, ".ERC1155Factory");
            // Prefer the WL-aware CurveFactory when its book exists (see
            // SetChunkyDefaults). Falls back to the pre-WL CurveFactory from Phase1 for
            // deployments that haven't yet migrated.
            string memory curveFactoryV2Path = string.concat("deployment-curvefactoryv2.", chainId, ".json");
            if (vm.exists(curveFactoryV2Path)) {
                curveFactory = vm.parseJsonAddress(vm.readFile(curveFactoryV2Path), ".CurveFactory");
                usingCurveFactoryV2 = true;
            } else {
                curveFactory = vm.parseJsonAddress(phase1, ".CurveFactory");
            }
            feeSplitter = vm.parseJsonAddress(flywheel, ".FeeSplitter");
            loyaltyOracle = vm.parseJsonAddress(flywheel, ".LoyaltyOracle");

            admin = vm.envOr("ADMIN", msg.sender);
            uruToken = vm.envAddress("URU_TOKEN_ADDRESS");
            minUruFee = vm.envOr("MIN_URU_FEE", uint256(0));
            if (minUruFee == 0) revert DeployRouter__ZeroMinUruFee();
        }

        // Mirror fees from the pre-existing Router by default.
        Router old = Router(payable(oldRouter));
        uint256 erc20Fee = _isTestContext ? old.fees(BaseType.ERC20) : vm.envOr("ERC20_FEE", old.fees(BaseType.ERC20));
        uint256 nftFee = _isTestContext ? old.fees(BaseType.ERC721A) : vm.envOr("NFT_FEE", old.fees(BaseType.ERC721A));
        uint256 erc1155Fee =
            _isTestContext ? old.fees(BaseType.ERC1155) : vm.envOr("ERC1155_FEE", old.fees(BaseType.ERC1155));
        uint256 moduleAddOn = _isTestContext ? old.moduleAddOnFee() : vm.envOr("MODULE_ADDON_FEE", old.moduleAddOnFee());
        uint256 hookAddOn = _isTestContext ? old.hookAddOnFee() : vm.envOr("HOOK_ADDON_FEE", old.hookAddOnFee());
        uint256 govAddOn =
            _isTestContext ? old.governanceAddOnFee() : vm.envOr("GOV_ADDON_FEE", old.governanceAddOnFee());

        // Greenfield detection: no old Router wired on NameRegistry means we
        // can synchronously setRouter + rewire factories in this same tx.
        // Rotation path stops after propose (Phase 1); ActivateRouter picks it up.
        bool greenfield = INameRegistryLike(registry).router() == address(0);

        _startBroadcastOrPrank(admin);

        // Step 1: deploy the URU sink pointed at FeeSplitter for its ETH proceeds.
        UruDepositSink sink = new UruDepositSink(admin, uruToken, feeSplitter, 2 days);

        // Step 2: deploy Router pointed at FeeSplitter as its ETH-fee receiver
        // and at the sink for its URU-fee receiver.
        Router routerV2 = new Router(
            admin,
            NameRegistry(registry),
            IFeeReceiver(feeSplitter),
            erc20Fee,
            nftFee,
            erc1155Fee,
            moduleAddOn,
            hookAddOn,
            govAddOn
        );
        routerV2.setUruConfig(uruToken, address(sink));
        routerV2.setMinUruFee(minUruFee);

        // Step 3: wire Router's per-base factory pointers + curve factory +
        // loyalty oracle. These are Router-side pointers (Router → factory),
        // not factory-side (factory → Router). Setting them on the new Router
        // does NOT affect the old Router or its ability to keep serving
        // launches during the pending window.
        routerV2.setFactory(BaseType.ERC20, erc20Factory);
        routerV2.setFactory(BaseType.ERC721A, erc721Factory);
        routerV2.setFactory(BaseType.ERC1155, erc1155Factory);
        routerV2.setCurveFactory(curveFactory);
        routerV2.setLoyaltyOracle(loyaltyOracle);

        // Step 3b: seed the fail-closed sentinels (moduleCountConfigured /
        // flagsConfigured) for every configHash the front-end can produce.
        _seedManifestSentinels(routerV2);

        // Step 3c: ban every retired Airdrop configHash on the freshly-
        // deployed Router. WITHOUT this, a new Router boots with
        // `bannedConfigHash[h] == false` for every hash — and once the
        // operator later unpoisons `minUruFee` from type(uint256).max the
        // retired-Airdrop URU launch path re-opens. This is the auditor's
        // BLOCKER #1: automatic + verifiable, no manual setter tx afterward.
        _banRetiredHashes(routerV2);

        // Step 4: CurveFactory trust — additive. `trustedRouters` is a mapping,
        // so pre-trusting the new Router does NOT untrust the old one. The old
        // Router keeps serving until Phase 2 flips.
        _authorizeOnCurveFactoryStrict(curveFactory, address(routerV2), admin);

        bool nameRegistryActivated;
        if (greenfield) {
            // Greenfield: nothing to preserve — do the full atomic wire here.
            // Setting factory Router pointers is required for launches to work
            // at all; on greenfield there is no old Router that would break.
            _authorizeOnFactoryStrict(erc20Factory, address(routerV2), admin);
            _authorizeOnFactoryStrict(erc721Factory, address(routerV2), admin);
            _authorizeOnFactoryStrict(erc1155Factory, address(routerV2), admin);
            _setNameRegistryGreenfield(registry, address(routerV2), admin);
            nameRegistryActivated = true;
        } else {
            // Rotation: propose new Router on NameRegistry, do NOT touch
            // factories yet. ActivateRouter will atomically rewire factories +
            // activate the registry + pause the old Router in one broadcast.
            _proposeNameRegistryRotation(registry, address(routerV2), admin);
            nameRegistryActivated = false;
        }

        _stopBroadcastOrPrank();

        // Post-broadcast assertions. Runs before the address book is written
        // so operators cannot ship a Router with a missing ban.
        _assertPostState(routerV2, uruToken, address(sink), minUruFee);

        out = Deployed({uruSink: address(sink), routerV2: address(routerV2), feeSplitter: feeSplitter});

        _logSummary(out, oldRouter, admin, uruToken, greenfield);
        if (usingCurveFactoryV2) {
            console2.log("  [note] wired to WL-aware CurveFactory:", curveFactory);
        } else {
            console2.log("  [note] wired to legacy CurveFactory:", curveFactory);
            console2.log("         WL launches will revert until SetChunkyDefaults has been run.");
        }
        // Skip address-book writes in test mode — the on-disk artifact is
        // shared across scripts + other tests, and a fork rehearsal shouldn't
        // clobber it. Production `run()` still writes normally.
        if (!_isTestContext) _writeAddressBook(out, nameRegistryActivated);
    }

    /// `admin` is the address making the mutation — matches broadcaster in
    /// production (`msg.sender`) and the pranked owner in test context. Every
    /// owner-vs-`msg.sender` check the pre-refactor code used implicitly
    /// assumed msg.sender-in-internal-frame == the entity actually calling the
    /// external setter. That assumption breaks when a forge test calls
    /// `runForTest` (msg.sender-in-internal-frame = test contract; pranked
    /// external-call sender = admin). Threading admin explicitly keeps both
    /// paths honest.
    function _authorizeOnFactoryStrict(
        address factory,
        address routerV2,
        address admin
    ) internal {
        IFactoryLike f = IFactoryLike(factory);
        if (f.owner() != admin) revert DeployRouter__AuthorizeSkipped(factory, "factory.setRouter");
        f.setRouter(routerV2);
        console2.log("  [ok] setRouter on factory:", factory);
    }

    function _authorizeOnCurveFactoryStrict(
        address curveFactory,
        address routerV2,
        address admin
    ) internal {
        ICurveFactoryLike cf = ICurveFactoryLike(curveFactory);
        if (cf.owner() != admin) {
            revert DeployRouter__AuthorizeSkipped(curveFactory, "curveFactory.setTrustedRouter");
        }
        cf.setTrustedRouter(routerV2, true);
        console2.log("  [ok] setTrustedRouter(true) on CurveFactory for new Router (additive)");
    }

    /// Greenfield NameRegistry wire — synchronous setRouter (registry accepts
    /// only when `router == address(0)`; any second call reverts). Also clears
    /// any accidental pending proposal that may have been made during a
    /// deploy race. Reverts if the broadcaster isn't the owner.
    function _setNameRegistryGreenfield(
        address registry_,
        address newRouter,
        address admin
    ) internal {
        INameRegistryLike reg = INameRegistryLike(registry_);
        if (reg.owner() != admin) revert DeployRouter__AuthorizeSkipped(registry_, "nameRegistry.setRouter");
        reg.setRouter(newRouter);
        console2.log("  [ok] setRouter on NameRegistry (greenfield)");
    }

    /// Rotation-only NameRegistry propose. Registry enforces 2-day timelock
    /// before ActivateRouter can flip it.
    function _proposeNameRegistryRotation(
        address registry_,
        address newRouter,
        address admin
    ) internal {
        INameRegistryLike reg = INameRegistryLike(registry_);
        if (reg.owner() != admin) revert DeployRouter__AuthorizeSkipped(registry_, "nameRegistry.proposeRouter");
        reg.proposeRouter(newRouter);
        console2.log("  [ok] proposeRouter on NameRegistry (rotation pending)");
        console2.log("  [next] run ActivateRouter after (unix ts):", reg.pendingRouterTs());
    }

    /// Seed every canonical configHash's module count + flags on the fresh
    /// Router in ONE atomic call (URU-A10). `registerConfigMetadataBatch` is
    /// one-shot per hash + emits `ConfigMetadataRegistered` per entry, so an
    /// operator cannot ship a Router in the count-set-but-flags-missing state.
    function _seedManifestSentinels(
        Router router
    ) internal {
        (bytes32[] memory hashes, uint256[] memory counts) = RhConfigManifest.hashesAndCounts();
        (, uint256[] memory flags) = RhConfigManifest.hashesAndFlags();
        router.registerConfigMetadataBatch(hashes, counts, flags);
        console2.log("  [ok] atomically registered config metadata for hashes:", hashes.length);
    }

    /// Ban every retired Airdrop configHash. Auditor blocker #1: the source-
    /// level bannedConfigHash mapping is worthless if the deploy script
    /// doesn't seed it. No batch setter exists; three individual calls is
    /// fine at ~25k gas each.
    function _banRetiredHashes(
        Router router
    ) internal {
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        string[] memory labels = RhConfigManifest.retiredAirdropLabels();
        for (uint256 i = 0; i < retired.length; i++) {
            router.setConfigHashBanned(retired[i], true);
            console2.log(string.concat("  [ok] setConfigHashBanned(true) for ", labels[i]));
        }
    }

    /// Post-broadcast state pass. Reverts on any drift between what the script
    /// wrote and what the freshly-deployed Router now reports. Reverts loudly
    /// on any retired hash that isn't banned. Runs before the address book is
    /// written so operators cannot ship a broken Router.
    function _assertPostState(
        Router router,
        address expectedUru,
        address expectedSink,
        uint256 expectedMinUruFee
    ) internal view {
        if (address(router.uru()) != expectedUru) revert DeployRouter__PostStateMismatch("uru");
        if (address(router.uruSink()) != expectedSink) revert DeployRouter__PostStateMismatch("uruSink");
        if (router.minUruFee() != expectedMinUruFee) revert DeployRouter__PostStateMismatch("minUruFee");
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            if (!router.moduleCountConfigured(e.configHash)) {
                revert DeployRouter__ManifestSeedFailed(e.configHash, "moduleCountConfigured");
            }
            if (!router.flagsConfigured(e.configHash)) {
                revert DeployRouter__ManifestSeedFailed(e.configHash, "flagsConfigured");
            }
            if (router.moduleCountForConfig(e.configHash) != e.moduleCount) {
                revert DeployRouter__ManifestSeedFailed(e.configHash, "moduleCount value");
            }
            if (router.flagsForConfig(e.configHash) != e.flags) {
                revert DeployRouter__ManifestSeedFailed(e.configHash, "flags value");
            }
        }
        // Retired-hash bans MUST be active. If any is false at this point the
        // whole rotation is unsafe — refuse to write an address book.
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            if (!router.bannedConfigHash(retired[i])) revert DeployRouter__RetiredHashNotBanned(retired[i]);
        }
    }

    function _logSummary(
        Deployed memory out,
        address oldRouter,
        address admin,
        address uruToken,
        bool greenfield
    ) internal pure {
        console2.log("=========================================================");
        console2.log(
            greenfield ? "Router stack deployed (greenfield)" : "Router stack deployed (rotation Phase 1 staged)"
        );
        console2.log("=========================================================");
        console2.log("  UruDepositSink:   ", out.uruSink);
        console2.log("  RouterV2:         ", out.routerV2);
        console2.log("  FeeSplitter (in): ", out.feeSplitter);
        console2.log("  Admin:            ", admin);
        console2.log("  URU token:        ", uruToken);
        console2.log("  Old Router:       ", oldRouter);
        console2.log("---------------------------------------------------------");
        if (greenfield) {
            console2.log("Next steps:");
            console2.log("  1. Run ConfigureFlywheel to allowlist the URU->ETH keeper on UruDepositSink.");
            console2.log("  2. Update .env addresses manually.");
            console2.log("  3. Frontend cutover: URU/ETH toggle on the create page.");
        } else {
            console2.log("Rotation Phase 1 complete. Phase 2 (ActivateRouter):");
            console2.log("  1. Wait for the NameRegistry timelock to elapse (2 days).");
            console2.log("  2. Run ActivateRouter.s.sol - atomically rewires factories +");
            console2.log("     activates the registry + pauses old Router in one broadcast.");
            console2.log("  3. Recommended: sign Phase 2 as a single multisig batch so the");
            console2.log("     cutover window is a single block, not two days.");
            console2.log("  4. UNTIL Phase 2 completes, the old Router continues serving");
            console2.log("     launches normally. DO NOT publish the new Router to");
            console2.log("     frontend/indexer configs until then.");
        }
    }

    /// Emits the address book, marked ACTIVE (greenfield) or PENDING_ACTIVATION
    /// (rotation). Frontend + indexer MUST refuse to flip to a
    /// PENDING_ACTIVATION Router until ActivateRouter completes Phase 2.
    function _writeAddressBook(
        Deployed memory out,
        bool nameRegistryActivated
    ) internal {
        string memory obj = "routerv2";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "UruDepositSink", out.uruSink);
        vm.serializeAddress(obj, "FeeSplitter", out.feeSplitter);
        vm.serializeAddress(obj, "RouterV2", out.routerV2);
        string memory json = vm.serializeString(obj, "status", nameRegistryActivated ? "ACTIVE" : "PENDING_ACTIVATION");
        string memory outPath = string.concat("deployment-routerv2.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, outPath);
        console2.log("Address book written:", outPath);
        if (!nameRegistryActivated) {
            console2.log("  [status] PENDING_ACTIVATION - do NOT publish this Router in web/indexer configs");
            console2.log("           until ActivateRouter.s.sol runs post-timelock.");
        }
    }
}
