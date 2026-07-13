// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {LPLockedHook} from "src/hooks/LPLockedHook.sol";
import {FeeRedirectHook} from "src/hooks/FeeRedirectHook.sol";
import {AntiSniperHook} from "src/hooks/AntiSniperHook.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BuybackBurnHook} from "src/hooks/BuybackBurnHook.sol";
import {Currency} from "v4-core/types/Currency.sol";

/// @notice Deploys both v4 hooks at deterministic CREATE2 addresses whose low 14 bits
///         match each hook's declared permissions. Both hooks are deployed by a canonical
///         factory-style CREATE2 deployer (e.g. Foundry's default at 0x4e59...).
///
/// Env vars:
///   V4_POOL_MANAGER   — deployed v4 PoolManager address (required).
///   PLATFORM          — FeeRedirect platform recipient. Defaults to broadcaster.
///   CREATOR           — FeeRedirect creator recipient. Defaults to broadcaster.
///   PLATFORM_BPS      — Defaults to 100 (1%).
///   CREATOR_BPS       — Defaults to 100 (1%).
///
/// Local rehearsal:
///   forge script script/DeployHooks.s.sol:DeployHooks --fork-url $SEPOLIA_RPC_URL -vvvv
contract DeployHooks is Script {
    /// @dev Canonical Foundry CREATE2 deployer, present on every EVM chain we care about.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run()
        external
        returns (address lpLocked, address feeRedirect, address antiSniper, address multiHookHost, address buybackBurn)
    {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address platform = vm.envOr("PLATFORM", msg.sender);
        address creator = vm.envOr("CREATOR", msg.sender);
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));

        // LPLockedHook: BEFORE_REMOVE_LIQUIDITY_FLAG only.
        {
            uint160 requiredFlags = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
            bytes memory creation = type(LPLockedHook).creationCode;
            bytes memory args = abi.encode(IPoolManager(poolManager));
            (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
            vm.startBroadcast();
            LPLockedHook deployed = new LPLockedHook{salt: bytes32(salt)}(IPoolManager(poolManager));
            vm.stopBroadcast();
            require(address(deployed) == predicted, "LPLocked salt drift");
            lpLocked = address(deployed);
        }

        // FeeRedirectHook: AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
        {
            uint160 requiredFlags = Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
            bytes memory creation = type(FeeRedirectHook).creationCode;
            bytes memory args = abi.encode(IPoolManager(poolManager), platform, creator, platformBps, creatorBps);
            (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
            vm.startBroadcast();
            FeeRedirectHook deployed = new FeeRedirectHook{salt: bytes32(salt)}(
                IPoolManager(poolManager), platform, creator, platformBps, creatorBps
            );
            vm.stopBroadcast();
            require(address(deployed) == predicted, "FeeRedirect salt drift");
            feeRedirect = address(deployed);
        }

        // AntiSniperHook: BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG.
        {
            uint256 gateBlocks = vm.envOr("ANTISNIPER_GATE_BLOCKS", uint256(5));
            uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
            bytes memory creation = type(AntiSniperHook).creationCode;
            bytes memory args = abi.encode(IPoolManager(poolManager), gateBlocks);
            (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
            vm.startBroadcast();
            AntiSniperHook deployed = new AntiSniperHook{salt: bytes32(salt)}(IPoolManager(poolManager), gateBlocks);
            vm.stopBroadcast();
            require(address(deployed) == predicted, "AntiSniper salt drift");
            antiSniper = address(deployed);
        }

        // MultiHookHost: BEFORE_REMOVE_LIQUIDITY | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA.
        {
            uint160 requiredFlags =
                Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
            bytes memory creation = type(MultiHookHost).creationCode;
            bytes memory args = abi.encode(IPoolManager(poolManager), platform, creator, platformBps, creatorBps);
            (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
            vm.startBroadcast();
            MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
                IPoolManager(poolManager), platform, creator, platformBps, creatorBps
            );
            vm.stopBroadcast();
            require(address(deployed) == predicted, "MultiHookHost salt drift");
            multiHookHost = address(deployed);
        }

        // BuybackBurnHook: AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA.
        // Requires the launched token currency to be known — provided post-launch, so we deploy
        // with a placeholder currency here for the go-live rehearsal. Production deploys mint one
        // BuybackBurnHook per launched token via a factory pattern in Phase 2.
        {
            address placeholderToken = vm.envOr("BUYBACK_TOKEN", address(0xdeaD));
            uint16 burnBps = uint16(vm.envOr("BUYBACK_BPS", uint256(200)));
            uint160 requiredFlags = Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
            bytes memory creation = type(BuybackBurnHook).creationCode;
            bytes memory args = abi.encode(IPoolManager(poolManager), Currency.wrap(placeholderToken), burnBps);
            (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
            vm.startBroadcast();
            BuybackBurnHook deployed = new BuybackBurnHook{salt: bytes32(salt)}(
                IPoolManager(poolManager), Currency.wrap(placeholderToken), burnBps
            );
            vm.stopBroadcast();
            require(address(deployed) == predicted, "BuybackBurn salt drift");
            buybackBurn = address(deployed);
        }

        console2.log("=========================================================");
        console2.log("v4 hooks deployed");
        console2.log("=========================================================");
        console2.log("  LPLockedHook:      ", lpLocked);
        console2.log("  FeeRedirectHook:   ", feeRedirect);
        console2.log("  AntiSniperHook:    ", antiSniper);
        console2.log("  MultiHookHost:     ", multiHookHost);
        console2.log("  BuybackBurnHook:   ", buybackBurn);
        console2.log("---------------------------------------------------------");
        console2.log("Post-deploy: create v4 pools with these hooks in PoolKey.hooks.");
        console2.log("Platform + creator claim fees via FeeRedirectHook.claim(currency).");
        console2.log("MultiHookHost delivers LP-locked + fee-split in one hook address.");

        // Persist addresses so DeployGraduator + sync-addresses.mjs can consume them
        // without hand-copying from the console.
        {
            string memory obj = "hooks";
            vm.serializeUint(obj, "chainId", block.chainid);
            vm.serializeAddress(obj, "PoolManager", poolManager);
            vm.serializeAddress(obj, "LPLockedHook", lpLocked);
            vm.serializeAddress(obj, "FeeRedirectHook", feeRedirect);
            vm.serializeAddress(obj, "AntiSniperHook", antiSniper);
            vm.serializeAddress(obj, "MultiHookHost", multiHookHost);
            string memory json = vm.serializeAddress(obj, "BuybackBurnHook", buybackBurn);
            string memory path = string.concat("deployment-hooks.", vm.toString(block.chainid), ".json");
            vm.writeJson(json, path);
            console2.log("Address book written:", path);
        }
    }
}
