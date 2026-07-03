// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";

/// @notice Post-deploy configuration for the flywheel. Two independent jobs:
///
///           1. `UruBuybackVault` allowlists (no timelock — owner-only):
///              - Allowlist the KEEPER address that will trigger buybacks
///              - Allowlist the SWAP_TARGET (Uniswap Universal Router) that the
///                keeper is permitted to route swaps through
///
///           2. `FeeSplitter` splits (timelock-gated — 2 days from deploy by default):
///              - Wire buyback + NFT sinks to the vaults deployed by `DeployFlywheel`
///              - Set the 40 / 35 / 25 split
///
///         The vault allowlists are done unconditionally. The splitter setConfig is
///         attempted but gracefully skipped if the timelock hasn't elapsed yet — the
///         script prints the exact `block.timestamp` at which the call becomes valid
///         so the operator can re-run at that time.
///
///         Well-known Uniswap Universal Router addresses (pass via `SWAP_TARGET`):
///           - Base mainnet:   0x6fF5693b99212Da76ad316178A184AB56D299b43
///           - Base sepolia:   0x492E6456D9528771018DeB9E87ef7750EF184104
///           - Ethereum:       0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af
///           - Sepolia:        0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b
///         Always verify against Uniswap docs before setting on mainnet.
///
/// Env vars:
///   KEEPER               — buyback keeper address (required)
///   SWAP_TARGET          — swap router the keeper is allowed to call (required)
///   TREASURY             — treasury sink for the 25% slice (defaults to broadcaster)
///   URU_BUYBACK_BPS      — override buyback slice (default 4000)
///   NFT_REVENUE_BPS      — override NFT slice (default 3500)
///   TREASURY_BPS         — override treasury slice (default 2500)
///
/// Usage:
///   forge script script/ConfigureFlywheel.s.sol:ConfigureFlywheel \
///     --rpc-url $BASE_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY -vvvv
contract ConfigureFlywheel is Script {
    error ConfigureFlywheel__NoFlywheelBook();
    error ConfigureFlywheel__BadSplit(uint256 total);

    function run() external {
        string memory path = string.concat("deployment-flywheel.", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) revert ConfigureFlywheel__NoFlywheelBook();
        string memory book = vm.readFile(path);

        address feeSplitterAddr = vm.parseJsonAddress(book, ".FeeSplitter");
        address nftVaultAddr = vm.parseJsonAddress(book, ".NftRevenueVault");
        address buybackVaultAddr = vm.parseJsonAddress(book, ".UruBuybackVault");

        address keeper = vm.envAddress("KEEPER");
        address swapTarget = vm.envAddress("SWAP_TARGET");
        address treasury = vm.envOr("TREASURY", msg.sender);

        uint16 buybackBps = uint16(vm.envOr("URU_BUYBACK_BPS", uint256(4_000)));
        uint16 nftBps = uint16(vm.envOr("NFT_REVENUE_BPS", uint256(3_500)));
        uint16 treasuryBps = uint16(vm.envOr("TREASURY_BPS", uint256(2_500)));

        uint256 sum = uint256(buybackBps) + uint256(nftBps) + uint256(treasuryBps);
        if (sum != 10_000) revert ConfigureFlywheel__BadSplit(sum);

        console2.log("=========================================================");
        console2.log("Configuring flywheel");
        console2.log("=========================================================");
        console2.log("  FeeSplitter:     ", feeSplitterAddr);
        console2.log("  UruBuybackVault: ", buybackVaultAddr);
        console2.log("  NftRevenueVault: ", nftVaultAddr);
        console2.log("  Keeper:          ", keeper);
        console2.log("  Swap target:     ", swapTarget);
        console2.log("  Treasury:        ", treasury);
        console2.log("  Split (bps):     ", buybackBps, nftBps, treasuryBps);

        UruBuybackVault vault = UruBuybackVault(payable(buybackVaultAddr));
        FeeSplitter splitter = FeeSplitter(payable(feeSplitterAddr));

        vm.startBroadcast();

        // --- Job 1: UruBuybackVault allowlists (no timelock) -----------------
        if (!vault.isKeeper(keeper)) {
            vault.setKeeper(keeper, true);
            console2.log("  [ok] keeper allowlisted");
        } else {
            console2.log("  [skip] keeper already allowlisted");
        }

        if (!vault.isSwapTarget(swapTarget)) {
            vault.setSwapTarget(swapTarget, true);
            console2.log("  [ok] swap target allowlisted");
        } else {
            console2.log("  [skip] swap target already allowlisted");
        }

        // --- Job 2: FeeSplitter splits (timelock-gated) ----------------------
        uint256 earliest = splitter.lastConfigChange() + splitter.minConfigDelay();
        if (block.timestamp < earliest) {
            console2.log("---------------------------------------------------------");
            console2.log("  [wait] FeeSplitter timelock not yet elapsed");
            console2.log("         earliest valid block.timestamp:", earliest);
            console2.log("         current block.timestamp:       ", block.timestamp);
            console2.log("         re-run this script after that time to apply splits");
        } else {
            splitter.setConfig(
                buybackVaultAddr,
                nftVaultAddr,
                treasury,
                buybackBps,
                nftBps,
                treasuryBps
            );
            console2.log("  [ok] FeeSplitter splits configured");
        }

        vm.stopBroadcast();

        console2.log("---------------------------------------------------------");
        console2.log("Done. Verify with:");
        console2.log("  cast call <UruBuybackVault> 'isKeeper(address)(bool)' <keeper> --rpc-url ...");
        console2.log("  cast call <UruBuybackVault> 'isSwapTarget(address)(bool)' <target> --rpc-url ...");
        console2.log("  cast call <FeeSplitter> 'uruBuybackSink()(address)' --rpc-url ...");
    }
}
