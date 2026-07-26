// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {Router} from "src/router/Router.sol";

/// @title  DeployV3Stack
/// @notice One-shot deploy of the V3 audit-fix stack in a single broadcast:
///           - new BondingCurve impl (Fix 3: WL fallbackTs validation;
///             Fix 4: zero-token buys revert; Fix 5: tokenReserve==0 no longer
///             triggers graduation and strands ETH)
///           - new CurveFactoryV3 pointing at the new impl
///           - new MultiHookHost V3 (Fix 1: pushOwed lets FeeSplitter receive
///             its accumulated platform slot without a claim() caller of its own)
///           - new Graduator V3 (Fix 2: setPoolConfig + setCreator called
///             unconditionally so pre-planted attacker configs are overwritten)
///           - wires new MultiHookHost.setInitializer(newGraduator)
///           - wires newCurveFactoryV3.setGraduator(newGraduator)
///           - wires newCurveFactoryV3.setTrustedRouter(RouterV2, true)
///           - wires RouterV2.setCurveFactory(newCurveFactoryV3)
///           - optionally rewires the OLD V1 + V2 CurveFactory graduator so
///             legacy in-flight curves also graduate through the fixed hook
///
///         Existing pools are NOT touched - their PoolKey (with the old hook)
///         is immutable. Trade pages find the right hook per-token via the
///         indexer's `graduations.hookAddress` column.
///
/// @dev    Requires the broadcaster to own:
///           - RouterV2 (to setCurveFactory)
///           - OLD_V1_CURVE_FACTORY + OLD_V2_CURVE_FACTORY (if WIRE_LEGACY=1)
///         If ownership has already handed off, set WIRE_LEGACY=0 and run those
///         setGraduator calls as multisig txs post-deploy.
///
/// Env vars:
///   V4_POOL_MANAGER      - required. v4 PoolManager for the target chain.
///   ROUTER_V2            - required. Deployed RouterV2 address.
///   FEE_SPLITTER         - required. Platform recipient on new MultiHookHost.
///   FEE_RECEIVER         - optional. Curve trade-fee sink on new CurveFactoryV3.
///                          Defaults to FEE_SPLITTER (existing behavior).
///   PLATFORM_BPS         - default 100 (1%). Matches existing V2 hook.
///   CREATOR_BPS          - default 100 (1%). Matches existing V2 hook.
///   FALLBACK_CREATOR     - optional. MultiHookHost's immutable creator fallback.
///                          Defaults to broadcaster.
///   GRADUATOR_FEE        - default 3000 (0.3% tier).
///   GRADUATOR_TICK_SPACING - default 60.
///   WIRE_LEGACY          - "1" to also call OLD_V1_CURVE_FACTORY.setGraduator +
///                          OLD_V2_CURVE_FACTORY.setGraduator with the new
///                          Graduator. Requires broadcaster ownership of both.
///   OLD_V1_CURVE_FACTORY - required if WIRE_LEGACY=1.
///   OLD_V2_CURVE_FACTORY - required if WIRE_LEGACY=1.
///
/// Local rehearsal (RH fork):
///   V4_POOL_MANAGER=0x8366... ROUTER_V2=0x66c9... FEE_SPLITTER=0x60cA... \
///     forge script script/DeployV3Stack.s.sol:DeployV3Stack \
///     --fork-url $ROBINHOOD_RPC_URL -vvvv
///
/// Broadcast:
///   V4_POOL_MANAGER=... ROUTER_V2=... FEE_SPLITTER=... WIRE_LEGACY=1 \
///     OLD_V1_CURVE_FACTORY=... OLD_V2_CURVE_FACTORY=... \
///     bash contracts/deploy.sh V3Stack robinhood
contract DeployV3Stack is Script {
    /// @dev Canonical Foundry CREATE2 deployer, present on every EVM chain we care about.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Deployed {
        address bondingCurveImpl;
        address curveFactoryV3;
        address multiHookHostV3;
        address graduatorV3;
    }

    function run() external returns (Deployed memory out) {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address routerV2 = vm.envAddress("ROUTER_V2");
        address feeSplitter = vm.envAddress("FEE_SPLITTER");
        address feeReceiver = vm.envOr("FEE_RECEIVER", feeSplitter);
        address fallbackCreator = vm.envOr("FALLBACK_CREATOR", msg.sender);
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));
        uint24 fee = uint24(vm.envOr("GRADUATOR_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("GRADUATOR_TICK_SPACING", uint256(60))));

        // 1. Curve stack - new BondingCurve impl + new CurveFactoryV3.
        out.bondingCurveImpl = _deployBondingCurve();
        out.curveFactoryV3 = _deployCurveFactoryV3(msg.sender, feeReceiver, out.bondingCurveImpl);

        // 2. Hook stack - new MultiHookHost V3 (mined salt) + Graduator V3.
        out.multiHookHostV3 = _deployMultiHookHostV3(poolManager, feeSplitter, fallbackCreator, platformBps, creatorBps);
        out.graduatorV3 = _deployGraduatorV3(poolManager, out.multiHookHostV3, fee, tickSpacing);

        // 3. Cross-wire: hook's initializer gate -> new Graduator.
        _wireInitializerGate(out.multiHookHostV3, out.graduatorV3);

        // 4. Wire new CurveFactory: graduator + trusted router.
        _wireNewCurveFactory(out.curveFactoryV3, out.graduatorV3, routerV2);

        // 5. Rotate RouterV2's CurveFactory pointer to the new one.
        _rotateRouterCurveFactory(routerV2, out.curveFactoryV3);

        // 6. Optional: rotate the OLD V1 + V2 CurveFactory graduators so
        //    in-flight curves also graduate through the fixed hook + graduator.
        _maybeWireLegacyFactories(out.graduatorV3);

        _logSummary(out, poolManager, feeSplitter, routerV2);
        _writeAddressBook(out, poolManager, fee, tickSpacing);
    }

    // ---------------------------------------------------------------- BondingCurve impl
    function _deployBondingCurve() internal returns (address addr) {
        vm.startBroadcast();
        BondingCurve impl = new BondingCurve();
        vm.stopBroadcast();
        addr = address(impl);
    }

    // ---------------------------------------------------------------- CurveFactoryV3
    function _deployCurveFactoryV3(
        address admin,
        address feeReceiver,
        address curveImpl
    ) internal returns (address addr) {
        vm.startBroadcast();
        CurveFactory f = new CurveFactory(admin, feeReceiver, curveImpl);
        vm.stopBroadcast();
        addr = address(f);
    }

    // ---------------------------------------------------------------- MultiHookHost V3
    // Same permission flags as V2 (0x22C4). Bytecode differs from V2 (pushOwed added
    // + audit-fix comment adjustments), so the mined salt lands at a fresh address.
    // Deploys via CREATE2 so the mined salt is honored and the address is deterministic.
    function _deployMultiHookHostV3(
        address poolManager,
        address platform,
        address creator,
        uint16 platformBps,
        uint16 creatorBps
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), platform, creator, platformBps, creatorBps, msg.sender);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);
        if (predicted.code.length > 0) {
            console2.log("  [skip] MultiHookHost V3 already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), platform, creator, platformBps, creatorBps, msg.sender
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "MultiHookHost V3 salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- Graduator V3
    function _deployGraduatorV3(
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

    // ---------------------------------------------------------------- initializer gate
    function _wireInitializerGate(
        address hookAddr,
        address newGraduator
    ) internal {
        vm.startBroadcast();
        try MultiHookHost(payable(hookAddr)).setInitializer(newGraduator) {
        // wire landed
        }
            catch {
            // idempotent re-run - already wired. Safe no-op.
        }
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- CurveFactory wiring
    function _wireNewCurveFactory(
        address newCurveFactory,
        address newGraduator,
        address routerV2
    ) internal {
        vm.startBroadcast();
        CurveFactory(newCurveFactory).setGraduator(newGraduator);
        CurveFactory(newCurveFactory).setTrustedRouter(routerV2, true);
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- RouterV2 rotation
    function _rotateRouterCurveFactory(
        address routerV2,
        address newCurveFactory
    ) internal {
        vm.startBroadcast();
        Router(payable(routerV2)).setCurveFactory(newCurveFactory);
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- Legacy factories
    // Rotates the OLD V1 + V2 CurveFactory graduators so their in-flight curves also
    // graduate against the fixed MultiHookHost + Graduator. Skipped by default so a
    // deploy can be reviewed on-chain first; when ownership has handed off, run these
    // via multisig instead of WIRE_LEGACY.
    function _maybeWireLegacyFactories(
        address newGraduator
    ) internal {
        bool wire = vm.envOr("WIRE_LEGACY", uint256(0)) == 1;
        if (!wire) {
            console2.log("  [pending] Legacy CurveFactory graduator rotation SKIPPED (WIRE_LEGACY=0).");
            return;
        }
        address v1Factory = vm.envAddress("OLD_V1_CURVE_FACTORY");
        address v2Factory = vm.envAddress("OLD_V2_CURVE_FACTORY");
        vm.startBroadcast();
        CurveFactory(v1Factory).setGraduator(newGraduator);
        CurveFactory(v2Factory).setGraduator(newGraduator);
        vm.stopBroadcast();
        console2.log("  [done] Legacy V1 + V2 CurveFactory.setGraduator invoked.");
    }

    // ---------------------------------------------------------------- Logging + book
    function _logSummary(
        Deployed memory out,
        address poolManager,
        address feeSplitter,
        address routerV2
    ) internal view {
        console2.log("=========================================================");
        console2.log("V3 stack deployed (audit-fix pass)");
        console2.log("=========================================================");
        console2.log("  chainid:              ", block.chainid);
        console2.log("  BondingCurve impl:    ", out.bondingCurveImpl);
        console2.log("  CurveFactoryV3:       ", out.curveFactoryV3);
        console2.log("  MultiHookHostV3:      ", out.multiHookHostV3);
        console2.log("  GraduatorV3:          ", out.graduatorV3);
        console2.log("---------------------------------------------------------");
        console2.log("  PoolManager:          ", poolManager);
        console2.log("  FeeSplitter (platform)", feeSplitter);
        console2.log("  RouterV2 rotated:     ", routerV2);
        console2.log("---------------------------------------------------------");
        console2.log("Fixes shipped in this stack:");
        console2.log("  1. MultiHookHost.pushOwed - anyone can route platform slot to FeeSplitter");
        console2.log("  2. Graduator overwrites pre-planted pool config + creator");
        console2.log("  3. BondingCurve rejects fallbackTs <= now on WL init");
        console2.log("  4. BondingCurve rejects tokensOut==0 buys (guards clamp-to-empty)");
        console2.log("  5. BondingCurve grad trigger gated on ethReserve only (no more stranded ETH)");
    }

    function _writeAddressBook(
        Deployed memory out,
        address poolManager,
        uint24 fee,
        int24 tickSpacing
    ) internal {
        string memory obj = "v3stack";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "BondingCurveImpl", out.bondingCurveImpl);
        vm.serializeAddress(obj, "CurveFactoryV3", out.curveFactoryV3);
        vm.serializeAddress(obj, "MultiHookHostV3", out.multiHookHostV3);
        vm.serializeAddress(obj, "GraduatorV3", out.graduatorV3);
        vm.serializeAddress(obj, "PoolManager", poolManager);
        vm.serializeUint(obj, "Fee", uint256(fee));
        string memory json = vm.serializeInt(obj, "TickSpacing", int256(tickSpacing));
        string memory path = string.concat("deployment-v3stack.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Address book written:", path);
    }
}
