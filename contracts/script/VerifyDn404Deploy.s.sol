// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404Graduator} from "src/dn404/Dn404Graduator.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/// Minimal V10 CurveFactory surface for the trust-check step.
interface IV10CurveFactoryView {
    function trustedRouters(address) external view returns (bool);
    function owner() external view returns (address);
}

/// @title  VerifyDn404Deploy
/// @notice Read-only post-deploy sanity script. Reads the address book at
///         `deployment-dn404.<chainid>.json` and asserts every wire the
///         deploy script set is STILL in place.
///
///         Kept separate from the deploy script's own `_assertInvariants`
///         because that only runs during broadcast. This one runs any
///         time you want to catch drift — someone accidentally rotates
///         an impl, a governance call breaks a wire, etc.
///
///         Reverts loudly on any drift. On success prints a clean pass
///         line and exits 0.
///
/// @dev    Usage:
///           forge script script/VerifyDn404Deploy.s.sol --rpc-url $ROBINHOOD_RPC_URL
///
///         No broadcast, no keys, no state changes. Safe to run against
///         a live chain from any wallet.
contract VerifyDn404Deploy is Script {
    error VerifyDn404__NoBook();
    error VerifyDn404__NotDeployed(string label, address addr);
    error VerifyDn404__MhhInitializerMismatch(address expected, address actual);
    error VerifyDn404__GraduatorDefaultHookMismatch(address expected, address actual);
    error VerifyDn404__CurveFactoryGraduatorMismatch(address expected, address actual);
    error VerifyDn404__CurveFactoryImplMismatch(address expected, address actual);
    error VerifyDn404__CurveFactoryNotTrusting(address launchFactory);
    error VerifyDn404__LaunchFactoryBaseImplMismatch(address expected, address actual);
    error VerifyDn404__LaunchFactoryMirrorImplMismatch(address expected, address actual);
    error VerifyDn404__LaunchFactoryTaxImplMismatch(address expected, address actual);
    error VerifyDn404__LaunchFactoryV10Mismatch(address expected, address actual);
    error VerifyDn404__LaunchFactoryDn404CfMismatch(address expected, address actual);
    error VerifyDn404__MhhFlagMaskWrong(uint160 flags);

    function run() external view {
        string memory chainId = vm.toString(block.chainid);
        string memory path = string.concat("deployment-dn404.", chainId, ".json");
        if (!vm.exists(path)) revert VerifyDn404__NoBook();
        string memory json = vm.readFile(path);

        // Load every address we're going to verify.
        address pairAllow = vm.parseJsonAddress(json, ".Dn404PairCurrencyAllowlist");
        address taxAllow = vm.parseJsonAddress(json, ".Dn404TaxAllowlist");
        address baseImpl = vm.parseJsonAddress(json, ".Dn404Template");
        address mirrorImpl = vm.parseJsonAddress(json, ".Dn404MirrorTemplate");
        address taxImpl = vm.parseJsonAddress(json, ".Dn404TaxTemplate");
        address bcImpl = vm.parseJsonAddress(json, ".Dn404BondingCurveImpl");
        address cf = vm.parseJsonAddress(json, ".Dn404CurveFactory");
        address mhh = vm.parseJsonAddress(json, ".Dn404MultiHookHost");
        address grad = vm.parseJsonAddress(json, ".Dn404Graduator");
        address lf = vm.parseJsonAddress(json, ".Dn404LaunchFactory");
        address v10Cf = vm.parseJsonAddress(json, ".V10CurveFactory");

        // ---- 1. Every deployed contract has code.
        _requireCode("Dn404PairCurrencyAllowlist", pairAllow);
        _requireCode("Dn404TaxAllowlist", taxAllow);
        _requireCode("Dn404Template", baseImpl);
        _requireCode("Dn404MirrorTemplate", mirrorImpl);
        _requireCode("Dn404TaxTemplate", taxImpl);
        _requireCode("Dn404BondingCurveImpl", bcImpl);
        _requireCode("Dn404CurveFactory", cf);
        _requireCode("Dn404MultiHookHost", mhh);
        _requireCode("Dn404Graduator", grad);
        _requireCode("Dn404LaunchFactory", lf);

        // ---- 2. Mined MHH address has the correct v4 permission mask
        //         baked into its low 14 bits. If PoolManager.initialize
        //         is ever called on a pool with this hook, it validates
        //         the flags — a mismatch would make graduation revert.
        uint160 required = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        uint160 mask = 0x3FFF;
        if ((uint160(mhh) & mask) != (required & mask)) {
            revert VerifyDn404__MhhFlagMaskWrong(uint160(mhh) & mask);
        }

        // ---- 3. MHH ↔ Graduator one-shot lock.
        address mhhInit = MultiHookHost(payable(mhh)).initializer();
        if (mhhInit != grad) revert VerifyDn404__MhhInitializerMismatch(grad, mhhInit);
        address gradHook = address(Dn404Graduator(payable(grad)).defaultHook());
        if (gradHook != mhh) revert VerifyDn404__GraduatorDefaultHookMismatch(mhh, gradHook);

        // ---- 4. Dn404 CurveFactory wired to the graduator + impl.
        address cfGrad = Dn404CurveFactory(cf).graduator();
        if (cfGrad != grad) revert VerifyDn404__CurveFactoryGraduatorMismatch(grad, cfGrad);
        address cfImpl = Dn404CurveFactory(cf).implementation();
        if (cfImpl != bcImpl) revert VerifyDn404__CurveFactoryImplMismatch(bcImpl, cfImpl);
        if (!Dn404CurveFactory(cf).trustedRouters(lf)) {
            revert VerifyDn404__CurveFactoryNotTrusting(lf);
        }

        // ---- 5. LaunchFactory routing + impls + tax wiring.
        address lfBase = Dn404LaunchFactory(lf).baseImpl();
        if (lfBase != baseImpl) revert VerifyDn404__LaunchFactoryBaseImplMismatch(baseImpl, lfBase);
        address lfMirror = Dn404LaunchFactory(lf).mirrorImpl();
        if (lfMirror != mirrorImpl) revert VerifyDn404__LaunchFactoryMirrorImplMismatch(mirrorImpl, lfMirror);
        address lfTax = Dn404LaunchFactory(lf).baseTaxImpl();
        if (lfTax != taxImpl) revert VerifyDn404__LaunchFactoryTaxImplMismatch(taxImpl, lfTax);
        address lfV10 = address(Dn404LaunchFactory(lf).curveFactory());
        if (lfV10 != v10Cf) revert VerifyDn404__LaunchFactoryV10Mismatch(v10Cf, lfV10);
        address lfDn404Cf = address(Dn404LaunchFactory(lf).dn404CurveFactory());
        if (lfDn404Cf != cf) revert VerifyDn404__LaunchFactoryDn404CfMismatch(cf, lfDn404Cf);

        // ---- 6. Best-effort informational: does the V10 CurveFactory
        //         trust the LaunchFactory? Missing this doesn't fail the
        //         verify — ETH-pair launches would just revert. Log
        //         either way so ops sees the state.
        bool v10Trusts = IV10CurveFactoryView(v10Cf).trustedRouters(lf);
        console2.log("V10 CurveFactory trusts Dn404 LaunchFactory:", v10Trusts);
        if (!v10Trusts) {
            console2.log("  -> ETH-pair DN404 launches will revert until V10 CF owner runs:");
            console2.log("     CurveFactory(v10).setTrustedRouter(Dn404LaunchFactory, true)");
            console2.log("     V10 CF owner:", IV10CurveFactoryView(v10Cf).owner());
        }

        console2.log("=== VerifyDn404Deploy PASSED ===");
        console2.log("book:", path);
        console2.log("Dn404LaunchFactory:", lf);
        console2.log("Dn404CurveFactory :", cf);
        console2.log("Dn404MultiHookHost:", mhh);
        console2.log("Dn404Graduator    :", grad);
    }

    function _requireCode(
        string memory label,
        address addr
    ) internal view {
        if (addr.code.length == 0) revert VerifyDn404__NotDeployed(label, addr);
    }
}
