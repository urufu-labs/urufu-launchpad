// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice One-shot admin script for TESTNET use: lowers `defaultGraduationTargetEth` on
///         the deployed CurveFactory to `TARGET_ETH` (default 0.05 ETH) so a developer can
///         graduate a real curve for cheap. Keeps every other default (curve supply,
///         virtual reserves, fee) exactly as they are so the curve math stays valid.
///
/// @dev    ONLY use before HandoffOwnership — the current CurveFactory owner (deploy key)
///         must call this. Post-handoff you'd need the multisig to run setDefaults instead.
///         Never use this on mainnet without a very deliberate reason: a 0.05 ETH grad
///         target is trivially graduatable by any user and wrecks the price-discovery
///         window bonding curves are designed for.
///
/// Env vars:
///   TARGET_ETH  — grad target in wei (default 0.05e18)
///
/// Usage:
///   TARGET_ETH=50000000000000000 forge script script/LowerGradTarget.s.sol:LowerGradTarget \
///     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY --slow
contract LowerGradTarget is Script {
    using stdJson for string;

    error LowerGradTarget__CurveFactoryNotFound();

    function run() external {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) revert LowerGradTarget__CurveFactoryNotFound();
        address cfAddr = vm.readFile(path).readAddress(".CurveFactory");
        CurveFactory cf = CurveFactory(cfAddr);

        // Read existing defaults so we preserve everything except the graduation target —
        // no accidental mutation of curve supply / virtual reserves / trade fee.
        uint256 curveSupply = cf.defaultCurveSupply();
        uint256 vTok = cf.defaultVirtualTokenReserve();
        uint256 vEth = cf.defaultVirtualEthReserve();
        uint16 feeBps = cf.defaultTradeFeeBps();

        uint256 newTarget = vm.envOr("TARGET_ETH", uint256(0.05 ether));

        console2.log("=========================================================");
        console2.log("LowerGradTarget on chain", block.chainid);
        console2.log("  CurveFactory        :", cfAddr);
        console2.log("  Old grad target (wei):", cf.defaultGraduationTargetEth());
        console2.log("  New grad target (wei):", newTarget);
        console2.log("  Preserving supply    :", curveSupply);
        console2.log("  Preserving vToken    :", vTok);
        console2.log("  Preserving vEth      :", vEth);
        console2.log("  Preserving feeBps    :", feeBps);
        console2.log("=========================================================");

        vm.startBroadcast();
        cf.setDefaults(curveSupply, vTok, vEth, newTarget, feeBps);
        vm.stopBroadcast();

        console2.log("Done. New curves created via CurveFactory.createCurve() will use the");
        console2.log("lowered target. Existing curves keep their original (immutable) target.");
    }
}
