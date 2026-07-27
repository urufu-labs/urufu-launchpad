// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

interface IOldRouterReads {
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function fees(BaseType b) external view returns (uint256);
    function moduleAddOnFee() external view returns (uint256);
    function hookAddOnFee() external view returns (uint256);
    function governanceAddOnFee() external view returns (uint256);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function minUruFee() external view returns (uint256);
    function loyaltyOracle() external view returns (address);
    function curveFactory() external view returns (address);
    function factories(BaseType b) external view returns (address);
}

interface IOldRouterAdmin {
    function setPaused(bool p) external;
    function owner() external view returns (address);
}

interface ICurveFactoryAdmin {
    function setGraduator(address graduator_) external;
    function setTrustedRouter(address router_, bool trusted_) external;
}

interface IRoyaltyRouterFactoryAdmin {
    function setTrustedDeployer(address deployer_, bool trusted_) external;
}

interface INameRegistryAdmin {
    function setRouter(address newRouter) external;
}

/// @title  RedeployRouterAndGrad
/// @notice Mini-redeploy fixing two on-chain HIGH bugs surfaced post-V4:
///           (1) Graduator was permissionless — anyone could pre-init a graduating
///               pool at attacker-chosen sqrtPriceX96 with attacker installed as
///               creator, bricking the real graduation forever.
///           (2) RouterV2's FoT-blacklist check lived only in parent Router.launch —
///               launchWithURU / launchWithWhitelist / launchWithURUAndWhitelist all
///               bypassed it, so a FoT token could be launched via those paths and
///               then brick swaps.
///
///         Ships:
///           - New Graduator with `curveFactory.curveFor(token) == msg.sender` gate.
///           - New MultiHookHost (setInitializer is one-shot, forces fresh hook so
///             we can point it at the new Graduator).
///           - New RouterV2 with the FoT-blacklist check inlined into all three
///             non-parent entrypoints.
///
///         Rewires:
///           - hook.setInitializer(newGraduator)
///           - curveFactory.setGraduator(newGraduator) + setTrustedRouter(newRouter)
///           - newRouter.setFactory(ERC20/721A/1155) mirrored from old router reads
///           - newRouter.setCurveFactory + setLoyaltyOracle + setMinUruFee
///           - NameRegistry.setRouter(newRouter)
///           - RoyaltyRouterFactory.setTrustedDeployer(newRouter)
///           - oldRouter.setPaused(true)
///
///         Not redeployed / not rewired (still live, unaffected by the two bugs):
///           - CurveFactory, BondingCurveImpl, FeeSplitter, UruDepositSink,
///             UruBuybackVault, NftRevenueVault, V4SwapRouter, RoyaltyRouterFactory,
///             RoyaltyRouterImpl, LoyaltyOracle, PoolManager.
///
/// Env vars (required):
///   V4_POOL_MANAGER              PoolManager (RH: 0x8366…)
///   OLD_ROUTER_V2                current live RouterV2 (RH: 0xb851…)
///   CURVE_FACTORY                current live CurveFactory (RH: 0x4631…)
///   FEE_SPLITTER                 current live FeeSplitter (RH: 0x20d2…) — hook's platform
///   NAME_REGISTRY                current live NameRegistry
///   ROYALTY_ROUTER_FACTORY       current live RoyaltyRouterFactory (RH: 0x6309…)
///   DEFAULT_CREATOR              fallback creator address baked into the hook (deployer works)
///
/// Env vars (optional, default 100 = 1%):
///   PLATFORM_BPS                 hook's platform fee bps
///   CREATOR_BPS                  hook's creator fee bps
///
/// Post-deploy MANUAL steps:
///   1. Replay `setCurveIncompatibleConfigHash(hash, true)` for every FoT hash on newRouter.
///   2. Verify 3 contracts on Blockscout.
///   3. node tools/sync-addresses.mjs robinhood + update Railway envs.
///   4. Point Ponder indexer factory subscriptions at newRouter + newHook.
contract RedeployRouterAndGrad is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Deployed {
        address multiHookHost;
        address graduator;
        address routerV2;
    }

    function run() external {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address oldRouterAddr = vm.envAddress("OLD_ROUTER_V2");
        address curveFactory = vm.envAddress("CURVE_FACTORY");
        address feeSplitter = vm.envAddress("FEE_SPLITTER");
        address nameRegistry = vm.envAddress("NAME_REGISTRY");
        address royaltyRouterFactory = vm.envAddress("ROYALTY_ROUTER_FACTORY");
        address defaultCreator = vm.envAddress("DEFAULT_CREATOR");

        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));

        IOldRouterReads oldReads = IOldRouterReads(oldRouterAddr);

        // ============================================================
        // 1. Deploy fresh MultiHookHost via CREATE2 mining
        //    (platform=FeeSplitter so post-grad swap fees route into the flywheel)
        // ============================================================
        Deployed memory out;
        out.multiHookHost =
            _deployMultiHookHost(poolManager, feeSplitter, defaultCreator, platformBps, creatorBps);
        console2.log("MultiHookHost deployed:", out.multiHookHost);

        // ============================================================
        // 2. Deploy Graduator wired to (1) + existing CurveFactory
        // ============================================================
        vm.startBroadcast();
        out.graduator = address(
            new Graduator(IPoolManager(poolManager), IHooks(out.multiHookHost), 3000, 60, curveFactory)
        );
        vm.stopBroadcast();
        console2.log("Graduator deployed:    ", out.graduator);

        // ============================================================
        // 3. Point hook's one-shot initializer slot at the new Graduator
        // ============================================================
        vm.startBroadcast();
        MultiHookHost(payable(out.multiHookHost)).setInitializer(out.graduator);
        vm.stopBroadcast();
        console2.log("  [ok] hook.setInitializer(newGraduator)");

        // ============================================================
        // 4. Deploy new RouterV2 mirroring the old one's constructor args.
        //    All immutables read live from the old router so state stays in sync.
        // ============================================================
        vm.startBroadcast();
        out.routerV2 = address(
            new RouterV2(
                msg.sender,
                NameRegistry(oldReads.registry()),
                IFeeReceiver(oldReads.feeReceiver()),
                oldReads.fees(BaseType.ERC20),
                oldReads.fees(BaseType.ERC721A),
                oldReads.fees(BaseType.ERC1155),
                oldReads.moduleAddOnFee(),
                oldReads.hookAddOnFee(),
                oldReads.governanceAddOnFee(),
                oldReads.uru(),
                UruDepositSink(payable(oldReads.uruSink()))
            )
        );
        vm.stopBroadcast();
        console2.log("RouterV2 deployed:     ", out.routerV2);

        // ============================================================
        // 5. Wire the new Router's post-construction slots from the old
        //    router's live state so behavior matches on day one.
        // ============================================================
        _wireNewRouter(out.routerV2, oldReads, curveFactory);

        // ============================================================
        // 6. Rotate external references onto the new stack
        // ============================================================
        vm.startBroadcast();
        ICurveFactoryAdmin(curveFactory).setGraduator(out.graduator);
        // Trust the new router AND untrust the old one, so createCurveWithConfigForWl
        // (only-trusted gate) rejects launches through the buggy old contract.
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(out.routerV2, true);
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(oldRouterAddr, false);
        vm.stopBroadcast();
        console2.log("  [ok] CurveFactory.setGraduator + setTrustedRouter(new=true, old=false)");

        _tryNameRegistrySetRouter(nameRegistry, out.routerV2);
        _tryRoyaltyRouterFactoryRotate(royaltyRouterFactory, out.routerV2, oldRouterAddr);

        // ============================================================
        // 7. Pause the old router so no launches land on the buggy contract
        //    while the frontend still points at it.
        // ============================================================
        _pauseOldRouter(oldRouterAddr);

        _logSummary(out, oldRouterAddr, poolManager);
    }

    // ---------------------------------------------------------------- MultiHookHost mining
    function _deployMultiHookHost(
        address poolManager,
        address platform,
        address defaultCreator,
        uint16 platformBps,
        uint16 creatorBps
    ) internal returns (address addr) {
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args = abi.encode(
            IPoolManager(poolManager), platform, defaultCreator, platformBps, creatorBps, msg.sender
        );
        // Scan salts, skipping any address that already has code — a redeploy with
        // identical ctor args (same PoolManager / FeeSplitter / bps / deployer) would
        // otherwise land on the currently-live hook. Bump the start salt until we find
        // a satisfying address that's genuinely empty on-chain.
        uint256 startSalt = 0;
        address predicted;
        uint256 salt;
        for (uint256 i = 0; i < 20; ++i) {
            (salt, predicted) =
                HookMiner.findFrom(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000, startSalt);
            if (predicted.code.length == 0) break;
            startSalt = salt + 1;
            console2.log("  [skip] salt collides with live contract, advancing", startSalt);
        }
        require(predicted.code.length == 0, "MultiHookHost: no free salt within window");
        vm.startBroadcast();
        MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), platform, defaultCreator, platformBps, creatorBps, msg.sender
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "MultiHookHost salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- New Router wiring
    function _wireNewRouter(
        address newRouter,
        IOldRouterReads oldReads,
        address curveFactory
    ) internal {
        RouterV2 r = RouterV2(payable(newRouter));

        vm.startBroadcast();
        address ercFactory = oldReads.factories(BaseType.ERC20);
        if (ercFactory != address(0)) r.setFactory(BaseType.ERC20, ercFactory);
        address nftFactory = oldReads.factories(BaseType.ERC721A);
        if (nftFactory != address(0)) r.setFactory(BaseType.ERC721A, nftFactory);
        address ff1155 = oldReads.factories(BaseType.ERC1155);
        if (ff1155 != address(0)) r.setFactory(BaseType.ERC1155, ff1155);

        r.setCurveFactory(curveFactory);

        address oracle = oldReads.loyaltyOracle();
        if (oracle != address(0)) r.setLoyaltyOracle(oracle);

        uint256 minFee = oldReads.minUruFee();
        if (minFee > 0) r.setMinUruFee(minFee);
        vm.stopBroadcast();
        console2.log("  [ok] newRouter.setFactory x3 + setCurveFactory + setLoyaltyOracle + setMinUruFee");
        console2.log("  [NOTE] FoT curveIncompatibleConfigHash entries are NOT copied - replay via cast");
    }

    function _tryNameRegistrySetRouter(address nameRegistry, address newRouter) internal {
        vm.startBroadcast();
        try INameRegistryAdmin(nameRegistry).setRouter(newRouter) {
            console2.log("  [ok] NameRegistry.setRouter(newRouter)");
        } catch {
            console2.log("  [warn] NameRegistry.setRouter FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _tryRoyaltyRouterFactoryRotate(address rrf, address newRouter, address oldRouter) internal {
        vm.startBroadcast();
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(newRouter, true) {
            console2.log("  [ok] RoyaltyRouterFactory.setTrustedDeployer(newRouter, true)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(new) FAILED (needs multisig)");
        }
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(oldRouter, false) {
            console2.log("  [ok] RoyaltyRouterFactory.setTrustedDeployer(oldRouter, false)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(old, false) FAILED (needs multisig)");
        }
        vm.stopBroadcast();
    }

    function _pauseOldRouter(address oldRouterAddr) internal {
        vm.startBroadcast();
        try IOldRouterAdmin(oldRouterAddr).setPaused(true) {
            console2.log("  [ok] oldRouter.setPaused(true)");
        } catch {
            console2.log("  [warn] oldRouter.setPaused FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- Summary
    function _logSummary(Deployed memory out, address oldRouter, address poolManager) internal view {
        console2.log("=========================================================");
        console2.log("V5 mini-redeploy complete");
        console2.log("=========================================================");
        console2.log("  chainid:            ", block.chainid);
        console2.log("  --- NEW ---");
        console2.log("  MultiHookHost:      ", out.multiHookHost);
        console2.log("  Graduator:          ", out.graduator);
        console2.log("  RouterV2:           ", out.routerV2);
        console2.log("  --- OLD (paused / superseded) ---");
        console2.log("  RouterV2 (old):     ", oldRouter);
        console2.log("  --- Unchanged ---");
        console2.log("  PoolManager:        ", poolManager);
        console2.log("---------------------------------------------------------");
        console2.log("Post-deploy MANUAL steps:");
        console2.log("  1. Replay FoT blacklist: cast send NEW_ROUTER setCurveIncompatibleConfigHash(...) per hash");
        console2.log("  2. Verify 3 contracts on Blockscout");
        console2.log("  3. node tools/sync-addresses.mjs robinhood -> update config.ts + Railway env");
        console2.log("  4. Update Ponder indexer factory subscription addresses + start block");
    }
}
