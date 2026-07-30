// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {GraduatorV2} from "src/curve/GraduatorV2.sol";

interface ICurveFactoryAdmin {
    function owner() external view returns (address);
    function graduator() external view returns (address);
    function setGraduator(
        address newGraduator
    ) external;
}

/// @title  DeployGraduatorV8Fix
/// @notice Deploys a fresh Graduator that FIXES the V7 LP-math bug (opened
///         pool at curve marginal price → deposited amounts mismatched at
///         that price → ~4 ETH per graduation permanently stranded in the
///         graduator contract with no recovery path).
///
///         V7 Graduator (0x36234107cC240cA564B9bC168d74CA3a1e3AE2f3) has 4.003
///         ETH permanently stuck — no owner, no sweep function. That ETH is
///         unrecoverable; only fix is to compensate the affected launcher
///         out of treasury. This deploy prevents future occurrences.
///
///         Changes:
///           - Price at RAW REAL RATIO (ethAmount/tokenAmount) not curve
///             marginal. Both amounts fully absorbed by LP.
///           - Refund any residual ETH to launcher on graduation (belt).
///           - Add owner + sweep(to) escape hatch (safety net).
///
///         Rotation shape: same as V6/V7 Graduator swaps — call
///         CurveFactory.setGraduator(new address). Existing curves that
///         already stored the V7 Graduator as their `graduator` at init
///         time will STILL call V7 at graduation (they baked the address
///         in). Only NEW launches use V8. That's the same limitation
///         earlier rotations had.
///
///         Env vars (all optional, default to V7 addresses):
///           ROBINHOOD_POOL_MANAGER_ADDRESS      (default 0x8366…0951)
///           ROBINHOOD_CURVE_FACTORY_ADDRESS     (default 0x1c34…2c70 V7)
///           ROBINHOOD_MULTI_HOOK_HOST_ADDRESS   (default 0xD763…e2c4 V7)
contract DeployGraduatorV8Fix is Script {
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant DEFAULT_MHH = 0xD7634D1B30c230265A036cBd8B957069eEE0e2c4;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    function run() external returns (address graduator) {
        address poolManager = _env("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address curveFactory = _env("ROBINHOOD_CURVE_FACTORY_ADDRESS", DEFAULT_CURVE_FACTORY);
        address mhh = _env("ROBINHOOD_MULTI_HOOK_HOST_ADDRESS", DEFAULT_MHH);

        require(poolManager.code.length > 0, "poolManager: no code");
        require(curveFactory.code.length > 0, "curveFactory: no code");
        require(mhh.code.length > 0, "mhh: no code");

        address cfOwner = ICurveFactoryAdmin(curveFactory).owner();
        require(cfOwner == msg.sender, "broadcaster is not CurveFactory owner - cannot setGraduator");

        // Sanity: the CurveFactory + MHH env pair MUST match the pair the
        // current graduator on this CurveFactory was built with. Otherwise
        // we're about to install a graduator wired to the wrong MHH and
        // every graduation will revert at MHH.beforeInitialize (initializer
        // mismatch). Ran into exactly this bug post-V7-broadcast because
        // the local .env still had a stale MHH address from an older era.
        address currentGrad = ICurveFactoryAdmin(curveFactory).graduator();
        if (currentGrad != address(0) && currentGrad.code.length > 0) {
            (bool ok, bytes memory ret) = currentGrad.staticcall(abi.encodeWithSignature("defaultHook()"));
            if (ok && ret.length == 32) {
                address currentMhh = abi.decode(ret, (address));
                if (currentMhh != mhh) {
                    // Escape hatch: when we're deploying V8 to FIX a previously-
                    // botched V8 that has the wrong MHH baked in, the check
                    // would otherwise refuse to let us correct it. Set
                    // OVERRIDE_MHH_MISMATCH=1 to acknowledge and proceed.
                    bool override_ = _envBool("OVERRIDE_MHH_MISMATCH");
                    if (!override_) {
                        console2.log("MHH mismatch: current graduator's MHH =", currentMhh);
                        console2.log("              env MHH                  =", mhh);
                        revert("MHH mismatch - set OVERRIDE_MHH_MISMATCH=1 to bypass");
                    }
                    console2.log("MHH mismatch OVERRIDE active - replacing broken graduator");
                }
            }
        }

        console2.log("---- pre-flight ----");
        console2.log("  PoolManager       :", poolManager);
        console2.log("  CurveFactory      :", curveFactory);
        console2.log("  MultiHookHost     :", mhh);
        console2.log("  CurveFactory.owner:", cfOwner);
        console2.log("  broadcaster       :", msg.sender);
        address prevGraduator = ICurveFactoryAdmin(curveFactory).graduator();
        console2.log("  prev Graduator    :", prevGraduator);

        vm.startBroadcast();
        GraduatorV2 g =
            new GraduatorV2(IPoolManager(poolManager), IHooks(mhh), FEE, TICK_SPACING, curveFactory, msg.sender);
        graduator = address(g);
        ICurveFactoryAdmin(curveFactory).setGraduator(graduator);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=========================================================");
        console2.log("Graduator V8 (LP-math fix) LIVE");
        console2.log("=========================================================");
        console2.log("  new Graduator     :", graduator);
        console2.log("  owner             :", msg.sender);
        console2.log("  V7 Graduator      :", prevGraduator, "(retired for NEW launches)");
        console2.log("");
        console2.log("Note: existing pre-launch curves still call the old graduator");
        console2.log("(address is baked into curve at init time). Only NEW launches");
        console2.log("through the CurveFactory get V8.");
        console2.log("");
        console2.log("Next:");
        console2.log("  1. Update GRADUATORS[robinhood] in web/src/lib/config.ts");
        console2.log("  2. Refund the launcher of the previously-graduated token");
        console2.log("     0xe595a5a411c9c236939130791ef5f9e3242209f2 (4 ETH stranded");
        console2.log("     in V7 Graduator - unrecoverable, compensate from treasury)");
    }

    function _env(
        string memory key,
        address fallback_
    ) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }

    function _envBool(
        string memory key
    ) internal view returns (bool) {
        try vm.envBool(key) returns (bool v) {
            return v;
        } catch {
            return false;
        }
    }
}
