// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IFairLaunchFactoryView, SwarmVault} from "src/swarm/SwarmVault.sol";
import {SwarmVaultFactory} from "src/swarm/SwarmVaultFactory.sol";

interface IFairFactoryPreflight {
    function launchesOpen() external view returns (bool);
    function batchImpl() external view returns (address);
}

/// @title  DeploySwarmVaultFactory
/// @notice Phase 3a (docs/PLAN-agents-and-swarms.md §4, §8): deploys the SwarmVaultFactory
///         (and its SwarmVault implementation) pointed at the live FairLaunchFactory.
///
///         NOT BROADCAST. The plan gates going live on an external audit of SwarmVault +
///         factory (step 3b) and a small real swarm rehearsal (3c). Dry run:
///
///           forge script script/DeploySwarmVaultFactory.s.sol --rpc-url $ROBINHOOD_RPC_URL
///
///         Broadcast only after the audit, with verification (Blockscout, runs=10000,
///         via_ir) as for every other urufu contract.
///
///         Env: FAIR_LAUNCH_FACTORY (defaults to the live RH factory).
contract DeploySwarmVaultFactory is Script {
    address internal constant LIVE_FAIR_FACTORY = 0x986BFC6c7be4b8d613FC3d25c6633eD9af27701d;
    uint256 internal constant RH_CHAIN_ID = 4663;

    function run() external returns (SwarmVaultFactory swarms) {
        address fairFactory = vm.envOr("FAIR_LAUNCH_FACTORY", LIVE_FAIR_FACTORY);

        // Preflight: right chain, a real Fair factory with code and its batch template.
        require(block.chainid == RH_CHAIN_ID, "not Robinhood Chain");
        require(fairFactory.code.length > 0, "Fair factory has no code");
        address batchImpl = IFairFactoryPreflight(fairFactory).batchImpl();
        require(batchImpl.code.length > 0, "Fair batch implementation has no code");
        console2.log("Fair factory:      ", fairFactory);
        console2.log("  launches open:   ", IFairFactoryPreflight(fairFactory).launchesOpen());
        console2.log("  batch impl:      ", batchImpl);

        vm.startBroadcast();
        swarms = new SwarmVaultFactory(IFairLaunchFactoryView(fairFactory));
        vm.stopBroadcast();

        // Postflight: wiring is immutable, so check it once here.
        SwarmVault impl = SwarmVault(payable(swarms.vaultImpl()));
        require(address(swarms.fairFactory()) == fairFactory, "factory wiring");
        require(impl.swarmFactory() == address(swarms), "impl -> factory");
        require(address(impl.fairFactory()) == fairFactory, "impl -> Fair factory");
        console2.log("SwarmVaultFactory: ", address(swarms));
        console2.log("SwarmVault impl:   ", address(impl));
    }
}
