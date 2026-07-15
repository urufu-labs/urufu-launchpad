// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {V4SwapRouter} from "src/router/V4SwapRouter.sol";

/// @notice Deploys `V4SwapRouter` for the launchpad's post-graduation trade widget.
///         One router per chain, wired to the chain's PoolManager. Writes a small
///         `deployment-v4router.<chainid>.json` book so sync-addresses can propagate
///         it to the web app alongside the other subsystem books.
contract DeployV4SwapRouter is Script {
    using stdJson for string;

    function run() external returns (address routerAddr) {
        // PoolManager address — prefer the hooks book, fall back to V4_POOL_MANAGER env.
        string memory hooksPath = string.concat("deployment-hooks.", vm.toString(block.chainid), ".json");
        address poolManager;
        if (vm.exists(hooksPath)) {
            poolManager = vm.readFile(hooksPath).readAddress(".PoolManager");
        } else {
            poolManager = vm.envAddress("V4_POOL_MANAGER");
        }

        vm.startBroadcast();
        V4SwapRouter router = new V4SwapRouter(IPoolManager(poolManager));
        vm.stopBroadcast();
        routerAddr = address(router);

        console2.log("=========================================================");
        console2.log("V4SwapRouter deployed");
        console2.log("=========================================================");
        console2.log("  chain           :", block.chainid);
        console2.log("  V4SwapRouter    :", routerAddr);
        console2.log("  PoolManager     :", poolManager);

        string memory book = string.concat(
            '{\n  "V4SwapRouter": "',
            vm.toString(routerAddr),
            '",\n  "PoolManager": "',
            vm.toString(poolManager),
            '"\n}\n'
        );
        string memory outPath = string.concat("deployment-v4router.", vm.toString(block.chainid), ".json");
        vm.writeFile(outPath, book);
        console2.log("  book written    :", outPath);
    }
}
