// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {Graduator} from "src/curve/Graduator.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice Deploys one `Graduator` per chain and (optionally) wires it into the local
///         `CurveFactory`. Graduation routing is chain-scoped by *deployment*: each chain
///         gets its own Graduator whose `poolManager` + `defaultHook` are immutable ctor
///         args. To add a new chain (Robinhood, Base, mainnet, etc.):
///
///           1. Broadcast `DeployHooks.s.sol` on the target chain so a v4 hook exists there.
///           2. Broadcast this script with the target chain's PoolManager + chosen hook.
///           3. Owner of `CurveFactory` calls `setGraduator(newGraduator)`.
///
///         Steps 2 and 3 can happen in one shot when the broadcaster still owns
///         CurveFactory (set `WIRE_INTO_FACTORY=1`). Once ownership hands off to a
///         multisig, step 3 becomes a Safe tx and this script exits after step 2.
///
/// Env vars:
///   V4_POOL_MANAGER      — target chain's v4 PoolManager. Required.
///                          Sepolia:        0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
///                          Mainnet/Base:   see https://docs.uniswap.org/contracts/v4/deployments
///                          Robinhood:      not yet published — see Robinhood's chain
///                                          developers group mailer or check
///                                          robinhoodchain.blockscout.com for the canonical
///                                          Uniswap v4 deployment.
///   DEFAULT_HOOK         — hook address to bake into every graduated pool. Required.
///                          Typically the `MultiHookHost` from DeployHooks (LP-lock +
///                          fee-split in one) or `LPLockedHook` for LP-lock only.
///   GRADUATOR_FEE        — pool fee in 1e-6 units. Default 3000 (0.3%).
///   GRADUATOR_TICK_SPACING — default 60 (matches 0.3% tier).
///   WIRE_INTO_FACTORY    — "1" to also call `CurveFactory.setGraduator`. Requires the
///                          broadcaster to still be the factory owner. Off by default so
///                          post-handoff runs stay safe.
///   CURVE_FACTORY        — CurveFactory address on this chain. Only read when
///                          WIRE_INTO_FACTORY=1. If unset, script tries to read
///                          `contracts/deployment.<chainid>.json:.CurveFactory`.
///
/// Local rehearsal:
///   forge script script/DeployGraduator.s.sol:DeployGraduator --fork-url $SEPOLIA_RPC_URL -vvvv
contract DeployGraduator is Script {
    function run() external returns (address graduator) {
        // PoolManager: env override wins; otherwise fall back to whatever DeployHooks
        // wrote (both scripts already share that address, so operators only need to set
        // it once).
        address poolManager = vm.envOr("V4_POOL_MANAGER", address(0));
        if (poolManager == address(0)) poolManager = _readAddressFromHooksBook(".PoolManager");
        // defaultHook: env wins; otherwise auto-read MultiHookHost from the hooks book —
        // MultiHookHost is the "batteries included" LP-lock + fee-split hook and the
        // production default.
        address defaultHook = vm.envOr("DEFAULT_HOOK", address(0));
        if (defaultHook == address(0)) defaultHook = _readAddressFromHooksBook(".MultiHookHost");
        uint24 fee = uint24(vm.envOr("GRADUATOR_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("GRADUATOR_TICK_SPACING", uint256(60))));

        vm.startBroadcast();
        Graduator g = new Graduator(IPoolManager(poolManager), IHooks(defaultHook), fee, tickSpacing);
        graduator = address(g);

        bool wire = vm.envOr("WIRE_INTO_FACTORY", uint256(0)) == 1;
        if (wire) {
            address factoryAddr = vm.envOr("CURVE_FACTORY", address(0));
            if (factoryAddr == address(0)) factoryAddr = _readFactoryFromBook();
            CurveFactory(factoryAddr).setGraduator(graduator);
        }
        vm.stopBroadcast();

        console2.log("=========================================================");
        console2.log("Graduator deployed");
        console2.log("=========================================================");
        console2.log("  chainid:        ", block.chainid);
        console2.log("  Graduator:      ", graduator);
        console2.log("  PoolManager:    ", poolManager);
        console2.log("  defaultHook:    ", defaultHook);
        console2.log("  fee:            ", uint256(fee));
        console2.log("  tickSpacing:    ", int256(tickSpacing));
        console2.log("---------------------------------------------------------");
        if (wire) {
            console2.log("CurveFactory.setGraduator invoked in-script.");
        } else {
            console2.log("Next: owner of CurveFactory calls setGraduator(", graduator, ")");
        }

        // Persist so sync-addresses.mjs can pick it up.
        {
            string memory obj = "graduator";
            vm.serializeUint(obj, "chainId", block.chainid);
            vm.serializeAddress(obj, "PoolManager", poolManager);
            vm.serializeAddress(obj, "DefaultHook", defaultHook);
            vm.serializeUint(obj, "Fee", uint256(fee));
            vm.serializeInt(obj, "TickSpacing", int256(tickSpacing));
            string memory json = vm.serializeAddress(obj, "Graduator", graduator);
            string memory path = string.concat("deployment-graduator.", vm.toString(block.chainid), ".json");
            vm.writeJson(json, path);
            console2.log("Address book written:", path);
        }
    }

    /// @dev Reads `contracts/deployment.<chainid>.json:.CurveFactory` so operators don't
    ///      have to paste the address into env after DeployPhase1 already wrote it.
    function _readFactoryFromBook() internal view returns (address) {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        string memory book = vm.readFile(path);
        return vm.parseJsonAddress(book, ".CurveFactory");
    }

    /// @dev Reads a field from `deployment-hooks.<chainid>.json`. Reverts with a legible
    ///      error if the hooks book is missing — operator needs to broadcast DeployHooks
    ///      first (or pass V4_POOL_MANAGER / DEFAULT_HOOK explicitly).
    function _readAddressFromHooksBook(
        string memory key
    ) internal view returns (address) {
        string memory path = string.concat("deployment-hooks.", vm.toString(block.chainid), ".json");
        require(
            vm.exists(path),
            "deployment-hooks.<chainid>.json missing -- run DeployHooks or set V4_POOL_MANAGER + DEFAULT_HOOK"
        );
        string memory book = vm.readFile(path);
        return vm.parseJsonAddress(book, key);
    }
}
