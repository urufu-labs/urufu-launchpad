// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

// AntiBot template imports intentionally omitted — the on-chain ERC20Factory lacks
// `updateImpl`, so rotating the AntiBot impl bytecode requires either factory
// redeploy (out of scope) or registering fresh @v2-suffixed configHashes
// (a separate migration). This script only ships the Router-side portion of
// the V6 fix; the AntiBot impl bytecode change stays in source, dormant until
// the version-suffix migration.

interface ILiveRouterReads {
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function fees(
        BaseType b
    ) external view returns (uint256);
    function moduleAddOnFee() external view returns (uint256);
    function hookAddOnFee() external view returns (uint256);
    function governanceAddOnFee() external view returns (uint256);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function minUruFee() external view returns (uint256);
    function loyaltyOracle() external view returns (address);
    function curveFactory() external view returns (address);
    function factories(
        BaseType b
    ) external view returns (address);
    function curveIncompatibleConfigHash(
        bytes32
    ) external view returns (bool);
}

interface ILiveRouterAdmin {
    function setPaused(
        bool p
    ) external;
    function owner() external view returns (address);
}

interface ICurveFactoryAdmin {
    function setGraduator(
        address
    ) external;
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function graduator() external view returns (address);
}

interface IRoyaltyRouterFactoryAdmin {
    function setTrustedDeployer(
        address deployer_,
        bool trusted_
    ) external;
}

interface INameRegistryAdmin {
    function setRouter(
        address newRouter
    ) external;
}

interface IBaseFactoryAdmin {
    /// Every base factory's `deploy()` has `onlyRouter` — post-Router-redeploy
    /// this needs updating or launches through the new Router revert.
    function setRouter(
        address newRouter
    ) external;
    function router() external view returns (address);
}

/// @title  RedeployRouterV6
/// @notice V6 mini-redeploy — Router-only. Ships the RouterV2 half of the
///         AntiBot/AntiWhale + curve integration fix. The template half
///         (AntiBot gate check bypass on from-allowlisted) needs new impl
///         bytecode; the on-chain ERC20Factory lacks `updateImpl` (only
///         one-shot `registerImpl`), so activating the impl fix requires
///         either a factory redeploy (out of scope) or registering fresh
///         version-suffixed configHashes (frontend module-registry bump —
///         follow-up migration). This script does NOT include the impl work.
///
///         What ships here:
///           - New RouterV2 with `_grantCurveModuleAllowances(token, curve)`
///             called from every launch entrypoint (parent Router.launch +
///             launchWithURU + launchWithWhitelist + launchWithURUAndWhitelist).
///             Allowlists the curve, the Graduator (from-side of the graduation
///             transferFrom), and the PoolManager (to-side of the graduation
///             liquidity transfer). Fixes AntiWhale + curve on its own (the
///             AntiWhale module already respects `_awExcluded[from]`). Adds
///             defense-in-depth for AntiBot + curve — full activation waits
///             on the impl migration.
///
///         What this rewires:
///           - `curveFactory.setTrustedRouter(newV6, true)` + `(oldV5, false)`.
///           - `NameRegistry.setRouter(newV6)`.
///           - `RoyaltyRouterFactory.setTrustedDeployer(newV6, true)` + `(oldV5, false)`.
///           - `newV6.setFactory(ERC20/721A/1155)` + `setCurveFactory` +
///             `setLoyaltyOracle` + `setMinUruFee` (mirrored from V5).
///           - `ERC20Factory.setRouter(newV6)` + `ERC721A/1155.setRouter(newV6)`.
///           - Replays the 3 FoT-inclusive configHash blacklist entries
///             (solo FoT + AntiBot,FoT + FoT,Permit) on the fresh Router.
///           - `oldV5Router.setPaused(true)`.
///
///         What stays unchanged:
///           - MultiHookHost, Graduator, CurveFactory, BondingCurveImpl,
///             FeeSplitter, UruDepositSink, UruBuybackVault, NftRevenueVault,
///             V4SwapRouter, RoyaltyRouterFactory, RoyaltyRouterImpl,
///             LoyaltyOracle, PoolManager, NameRegistry, all factories, all
///             module impls.
///
/// Env vars (required):
///   V5_ROUTER_V2                current live RouterV2 (0x5EFA...)
///   CURVE_FACTORY               live CurveFactory
///   NAME_REGISTRY               live NameRegistry
///   ROYALTY_ROUTER_FACTORY      live RoyaltyRouterFactory
///
/// Post-deploy MANUAL steps:
///   1. Verify V6 Router + 5 fresh impl contracts on Blockscout.
///   2. Bump ROBINHOOD_ROUTER_ADDRESS in .env + Railway to V6.
///   3. Rebuild frontend with V6 Router in web/src/lib/config.ts.
///   4. Restart Ponder indexer (picks up new Router address from env).
contract RedeployRouterV6 is Script {
    // Hashes the V5 Router already blacklists. Kept as constants so the redeploy
    // can replay them on the fresh V6 Router without loading logs from chain.
    bytes32 internal constant HASH_FOT_SOLO = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot,FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_PERMIT = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));

    // AntiBot configHash constants intentionally omitted — no impl rotation this
    // pass (see the comment above imports).

    function run() external {
        address oldRouterAddr = vm.envAddress("V5_ROUTER_V2");
        address curveFactory = vm.envAddress("CURVE_FACTORY");
        address nameRegistry = vm.envAddress("NAME_REGISTRY");
        address royaltyRouterFactory = vm.envAddress("ROYALTY_ROUTER_FACTORY");

        ILiveRouterReads oldReads = ILiveRouterReads(oldRouterAddr);

        // ============================================================
        // 1. AntiBot impls INTENTIONALLY not rotated. The deployed ERC20Factory
        //    only exposes one-shot `registerImpl` and lacks `updateImpl`, so the
        //    only way to install fresh AntiBot bytecode against the existing
        //    configHashes is to redeploy the factory (out of scope) OR register
        //    new impls under `@version`-suffixed hashes (frontend module-registry
        //    bump — separate migration when we decide to relax the frontend's
        //    AntiBot+curve gate). Today the frontend blocks that combo entirely,
        //    so no direct user is exposed to the impl-level bug. Ship this V6
        //    Router redeploy first; the AntiBot impl migration can follow.
        // ============================================================

        // ============================================================
        // 2. Deploy V6 RouterV2 mirroring V5's ctor args.
        // ============================================================
        vm.startBroadcast();
        address newRouter = address(
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
        console2.log("V6 RouterV2 deployed:     ", newRouter);

        // ============================================================
        // 3. Wire the fresh Router's post-construction state from V5 live state.
        // ============================================================
        _wireNewRouter(newRouter, oldReads, curveFactory);

        // ============================================================
        // 4. Rotate external references onto the V6 Router.
        // ============================================================
        vm.startBroadcast();
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(newRouter, true);
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(oldRouterAddr, false);
        vm.stopBroadcast();
        console2.log("  [ok] CurveFactory.setTrustedRouter(V6=true, V5=false)");

        _tryNameRegistrySetRouter(nameRegistry, newRouter);
        _tryRoyaltyRouterFactoryRotate(royaltyRouterFactory, newRouter, oldRouterAddr);

        // ============================================================
        // 5. Rotate the 3 base factories' `router` slot to V6.
        // ============================================================
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC20), newRouter, "ERC20Factory");
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC721A), newRouter, "ERC721AFactory");
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC1155), newRouter, "ERC1155Factory");

        // ============================================================
        // 6. Replay every FoT-inclusive blacklist hash on the fresh V6 Router.
        // ============================================================
        _replayBlacklist(newRouter, HASH_FOT_SOLO, "FeeOnTransfer (solo)");
        _replayBlacklist(newRouter, HASH_FOT_ANTIBOT, "AntiBot,FeeOnTransfer");
        _replayBlacklist(newRouter, HASH_FOT_PERMIT, "FeeOnTransfer,Permit");

        // ============================================================
        // 7. Pause V5 Router so no launches land there while the frontend swap propagates.
        // ============================================================
        _pauseOldRouter(oldRouterAddr);

        _logSummary(newRouter, oldRouterAddr);
    }

    // ---------------------------------------------------------------- New Router wiring
    function _wireNewRouter(
        address newRouter,
        ILiveRouterReads oldReads,
        address curveFactory
    ) internal {
        RouterV2 r = RouterV2(payable(newRouter));

        vm.startBroadcast();
        address f0 = oldReads.factories(BaseType.ERC20);
        if (f0 != address(0)) r.setFactory(BaseType.ERC20, f0);
        address f1 = oldReads.factories(BaseType.ERC721A);
        if (f1 != address(0)) r.setFactory(BaseType.ERC721A, f1);
        address f2 = oldReads.factories(BaseType.ERC1155);
        if (f2 != address(0)) r.setFactory(BaseType.ERC1155, f2);

        r.setCurveFactory(curveFactory);

        address oracle = oldReads.loyaltyOracle();
        if (oracle != address(0)) r.setLoyaltyOracle(oracle);

        uint256 minFee = oldReads.minUruFee();
        if (minFee > 0) r.setMinUruFee(minFee);
        vm.stopBroadcast();
        console2.log("  [ok] V6.setFactory x3 + setCurveFactory + setLoyaltyOracle + setMinUruFee");
    }

    function _tryNameRegistrySetRouter(
        address nameRegistry,
        address newRouter
    ) internal {
        vm.startBroadcast();
        try INameRegistryAdmin(nameRegistry).setRouter(newRouter) {
            console2.log("  [ok] NameRegistry.setRouter(V6)");
        } catch {
            console2.log("  [warn] NameRegistry.setRouter FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _tryRoyaltyRouterFactoryRotate(
        address rrf,
        address newRouter,
        address oldRouter
    ) internal {
        vm.startBroadcast();
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(newRouter, true) {
            console2.log("  [ok] RRF.setTrustedDeployer(V6, true)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(V6) FAILED (needs multisig)");
        }
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(oldRouter, false) {
            console2.log("  [ok] RRF.setTrustedDeployer(V5, false)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(V5, false) FAILED (needs multisig)");
        }
        vm.stopBroadcast();
    }

    function _tryFactorySetRouter(
        address factory,
        address newRouter,
        string memory name
    ) internal {
        if (factory == address(0)) return;
        vm.startBroadcast();
        try IBaseFactoryAdmin(factory).setRouter(newRouter) {
            console2.log(string.concat("  [ok] ", name, ".setRouter(V6)"));
        } catch {
            console2.log(string.concat("  [warn] ", name, ".setRouter FAILED (needs owner)"));
        }
        vm.stopBroadcast();
    }

    function _replayBlacklist(
        address router,
        bytes32 hash,
        string memory label
    ) internal {
        vm.startBroadcast();
        try RouterV2(payable(router)).setCurveIncompatibleConfigHash(hash, true) {
            console2.log(string.concat("  [ok] V6.blacklist(", label, ")"));
        } catch {
            console2.log(string.concat("  [warn] V6.blacklist(", label, ") FAILED"));
        }
        vm.stopBroadcast();
    }

    function _pauseOldRouter(
        address oldRouterAddr
    ) internal {
        vm.startBroadcast();
        try ILiveRouterAdmin(oldRouterAddr).setPaused(true) {
            console2.log("  [ok] V5 Router setPaused(true)");
        } catch {
            console2.log("  [warn] V5 Router setPaused FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _logSummary(
        address newRouter,
        address oldRouter
    ) internal view {
        console2.log("=========================================================");
        console2.log("V6 mini-redeploy complete (Router-only)");
        console2.log("=========================================================");
        console2.log("  chainid:                     ", block.chainid);
        console2.log("  RouterV2 (V6):               ", newRouter);
        console2.log("  RouterV2 (V5, paused):       ", oldRouter);
    }
}
