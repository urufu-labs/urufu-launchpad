// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IUruBuybackVault {
    function distributionSink() external view returns (address);
    function pendingDistributionSink() external view returns (address);
    function pendingDistributionSinkTs() external view returns (uint256);
    function minConfigDelay() external view returns (uint256);
    function owner() external view returns (address);
    function proposeDistributionSink(
        address sink
    ) external;
    function activateDistributionSink() external;
}

/// @title  RotateUruSink
/// @notice Two-step owner rotation of UruBuybackVault.distributionSink.
///
///         The vault enforces a `minConfigDelay` (48h on RH) between
///         proposeDistributionSink() and activateDistributionSink() as
///         MEV / rug protection -- an owner-key compromise can't instantly
///         redirect bought URU. You broadcast the propose now, wait 48h,
///         then broadcast the activate.
///
///         Target sink: 0x000000000000000000000000000000000000dEaD
///         Effect after activation: every keeper buyback tick swaps ETH
///         from the vault into URU and burns the URU by sending it to
///         the dead address.
///
///         Env: DEV_PRIVATE_KEY (must be vault owner).
///
///         Usage:
///           # right now, to start the 48h timelock:
///           forge script script/RotateUruSink.s.sol:PropUruSink \
///             --rpc-url $ROBINHOOD_RPC_URL --broadcast --chain 4663
///
///           # 48h later, to commit:
///           forge script script/RotateUruSink.s.sol:ActivateUruSink \
///             --rpc-url $ROBINHOOD_RPC_URL --broadcast --chain 4663
contract PropUruSink is Script {
    address constant URU_VAULT = 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354;
    address constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);
        IUruBuybackVault vault = IUruBuybackVault(URU_VAULT);

        require(vault.owner() == me, "signer is not vault owner");

        address currentSink = vault.distributionSink();
        console2.log("========================================================");
        console2.log("URU BUYBACK VAULT - PROPOSE distributionSink rotation");
        console2.log("========================================================");
        console2.log("Signer (owner):", me);
        console2.log("Current sink:  ", currentSink);
        console2.log("Proposed sink: ", BURN_SINK, "(burn URU)");
        console2.log("Timelock delay:", vault.minConfigDelay() / 3600, "hours");

        vm.startBroadcast(pk);
        vault.proposeDistributionSink(BURN_SINK);
        vm.stopBroadcast();

        uint256 readyAt = vault.pendingDistributionSinkTs();
        console2.log("========================================================");
        console2.log("PROPOSED. Ready to activate at unix:", readyAt);
        console2.log("Re-run this same script's Activate variant after that.");
        console2.log("========================================================");
    }
}

contract ActivateUruSink is Script {
    address constant URU_VAULT = 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354;
    address constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);
        IUruBuybackVault vault = IUruBuybackVault(URU_VAULT);

        require(vault.owner() == me, "signer is not vault owner");

        address pending = vault.pendingDistributionSink();
        uint256 readyAt = vault.pendingDistributionSinkTs();
        require(pending == BURN_SINK, "pending sink is not 0xdEaD -- re-propose first");
        require(block.timestamp >= readyAt, "timelock not yet elapsed");

        console2.log("========================================================");
        console2.log("URU BUYBACK VAULT - ACTIVATE distributionSink rotation");
        console2.log("========================================================");
        console2.log("Signer (owner):", me);
        console2.log("Old sink:      ", vault.distributionSink());
        console2.log("New sink:      ", pending);

        vm.startBroadcast(pk);
        vault.activateDistributionSink();
        vm.stopBroadcast();

        console2.log("========================================================");
        console2.log("ACTIVATED. distributionSink is now:", vault.distributionSink());
        console2.log("Next step: flip URU_BUYBACK_ENABLED=true on compile-service");
        console2.log("Railway env + redeploy. Keeper loop drains ETH -> URU -> burn.");
        console2.log("========================================================");
    }
}
