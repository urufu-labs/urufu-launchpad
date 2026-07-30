// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/// Minimal admin surface for the swap step. CurveFactory exposes setGraduator
/// as an owner-only call; we look it up and rewire it here.
interface ICurveFactoryAdmin {
    function graduator() external view returns (address);
    function setGraduator(
        address newGraduator
    ) external;
    function owner() external view returns (address);
}

/// Interface for the MultiHookHost setInitializer path. The V4 hook trusts a
/// single "initializer" address to be the sole caller of `beforeInitialize`
/// (i.e., the address that opens graduating pools). Since we're swapping the
/// graduator, we need to point the hook at the new address too, or the hook
/// will reject the new graduator's `initialize` calls.
interface IMultiHookHostAdmin {
    function initializer() external view returns (address);
    function setInitializer(
        address newInitializer
    ) external;
    function owner() external view returns (address);
}

/// @title  DeployGraduatorV2
/// @notice Deploys the fixed GraduatorV2 (which opens v4 pools at the curve's
///         marginal price, not the raw token/ETH ratio) and rewires the live
///         CurveFactory + MultiHookHost to use it.
///
///         Reversible: keep the old Graduator address handy and just call
///         setGraduator again with it to roll back.
///
///         Runs: forge script script/DeployGraduatorV2.s.sol --broadcast
///                                                             --rpc-url $RPC
///                                                             --private-key $PK
///
///         Env vars:
///           ROBINHOOD_POOL_MANAGER_ADDRESS
///           ROBINHOOD_MULTI_HOOK_HOST_ADDRESS
///           ROBINHOOD_CURVE_FACTORY_ADDRESS
///         (Auto-fallback to hardcoded RH mainnet addresses when unset.)
contract DeployGraduatorV2 is Script {
    // Live RH mainnet defaults. Overridden per env var if the deployer wants
    // to target a different chain later.
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_MHH = 0xd19d999A3E35cA4b28f245D9bAf30FeFf4F862c4;
    address internal constant DEFAULT_CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;

    /// Match the original Graduator's fee + tickSpacing so pool identity
    /// (poolId = keccak(currency0, currency1, fee, tickSpacing, hooks)) stays
    /// on the same tuple family. If we ever change these, existing pre-swap
    /// graduated pools remain queryable at their old poolIds; new pools live
    /// under the new tuple.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    function run() external pure {
        // SUPERSEDED — this script omits the MHH.setInitializer call and
        // will deploy a new GraduatorV2 whose PoolManager.initialize
        // requests are rejected by beforeInitialize (because the old MHH's
        // initializer slot is locked to a different graduator). That's the
        // exact bug that stranded the FDGDFVS + TIGER test curves. Use
        // script/DeployMhhAndGraduatorV5.s.sol which deploys the MHH and
        // Graduator as a matched pair with setInitializer wired atomically.
        revert("superseded: use script/DeployMhhAndGraduatorV5.s.sol");
    }

    /// Kept below the guard as historical reference for the intended flow.
    /// Unreachable — run() reverts before entering this.
    function _runLegacy_UNREACHABLE() internal {
        address poolManager = _envAddress("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address mhh = _envAddress("ROBINHOOD_MULTI_HOOK_HOST_ADDRESS", DEFAULT_MHH);
        address curveFactory = _envAddress("ROBINHOOD_CURVE_FACTORY_ADDRESS", DEFAULT_CURVE_FACTORY);

        // Sanity: all three must be contracts + owner must match msg.sender.
        // Fail loud rather than half-deploying + leaving state torn.
        require(poolManager.code.length > 0, "poolManager not a contract");
        require(mhh.code.length > 0, "MultiHookHost not a contract");
        require(curveFactory.code.length > 0, "CurveFactory not a contract");
        address oldGraduator = ICurveFactoryAdmin(curveFactory).graduator();
        console2.log("Existing Graduator on CurveFactory:", oldGraduator);

        vm.startBroadcast();
        // 1. Deploy the new Graduator, pointing at the same PoolManager +
        //    MultiHookHost + CurveFactory. No new secrets or config needed.
        GraduatorV2 gv2 =
            new GraduatorV2(IPoolManager(poolManager), IHooks(mhh), FEE, TICK_SPACING, curveFactory, msg.sender);
        console2.log("GraduatorV2 deployed at:", address(gv2));

        // 2. Rewire CurveFactory to hand out this graduator to every future
        //    BondingCurve at init time. Owner-gated; the broadcasting key
        //    must equal `CurveFactory.owner()` (typically the deployer).
        ICurveFactoryAdmin(curveFactory).setGraduator(address(gv2));
        console2.log("CurveFactory.setGraduator -> GraduatorV2");

        // NOTE: MultiHookHost.setInitializer is deliberately NOT called here.
        // The "initializer" is a one-shot admin slot on the hook, and it's
        // ALREADY set to the old graduator. But setPoolConfig / setCreator
        // are gated by `launchBlock != 0` (config-frozen), NOT by
        // onlyInitializer -- so the new graduator can call them just fine
        // during its atomic initialize+config sequence. Leaving the old
        // graduator's initializer slot intact avoids the
        // InitializerAlreadySet revert without any functional cost.

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== POST-DEPLOY STATE ===");
        console2.log("CurveFactory.graduator():", ICurveFactoryAdmin(curveFactory).graduator());
        console2.log("");
        console2.log("Old graduator (keep for rollback):", oldGraduator);
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
}
