// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";

/// @notice Deploys the NameRegistry with the canonical reserved-ticker seed.
///
/// Env vars (all optional — defaults to `msg.sender` from the broadcast key):
///   REGISTRY_OWNER (or ADMIN)         — initial owner. Post-deploy, transfer to a 2-of-3 multisig.
///   REGISTRY_TREASURY (or TREASURY)   — treasury address for future sweeps.
///
/// Both names are read for compatibility with `DeployPhase1.s.sol`, which uses ADMIN
/// and TREASURY; if you're running both scripts and want a single set of env vars, set
/// ADMIN + TREASURY and leave the REGISTRY_* names unset.
///
/// Local fork rehearsal (no broadcast, runs in-memory against a forked node):
///   forge script script/DeployNameRegistry.s.sol:DeployNameRegistry \
///     --fork-url $SEPOLIA_RPC_URL -vvvv
///
/// Sepolia broadcast:
///   forge script script/DeployNameRegistry.s.sol:DeployNameRegistry \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --verify -vvvv \
///     --private-key $DEV_PRIVATE_KEY
contract DeployNameRegistry is Script {
    function run() external returns (NameRegistry registry) {
        address deployer = msg.sender;
        // Prefer the REGISTRY_* names (more specific); fall back to ADMIN/TREASURY (the
        // DeployPhase1 names) so operators can share env vars across scripts.
        address owner = vm.envOr("REGISTRY_OWNER", vm.envOr("ADMIN", deployer));
        address treasury = vm.envOr("REGISTRY_TREASURY", vm.envOr("TREASURY", deployer));

        string[] memory reserved = _initialReservedTickers();

        vm.startBroadcast();
        registry = new NameRegistry(owner, treasury, reserved);
        vm.stopBroadcast();

        console2.log("NameRegistry deployed at:", address(registry));
        console2.log("  initial owner:         ", owner);
        console2.log("  initial treasury:      ", treasury);
        console2.log("  reserved seed count:   ", reserved.length);
        console2.log("");
        console2.log("Next: router.setRouter(routerAddr) once Router is deployed.");
        console2.log("Next: transferOwnership to multisig.");
    }

    /// @dev Canonical v1 reserved-ticker seed. Per docs/SPEC-registry.md §Deploy.
    function _initialReservedTickers() internal pure returns (string[] memory) {
        string[] memory list = new string[](26);
        list[0] = "ETH";
        list[1] = "WETH";
        list[2] = "USDC";
        list[3] = "USDT";
        list[4] = "DAI";
        list[5] = "WBTC";
        list[6] = "MATIC";
        list[7] = "LINK";
        list[8] = "UNI";
        list[9] = "AAVE";
        list[10] = "COMP";
        list[11] = "MKR";
        list[12] = "SUSHI";
        list[13] = "CRV";
        list[14] = "LDO";
        list[15] = "PEPE";
        list[16] = "SHIB";
        list[17] = "DOGE";
        list[18] = "BASE";
        list[19] = "OP";
        list[20] = "ARB";
        list[21] = "SOL";
        list[22] = "BNB";
        list[23] = "AVAX";
        list[24] = "NEAR";
        list[25] = "ATOM";
        return list;
    }
}
