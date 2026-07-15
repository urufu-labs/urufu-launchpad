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

    /// @dev Bundle every param the per-hook deploy helpers need so the top-level `run()`
    ///      doesn't carry N locals in scope while calling five sub-helpers. Trimming that
    ///      set is what lets `forge coverage --ir-minimum` (min-optimizer viaIR) compile
    ///      the script without tripping stack-too-deep — coverage keeps every named-return
    ///      variable live across the whole function body.
    struct Ctx {
        address poolManager;
        address platform;
        address creator;
        uint16 platformBps;
        uint16 creatorBps;
    }

    function run()
        external
        returns (address lpLocked, address feeRedirect, address antiSniper, address multiHookHost, address buybackBurn)
    {
        Ctx memory ctx = Ctx({
            poolManager: vm.envAddress("V4_POOL_MANAGER"),
            platform: vm.envOr("PLATFORM", msg.sender),
            creator: vm.envOr("CREATOR", msg.sender),
            platformBps: uint16(vm.envOr("PLATFORM_BPS", uint256(100))),
            creatorBps: uint16(vm.envOr("CREATOR_BPS", uint256(100)))
        });

        lpLocked = _deployLPLocked(ctx);
        feeRedirect = _deployFeeRedirect(ctx);
        antiSniper = _deployAntiSniper(ctx);
        multiHookHost = _deployMultiHookHost(ctx);
        buybackBurn = _deployBuybackBurn(ctx);

        _logSummary(lpLocked, feeRedirect, antiSniper, multiHookHost, buybackBurn);
        _writeAddressBook(ctx.poolManager, lpLocked, feeRedirect, antiSniper, multiHookHost, buybackBurn);
    }

    // ---------------------------------------------------------------- LPLockedHook
    // BEFORE_REMOVE_LIQUIDITY_FLAG only.
    function _deployLPLocked(
        Ctx memory ctx
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(ctx.poolManager));
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] LPLockedHook already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        LPLockedHook deployed = new LPLockedHook{salt: bytes32(salt)}(IPoolManager(ctx.poolManager));
        vm.stopBroadcast();
        require(address(deployed) == predicted, "LPLocked salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- FeeRedirectHook
    // AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG.
    function _deployFeeRedirect(
        Ctx memory ctx
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(FeeRedirectHook).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(ctx.poolManager), ctx.platform, ctx.creator, ctx.platformBps, ctx.creatorBps);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] FeeRedirectHook already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        FeeRedirectHook deployed = new FeeRedirectHook{salt: bytes32(salt)}(
            IPoolManager(ctx.poolManager), ctx.platform, ctx.creator, ctx.platformBps, ctx.creatorBps
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "FeeRedirect salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- AntiSniperHook
    // BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG.
    function _deployAntiSniper(
        Ctx memory ctx
    ) internal returns (address addr) {
        uint256 gateBlocks = vm.envOr("ANTISNIPER_GATE_BLOCKS", uint256(5));
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
        bytes memory creation = type(AntiSniperHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(ctx.poolManager), gateBlocks);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 200_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] AntiSniperHook already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        AntiSniperHook deployed =
            new AntiSniperHook{salt: bytes32(salt)}(IPoolManager(ctx.poolManager), gateBlocks);
        vm.stopBroadcast();
        require(address(deployed) == predicted, "AntiSniper salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- MultiHookHost v2
    // Adds BEFORE_INITIALIZE (stamps launchBlock) + BEFORE_SWAP (per-pool anti-sniper
    // gate) on top of the original three. Mask = 0x22C4.
    function _deployMultiHookHost(
        Ctx memory ctx
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(ctx.poolManager), ctx.platform, ctx.creator, ctx.platformBps, ctx.creatorBps);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] MultiHookHost already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(ctx.poolManager), ctx.platform, ctx.creator, ctx.platformBps, ctx.creatorBps
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "MultiHookHost salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- BuybackBurnHook
    // AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA. Requires a token currency, so we deploy
    // with a placeholder for the go-live rehearsal. Production spawns one per launched
    // token via a factory in a later phase.
    function _deployBuybackBurn(
        Ctx memory /* ctx */
    ) internal returns (address addr) {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address placeholderToken = vm.envOr("BUYBACK_TOKEN", address(0xdeaD));
        uint16 burnBps = uint16(vm.envOr("BUYBACK_BPS", uint256(200)));
        uint160 requiredFlags = Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(BuybackBurnHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(poolManager), Currency.wrap(placeholderToken), burnBps);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] BuybackBurnHook already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        BuybackBurnHook deployed = new BuybackBurnHook{salt: bytes32(salt)}(
            IPoolManager(poolManager), Currency.wrap(placeholderToken), burnBps
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "BuybackBurn salt drift");
        addr = address(deployed);
    }

    function _logSummary(
        address lpLocked,
        address feeRedirect,
        address antiSniper,
        address multiHookHost,
        address buybackBurn
    ) internal pure {
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
    }

    /// @dev Serializes the deploy addresses into `deployment-hooks.<chainid>.json` so
    ///      DeployGraduator + sync-addresses.mjs can consume them without hand-copying.
    function _writeAddressBook(
        address poolManager,
        address lpLocked,
        address feeRedirect,
        address antiSniper,
        address multiHookHost,
        address buybackBurn
    ) internal {
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
