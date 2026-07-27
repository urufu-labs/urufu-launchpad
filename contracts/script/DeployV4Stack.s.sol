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
import {RouterV2} from "src/router/RouterV2.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType} from "src/types/VMTypes.sol";

interface IFactoryOwned {
    function setRouter(
        address newRouter
    ) external;
    function owner() external view returns (address);
}

interface ICurveFactoryOwned {
    function setGraduator(
        address graduator_
    ) external;
}

/// @title  DeployV4Stack
/// @notice One-shot broadcast that deploys the entire audit-fix V4 stack + wires
///         it into the existing infrastructure. Ships the following fixes:
///
///           - MultiHookHost F-2: exact-output swaps now pay platform+creator fees
///           - RouterV2 H-1:      minUruFee floor to block URU-pay spam
///           - Router M-3:        loyalty discount clamped at HARD_MAX_BPS locally
///           - Router H-3:        curveIncompatibleConfigHash blocks FoT+curve installs
///           - UruDepositSink H-2 + M-5: minEthPerUru floor + timelock rotation
///           - UruBuybackVault H-2 + sweep: minUruPerEth + sweepURU + timelock
///           - FeeSplitter M-4:   try/call fallback so bad sinks can't brick launches
///           - V4SwapRouter H-2 + H-3 + M-3 + M-4: slippage hoist, deadline, refund, guard
///           - RoyaltyRouterFactory H: authorized-caller check on deployFor
///           - RoyaltyRouterImpl:  sweep now routes through split
///           - NftRevenueVault:    zero-root reject, overcommit reject, sweepDust
///
///         Wires + rotates:
///           - MultiHookHostV4.setInitializer(GraduatorV4)
///           - CurveFactoryV4.setGraduator + setTrustedRouter(RouterV2 V4)
///           - RouterV2 V4.setFactory (ERC20/721A/1155) + setCurveFactory + setLoyaltyOracle
///           - UruDepositSink V4 setKeeper + setSwapTarget + setMinEthPerUru
///           - UruBuybackVault V4 setKeeper + setSwapTarget + setMinUruPerEth
///           - RoyaltyRouterFactory V4 setTrustedDeployer(RouterV2 V4)
///           - NameRegistry (V3, on-chain).setRouter(RouterV2 V4)  // one-time
///           - ERC20/721A/1155 factories setRouter(RouterV2 V4)
///           - Old CurveFactory (V1, V2, V3) setGraduator(GraduatorV4)
///
///         Not deployed / kept as-is:
///           - NameRegistry (state has reserved names; V3 unchanged; new setRouter
///             flow only affects future deploys)
///           - LoyaltyOracle (unchanged)
///           - PoolManager (Uniswap v4 core, not ours)
///
///         Post-deploy manual steps (2-day timelock):
///           - FeeSplitter V4.setConfig(buyback, nft, treasury, 4000, 3500, 2500)
///             after minConfigDelay elapses (~2 days).
///
/// Env vars (required):
///   V4_POOL_MANAGER            v4 PoolManager (RH: 0x8366...)
///   NAME_REGISTRY              existing NameRegistry (RH: 0x60b7...)
///   ERC20_FACTORY, ERC721A_FACTORY, ERC1155_FACTORY   existing base factories
///   URU_TOKEN                  URU ERC20 (RH: 0x9fbe...)
///   GEMU_NFT                   gemu ERC721 (RH: 0x60cB...)
///   LOYALTY_ORACLE             existing LoyaltyOracle (RH: 0xd13A...)
///   OLD_ROUTER                 existing V1 Router (for fee-schedule mirror)
///   TREASURY                   FeeSplitter's treasury sink
///
/// Env vars (optional):
///   PLATFORM_BPS               MultiHookHost platform slice (default 100)
///   CREATOR_BPS                MultiHookHost creator fallback slice (default 100)
///   MIN_CONFIG_DELAY           Timelock delay for vault rotations (default 2 days)
///   MIN_URU_FEE                RouterV2 URU-pay floor (default 100e18)
///   MIN_ETH_PER_URU            UruDepositSink swap-rate floor (default 0)
///   MIN_URU_PER_ETH            UruBuybackVault swap-rate floor (default 0)
///   ROYALTY_PLATFORM_BPS       RoyaltyRouterFactory platform slice (default 500)
///   WIRE_LEGACY                "1" to rotate old CurveFactory graduators (default 0)
///   OLD_V1_CURVE_FACTORY       required if WIRE_LEGACY=1
///   OLD_V2_CURVE_FACTORY       required if WIRE_LEGACY=1
///   OLD_V3_CURVE_FACTORY       required if WIRE_LEGACY=1
///   KEEPER                     Keeper for both URU vaults (default = broadcaster)
///   UNI_UR                     Universal Router for keeper swaps (RH: 0x8876...)
contract DeployV4Stack is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Deployed {
        // Flywheel
        address nftRevenueVault;
        address uruBuybackVault;
        address feeSplitter;
        address uruDepositSink;
        address royaltyRouterImpl;
        address royaltyRouterFactory;
        // Router + curve
        address routerV2;
        address bondingCurveImpl;
        address curveFactory;
        // v4 hook + graduator + swap router
        address multiHookHost;
        address graduator;
        address v4SwapRouter;
    }

    function run() external returns (Deployed memory out) {
        // ---- Required env
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address nameRegistry = vm.envAddress("NAME_REGISTRY");
        address erc20Factory = vm.envAddress("ERC20_FACTORY");
        address erc721aFactory = vm.envAddress("ERC721A_FACTORY");
        address erc1155Factory = vm.envAddress("ERC1155_FACTORY");
        address uruToken = vm.envAddress("URU_TOKEN");
        address loyaltyOracle = vm.envAddress("LOYALTY_ORACLE");
        address oldRouter = vm.envAddress("OLD_ROUTER");
        address treasury = vm.envAddress("TREASURY");

        // ---- Optional env (with defaults)
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));
        uint256 minConfigDelay = vm.envOr("MIN_CONFIG_DELAY", uint256(2 days));
        uint256 minUruFee = vm.envOr("MIN_URU_FEE", uint256(100e18));
        uint256 minEthPerUru = vm.envOr("MIN_ETH_PER_URU", uint256(0));
        uint256 minUruPerEth = vm.envOr("MIN_URU_PER_ETH", uint256(0));
        uint16 royaltyPlatformBps = uint16(vm.envOr("ROYALTY_PLATFORM_BPS", uint256(500)));
        address keeper = vm.envOr("KEEPER", msg.sender);
        address uniUR = vm.envOr("UNI_UR", address(0));

        // ============================================================
        // 1. Flywheel base (NftRevenueVault, FeeSplitter)
        // ============================================================
        vm.startBroadcast();
        out.nftRevenueVault = address(new NftRevenueVault(msg.sender));
        out.feeSplitter = address(new FeeSplitter(msg.sender, treasury, minConfigDelay));
        // UruBuybackVault forwards proceeds to NftRevenueVault - hard-wired here
        // so the flywheel loop closes automatically at deploy time.
        out.uruBuybackVault = address(new UruBuybackVault(msg.sender, uruToken, out.nftRevenueVault, minConfigDelay));
        out.uruDepositSink = address(new UruDepositSink(msg.sender, uruToken, out.feeSplitter, minConfigDelay));

        // Keeper allowlist + swap target for both vaults (only if UNI_UR provided).
        UruBuybackVault(payable(out.uruBuybackVault)).setKeeper(keeper, true);
        UruDepositSink(payable(out.uruDepositSink)).setKeeper(keeper, true);
        if (uniUR != address(0)) {
            UruBuybackVault(payable(out.uruBuybackVault)).setSwapTarget(uniUR, true);
            UruDepositSink(payable(out.uruDepositSink)).setSwapTarget(uniUR, true);
        }
        // Slippage floors (optional; 0 = disabled until owner tunes).
        UruBuybackVault(payable(out.uruBuybackVault)).setMinUruPerEth(minUruPerEth);
        UruDepositSink(payable(out.uruDepositSink)).setMinEthPerUru(minEthPerUru);
        vm.stopBroadcast();

        // ============================================================
        // 2. Royalty flywheel (Impl + Factory)
        // ============================================================
        vm.startBroadcast();
        out.royaltyRouterImpl = address(new RoyaltyRouterImpl());
        out.royaltyRouterFactory =
            address(new RoyaltyRouterFactory(msg.sender, out.royaltyRouterImpl, out.feeSplitter, royaltyPlatformBps));
        vm.stopBroadcast();

        // ============================================================
        // 3. RouterV2 (V4 bytecode) + factory dispatch wiring
        // ============================================================
        Router oldR = Router(payable(oldRouter));
        vm.startBroadcast();
        out.routerV2 = address(
            new RouterV2(
                msg.sender,
                NameRegistry(nameRegistry),
                IFeeReceiver(out.feeSplitter),
                oldR.fees(BaseType.ERC20),
                oldR.fees(BaseType.ERC721A),
                oldR.fees(BaseType.ERC1155),
                oldR.moduleAddOnFee(),
                oldR.hookAddOnFee(),
                oldR.governanceAddOnFee(),
                uruToken,
                UruDepositSink(payable(out.uruDepositSink))
            )
        );
        RouterV2(payable(out.routerV2)).setFactory(BaseType.ERC20, erc20Factory);
        RouterV2(payable(out.routerV2)).setFactory(BaseType.ERC721A, erc721aFactory);
        RouterV2(payable(out.routerV2)).setFactory(BaseType.ERC1155, erc1155Factory);
        RouterV2(payable(out.routerV2)).setLoyaltyOracle(loyaltyOracle);
        RouterV2(payable(out.routerV2)).setMinUruFee(minUruFee);
        vm.stopBroadcast();

        // ============================================================
        // 4. Curve stack (BondingCurve impl + CurveFactory)
        // ============================================================
        vm.startBroadcast();
        out.bondingCurveImpl = address(new BondingCurve());
        out.curveFactory = address(new CurveFactory(msg.sender, out.feeSplitter, out.bondingCurveImpl));
        CurveFactory(out.curveFactory).setTrustedRouter(out.routerV2, true);
        RouterV2(payable(out.routerV2)).setCurveFactory(out.curveFactory);
        vm.stopBroadcast();

        // ============================================================
        // 5. v4 hook + graduator + swap router
        // ============================================================
        out.multiHookHost = _deployMultiHookHost(poolManager, out.feeSplitter, msg.sender, platformBps, creatorBps);

        vm.startBroadcast();
        out.graduator = address(new Graduator(IPoolManager(poolManager), IHooks(out.multiHookHost), 3000, 60));
        MultiHookHost(payable(out.multiHookHost)).setInitializer(out.graduator);
        CurveFactory(out.curveFactory).setGraduator(out.graduator);
        out.v4SwapRouter = address(new V4SwapRouter(IPoolManager(poolManager)));
        vm.stopBroadcast();

        // ============================================================
        // 6. Royalty factory: NO trusted deployers wired at deploy time. RouterV2
        //    doesn't call deployFor today - the atomic-launch integration is a
        //    follow-up. Operator can `setTrustedDeployer(router, true)` from a
        //    multisig once that path exists. Wiring it now would create a
        //    permissioned deployer with no consumer.
        // ============================================================

        // ============================================================
        // 7. Rotate external references onto V4 stack
        // ============================================================
        _rotateExternal(nameRegistry, erc20Factory, erc721aFactory, erc1155Factory, out.routerV2, out.graduator);

        _logSummary(out, poolManager);
        _writeAddressBook(out, poolManager);
    }

    // ---------------------------------------------------------------- MultiHookHost mining
    function _deployMultiHookHost(
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
            console2.log("  [skip] MultiHookHost V4 already at predicted address");
            return predicted;
        }
        vm.startBroadcast();
        MultiHookHost deployed = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), platform, creator, platformBps, creatorBps, msg.sender
        );
        vm.stopBroadcast();
        require(address(deployed) == predicted, "MultiHookHost V4 salt drift");
        addr = address(deployed);
    }

    // ---------------------------------------------------------------- External rotations
    function _rotateExternal(
        address nameRegistry,
        address erc20Factory,
        address erc721aFactory,
        address erc1155Factory,
        address newRouter,
        address newGraduator
    ) internal {
        // Every rotation is try/catch'd because the 12 preceding deploys are
        // ALREADY on-chain by this point - if any wire reverts (broadcaster no
        // longer owns target after handoff, unknown ownership state, etc), we
        // do NOT unwind the whole broadcast. Failures log a specific "needs
        // multisig" hint so the operator can finish rotation from a Safe.
        _tryNameRegistrySetRouter(nameRegistry, newRouter);
        _tryFactorySetRouter(erc20Factory, newRouter, "ERC20Factory");
        _tryFactorySetRouter(erc721aFactory, newRouter, "ERC721AFactory");
        _tryFactorySetRouter(erc1155Factory, newRouter, "ERC1155Factory");

        bool wire = vm.envOr("WIRE_LEGACY", uint256(0)) == 1;
        if (!wire) {
            console2.log("  [pending] Legacy CurveFactory setGraduator SKIPPED (WIRE_LEGACY=0)");
            return;
        }
        _tryLegacyCfSetGraduator(vm.envOr("OLD_V1_CURVE_FACTORY", address(0)), newGraduator, "V1");
        _tryLegacyCfSetGraduator(vm.envOr("OLD_V2_CURVE_FACTORY", address(0)), newGraduator, "V2");
        _tryLegacyCfSetGraduator(vm.envOr("OLD_V3_CURVE_FACTORY", address(0)), newGraduator, "V3");
    }

    function _tryNameRegistrySetRouter(
        address nameRegistry,
        address newRouter
    ) internal {
        vm.startBroadcast();
        try NameRegistry(nameRegistry).setRouter(newRouter) {
            console2.log("  [ok] NameRegistry.setRouter");
        } catch {
            console2.log("  [warn] NameRegistry.setRouter FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _tryFactorySetRouter(
        address factory,
        address newRouter,
        string memory name
    ) internal {
        vm.startBroadcast();
        try IFactoryOwned(factory).setRouter(newRouter) {
            console2.log("  [ok] factory setRouter", name);
        } catch {
            console2.log("  [warn] factory setRouter FAILED (needs multisig)", name);
        }
        vm.stopBroadcast();
    }

    function _tryLegacyCfSetGraduator(
        address cf,
        address newGraduator,
        string memory version
    ) internal {
        if (cf == address(0)) return;
        vm.startBroadcast();
        try ICurveFactoryOwned(cf).setGraduator(newGraduator) {
            console2.log("  [ok] legacy CurveFactory setGraduator", version);
        } catch {
            console2.log("  [warn] legacy CurveFactory setGraduator FAILED (needs multisig)", version);
        }
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- Logging + book
    function _logSummary(
        Deployed memory out,
        address poolManager
    ) internal view {
        console2.log("=========================================================");
        console2.log("V4 stack deployed (second-pass audit fixes)");
        console2.log("=========================================================");
        console2.log("  chainid:              ", block.chainid);
        console2.log("  --- Router + curve ---");
        console2.log("  RouterV2 V4:          ", out.routerV2);
        console2.log("  CurveFactoryV4:       ", out.curveFactory);
        console2.log("  BondingCurve impl V4: ", out.bondingCurveImpl);
        console2.log("  --- v4 hook stack ---");
        console2.log("  MultiHookHostV4:      ", out.multiHookHost);
        console2.log("  GraduatorV4:          ", out.graduator);
        console2.log("  V4SwapRouterV4:       ", out.v4SwapRouter);
        console2.log("  PoolManager (existing):", poolManager);
        console2.log("  --- Flywheel ---");
        console2.log("  FeeSplitterV4:        ", out.feeSplitter);
        console2.log("  UruDepositSinkV4:     ", out.uruDepositSink);
        console2.log("  UruBuybackVaultV4:    ", out.uruBuybackVault);
        console2.log("  NftRevenueVaultV4:    ", out.nftRevenueVault);
        console2.log("  RoyaltyRouterFactory V4:", out.royaltyRouterFactory);
        console2.log("  RoyaltyRouterImpl V4:  ", out.royaltyRouterImpl);
        console2.log("---------------------------------------------------------");
        console2.log("Post-deploy MANUAL steps (verify each):");
        console2.log("  1. Verify all 12 contracts on Blockscout.");
        console2.log("  2. node tools/sync-addresses.mjs robinhood - patches config.ts + emits Railway env block.");
        console2.log(
            "  3. Update Railway indexer + compile-service env vars to V4 addresses. Bump PONDER_START_BLOCK_ROBINHOOD to this deploy's block. Restart both services."
        );
        console2.log(
            "  4. RouterV2.setCurveIncompatibleConfigHash(configHash, true) for every FoT/rebasing module combo (frontend list in web/src/lib/modules.ts taxesTransfers = true)."
        );
        console2.log(
            "  5. FeeSplitter.setConfig(uruBuybackVault, nftRevenueVault, treasury, 4000, 3500, 2500) after minConfigDelay (~2 days) elapses. Until then, 100% of fees route to treasury sink."
        );
        console2.log("  6. Fund KEEPER wallet with ETH for keeper operations.");
        console2.log(
            "  7. Once keeper flow validated on-chain, UruDepositSink.setMinEthPerUru + UruBuybackVault.setMinUruPerEth with real market-rate floors (0 = disabled today = vulnerable to keeper-key MEV drain)."
        );
        console2.log("---------------------------------------------------------");
        console2.log("MIGRATION WARNINGS (from V3-to-V4 compat audit):");
        console2.log(
            "  * Pause V3 RouterV2 (Router.setPaused(true)) 1 block BEFORE this broadcast to avoid mempool launches reverting mid-rotation."
        );
        console2.log(
            "  * WIRE_LEGACY=1 rewires OLD CurveFactory graduators to V4 Graduator. Old-impl BondingCurves initialized post-rotation would ABI-mismatch the V4 Graduator (permanently strand). RECOMMEND: set WIRE_LEGACY=0 OR call setGraduator(0) on old factories to disable direct-init graduation entirely."
        );
        console2.log(
            "  * V2 MultiHookHost platform fees are STUCK (no pushOwed). V1/V3 fees are recoverable via pushOwed. Publish claim UI wired to V1/V3 hosts per-token."
        );
        console2.log(
            "  * For any pre-V4 NFT collection that never materialized its V3 RoyaltyRouter clone (deployFor was never called), force-deploy the V3 clone NOW via the V3 factory before rotating trust. Otherwise marketplace royalty sends go to a code-less address."
        );
    }

    function _writeAddressBook(
        Deployed memory out,
        address poolManager
    ) internal {
        string memory obj = "v4stack";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "RouterV2", out.routerV2);
        vm.serializeAddress(obj, "CurveFactoryV4", out.curveFactory);
        vm.serializeAddress(obj, "BondingCurveImpl", out.bondingCurveImpl);
        vm.serializeAddress(obj, "MultiHookHostV4", out.multiHookHost);
        vm.serializeAddress(obj, "GraduatorV4", out.graduator);
        vm.serializeAddress(obj, "V4SwapRouterV4", out.v4SwapRouter);
        vm.serializeAddress(obj, "FeeSplitterV4", out.feeSplitter);
        vm.serializeAddress(obj, "UruDepositSinkV4", out.uruDepositSink);
        vm.serializeAddress(obj, "UruBuybackVaultV4", out.uruBuybackVault);
        vm.serializeAddress(obj, "NftRevenueVaultV4", out.nftRevenueVault);
        vm.serializeAddress(obj, "RoyaltyRouterFactoryV4", out.royaltyRouterFactory);
        vm.serializeAddress(obj, "RoyaltyRouterImplV4", out.royaltyRouterImpl);
        string memory json = vm.serializeAddress(obj, "PoolManager", poolManager);
        string memory path = string.concat("deployment-v4stack.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Address book written:", path);
    }
}
