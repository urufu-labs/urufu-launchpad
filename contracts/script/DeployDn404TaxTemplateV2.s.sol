// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Dn404TaxTemplateV2} from "src/dn404/Dn404TaxTemplateV2.sol";

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

/// @title  DeployDn404TaxTemplateV2
/// @notice Deploys Dn404TaxTemplateV2 (system exemptions for graduators, hooks,
///         keeper) and binds it as the live Dn404LaunchFactory's tax impl, so
///         NEW taxed DN404 launches can graduate. Existing launches keep the
///         impl they cloned (none taxed exist as of 2026-10-01).
///
///         Every address comes from the books AND is cross-checked on-chain:
///           - GRADUATOR_ETH  = deployment-live-rh.<chain>.json .graduator
///           - HOOK_ETH       = deployment-live-rh.<chain>.json .multiHookHost
///             (must equal GRADUATOR_ETH.defaultHook())
///           - GRADUATOR_PAIR = deployment-dn404.<chain>.json .Dn404Graduator
///           - HOOK_PAIR      = deployment-dn404.<chain>.json .Dn404MultiHookHost
///             (must equal GRADUATOR_PAIR.defaultHook())
///         A stale book aborts the run (deployment-book landmine memory).
///
///         Broadcast:  forge script script/DeployDn404TaxTemplateV2.s.sol \
///                       --rpc-url $ROBINHOOD_RPC_URL --private-key $DEV_PRIVATE_KEY --broadcast
///         The signer must be the factory owner. Verify on Blockscout after.
contract DeployDn404TaxTemplateV2 is Script {
    error DeployV2__HookMismatch(address graduator, address bookHook, address onchainHook);
    error DeployV2__NotFactoryOwner(address signer, address owner);
    error DeployV2__BindFailed();

    function run() external returns (Dn404TaxTemplateV2 v2) {
        string memory chainId = vm.toString(block.chainid);
        string memory live = vm.readFile(string.concat("deployment-live-rh.", chainId, ".json"));
        string memory dn = vm.readFile(string.concat("deployment-dn404.", chainId, ".json"));

        address gradEth = vm.parseJsonAddress(live, ".graduator");
        address hookEth = vm.parseJsonAddress(live, ".multiHookHost");
        address gradPair = vm.parseJsonAddress(dn, ".Dn404Graduator");
        address hookPair = vm.parseJsonAddress(dn, ".Dn404MultiHookHost");
        IDn404LaunchFactoryAdmin lf = IDn404LaunchFactoryAdmin(vm.parseJsonAddress(dn, ".Dn404LaunchFactory"));

        address onEth = IGraduatorView(gradEth).defaultHook();
        if (onEth != hookEth) revert DeployV2__HookMismatch(gradEth, hookEth, onEth);
        address onPair = IGraduatorView(gradPair).defaultHook();
        if (onPair != hookPair) revert DeployV2__HookMismatch(gradPair, hookPair, onPair);

        address owner = lf.owner();
        console2.log("factory          ", address(lf));
        console2.log("factory owner    ", owner);
        console2.log("current tax impl ", lf.baseTaxImpl());
        console2.log("GRADUATOR_ETH    ", gradEth);
        console2.log("GRADUATOR_PAIR   ", gradPair);
        console2.log("HOOK_ETH         ", hookEth);
        console2.log("HOOK_PAIR        ", hookPair);

        vm.startBroadcast();
        if (msg.sender != owner) revert DeployV2__NotFactoryOwner(msg.sender, owner);
        v2 = new Dn404TaxTemplateV2(gradEth, gradPair, hookEth, hookPair);
        lf.setBaseTaxImpl(address(v2), keccak256(address(v2).code));
        vm.stopBroadcast();

        if (lf.baseTaxImpl() != address(v2)) revert DeployV2__BindFailed();
        console2.log("Dn404TaxTemplateV2", address(v2));
        console2.logBytes32(keccak256(address(v2).code));
    }
}
