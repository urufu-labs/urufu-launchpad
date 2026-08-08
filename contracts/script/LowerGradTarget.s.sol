// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice One-shot admin script for private rehearsal deployments. Lowers
///         `defaultGraduationTargetEth` on the deployed CurveFactory to
///         `TARGET_ETH` so a developer can graduate a real curve cheaply.
///         Preserves every other default.
contract LowerGradTarget is Script {
    using stdJson for string;

    error LowerGradTarget__CurveFactoryNotFound();
    error LowerGradTarget__MainnetRequiresAck();
    error LowerGradTarget__InvalidTarget();
    error LowerGradTarget__TargetExhaustsCurve(uint256 target, uint256 maxSafeTarget);

    function run() external {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) revert LowerGradTarget__CurveFactoryNotFound();
        address cfAddr = vm.readFile(path).readAddress(".CurveFactory");
        CurveFactory cf = CurveFactory(cfAddr);

        uint256 curveSupply = cf.defaultCurveSupply();
        uint256 vTok = cf.defaultVirtualTokenReserve();
        uint256 vEth = cf.defaultVirtualEthReserve();
        uint16 feeBps = cf.defaultTradeFeeBps();

        uint256 newTarget = vm.envOr("TARGET_ETH", uint256(0.001 ether));
        if (newTarget == 0 || vTok == 0) revert LowerGradTarget__InvalidTarget();
        uint256 maxReachable = (curveSupply * vEth) / vTok;
        uint256 maxSafeTarget = (maxReachable * (10_000 - uint256(cf.graduationSafetyMarginBps()))) / 10_000;
        if (newTarget >= maxSafeTarget) {
            revert LowerGradTarget__TargetExhaustsCurve(newTarget, maxSafeTarget);
        }
        if (block.chainid == 1 && vm.envOr("ALLOW_ETHEREUM_MAINNET_TINY_TARGET", uint256(0)) != 1) {
            revert LowerGradTarget__MainnetRequiresAck();
        }
        if (block.chainid == 4663 && vm.envOr("ALLOW_ROBINHOOD_MAINNET_TINY_TARGET", uint256(0)) != 1) {
            revert LowerGradTarget__MainnetRequiresAck();
        }

        console2.log("=========================================================");
        console2.log("LowerGradTarget on chain", block.chainid);
        console2.log("  CurveFactory          :", cfAddr);
        console2.log("  Old grad target (wei) :", cf.defaultGraduationTargetEth());
        console2.log("  New grad target (wei) :", newTarget);
        console2.log("  Max safe target (wei) :", maxSafeTarget);
        console2.log("  Preserving supply     :", curveSupply);
        console2.log("  Preserving vToken     :", vTok);
        console2.log("  Preserving vEth       :", vEth);
        console2.log("  Preserving feeBps     :", feeBps);
        console2.log("=========================================================");

        vm.startBroadcast();
        cf.setDefaults(curveSupply, vTok, vEth, newTarget, feeBps);
        vm.stopBroadcast();

        console2.log("Done. New curves created via CurveFactory use the lowered target.");
    }
}
