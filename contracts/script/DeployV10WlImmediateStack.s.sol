// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

interface IRouterAdmin {
    function owner() external view returns (address);
    function curveFactory() external view returns (address);
    function setCurveFactory(
        address newCurveFactory
    ) external;
}

/// @title  DeployV10WlImmediateStack
/// @notice Quadruple rotation for the WL immediate-transfer redesign
///         (2026-08-11): fresh BondingCurve impl + CurveFactory + Graduator + MHH.
///
///         Why the quadruple:
///           - BondingCurve.sol changed: `buyWithProof` now safeTransfers tokens
///             to msg.sender instead of holding them in `wlHeldForUser`;
///             `claimWl`, `wlHeldForUser`, `wlHeldTotal` deleted. WL buyers
///             receive tokens immediately, no post-graduation claim step.
///           - CurveFactory's `implementation` field is IMMUTABLE, so any
///             BondingCurve impl swap requires a fresh CurveFactory.
///           - Graduator's `curveFactory` field is IMMUTABLE, so any new
///             CurveFactory requires a fresh Graduator.
///           - MultiHookHost's `setInitializer` is one-shot locked to the
///             previous Graduator, so a fresh Graduator requires a fresh MHH.
///
///         Same pattern as DeployV9StackFix.s.sol but adds `new BondingCurve()`
///         at the top and threads the new impl through the CurveFactory
///         constructor. Every wiring invariant is verified post-deploy; the
///         script reverts if anything is off.
///
///         Wiring (one broadcast, atomic):
///           0. deploy V10 BondingCurve impl                  [source-of-truth WL semantics]
///           1. deploy V10 CurveFactory(operator, feeSplitter, V10 impl)
///           2. mine + deploy V10 MHH (hook flags 0x20C4)
///           3. deploy V10 Graduator wired to V10 MHH + V10 CF
///           4. V10 MHH.setInitializer(V10 Graduator)         [one-shot lock]
///           5. V10 CF.setGraduator(V10 Graduator)
///           6. V10 CF.setTrustedRouter(Router, true)
///           7. V10 CF.setDefaults(...)                        [17 virt / 4.2 grad — matches live]
///           8. Router.setCurveFactory(V10 CF)                 [route new launches through it]
///
///         Existing curves stay on V9 impl — their `implementation` was
///         baked at clone-time, so nothing about them changes.
///
///         Env vars (defaults to live V9 addresses + on-chain default values):
///           ROBINHOOD_POOL_MANAGER_ADDRESS
///           ROBINHOOD_ROUTER_ADDRESS
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           V10_CURVE_SUPPLY            (default 800M)
///           V10_VIRT_TOKEN_RESERVE      (default 800M)
///           V10_VIRT_ETH_RESERVE        (default 17 ETH)
///           V10_GRAD_TARGET_ETH         (default 4.2 ETH — matches current on-chain)
///           V10_TRADE_FEE_BPS           (default 100 = 1%)
contract DeployV10WlImmediateStack is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ---- RH mainnet live defaults ----
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

    // Fee tier + tick spacing must match the frontend v4 pool-id computation.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // Default curve shape — matches the live V9 CurveFactory state after the
    // 2026-08-11 setCurveDefaults broadcast that lowered graduation from 10
    // ETH to 4.2 ETH.
    uint256 internal constant DEFAULT_CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant DEFAULT_VIRT_TOKEN = 800_000_000e18;
    uint256 internal constant DEFAULT_VIRT_ETH = 17 ether;
    uint256 internal constant DEFAULT_GRAD_TARGET = 4.2 ether;
    uint16 internal constant DEFAULT_TRADE_FEE_BPS = 100;

    struct Deployed {
        address bondingCurveImpl;
        address curveFactory;
        address multiHookHost;
        address graduator;
    }

    bool internal _isTestContext;
    address internal _testPrankAs;

    function run() external returns (Deployed memory out) {
        return _runInner(true);
    }

    function runForTest(
        address prankAs
    ) external returns (Deployed memory out) {
        _isTestContext = true;
        _testPrankAs = prankAs;
        return _runInner(false);
    }

    function _effectiveOperator() internal view returns (address) {
        return _isTestContext ? _testPrankAs : msg.sender;
    }

    function _runInner(
        bool useBroadcast
    ) internal returns (Deployed memory out) {
        address poolManager = _envAddress("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address router = _envAddress("ROBINHOOD_ROUTER_ADDRESS", DEFAULT_ROUTER);
        address feeSplitter = _envAddress("ROBINHOOD_FEE_SPLITTER_ADDRESS", DEFAULT_FEE_SPLITTER);
        uint256 curveSupply = _envUint("V10_CURVE_SUPPLY", DEFAULT_CURVE_SUPPLY);
        uint256 virtTokenReserve = _envUint("V10_VIRT_TOKEN_RESERVE", DEFAULT_VIRT_TOKEN);
        uint256 virtEthReserve = _envUint("V10_VIRT_ETH_RESERVE", DEFAULT_VIRT_ETH);
        uint256 gradTarget = _envUint("V10_GRAD_TARGET_ETH", DEFAULT_GRAD_TARGET);
        uint16 tradeFeeBps = uint16(_envUint("V10_TRADE_FEE_BPS", DEFAULT_TRADE_FEE_BPS));

        // Pre-flight
        require(poolManager.code.length > 0, "poolManager: no code");
        require(router.code.length > 0, "router: no code");
        require(feeSplitter.code.length > 0, "feeSplitter: no code");

        address routerOwner = IRouterAdmin(router).owner();
        if (_isTestContext) {
            require(routerOwner == _testPrankAs, "test prank address is not Router owner");
        } else {
            require(routerOwner == msg.sender, "broadcaster is not Router owner");
        }

        console2.log("---- pre-flight ----");
        console2.log("  PoolManager       :", poolManager);
        console2.log("  Router            :", router);
        console2.log("  FeeSplitter       :", feeSplitter);
        console2.log("  broadcaster       :", msg.sender);
        console2.log("---- new defaults ----");
        console2.log("  curveSupply       :", curveSupply);
        console2.log("  virtTokenReserve  :", virtTokenReserve);
        console2.log("  virtEthReserve    :", virtEthReserve);
        console2.log("  graduationTarget  :", gradTarget);
        console2.log("  tradeFeeBps       :", tradeFeeBps);

        if (useBroadcast) vm.startBroadcast();
        if (_isTestContext) vm.startPrank(_testPrankAs, _testPrankAs);
        address operator = _effectiveOperator();

        // Step 0: deploy V10 BondingCurve impl — the whole point of this
        // rotation. Contains the immediate-transfer WL semantics.
        BondingCurve bcImpl = new BondingCurve();
        out.bondingCurveImpl = address(bcImpl);
        console2.log("---- deployed ----");
        console2.log("  V10 BondingCurve  :", out.bondingCurveImpl);

        // Step 1: deploy V10 CurveFactory pointing at the fresh impl
        CurveFactory cf = new CurveFactory(operator, feeSplitter, out.bondingCurveImpl);
        out.curveFactory = address(cf);
        console2.log("  V10 CurveFactory  :", out.curveFactory);

        // Step 2: mine + deploy new MHH
        out.multiHookHost = _mineAndDeployMHH(poolManager, feeSplitter, operator);

        // Step 3: deploy V10 Graduator wired to V10 MHH + V10 CF + operator as owner
        GraduatorV2 g = new GraduatorV2(
            IPoolManager(poolManager), IHooks(out.multiHookHost), FEE, TICK_SPACING, out.curveFactory, operator
        );
        out.graduator = address(g);
        console2.log("  V10 Graduator     :", out.graduator);

        // Step 4: MHH.setInitializer(V10 Graduator) — one-shot lock, closed same tx
        MultiHookHost(payable(out.multiHookHost)).setInitializer(out.graduator);

        // Step 5-7: wire V10 CF
        cf.setGraduator(out.graduator);
        cf.setTrustedRouter(router, true);
        cf.setDefaults(curveSupply, virtTokenReserve, virtEthReserve, gradTarget, tradeFeeBps);

        // Step 8: rotate Router.curveFactory
        IRouterAdmin(router).setCurveFactory(out.curveFactory);

        if (useBroadcast) vm.stopBroadcast();
        if (_isTestContext) vm.stopPrank();

        // Post-deploy verification — script reverts if ANY invariant is off.
        _assertAllInvariants(router, out);

        _successLog(out, router);
    }

    function _mineAndDeployMHH(
        address poolManager,
        address feeSplitter,
        address operator
    ) internal returns (address) {
        // Audit-round-2 FINDING 5 flag set: BEFORE_INITIALIZE + BEFORE_SWAP +
        // AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA. Same as V9 — no hook changes
        // in the WL rotation.
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), feeSplitter, operator, uint16(100), uint16(100), operator);

        address miner = _isTestContext ? _testPrankAs : CREATE2_DEPLOYER;
        uint256 startSalt = 0;
        uint256 salt;
        address predicted;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, predicted) = HookMiner.findFrom(miner, requiredFlags, creation, args, 500_000, startSalt);
            if (predicted.code.length == 0) break;
            console2.log("  [skip] MHH salt already deployed, bumping past", salt);
            startSalt = salt + 1;
        }
        require(predicted.code.length == 0, "could not find empty MHH salt in 10 attempts");

        MultiHookHost mhh = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), feeSplitter, operator, uint16(100), uint16(100), operator
        );
        require(address(mhh) == predicted, "MHH salt drift");
        console2.log("  V10 MHH           :", address(mhh), "(salt", salt);
        return address(mhh);
    }

    function _assertAllInvariants(
        address router,
        Deployed memory out
    ) internal view {
        // Fresh BondingCurve impl exists at the expected address
        require(out.bondingCurveImpl.code.length > 0, "BondingCurve impl not deployed");

        // CurveFactory points at the new impl
        require(
            CurveFactory(out.curveFactory).implementation() == out.bondingCurveImpl,
            "CurveFactory.implementation != V10 BondingCurve impl"
        );

        // MHH <-> Graduator pair
        require(
            MultiHookHost(payable(out.multiHookHost)).initializer() == out.graduator,
            "MHH.initializer must equal Graduator"
        );
        require(
            address(GraduatorV2(payable(out.graduator)).defaultHook()) == out.multiHookHost,
            "Graduator.defaultHook must equal MHH"
        );
        require(
            address(GraduatorV2(payable(out.graduator)).curveFactory()) == out.curveFactory,
            "Graduator.curveFactory must equal V10 CF"
        );

        // CurveFactory wiring
        require(
            CurveFactory(out.curveFactory).graduator() == out.graduator, "V10 CF.graduator must equal V10 Graduator"
        );
        require(CurveFactory(out.curveFactory).trustedRouters(router), "V10 CF must trust Router");

        // Router pointed at V10 CF
        require(IRouterAdmin(router).curveFactory() == out.curveFactory, "Router.curveFactory must equal V10 CF");

        // Defaults actually applied
        require(
            CurveFactory(out.curveFactory).defaultVirtualEthReserve()
                == _envUint("V10_VIRT_ETH_RESERVE", DEFAULT_VIRT_ETH),
            "virtEthReserve not applied"
        );
        require(
            CurveFactory(out.curveFactory).defaultGraduationTargetEth()
                == _envUint("V10_GRAD_TARGET_ETH", DEFAULT_GRAD_TARGET),
            "gradTarget not applied"
        );
    }

    function _successLog(
        Deployed memory out,
        address router
    ) internal pure {
        console2.log("");
        console2.log("=========================================================");
        console2.log("V10 stack LIVE (WL immediate-transfer redesign)");
        console2.log("=========================================================");
        console2.log("  BondingCurve impl :", out.bondingCurveImpl);
        console2.log("  CurveFactory      :", out.curveFactory);
        console2.log("  MultiHookHost     :", out.multiHookHost);
        console2.log("  Graduator         :", out.graduator);
        console2.log("");
        console2.log("Router now points at V10 CurveFactory:", router);
        console2.log("");
        console2.log("Next:");
        console2.log("  1. Update web/src/lib/config.ts (CurveFactory + MultiHookHost + Graduator)");
        console2.log("  2. Update .env (BONDING_CURVE_IMPL + MHH + CurveFactory + Graduator)");
        console2.log("  3. Update Railway indexer env (MHH)");
    }

    function _envAddress(
        string memory key,
        address fallback_
    ) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }

    function _envUint(
        string memory key,
        uint256 fallback_
    ) internal view returns (uint256) {
        try vm.envUint(key) returns (uint256 v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
