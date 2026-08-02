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
}

interface ICurveFactoryLike {
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function owner() external view returns (address);
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

/// @notice Deploys the URU-pay stack on Robinhood: `UruDepositSink` + `RouterV2` pointed
///         at the flywheel's FeeSplitter as the ETH-fee receiver. Wires the new Router
///         into the existing factory + curve setup so it can serve launches immediately.
///
///         Reads:
///           - deployment.<chainid>.json           (Phase1 address book — factories, registry, curve)
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
///           PAUSE_OLD_ROUTER    "1" to call setPaused(true) on the pre-existing Router
///                               so users can no longer launch through it. Requires
///                               broadcaster to still own the old Router.
///
///         Behavior on missing ownership (audit fail-closed requirement):
///           If the broadcaster does not own a factory / CurveFactory / NameRegistry,
///           the script REVERTS instead of writing a partial address book. Rationale:
///           an address book that names a Router the front-end will use but whose
///           factory pointers still route to the OLD Router silently 404s every launch.
///           If a multisig-signed activation flow is needed later, add a follow-up
///           Activate.s.sol script that verifies the missing wires before committing
///           the address book.
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
    /// A required owner-only wire (factory setRouter, CurveFactory trust,
    /// NameRegistry setRouter) could not be performed because the broadcaster
    /// does not own the target contract. Refuses to write a partial address
    /// book. See the header comment for the multisig-handoff pattern.
    error DeployRouter__AuthorizeSkipped(address contractAddr, string what);
    /// Post-broadcast assertion tripped — some manifest hash did not land its
    /// count/flags on the freshly deployed Router. Should be impossible unless
    /// the manifest is out of sync with the batch call sizes.
    error DeployRouter__ManifestSeedFailed(bytes32 configHash, string what);
    /// Post-broadcast assertion tripped — Router state does not match what
    /// the script just wrote. Should be impossible; guards against silent
    /// setter-reverts / RPC nonce anomalies.
    error DeployRouter__PostStateMismatch(string what);

    struct Deployed {
        address uruSink;
        address routerV2;
        address feeSplitter;
    }

    function run() external returns (Deployed memory out) {
        string memory chainId = vm.toString(block.chainid);
        string memory phase1Path = string.concat("deployment.", chainId, ".json");
        string memory flywheelPath = string.concat("deployment-flywheel.", chainId, ".json");

        if (!vm.exists(phase1Path)) revert DeployRouter__NoPhase1Book();
        if (!vm.exists(flywheelPath)) revert DeployRouter__NoFlywheelBook();

        string memory phase1 = vm.readFile(phase1Path);
        string memory flywheel = vm.readFile(flywheelPath);

        address oldRouter = vm.parseJsonAddress(phase1, ".Router");
        address registry = vm.parseJsonAddress(phase1, ".NameRegistry");
        address erc20Factory = vm.parseJsonAddress(phase1, ".ERC20Factory");
        address erc721Factory = vm.parseJsonAddress(phase1, ".ERC721AFactory");
        address erc1155Factory = vm.parseJsonAddress(phase1, ".ERC1155Factory");
        // Prefer the WL-aware CurveFactory when its book exists (see
        // SetChunkyDefaults). Falls back to the pre-WL CurveFactory from Phase1 for
        // deployments that haven't yet migrated. This makes launchWithWhitelist work
        // out of the box on RH once both scripts have been run.
        string memory curveFactoryV2Path = string.concat("deployment-curvefactoryv2.", chainId, ".json");
        address curveFactory;
        bool usingCurveFactoryV2;
        if (vm.exists(curveFactoryV2Path)) {
            curveFactory = vm.parseJsonAddress(vm.readFile(curveFactoryV2Path), ".CurveFactory");
            usingCurveFactoryV2 = true;
        } else {
            curveFactory = vm.parseJsonAddress(phase1, ".CurveFactory");
        }
        address feeSplitter = vm.parseJsonAddress(flywheel, ".FeeSplitter");
        address loyaltyOracle = vm.parseJsonAddress(flywheel, ".LoyaltyOracle");

        address admin = vm.envOr("ADMIN", msg.sender);
        address uruToken = vm.envAddress("URU_TOKEN_ADDRESS");
        // Nonzero floor is a required deploy parameter — auditor mandate.
        // Fetch as uint256 (18 decimals); 0 is a hard revert since
        // launchWithURU only guards against amount==0, so any floor at all
        // is the difference between a real spam gate and one wei of URU.
        uint256 minUruFee = vm.envOr("MIN_URU_FEE", uint256(0));
        if (minUruFee == 0) revert DeployRouter__ZeroMinUruFee();

        // Mirror fees from the pre-existing Router by default. Old-router reads
        // are view-only, no gas cost.
        Router old = Router(payable(oldRouter));
        uint256 erc20Fee = vm.envOr("ERC20_FEE", old.fees(BaseType.ERC20));
        uint256 nftFee = vm.envOr("NFT_FEE", old.fees(BaseType.ERC721A));
        uint256 erc1155Fee = vm.envOr("ERC1155_FEE", old.fees(BaseType.ERC1155));
        uint256 moduleAddOn = vm.envOr("MODULE_ADDON_FEE", old.moduleAddOnFee());
        uint256 hookAddOn = vm.envOr("HOOK_ADDON_FEE", old.hookAddOnFee());
        uint256 govAddOn = vm.envOr("GOV_ADDON_FEE", old.governanceAddOnFee());

        vm.startBroadcast();

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
        // Set the URU spam-gate floor immediately so the first block the
        // Router is reachable already enforces it. Prior to this fix,
        // DeployRouter left minUruFee at zero and required a manual
        // follow-up setter tx that was easy to forget.
        routerV2.setMinUruFee(minUruFee);

        // Step 3: wire Router's per-base factory pointers + curve factory + loyalty
        // oracle. These are stored (not immutable), so setters do the job.
        routerV2.setFactory(BaseType.ERC20, erc20Factory);
        routerV2.setFactory(BaseType.ERC721A, erc721Factory);
        routerV2.setFactory(BaseType.ERC1155, erc1155Factory);
        routerV2.setCurveFactory(curveFactory);
        routerV2.setLoyaltyOracle(loyaltyOracle);

        // Step 3b: seed the fail-closed sentinels (moduleCountConfigured /
        // flagsConfigured) for every configHash the front-end can produce.
        // Without this, EVERY launch reverts with Router__ModuleCountMissing
        // or Router__FlagsMissing until the operator remembers to run twelve
        // manual setter txs. The August 2026 audit's blocker #1.
        _seedManifestSentinels(routerV2);

        // Step 4: authorize Router on each factory (setRouter is owner-only). The
        // audit fail-closed requirement (blocker #5): if the broadcaster does NOT
        // own the target, REVERT rather than log-and-continue. A skipped wire +
        // a written address book equals a Router the front-end will use whose
        // factory pointers still route to the OLD Router.
        _authorizeOnFactoryStrict(erc20Factory, address(routerV2));
        _authorizeOnFactoryStrict(erc721Factory, address(routerV2));
        _authorizeOnFactoryStrict(erc1155Factory, address(routerV2));
        _authorizeOnCurveFactoryStrict(curveFactory, address(routerV2));

        // Step 4b: NameRegistry.reserve is gated on msg.sender == router. The registry
        // still points at the old Router; swap it to the new Router or launches
        // through V2 will revert with NameRegistry__NotRouter. Caught by the RH URU
        // pay E2E fork test — do NOT drop this step even if the tests aren't loaded.
        bool nameRegistryActivated = _authorizeOnNameRegistryStrict(registry, address(routerV2));

        // Step 5 (optional): pause the old Router so users can no longer launch through
        // it. Only useful if the broadcaster is still the old-Router owner.
        if (vm.envOr("PAUSE_OLD_ROUTER", uint256(0)) == 1) {
            _pauseOldRouter(oldRouter);
        }

        vm.stopBroadcast();

        // Post-broadcast assertions. Everything above went through startBroadcast,
        // so any revert would have bubbled up already. This pass exists as a
        // second line of defense against silent RPC / nonce anomalies. Address
        // book is written only after all checks pass.
        _assertPostState(routerV2, uruToken, address(sink), minUruFee);

        out = Deployed({uruSink: address(sink), routerV2: address(routerV2), feeSplitter: feeSplitter});

        _logSummary(out, oldRouter, admin, uruToken);
        if (usingCurveFactoryV2) {
            console2.log("  [note] wired to WL-aware CurveFactory:", curveFactory);
        } else {
            console2.log("  [note] wired to legacy CurveFactory:", curveFactory);
            console2.log("         WL launches will revert until SetChunkyDefaults has been run.");
        }
        _writeAddressBook(out, nameRegistryActivated);
    }

    function _authorizeOnFactoryStrict(
        address factory,
        address routerV2
    ) internal {
        IFactoryLike f = IFactoryLike(factory);
        if (f.owner() != msg.sender) revert DeployRouter__AuthorizeSkipped(factory, "factory.setRouter");
        f.setRouter(routerV2);
        console2.log("  [ok] setRouter on factory:", factory);
    }

    function _authorizeOnCurveFactoryStrict(
        address curveFactory,
        address routerV2
    ) internal {
        ICurveFactoryLike cf = ICurveFactoryLike(curveFactory);
        if (cf.owner() != msg.sender) {
            revert DeployRouter__AuthorizeSkipped(curveFactory, "curveFactory.setTrustedRouter");
        }
        cf.setTrustedRouter(routerV2, true);
        console2.log("  [ok] setTrustedRouter on CurveFactory");
    }

    /// NameRegistry rotation: if the current router is address(0) we're a
    /// greenfield chain and can call setRouter directly (which enforces
    /// "must be unset first"). If it's already pointed at the OLD Router,
    /// we're a rotation and must go through the two-phase
    /// proposeRouter → wait MIN_ROUTER_DELAY (2 days) → activateRouter
    /// flow. The activation is a follow-up operator broadcast — this
    /// script only proposes.
    ///
    /// The address book emitted by _writeAddressBook flags the deployment
    /// as PENDING_ACTIVATION whenever this path is taken. Frontend / indexer
    /// must NOT flip to the new Router until an operator runs
    /// `contracts/script/ActivateRouter.s.sol` after the delay.
    function _authorizeOnNameRegistryStrict(
        address registry_,
        address newRouter
    ) internal returns (bool activated) {
        INameRegistryLike reg = INameRegistryLike(registry_);
        if (reg.owner() != msg.sender) revert DeployRouter__AuthorizeSkipped(registry_, "nameRegistry.setRouter");
        address currentRouter = reg.router();
        if (currentRouter == address(0)) {
            // Greenfield: setRouter accepts.
            reg.setRouter(newRouter);
            console2.log("  [ok] setRouter on NameRegistry (greenfield)");
            return true;
        }
        // Rotation: setRouter would revert with NameRegistry__RouterAlreadySet.
        // Propose the new Router; operator activates after MIN_ROUTER_DELAY.
        // A previous propose that hasn't been activated OR canceled will make
        // this revert with NameRegistry__PendingRouterExists — a signal that
        // an earlier rotation is still in flight; halt and diagnose.
        reg.proposeRouter(newRouter);
        console2.log("  [ok] proposeRouter on NameRegistry (rotation pending)");
        console2.log("  [warn] NameRegistry activation is timelock-gated; run ActivateRouter after:");
        console2.log("         ready-at (unix): ", reg.pendingRouterTs());
        return false;
    }

    /// Seed every canonical configHash's module count + flags on the fresh
    /// Router via batch setters (~50k gas + 20k per hash). Manifest is the
    /// single source of truth — see `contracts/script/manifest/RhConfigManifest.sol`.
    function _seedManifestSentinels(
        Router router
    ) internal {
        (bytes32[] memory hashes, uint256[] memory counts) = RhConfigManifest.hashesAndCounts();
        (, uint256[] memory flags) = RhConfigManifest.hashesAndFlags();
        router.setModuleCountForConfigBatch(hashes, counts);
        router.setFlagsForConfigBatch(hashes, flags);
        console2.log("  [ok] seeded manifest sentinels for hashes:", hashes.length);
    }

    /// Post-broadcast state pass. Reverts on any drift between what the script
    /// wrote and what the freshly-deployed Router now reports. Belt-and-braces
    /// against silent RPC / nonce anomalies. Runs before the address book is
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
    }

    function _pauseOldRouter(
        address oldRouter
    ) internal {
        try Router(payable(oldRouter)).setPaused(true) {
            console2.log("  [ok] old Router paused");
        } catch {
            console2.log("  [skip] setPaused failed on old Router (probably not owned by broadcaster)");
        }
    }

    function _logSummary(
        Deployed memory out,
        address oldRouter,
        address admin,
        address uruToken
    ) internal pure {
        console2.log("=========================================================");
        console2.log("Router stack deployed");
        console2.log("=========================================================");
        console2.log("  UruDepositSink:   ", out.uruSink);
        console2.log("  RouterV2:         ", out.routerV2);
        console2.log("  FeeSplitter (in): ", out.feeSplitter);
        console2.log("  Admin:            ", admin);
        console2.log("  URU token:        ", uruToken);
        console2.log("  Old Router:       ", oldRouter);
        console2.log("---------------------------------------------------------");
        console2.log("Next steps:");
        console2.log("  1. Run ConfigureRouterV2Keeper to allowlist the URU->ETH keeper");
        console2.log("     on UruDepositSink (mirror of ConfigureFlywheel for buyback).");
        console2.log("  2. update .env addresses manually");
        console2.log("     (updates web/src/lib/config.ts CONTRACTS.robinhood.Router)");
        console2.log("  3. Frontend cutover: URU/ETH toggle on the create page.");
    }

    /// Emits the address book, marked ACTIVE or PENDING_ACTIVATION depending
    /// on whether the NameRegistry rotation landed synchronously (greenfield
    /// setRouter path) or was proposed for later activation (timelock-gated
    /// proposeRouter path). Frontend + indexer MUST refuse to flip to a
    /// PENDING_ACTIVATION Router until the operator runs ActivateRouter.
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
