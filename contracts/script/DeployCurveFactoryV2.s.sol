// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice Deploys the whitelist-aware BondingCurve impl + a fresh CurveFactory
///         pointing at it. The RH-deployed CurveFactory is the pre-WL version and
///         doesn't have `createCurveWithConfigForWl`, so new whitelisted launches
///         need this replacement. Legacy curves (pre-WL launches) keep working -
///         they're independent clones referencing the OLD impl.
///
///         Reads:
///           - deployment.<chainid>.json           (Phase1 - for graduator address, treasury)
///           - deployment-graduator.<chainid>.json (optional override for graduator address)
///
///         Env vars:
///           ADMIN               initial owner of the new CurveFactory (defaults to sender)
///           FEE_RECEIVER        curve trade-fee sink (defaults to Phase1 FeeReceiver)
///           GRADUATOR_OVERRIDE  hex address override for the graduator (else read from books)
///
///         Post-deploy - the operator OR DeployRouterV2 need to:
///           1. Call `newCurveFactory.setTrustedRouter(RouterV2, true)`
///           2. Update RouterV2 to point at the new factory
///              (`routerV2.setCurveFactory(newFactory)`)
///           Both are handled automatically by DeployRouterV2 when the routerv2 book
///           doesn't yet exist and the curvefactoryv2 book does.
///
/// Usage:
///   bash contracts/deploy.sh CurveFactoryV2 robinhood
contract DeployCurveFactoryV2 is Script {
    error DeployCurveFactoryV2__NoPhase1Book();

    struct Deployed {
        address curveImpl;
        address curveFactory;
        address graduator;
    }

    function run() external returns (Deployed memory out) {
        string memory chainId = vm.toString(block.chainid);
        string memory phase1Path = string.concat("deployment.", chainId, ".json");
        string memory gradPath = string.concat("deployment-graduator.", chainId, ".json");

        if (!vm.exists(phase1Path)) revert DeployCurveFactoryV2__NoPhase1Book();
        string memory phase1 = vm.readFile(phase1Path);

        // Prefer explicit env override, then the graduator book, then Phase1's Router
        // owner as a last resort (won't work for graduation but lets deploy succeed).
        address graduator;
        try vm.envAddress("GRADUATOR_OVERRIDE") returns (address g) {
            graduator = g;
        } catch {
            if (vm.exists(gradPath)) {
                graduator = vm.parseJsonAddress(vm.readFile(gradPath), ".Graduator");
            } else {
                console2.log("  [warn] no graduator book + no GRADUATOR_OVERRIDE - factory ships without a graduator");
            }
        }

        address admin = vm.envOr("ADMIN", msg.sender);
        // Default fee receiver = Phase1's FeeReceiver so curve trade fees keep flowing to
        // the existing sink. Override via env if you want to redirect (e.g. → FeeSplitter).
        address feeReceiver = vm.envOr("FEE_RECEIVER", vm.parseJsonAddress(phase1, ".FeeReceiver"));

        vm.startBroadcast();

        BondingCurve impl = new BondingCurve();
        CurveFactory factory = new CurveFactory(admin, feeReceiver, address(impl));
        if (graduator != address(0)) {
            factory.setGraduator(graduator);
        }

        vm.stopBroadcast();

        out = Deployed({curveImpl: address(impl), curveFactory: address(factory), graduator: graduator});

        _logSummary(out, admin, feeReceiver);
        _writeAddressBook(out);
    }

    function _logSummary(
        Deployed memory out,
        address admin,
        address feeReceiver
    ) internal pure {
        console2.log("=========================================================");
        console2.log("Whitelist-aware CurveFactory deployed");
        console2.log("=========================================================");
        console2.log("  BondingCurve impl:  ", out.curveImpl);
        console2.log("  CurveFactory:       ", out.curveFactory);
        console2.log("  Graduator wired:    ", out.graduator);
        console2.log("  Admin:              ", admin);
        console2.log("  Trade-fee receiver: ", feeReceiver);
        console2.log("---------------------------------------------------------");
        console2.log("Next steps:");
        console2.log("  1. Run DeployRouterV2 - it auto-picks up the new CurveFactory from");
        console2.log("     deployment-curvefactoryv2.<chainid>.json and calls setTrustedRouter");
        console2.log("     + setCurveFactory as part of its wiring.");
        console2.log("  2. sync-addresses.mjs picks up the new CurveFactory address");
        console2.log("     for CONTRACTS.<chain>.CurveFactory in web/src/lib/config.ts.");
    }

    function _writeAddressBook(
        Deployed memory out
    ) internal {
        string memory obj = "curvefactoryv2";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "BondingCurveImpl", out.curveImpl);
        vm.serializeAddress(obj, "Graduator", out.graduator);
        string memory json = vm.serializeAddress(obj, "CurveFactory", out.curveFactory);
        string memory outPath = string.concat("deployment-curvefactoryv2.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, outPath);
        console2.log("Address book written:", outPath);
    }
}
