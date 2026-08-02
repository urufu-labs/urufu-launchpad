// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface INameRegistry {
    function router() external view returns (address);
    function pendingRouter() external view returns (address);
    function pendingRouterTs() external view returns (uint256);
    function activateRouter() external;
    function owner() external view returns (address);
}

/// @title  ActivateRouter
/// @notice Post-timelock second phase of a Router rotation. After
///         `DeployRouter` proposes the new Router on `NameRegistry`, the
///         registry enforces a 2-day delay before the rotation can be
///         activated (`MIN_ROUTER_DELAY = 2 days`). This script performs
///         the activation once the timelock has elapsed and re-marks the
///         address book as ACTIVE.
///
///         Env:
///           ROBINHOOD_NAME_REGISTRY_ADDRESS  (required)
///           ROBINHOOD_ROUTER_ADDRESS         (required — must match pending)
///
///         Errors it prints (all fatal):
///           - NameRegistry has no pending router (deploy step never ran, or
///             activation already happened, or activation was canceled).
///           - Pending router differs from ROBINHOOD_ROUTER_ADDRESS (env
///             drift; deploying operator staged a different Router than the
///             activator env points at).
///           - Timelock not yet passed (retry after readyAt).
///
///         Run:
///           ROBINHOOD_NAME_REGISTRY_ADDRESS=0x… \
///           ROBINHOOD_ROUTER_ADDRESS=0x… \
///           bash contracts/deploy.sh ActivateRouter robinhood
contract ActivateRouter is Script {
    error ActivateRouter__NoPendingRouter(address registry);
    error ActivateRouter__PendingMismatch(address expectedRouter, address actualPending);
    error ActivateRouter__TimelockNotPassed(uint256 readyAt);

    function run() external {
        address registryAddr = vm.envAddress("ROBINHOOD_NAME_REGISTRY_ADDRESS");
        address expectedRouter = vm.envAddress("ROBINHOOD_ROUTER_ADDRESS");

        INameRegistry reg = INameRegistry(registryAddr);
        address pending = reg.pendingRouter();
        if (pending == address(0)) revert ActivateRouter__NoPendingRouter(registryAddr);
        if (pending != expectedRouter) revert ActivateRouter__PendingMismatch(expectedRouter, pending);
        uint256 readyAt = reg.pendingRouterTs();
        if (block.timestamp < readyAt) revert ActivateRouter__TimelockNotPassed(readyAt);

        console2.log("---- activating router ----");
        console2.log("  registry :", registryAddr);
        console2.log("  pending  :", pending);
        console2.log("  ready at :", readyAt);
        console2.log("  now      :", block.timestamp);

        vm.startBroadcast();
        reg.activateRouter();
        vm.stopBroadcast();

        address activeRouter = reg.router();
        require(activeRouter == expectedRouter, "activateRouter: router mismatch post-activate");
        console2.log("  [ok] NameRegistry.router now:", activeRouter);
        console2.log("");
        console2.log("Next step: update the address book status ACTIVE for");
        console2.log(string.concat("  deployment-routerv2.", vm.toString(block.chainid), ".json"));
    }
}
