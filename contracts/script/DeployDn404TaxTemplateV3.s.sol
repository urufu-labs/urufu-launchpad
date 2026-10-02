// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Dn404TaxTemplateV3} from "src/dn404/Dn404TaxTemplateV3.sol";

interface IDn404LaunchFactoryAdmin {
    function owner() external view returns (address);
    function baseTaxImpl() external view returns (address);
    function setBaseTaxImpl(
        address impl,
        bytes32 expectedCodeHash
    ) external;
}

interface IGraduatorView {
    function defaultHook() external view returns (address);
}

/// @title  DeployDn404TaxTemplateV3
/// @notice Deploys Dn404TaxTemplateV3 (V2 system exemptions + untaxed transfers INTO
///         the v4 PoolManager, so taxed sells work through Uniswap's app) and binds
///         it as the live Dn404LaunchFactory's tax impl. NEW taxed launches clone
///         V3; existing taxed clones keep the impl they cloned (V2: only hidden
///         deployer test launches as of 2026-10-02).
///
///         Every address comes from the books AND is cross-checked on-chain:
///           - GRADUATOR_ETH  = deployment-live-rh.<chain>.json .graduator
///           - HOOK_ETH       = deployment-live-rh.<chain>.json .multiHookHost
///             (must equal GRADUATOR_ETH.defaultHook())
///           - POOL_MANAGER   = deployment-live-rh.<chain>.json .poolManager (must have code)
///           - GRADUATOR_PAIR = deployment-dn404.<chain>.json .Dn404Graduator
///           - HOOK_PAIR      = deployment-dn404.<chain>.json .Dn404MultiHookHost
///             (must equal GRADUATOR_PAIR.defaultHook())
///         A stale book aborts the run (deployment-book landmine memory).
///
///         Broadcast:  forge script script/DeployDn404TaxTemplateV3.s.sol \
///                       --rpc-url $ROBINHOOD_RPC_URL --private-key $DEV_PRIVATE_KEY --broadcast
///         The signer must be the factory owner. Verify on Blockscout after.
contract DeployDn404TaxTemplateV3 is Script {
    error DeployV3__HookMismatch(address graduator, address bookHook, address onchainHook);
    error DeployV3__NotFactoryOwner(address signer, address owner);
    error DeployV3__BindFailed();
    error DeployV3__NoPoolManagerCode(address poolManager);

    function run() external returns (Dn404TaxTemplateV3 v3) {
        string memory chainId = vm.toString(block.chainid);
        string memory live = vm.readFile(string.concat("deployment-live-rh.", chainId, ".json"));
        string memory dn = vm.readFile(string.concat("deployment-dn404.", chainId, ".json"));

        address gradEth = vm.parseJsonAddress(live, ".graduator");
        address hookEth = vm.parseJsonAddress(live, ".multiHookHost");
        address gradPair = vm.parseJsonAddress(dn, ".Dn404Graduator");
        address hookPair = vm.parseJsonAddress(dn, ".Dn404MultiHookHost");
        address poolManager = vm.parseJsonAddress(live, ".poolManager");
        if (poolManager.code.length == 0) revert DeployV3__NoPoolManagerCode(poolManager);
        IDn404LaunchFactoryAdmin lf = IDn404LaunchFactoryAdmin(vm.parseJsonAddress(dn, ".Dn404LaunchFactory"));

        address onEth = IGraduatorView(gradEth).defaultHook();
        if (onEth != hookEth) revert DeployV3__HookMismatch(gradEth, hookEth, onEth);
        address onPair = IGraduatorView(gradPair).defaultHook();
        if (onPair != hookPair) revert DeployV3__HookMismatch(gradPair, hookPair, onPair);

        address owner = lf.owner();
        console2.log("factory          ", address(lf));
        console2.log("factory owner    ", owner);
        console2.log("current tax impl ", lf.baseTaxImpl());
        console2.log("GRADUATOR_ETH    ", gradEth);
        console2.log("GRADUATOR_PAIR   ", gradPair);
        console2.log("HOOK_ETH         ", hookEth);
        console2.log("HOOK_PAIR        ", hookPair);
        console2.log("POOL_MANAGER     ", poolManager);

        vm.startBroadcast();
        if (msg.sender != owner) revert DeployV3__NotFactoryOwner(msg.sender, owner);
        v3 = new Dn404TaxTemplateV3(gradEth, gradPair, hookEth, hookPair, poolManager);
        lf.setBaseTaxImpl(address(v3), keccak256(address(v3).code));
        vm.stopBroadcast();

        if (lf.baseTaxImpl() != address(v3)) revert DeployV3__BindFailed();
        console2.log("Dn404TaxTemplateV3", address(v3));
        console2.logBytes32(keccak256(address(v3).code));
    }
}
