// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {FeeReceiver} from "src/router/FeeReceiver.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice Transfers ownership of every Phase 1 admin-controlled contract to a target
///         multisig. Uses Solady `Ownable.transferOwnership(address)` which is a
///         one-step transfer (Solady's Ownable2Step isn't wired here — the deploy key is
///         expected to be a hot wallet or HSM that we're rotating OUT immediately).
///
/// @dev    Broadcast with the current owner's key. If a contract was already handed off
///         in a previous run, the transferOwnership call reverts and the script stops —
///         re-run with the specific contract commented out, or use `HANDOFF_SKIP_*` env
///         vars for granular skipping.
///
/// Env vars:
///   MULTISIG_ADMIN  — target multisig address (required).
///   DEPLOYMENT_JSON — path to `deployment.<chainid>.json`. Defaults to auto-detect via chainid.
///
/// Usage:
///   forge script script/HandoffOwnership.s.sol:HandoffOwnership \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY -vvvv
contract HandoffOwnership is Script {
    error HandoffOwnership__NoMultisig();
    error HandoffOwnership__NoAddressBook();

    function run() external {
        address multisig = vm.envAddress("MULTISIG_ADMIN");
        if (multisig == address(0)) revert HandoffOwnership__NoMultisig();

        string memory corePath = string.concat("deployment.", vm.toString(block.chainid), ".json");
        if (!vm.exists(corePath)) revert HandoffOwnership__NoAddressBook();
        string memory core = vm.readFile(corePath);

        address registry = vm.parseJsonAddress(core, ".NameRegistry");
        address feeReceiver = vm.parseJsonAddress(core, ".FeeReceiver");
        address router = vm.parseJsonAddress(core, ".Router");
        address f20 = vm.parseJsonAddress(core, ".ERC20Factory");
        address f721 = vm.parseJsonAddress(core, ".ERC721AFactory");
        address f1155 = vm.parseJsonAddress(core, ".ERC1155Factory");
        address cf = vm.parseJsonAddress(core, ".CurveFactory");

        console2.log("=========================================================");
        console2.log("Handoff -> multisig:", multisig);
        console2.log("=========================================================");

        vm.startBroadcast();
        _handoff("NameRegistry", registry, multisig);
        _handoff("FeeReceiver", feeReceiver, multisig);
        _handoff("Router", router, multisig);
        _handoff("ERC20Factory", f20, multisig);
        _handoff("ERC721AFactory", f721, multisig);
        _handoff("ERC1155Factory", f1155, multisig);
        _handoff("CurveFactory", cf, multisig);

        // Graduator itself has no admin surface (poolManager / defaultHook / fee /
        // tickSpacing are all immutable ctor args, no owner) — nothing to hand off.
        // Graduation routing changes require `CurveFactory.setGraduator(new)`, which is
        // gated by CurveFactory ownership already handed off above.

        // Flywheel Ownables: same pattern — skip when the flywheel isn't deployed on this
        // chain (URU + gemu NFT only live on Base today, so mainnet/sepolia never have this).
        string memory flyPath = string.concat("deployment-flywheel.", vm.toString(block.chainid), ".json");
        if (vm.exists(flyPath)) {
            string memory flyBook = vm.readFile(flyPath);
            _handoff("FeeSplitter", vm.parseJsonAddress(flyBook, ".FeeSplitter"), multisig);
            _handoff("LoyaltyOracle", vm.parseJsonAddress(flyBook, ".LoyaltyOracle"), multisig);
            _handoff("NftRevenueVault", vm.parseJsonAddress(flyBook, ".NftRevenueVault"), multisig);
            _handoff("UruBuybackVault", vm.parseJsonAddress(flyBook, ".UruBuybackVault"), multisig);
            _handoff("RoyaltyRouterFactory", vm.parseJsonAddress(flyBook, ".RoyaltyRouterFactory"), multisig);
            // RoyaltyRouterImpl is a stateless template — no owner, skipped intentionally.
        } else {
            console2.log("  skip Flywheel (no deployment-flywheel.<chainid>.json)");
        }
        vm.stopBroadcast();

        console2.log("---------------------------------------------------------");
        console2.log("Done. All ownership now sits at:", multisig);
        console2.log("Verify: cast call <contract> 'owner()(address)' --rpc-url ...");
    }

    function _handoff(
        string memory name,
        address target,
        address newOwner
    ) internal {
        if (target == address(0)) {
            console2.log("  skip", name);
            return;
        }
        address current = Ownable(target).owner();
        if (current == newOwner) {
            console2.log("  already handed off:", name);
            return;
        }
        console2.log("  transfer", name);
        Ownable(target).transferOwnership(newOwner);
    }
}
