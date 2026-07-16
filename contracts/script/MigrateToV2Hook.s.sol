// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @title  MigrateToV2Hook
/// @notice Targeted migration from V1 MultiHookHost (immutable single-creator) to V2
///         (per-pool `mapping(PoolId => address) creators` set at graduation). Only
///         touches the two contracts whose semantics changed — the LP-lock,
///         fee-redirect, anti-sniper, and buyback-burn hooks are byte-identical to
///         their V1 deployments and stay at their current addresses.
///
/// @dev    Idempotency: the V2 hook is mined at a fresh CREATE2 salt (its bytecode
///         differs from V1 → different predicted address). If the predicted V2 hook
///         address already has code, this script no-ops. Every V1 pool (TEST, BALLS,
///         etc.) stays bound to the V1 hook it initialized against — their pool key
///         is immutable — so their trade pages continue to work via the per-token
///         `graduations.hookAddress` column the indexer now records.
///
///         Ownership: the CurveFactory rewire (`setGraduator`) requires the
///         broadcaster to still own CurveFactory. Post-multisig-handoff, drop
///         WIRE_INTO_FACTORY and execute step 3 as a Safe tx.
///
/// Env vars:
///   V4_POOL_MANAGER      — v4 PoolManager for the target chain. Required.
///   PLATFORM             — MultiHookHost platform recipient. Defaults to broadcaster.
///   CREATOR              — MultiHookHost fallback creator (used only for pools that
///                          skip `setCreator`). Defaults to broadcaster.
///   PLATFORM_BPS         — platform slice of the fee-redirect (default 100 = 1%).
///   CREATOR_BPS          — creator slice of the fee-redirect (default 100 = 1%).
///   GRADUATOR_FEE        — v4 fee tier in 1e-6 units (default 3000 = 0.3%).
///   GRADUATOR_TICK_SPACING — default 60 (matches 0.3% tier).
///   WIRE_INTO_FACTORY    — "1" to also call CurveFactory.setGraduator with the new
///                          Graduator. Requires broadcaster to still own the factory.
///   CURVE_FACTORY        — override CurveFactory address; defaults to reading
///                          `deployment.<chainid>.json:.CurveFactory`.
///
/// Local rehearsal (Base fork):
///   forge script script/MigrateToV2Hook.s.sol:MigrateToV2Hook --fork-url $BASE_RPC_URL -vvvv
///
/// Broadcast (after review):
///   WIRE_INTO_FACTORY=1 bash contracts/deploy.sh MigrateToV2Hook base
contract MigrateToV2Hook is Script {
    /// @dev Canonical Foundry CREATE2 deployer, present on every EVM chain we care about.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (address v2Hook, address newGraduator) {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address platform = vm.envOr("PLATFORM", msg.sender);
        address creator = vm.envOr("CREATOR", msg.sender);
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));
        uint24 fee = uint24(vm.envOr("GRADUATOR_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("GRADUATOR_TICK_SPACING", uint256(60))));

        v2Hook = _deployMultiHookHostV2(poolManager, platform, creator, platformBps, creatorBps);
        newGraduator = _deployGraduatorV2(poolManager, v2Hook, fee, tickSpacing);
        _maybeWireFactory(newGraduator);

        _logSummary(v2Hook, newGraduator, poolManager, platform, creator);
        _writeAddressBook(v2Hook, newGraduator, poolManager, fee, tickSpacing);
    }

    // ---------------------------------------------------------------- V2 MultiHookHost
    // Same permission flags as V1 (0x22C4) — the V2 changes are storage-layout + a new
    // setCreator function, both invisible to the hook-flag mask. Salt is mined fresh
    // because the bytecode changed → new predicted address.
    function _deployMultiHookHostV2(
        address poolManager,
        address platform,
        address creator,
        uint16 platformBps,
        uint16 creatorBps
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args = abi.encode(IPoolManager(poolManager), platform, creator, platformBps, creatorBps);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] MultiHookHost V2 already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), platform, creator, platformBps, creatorBps
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "MultiHookHost V2 salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- V2 Graduator
    // Deploys a fresh Graduator wired to the V2 hook. Old Graduator keeps working for
    // any curve that already installed it as `graduator`; only NEW curves picked up
    // through `curveFactory.setGraduator(newGraduator)` route through V2.
    function _deployGraduatorV2(
        address poolManager,
        address hookAddr,
        uint24 fee,
        int24 tickSpacing
    ) internal returns (address addr) {
        vm.startBroadcast();
        Graduator g = new Graduator(IPoolManager(poolManager), IHooks(hookAddr), fee, tickSpacing);
        vm.stopBroadcast();
        addr = address(g);
    }

    // ---------------------------------------------------------------- Factory rewire
    // Optional: call CurveFactory.setGraduator so new launches use the V2 Graduator.
    // Skipped by default so a broadcast can be reviewed on-chain before flipping the
    // wire. When ownership has already handed off to a multisig, run this as a Safe
    // tx instead of setting WIRE_INTO_FACTORY.
    function _maybeWireFactory(
        address newGraduator
    ) internal {
        bool wire = vm.envOr("WIRE_INTO_FACTORY", uint256(0)) == 1;
        if (!wire) {
            console2.log("  [pending] CurveFactory.setGraduator NOT called (WIRE_INTO_FACTORY=0).");
            console2.log("  Next step: owner runs CurveFactory.setGraduator(", newGraduator, ")");
            return;
        }
        address factoryAddr = vm.envOr("CURVE_FACTORY", address(0));
        if (factoryAddr == address(0)) factoryAddr = _readFactoryFromBook();
        vm.startBroadcast();
        CurveFactory(factoryAddr).setGraduator(newGraduator);
        vm.stopBroadcast();
        console2.log("  [done] CurveFactory.setGraduator invoked for", newGraduator);
    }

    function _readFactoryFromBook() internal view returns (address) {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        string memory book = vm.readFile(path);
        return vm.parseJsonAddress(book, ".CurveFactory");
    }

    function _logSummary(
        address v2Hook,
        address newGraduator,
        address poolManager,
        address platform,
        address creator
    ) internal view {
        console2.log("=========================================================");
        console2.log("Migration to MultiHookHost v2 (per-launcher creator)");
        console2.log("=========================================================");
        console2.log("  chainid:            ", block.chainid);
        console2.log("  MultiHookHost V2:   ", v2Hook);
        console2.log("  Graduator V2:       ", newGraduator);
        console2.log("  PoolManager:        ", poolManager);
        console2.log("  platform:           ", platform);
        console2.log("  fallback creator:   ", creator);
        console2.log("---------------------------------------------------------");
        console2.log("Existing pools stay on V1 hook -- their trade pages read the");
        console2.log("hook per-token from the indexer, so nothing breaks.");
        console2.log("New launches (after setGraduator) route creator share to the");
        console2.log("per-pool `creators[poolId]` set by the V2 Graduator.");
    }

    /// @dev Writes a small book so sync-addresses.mjs can pick up the V2 addresses
    ///      without hand-editing the frontend config.
    function _writeAddressBook(
        address v2Hook,
        address newGraduator,
        address poolManager,
        uint24 fee,
        int24 tickSpacing
    ) internal {
        string memory obj = "v2Hook";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "MultiHookHostV2", v2Hook);
        vm.serializeAddress(obj, "GraduatorV2", newGraduator);
        vm.serializeAddress(obj, "PoolManager", poolManager);
        vm.serializeUint(obj, "Fee", uint256(fee));
        string memory json = vm.serializeInt(obj, "TickSpacing", int256(tickSpacing));
        string memory path = string.concat("deployment-v2hook.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Address book written:", path);
    }
}
