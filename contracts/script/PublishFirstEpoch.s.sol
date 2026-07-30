// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IVault {
    function owner() external view returns (address);
    function nextEpochId() external view returns (uint256);
    function addEpoch(bytes32 merkleRoot, uint256 totalAmount) external;
}

/// @title  PublishFirstEpoch
/// @notice Broadcasts vault.addEpoch(root, totalAmount) for the first-ever
///         NftRevenueVault epoch on Robinhood. Root + total were computed
///         off-chain by compile-service/src/buildEpochTree.ts and hardcoded
///         here so this script does exactly one thing: sign + send.
///
///         Post-broadcast, the frontend can serve proofs from the persisted
///         epoch0.json (contracts/tmp/epoch/epoch0.json) until the DB is
///         populated (or seed the DB directly from that JSON).
contract PublishFirstEpoch is Script {
    address internal constant VAULT = 0x93CFF459d5019eEc82fE9335013e265F1eD659c7;

    // Precomputed by buildEpochTree.ts against RH mainnet head 2026-07-30:
    //   395 gemu NFT holders, 3216 total NFTs
    //   vault balance = 0.019369610179987726 ETH
    bytes32 internal constant MERKLE_ROOT = 0xb73e9a5a5d4b4daec3738c3f1c8c88aae688f6bf7d283c248cc73d82934ff3a0;
    uint256 internal constant TOTAL_AMOUNT = 19_369_610_179_987_726; // wei

    function run() external {
        address broadcaster = msg.sender;
        console2.log("broadcaster :", broadcaster);
        console2.log("vault       :", VAULT);

        address owner_ = IVault(VAULT).owner();
        require(owner_ == broadcaster, "broadcaster is not vault owner");

        uint256 next = IVault(VAULT).nextEpochId();
        require(next == 0, "nextEpochId != 0 - tree was computed for epoch 0");

        vm.startBroadcast();
        IVault(VAULT).addEpoch(MERKLE_ROOT, TOTAL_AMOUNT);
        vm.stopBroadcast();

        console2.log("");
        console2.log("========================================");
        console2.log("Epoch 0 published");
        console2.log("========================================");
        console2.log("  merkleRoot:  0x", vm.toString(MERKLE_ROOT));
        console2.log("  totalAmount:", TOTAL_AMOUNT);
        console2.log("  holderCount: 395");
        console2.log("");
        console2.log("Next: seed proofs into app.rewards_epochs + app.rewards_leaves");
        console2.log("  source: contracts/tmp/epoch/epoch0.json");
    }
}
