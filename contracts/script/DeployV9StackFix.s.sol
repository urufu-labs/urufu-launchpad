// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

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

/// @title  DeployV9StackFix
/// @notice Full CurveFactory + MHH + Graduator triple rotation.
///
///         Why the triple: adding the modules-over-allocated cap to
///         CurveFactory requires a new CurveFactory deploy. But the current
///         Graduator's `curveFactory` field is IMMUTABLE and points at V7 CF.
///         If we point Router at V9 CF but keep V8 Graduator, V8 Graduator
///         will ask V7 CF for curveFor(token) — which returns 0 for
///         V9-minted curves — and every graduation reverts NotAuthorizedCurve.
///
///         So we need a new Graduator too, pointing at V9 CF. And a new
///         Graduator can't reuse the existing MHH (initializer is one-shot
///         locked to the old Graduator). So the full triple rotates together.
///
///         Wiring the new stack (one broadcast, atomic):
///           1. deploy V9 CurveFactory (with airdrop cap in _createCurve)
///           2. mine + deploy new MHH (hook flags 0x20C4 post-round-2 finding 5)
///           3. deploy V9 Graduator wired to V9 MHH + V9 CF
///           4. V9 MHH.setInitializer(V9 Graduator)         [one-shot lock]
///           5. V9 CF.setGraduator(V9 Graduator)            [creation-time wiring]
///           6. V9 CF.setTrustedRouter(Router, true)        [ACL for Router]
///           7. V9 CF.setDefaults(...)                       [17 ETH virt / 10 ETH grad]
///           8. Router.setCurveFactory(V9 CF)               [route new launches through it]
///
///         Post-deploy the script verifies every wiring invariant and reverts
///         if any is off — no chance to ship a broken pair like the V8 saga.
///
///         Env vars (defaults to live V7 addresses):
///           ROBINHOOD_POOL_MANAGER_ADDRESS
///           ROBINHOOD_ROUTER_ADDRESS
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           ROBINHOOD_BONDING_CURVE_IMPL
///           V9_CURVE_SUPPLY            (default 800M)
///           V9_VIRT_TOKEN_RESERVE      (default 800M)
///           V9_VIRT_ETH_RESERVE        (default 17 ETH)
///           V9_GRAD_TARGET_ETH         (default 10 ETH)
///           V9_TRADE_FEE_BPS           (default 100 = 1%)
contract DeployV9StackFix is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ---- RH mainnet live defaults ----
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    /// BondingCurve impl reused since it has no changes.
    address internal constant DEFAULT_BONDING_CURVE_IMPL = 0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9;

    // Fee tier + tick spacing must match the frontend v4 pool-id computation.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // Chunky-pool defaults (per user decision 2026-07-30):
    //   17 ETH virt + 10 ETH grad -> ~207M tokens + 10 ETH in LP (~25% supply)
    //   survives 100-200M module carves gracefully.
    uint256 internal constant DEFAULT_CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant DEFAULT_VIRT_TOKEN = 800_000_000e18;
    uint256 internal constant DEFAULT_VIRT_ETH = 17 ether;
    uint256 internal constant DEFAULT_GRAD_TARGET = 10 ether;
    uint16 internal constant DEFAULT_TRADE_FEE_BPS = 100;

    struct Deployed {
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
        address curveImpl = _envAddress("ROBINHOOD_BONDING_CURVE_IMPL", DEFAULT_BONDING_CURVE_IMPL);
        uint256 curveSupply = _envUint("V9_CURVE_SUPPLY", DEFAULT_CURVE_SUPPLY);
        uint256 virtTokenReserve = _envUint("V9_VIRT_TOKEN_RESERVE", DEFAULT_VIRT_TOKEN);
        uint256 virtEthReserve = _envUint("V9_VIRT_ETH_RESERVE", DEFAULT_VIRT_ETH);
        uint256 gradTarget = _envUint("V9_GRAD_TARGET_ETH", DEFAULT_GRAD_TARGET);
        uint16 tradeFeeBps = uint16(_envUint("V9_TRADE_FEE_BPS", DEFAULT_TRADE_FEE_BPS));

        // Pre-flight
        require(poolManager.code.length > 0, "poolManager: no code");
        require(router.code.length > 0, "router: no code");
        require(feeSplitter.code.length > 0, "feeSplitter: no code");
        require(curveImpl.code.length > 0, "bondingCurveImpl: no code");

        address routerOwner = IRouterAdmin(router).owner();
        if (_isTestContext) {
            require(routerOwner == _testPrankAs, "test prank address is not Router owner");
        } else {
            require(routerOwner == msg.sender, "broadcaster is not Router owner");
        }

        _preflightLog(poolManager, router, feeSplitter, curveImpl);
        console2.log("---- new defaults ----");
        console2.log("  curveSupply       :", curveSupply);
        console2.log("  virtTokenReserve  :", virtTokenReserve);
        console2.log("  virtEthReserve    :", virtEthReserve);
        console2.log("  graduationTarget  :", gradTarget);
        console2.log("  tradeFeeBps       :", tradeFeeBps);

        if (useBroadcast) vm.startBroadcast();
        if (_isTestContext) vm.startPrank(_testPrankAs, _testPrankAs);
        address operator = _effectiveOperator();

        // Step 1: deploy V9 CurveFactory
        CurveFactory cf = new CurveFactory(operator, feeSplitter, curveImpl);
        out.curveFactory = address(cf);
        console2.log("---- deployed ----");
        console2.log("  V9 CurveFactory :", out.curveFactory);

        // Step 2: mine + deploy new MHH
        out.multiHookHost = _mineAndDeployMHH(poolManager, feeSplitter, operator);

        // Step 3: deploy V9 Graduator wired to V9 MHH + V9 CF + operator as owner
        GraduatorV2 g = new GraduatorV2(
            IPoolManager(poolManager), IHooks(out.multiHookHost), FEE, TICK_SPACING, out.curveFactory, operator
        );
        out.graduator = address(g);
        console2.log("  V9 Graduator    :", out.graduator);

        // Step 4: MHH.setInitializer(V9 Graduator) — one-shot lock, closed same tx
        MultiHookHost(payable(out.multiHookHost)).setInitializer(out.graduator);

        // Step 5-7: wire V9 CF
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
        // Audit-round-2 FINDING 5: dropped BEFORE_REMOVE_LIQUIDITY_FLAG. Graduation
        // LP is locked structurally by GraduatorV2; gating removal on the hook was
        // freezing every third-party LP forever.
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), feeSplitter, operator, uint16(100), uint16(100), operator);

        // Under `forge script --broadcast`, `new X{salt}(...)` routes through the
        // canonical CREATE2 factory. Under `forge test` with vm.startPrank
        // active, it's attributed to the prank sender. Same fix as V6/V7/V8
        // scripts had.
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
        console2.log("  V9 MHH          :", address(mhh), "(salt", salt);
        return address(mhh);
    }

    function _assertAllInvariants(
        address router,
        Deployed memory out
    ) internal view {
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
            "Graduator.curveFactory must equal V9 CF"
        );

        // CurveFactory wiring
        require(CurveFactory(out.curveFactory).graduator() == out.graduator, "V9 CF.graduator must equal V9 Graduator");
        require(CurveFactory(out.curveFactory).trustedRouters(router), "V9 CF must trust Router");

        // Router pointed at V9 CF
        require(IRouterAdmin(router).curveFactory() == out.curveFactory, "Router.curveFactory must equal V9 CF");

        // Defaults actually applied
        require(
            CurveFactory(out.curveFactory).defaultVirtualEthReserve()
                == _envUint("V9_VIRT_ETH_RESERVE", DEFAULT_VIRT_ETH),
            "virtEthReserve not applied"
        );
        require(
            CurveFactory(out.curveFactory).defaultGraduationTargetEth()
                == _envUint("V9_GRAD_TARGET_ETH", DEFAULT_GRAD_TARGET),
            "gradTarget not applied"
        );
    }

    function _preflightLog(
        address poolManager,
        address router,
        address feeSplitter,
        address curveImpl
    ) internal view {
        console2.log("---- pre-flight ----");
        console2.log("  PoolManager       :", poolManager);
        console2.log("  Router            :", router);
        console2.log("  FeeSplitter       :", feeSplitter);
        console2.log("  BondingCurve impl :", curveImpl);
        console2.log("  broadcaster       :", msg.sender);
    }

    function _successLog(
        Deployed memory out,
        address router
    ) internal pure {
        console2.log("");
        console2.log("=========================================================");
        console2.log("V9 stack LIVE (single-broadcast triple rotation)");
        console2.log("=========================================================");
        console2.log("  CurveFactory      :", out.curveFactory);
        console2.log("  MultiHookHost     :", out.multiHookHost);
        console2.log("  Graduator         :", out.graduator);
        console2.log("");
        console2.log("Router now points at V9 CurveFactory:", router);
        console2.log("");
        console2.log("Next:");
        console2.log("  1. Update web/src/lib/config.ts (CurveFactory + MultiHookHost + Graduator)");
        console2.log("  2. Update .env (MHH + CurveFactory)");
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
