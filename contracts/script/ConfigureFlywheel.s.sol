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
interface IUruDepositSinkLike {
    function isKeeper(
        address
    ) external view returns (bool);
    function isSwapTarget(
        address
    ) external view returns (bool);
    function setKeeper(
        address keeper,
        bool allowed
    ) external;
    function setSwapTarget(
        address target,
        bool allowed
    ) external;
    // URU-A11: propose/activate helpers so this script can stage a keeper /
    // target change on the first pass and activate it on the follow-up.
    function keeperChangeId(
        address keeper,
        bool allowed
    ) external pure returns (bytes32);
    function swapTargetChangeId(
        address target,
        bool allowed
    ) external pure returns (bytes32);
    function adminChangeReadyAt(
        bytes32 changeId
    ) external view returns (uint256);
    function proposeAdminChange(
        bytes32 changeId
    ) external;
}

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

        // UruDepositSink also has a keeper + swap-target allowlist. It lives
        // in the fresh-deploy or router-rotation address book (not the
        // flywheel book which pre-dates URU-pay). Try fresh first, then
        // routerv2, then skip if neither is present — an operator running
        // against a legacy Base-era stack won't have URU pay wired at all.
        address uruSinkAddr;
        string memory freshPath = string.concat("deployment-fresh.", vm.toString(block.chainid), ".json");
        if (vm.exists(freshPath)) {
            uruSinkAddr = vm.parseJsonAddress(vm.readFile(freshPath), ".uruDepositSink");
        } else {
            string memory rvPath = string.concat("deployment-routerv2.", vm.toString(block.chainid), ".json");
            if (vm.exists(rvPath)) {
                uruSinkAddr = vm.parseJsonAddress(vm.readFile(rvPath), ".UruDepositSink");
            }
        }

        address keeper = vm.envAddress("KEEPER");
        address swapTarget = vm.envAddress("SWAP_TARGET");
        address treasury = vm.envOr("TREASURY", msg.sender);

        uint16 buybackBps = uint16(vm.envOr("URU_BUYBACK_BPS", uint256(4000)));
        uint16 nftBps = uint16(vm.envOr("NFT_REVENUE_BPS", uint256(3500)));
        uint16 treasuryBps = uint16(vm.envOr("TREASURY_BPS", uint256(2500)));

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

        // --- Job 1: UruBuybackVault allowlists (URU-A11 propose→activate) ----
        _stageOrActivateBuybackKeeper(vault, keeper);
        _stageOrActivateBuybackTarget(vault, swapTarget);

        // --- Job 1b: UruDepositSink allowlists ----------------------------
        if (uruSinkAddr != address(0)) {
            IUruDepositSinkLike sink = IUruDepositSinkLike(uruSinkAddr);
            _stageOrActivateSinkKeeper(sink, keeper);
            _stageOrActivateSinkTarget(sink, swapTarget);
        } else {
            console2.log("  [skip] UruDepositSink not in address book (pre-URU-pay stack)");
        }

        // --- Job 2: FeeSplitter splits (URU-A11 propose→activate) ----------
        (,,,,,, uint64 splitterReadyAt) = splitter.pendingConfig();
        if (splitterReadyAt == 0) {
            // No pending proposal — stage one. Operator re-runs to activate.
            splitter.proposeConfig(buybackVaultAddr, nftVaultAddr, treasury, buybackBps, nftBps, treasuryBps);
            console2.log("  [staged] FeeSplitter config proposed; re-run after maturity to activate");
        } else if (block.timestamp < splitterReadyAt) {
            console2.log("---------------------------------------------------------");
            console2.log("  [wait] FeeSplitter proposal not yet mature");
            console2.log("         earliest valid block.timestamp:", splitterReadyAt);
            console2.log("         current block.timestamp:       ", block.timestamp);
            console2.log("         re-run this script after that time to activate");
        } else {
            splitter.activateConfig();
            console2.log("  [ok] FeeSplitter proposed config activated");
        }

        vm.stopBroadcast();

        console2.log("---------------------------------------------------------");
        console2.log("Done. Verify with:");
        console2.log("  cast call <UruBuybackVault> 'isKeeper(address)(bool)' <keeper> --rpc-url ...");
        console2.log("  cast call <UruBuybackVault> 'isSwapTarget(address)(bool)' <target> --rpc-url ...");
        console2.log("  cast call <FeeSplitter> 'uruBuybackSink()(address)' --rpc-url ...");
    }

    // URU-A11 helpers — propose on first invocation, activate on the follow-up
    // after `minConfigDelay` has elapsed. Idempotent: skip if already granted.
    function _stageOrActivateBuybackKeeper(
        UruBuybackVault vault,
        address keeper
    ) internal {
        if (vault.isKeeper(keeper)) {
            console2.log("  [skip] UruBuybackVault keeper already allowlisted");
            return;
        }
        bytes32 id = vault.keeperChangeId(keeper, true);
        uint256 readyAt = vault.adminChangeReadyAt(id);
        if (readyAt == 0) {
            vault.proposeAdminChange(id);
            console2.log("  [staged] UruBuybackVault keeper proposal");
        } else if (block.timestamp >= readyAt) {
            vault.setKeeper(keeper, true);
            console2.log("  [ok] UruBuybackVault keeper allowlisted");
        } else {
            console2.log("  [wait] UruBuybackVault keeper proposal matures at:", readyAt);
        }
    }

    function _stageOrActivateBuybackTarget(
        UruBuybackVault vault,
        address target
    ) internal {
        if (vault.isSwapTarget(target)) {
            console2.log("  [skip] UruBuybackVault swap target already allowlisted");
            return;
        }
        bytes32 id = vault.swapTargetChangeId(target, true);
        uint256 readyAt = vault.adminChangeReadyAt(id);
        if (readyAt == 0) {
            vault.proposeAdminChange(id);
            console2.log("  [staged] UruBuybackVault swap target proposal");
        } else if (block.timestamp >= readyAt) {
            vault.setSwapTarget(target, true);
            console2.log("  [ok] UruBuybackVault swap target allowlisted");
        } else {
            console2.log("  [wait] UruBuybackVault swap target proposal matures at:", readyAt);
        }
    }

    function _stageOrActivateSinkKeeper(
        IUruDepositSinkLike sink,
        address keeper
    ) internal {
        if (sink.isKeeper(keeper)) {
            console2.log("  [skip] UruDepositSink keeper already allowlisted");
            return;
        }
        bytes32 id = sink.keeperChangeId(keeper, true);
        uint256 readyAt = sink.adminChangeReadyAt(id);
        if (readyAt == 0) {
            sink.proposeAdminChange(id);
            console2.log("  [staged] UruDepositSink keeper proposal");
        } else if (block.timestamp >= readyAt) {
            sink.setKeeper(keeper, true);
            console2.log("  [ok] UruDepositSink keeper allowlisted");
        } else {
            console2.log("  [wait] UruDepositSink keeper proposal matures at:", readyAt);
        }
    }

    function _stageOrActivateSinkTarget(
        IUruDepositSinkLike sink,
        address target
    ) internal {
        if (sink.isSwapTarget(target)) {
            console2.log("  [skip] UruDepositSink swap target already allowlisted");
            return;
        }
        bytes32 id = sink.swapTargetChangeId(target, true);
        uint256 readyAt = sink.adminChangeReadyAt(id);
        if (readyAt == 0) {
            sink.proposeAdminChange(id);
            console2.log("  [staged] UruDepositSink swap target proposal");
        } else if (block.timestamp >= readyAt) {
            sink.setSwapTarget(target, true);
            console2.log("  [ok] UruDepositSink swap target allowlisted");
        } else {
            console2.log("  [wait] UruDepositSink swap target proposal matures at:", readyAt);
        }
    }
}
