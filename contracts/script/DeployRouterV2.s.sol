// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

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
    function router() external view returns (address);
    function owner() external view returns (address);
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
///           ADMIN               initial owner of RouterV2 + UruDepositSink (defaults to sender)
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
/// Usage:
///   URU_TOKEN_ADDRESS=0x9fbe...9d24 \
///   bash contracts/deploy.sh RouterV2 robinhood
contract DeployRouterV2 is Script {
    error DeployRouterV2__NoPhase1Book();
    error DeployRouterV2__NoFlywheelBook();

    struct Deployed {
        address uruSink;
        address routerV2;
        address feeSplitter;
    }

    function run() external returns (Deployed memory out) {
        string memory chainId = vm.toString(block.chainid);
        string memory phase1Path = string.concat("deployment.", chainId, ".json");
        string memory flywheelPath = string.concat("deployment-flywheel.", chainId, ".json");

        if (!vm.exists(phase1Path)) revert DeployRouterV2__NoPhase1Book();
        if (!vm.exists(flywheelPath)) revert DeployRouterV2__NoFlywheelBook();

        string memory phase1 = vm.readFile(phase1Path);
        string memory flywheel = vm.readFile(flywheelPath);

        address oldRouter = vm.parseJsonAddress(phase1, ".Router");
        address registry = vm.parseJsonAddress(phase1, ".NameRegistry");
        address erc20Factory = vm.parseJsonAddress(phase1, ".ERC20Factory");
        address erc721Factory = vm.parseJsonAddress(phase1, ".ERC721AFactory");
        address erc1155Factory = vm.parseJsonAddress(phase1, ".ERC1155Factory");
        // Prefer the WL-aware CurveFactory when its book exists (see
        // DeployCurveFactoryV2). Falls back to the pre-WL CurveFactory from Phase1 for
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

        // Step 2: deploy RouterV2 pointed at FeeSplitter as its ETH-fee receiver
        // and at the sink for its URU-fee receiver.
        RouterV2 routerV2 = new RouterV2(
            admin,
            NameRegistry(registry),
            IFeeReceiver(feeSplitter),
            erc20Fee,
            nftFee,
            erc1155Fee,
            moduleAddOn,
            hookAddOn,
            govAddOn,
            uruToken,
            sink
        );

        // Step 3: wire RouterV2's per-base factory pointers + curve factory + loyalty
        // oracle. These are stored (not immutable), so setters do the job.
        routerV2.setFactory(BaseType.ERC20, erc20Factory);
        routerV2.setFactory(BaseType.ERC721A, erc721Factory);
        routerV2.setFactory(BaseType.ERC1155, erc1155Factory);
        routerV2.setCurveFactory(curveFactory);
        routerV2.setLoyaltyOracle(loyaltyOracle);

        // Step 4: authorize RouterV2 on each factory (setRouter is owner-only). Skips
        // gracefully if the broadcaster no longer owns the factory (post-multisig
        // handoff) — operator must run those calls as Safe txs instead.
        _authorizeOnFactory(erc20Factory, address(routerV2));
        _authorizeOnFactory(erc721Factory, address(routerV2));
        _authorizeOnFactory(erc1155Factory, address(routerV2));
        _authorizeOnCurveFactory(curveFactory, address(routerV2));

        // Step 4b: NameRegistry.reserve is gated on msg.sender == router. The registry
        // still points at the old Router; swap it to the new RouterV2 or launches
        // through V2 will revert with NameRegistry__NotRouter. Caught by the RH URU
        // pay E2E fork test — do NOT drop this step even if the tests aren't loaded.
        _authorizeOnNameRegistry(registry, address(routerV2));

        // Step 5 (optional): pause the old Router so users can no longer launch through
        // it. Only useful if the broadcaster is still the old-Router owner.
        if (vm.envOr("PAUSE_OLD_ROUTER", uint256(0)) == 1) {
            _pauseOldRouter(oldRouter);
        }

        vm.stopBroadcast();

        out = Deployed({uruSink: address(sink), routerV2: address(routerV2), feeSplitter: feeSplitter});

        _logSummary(out, oldRouter, admin, uruToken);
        if (usingCurveFactoryV2) {
            console2.log("  [note] wired to WL-aware CurveFactory:", curveFactory);
        } else {
            console2.log("  [note] wired to legacy CurveFactory:", curveFactory);
            console2.log("         WL launches will revert until DeployCurveFactoryV2 has been run.");
        }
        _writeAddressBook(out);
    }

    function _authorizeOnFactory(
        address factory,
        address routerV2
    ) internal {
        IFactoryLike f = IFactoryLike(factory);
        if (f.owner() != msg.sender) {
            console2.log("  [skip] factory owner != broadcaster; setRouter must be a Safe tx:", factory);
            return;
        }
        f.setRouter(routerV2);
        console2.log("  [ok] setRouter on factory:", factory);
    }

    function _authorizeOnCurveFactory(
        address curveFactory,
        address routerV2
    ) internal {
        ICurveFactoryLike cf = ICurveFactoryLike(curveFactory);
        if (cf.owner() != msg.sender) {
            console2.log("  [skip] CurveFactory owner != broadcaster; setTrustedRouter must be a Safe tx");
            return;
        }
        cf.setTrustedRouter(routerV2, true);
        console2.log("  [ok] setTrustedRouter on CurveFactory");
    }

    function _authorizeOnNameRegistry(
        address registry_,
        address routerV2
    ) internal {
        INameRegistryLike reg = INameRegistryLike(registry_);
        if (reg.owner() != msg.sender) {
            console2.log("  [skip] NameRegistry owner != broadcaster; setRouter must be a Safe tx:", registry_);
            return;
        }
        reg.setRouter(routerV2);
        console2.log("  [ok] setRouter on NameRegistry");
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
        console2.log("RouterV2 stack deployed");
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
        console2.log("  2. node tools/sync-addresses.mjs robinhood");
        console2.log("     (updates web/src/lib/config.ts CONTRACTS.robinhood.Router)");
        console2.log("  3. Frontend cutover: URU/ETH toggle on the create page.");
    }

    function _writeAddressBook(
        Deployed memory out
    ) internal {
        string memory obj = "routerv2";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "UruDepositSink", out.uruSink);
        vm.serializeAddress(obj, "FeeSplitter", out.feeSplitter);
        string memory json = vm.serializeAddress(obj, "RouterV2", out.routerV2);
        string memory outPath = string.concat("deployment-routerv2.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, outPath);
        console2.log("Address book written:", outPath);
    }
}
