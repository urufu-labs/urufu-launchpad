// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @title  VerifyWiring
/// @notice Read-only script that asserts the LIVE stack is wired correctly.
///         Runs no writes, holds no keys — safe to point at mainnet fork or
///         mainnet directly. Reverts loudly on any misconfig so an operator
///         doing a stack handoff (V5→V6, ownership transfer, etc.) can't
///         false-green their way past a busted invariant.
///
///         Prior version validated a legacy Router / Graduator tuple that
///         had been rotated out of the live path — it would green-light a
///         completely broken deployment because it never touched the
///         actual live addresses. Rewritten to check what's ACTUALLY on
///         the current stack and to include the invariant whose breakage
///         stranded the FDGDFVS + TIGER test curves:
///           MultiHookHost.initializer() == Graduator
///
///         Live-stack addresses default to the current RH mainnet V5 pair.
///         Override via env var when validating a V6-in-progress or a fork
///         with different addresses.
///
///         Env vars (all optional; defaults to current RH mainnet):
///           ROBINHOOD_ROUTER_ADDRESS        (default 0x2dfA…D973)
///           ROBINHOOD_CURVE_FACTORY_ADDRESS (default 0x4631…c248)
///           ROBINHOOD_NAME_REGISTRY_ADDRESS (default 0x60b7…118C)
///           ROBINHOOD_POOL_MANAGER_ADDRESS  (default 0x8366…0951)
///           ROBINHOOD_MULTI_HOOK_HOST_ADDRESS(default 0x1Bb4…f2C4)
///           ROBINHOOD_GRADUATOR_ADDRESS     (default 0x0d63…bd02)
///           ROBINHOOD_FEE_SPLITTER_ADDRESS  (default 0x20d2…0FfA)
///           EXPECTED_OWNER                  (default deployer 0x6d60…5Bb9)
///
///         Run:
///           forge script script/VerifyWiring.s.sol:VerifyWiring \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com

interface IRouterV5 {
    function owner() external view returns (address);
    function curveFactory() external view returns (address);
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function paused() external view returns (bool);
    function factories(uint8 base) external view returns (address);
}

interface ICurveFactoryV5 {
    function owner() external view returns (address);
    function graduator() external view returns (address);
    function trustedRouters(address) external view returns (bool);
}

interface INameRegistry {
    function router() external view returns (address);
}

interface IGraduatorV5 {
    function defaultHook() external view returns (address);
    function curveFactory() external view returns (address);
    function poolManager() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface IMultiHookHostV5 {
    function initializer() external view returns (address);
    function poolManager() external view returns (address);
    function platform() external view returns (address);
    function deployer() external view returns (address);
}

contract VerifyWiring is Script {
    // Live RH mainnet V5 defaults. Update whenever the stack rotates.
    address internal constant DEFAULT_ROUTER = 0x2dfA89FF6822C53509127b4943c97A48952dD973;
    address internal constant DEFAULT_CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant DEFAULT_NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_MHH = 0x1Bb4666b905D81aE0b70aC63Df76Eea096efA2C4;
    address internal constant DEFAULT_GRADUATOR = 0x0d63E9D1b8EA9b3620ba75F1D6DA69eFf4adbd02;
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant DEFAULT_OWNER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    function run() external view {
        address router = _env("ROBINHOOD_ROUTER_ADDRESS", DEFAULT_ROUTER);
        address cf = _env("ROBINHOOD_CURVE_FACTORY_ADDRESS", DEFAULT_CURVE_FACTORY);
        address nr = _env("ROBINHOOD_NAME_REGISTRY_ADDRESS", DEFAULT_NAME_REGISTRY);
        address pm = _env("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address mhh = _env("ROBINHOOD_MULTI_HOOK_HOST_ADDRESS", DEFAULT_MHH);
        address grad = _env("ROBINHOOD_GRADUATOR_ADDRESS", DEFAULT_GRADUATOR);
        address feeSplitter = _env("ROBINHOOD_FEE_SPLITTER_ADDRESS", DEFAULT_FEE_SPLITTER);
        address expectedOwner = _env("EXPECTED_OWNER", DEFAULT_OWNER);

        console2.log("---- addresses under verification ----");
        console2.log("  Router        :", router);
        console2.log("  CurveFactory  :", cf);
        console2.log("  NameRegistry  :", nr);
        console2.log("  PoolManager   :", pm);
        console2.log("  MultiHookHost :", mhh);
        console2.log("  Graduator     :", grad);
        console2.log("  FeeSplitter   :", feeSplitter);
        console2.log("  expected owner:", expectedOwner);
        console2.log("");

        // ---- code presence ----
        _requireHasCode(router, "Router");
        _requireHasCode(cf, "CurveFactory");
        _requireHasCode(nr, "NameRegistry");
        _requireHasCode(pm, "PoolManager");
        _requireHasCode(mhh, "MultiHookHost");
        _requireHasCode(grad, "Graduator");
        _requireHasCode(feeSplitter, "FeeSplitter");

        // ---- ownership ----
        _requireEqAddr(IRouterV5(router).owner(), expectedOwner, "Router.owner");
        _requireEqAddr(ICurveFactoryV5(cf).owner(), expectedOwner, "CurveFactory.owner");

        // ---- Router wiring ----
        _requireEqAddr(IRouterV5(router).curveFactory(), cf, "Router.curveFactory");
        _requireEqAddr(IRouterV5(router).registry(), nr, "Router.registry");
        _requireEqAddr(IRouterV5(router).feeReceiver(), feeSplitter, "Router.feeReceiver");

        // ---- CurveFactory wiring ----
        _requireEqAddr(ICurveFactoryV5(cf).graduator(), grad, "CurveFactory.graduator");
        require(ICurveFactoryV5(cf).trustedRouters(router), "CurveFactory.trustedRouters[Router] must be true");

        // ---- NameRegistry wiring ----
        _requireEqAddr(INameRegistry(nr).router(), router, "NameRegistry.router");

        // ---- Graduator wiring ----
        _requireEqAddr(IGraduatorV5(grad).defaultHook(), mhh, "Graduator.defaultHook");
        _requireEqAddr(IGraduatorV5(grad).curveFactory(), cf, "Graduator.curveFactory");
        _requireEqAddr(IGraduatorV5(grad).poolManager(), pm, "Graduator.poolManager");
        require(IGraduatorV5(grad).fee() == 3000, "Graduator.fee != 3000");
        require(IGraduatorV5(grad).tickSpacing() == 60, "Graduator.tickSpacing != 60");

        // ---- MultiHookHost wiring ----
        // THE critical invariant whose breakage stranded the pre-V5 test curves:
        // MHH.beforeInitialize rejects any sender != initializer. If this drifts,
        // every graduation reverts silently. This is the assertion the prior
        // VerifyWiring script was missing.
        _requireEqAddr(IMultiHookHostV5(mhh).initializer(), grad, "MultiHookHost.initializer (MUST equal Graduator)");
        _requireEqAddr(IMultiHookHostV5(mhh).poolManager(), pm, "MultiHookHost.poolManager");
        _requireEqAddr(IMultiHookHostV5(mhh).platform(), feeSplitter, "MultiHookHost.platform");

        // ---- Operational state ----
        // Not a fatal assertion — a paused Router is intentional during
        // audit-fix deploys — but log loudly so an unintended pause is visible.
        bool isPaused = IRouterV5(router).paused();
        if (isPaused) {
            console2.log("  [warn] Router is PAUSED - expected only during active mitigation windows");
        }

        console2.log("");
        console2.log("=========================================================");
        console2.log("  ALL WIRE-UP INVARIANTS HOLD");
        console2.log("=========================================================");
    }

    // ---------------------------------------------------------------- helpers

    function _requireHasCode(address a, string memory label) internal view {
        require(a.code.length > 0, string.concat(label, ": no code at address"));
    }

    function _requireEqAddr(address got, address want, string memory label) internal pure {
        if (got != want) {
            console2.log(string.concat("MISMATCH: ", label));
            console2.log("  got :", got);
            console2.log("  want:", want);
            revert(string.concat("wiring mismatch: ", label));
        }
    }

    function _env(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
