// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice Applies the "chunky pool" defaults on a live CurveFactory:
///         17 ETH virtual reserve + 10 ETH graduation target. Every other
///         default is READ-BACK and re-set exactly as-is so nothing else
///         mutates by accident.
///
///         Motivation: with 5/4 defaults, graduations opened v4 pools with
///         only ~20M tokens + 4 ETH of liquidity — very thin, easily
///         moved by the first swap. 17/10 targets a ~207M + 10 ETH LP,
///         which is ~10x deeper and matches the pump-style feel we want.
///
/// Env vars:
///   CURVE_FACTORY_ADDRESS  (required)  — target CF address. No default so
///                                        that a typo can't silently hit
///                                        the wrong chain's CF.
///   VIRT_ETH               (optional)  — override virtual reserve (wei)
///   GRAD_ETH               (optional)  — override graduation target (wei)
///
/// Usage (broadcast):
///   CURVE_FACTORY_ADDRESS=0x1c34... forge script script/SetChunkyDefaults.s.sol \
///     --rpc-url $ROBINHOOD_RPC_URL --broadcast --private-key $DEPLOYER_PK --slow
///
/// Fork-test entrypoint: `runFor(address cf)` — call directly from a test.
contract SetChunkyDefaults is Script {
    uint256 internal constant DEFAULT_VIRT_ETH = 17 ether;
    uint256 internal constant DEFAULT_GRAD_ETH = 10 ether;

    error SetChunkyDefaults__NoCfEnv();
    error SetChunkyDefaults__ZeroCf();

    function run() external {
        address cfAddr;
        try vm.envAddress("CURVE_FACTORY_ADDRESS") returns (address a) {
            cfAddr = a;
        } catch {
            revert SetChunkyDefaults__NoCfEnv();
        }
        if (cfAddr == address(0)) revert SetChunkyDefaults__ZeroCf();

        uint256 virtEth = vm.envOr("VIRT_ETH", uint256(DEFAULT_VIRT_ETH));
        uint256 gradEth = vm.envOr("GRAD_ETH", uint256(DEFAULT_GRAD_ETH));

        vm.startBroadcast();
        _apply(cfAddr, virtEth, gradEth);
        vm.stopBroadcast();
    }

    /// Test entrypoint. `prankAs` becomes tx.origin/msg.sender for the setDefaults
    /// call — pass the CF owner.
    function runFor(
        address cfAddr,
        address prankAs
    ) external {
        vm.startPrank(prankAs);
        _apply(cfAddr, DEFAULT_VIRT_ETH, DEFAULT_GRAD_ETH);
        vm.stopPrank();
    }

    function _apply(
        address cfAddr,
        uint256 virtEth,
        uint256 gradEth
    ) internal {
        CurveFactory cf = CurveFactory(cfAddr);

        uint256 supply = cf.defaultCurveSupply();
        uint256 vTok = cf.defaultVirtualTokenReserve();
        uint16 feeBps = cf.defaultTradeFeeBps();
        uint256 oldVEth = cf.defaultVirtualEthReserve();
        uint256 oldGrad = cf.defaultGraduationTargetEth();

        console2.log("=========================================================");
        console2.log("SetChunkyDefaults on chain", block.chainid);
        console2.log("  CurveFactory        :", cfAddr);
        console2.log("  old virtEth (wei)   :", oldVEth);
        console2.log("  new virtEth (wei)   :", virtEth);
        console2.log("  old gradEth (wei)   :", oldGrad);
        console2.log("  new gradEth (wei)   :", gradEth);
        console2.log("  preserving supply   :", supply);
        console2.log("  preserving vToken   :", vTok);
        console2.log("  preserving feeBps   :", feeBps);
        console2.log("=========================================================");

        cf.setDefaults(supply, vTok, virtEth, gradEth, feeBps);

        // Post-condition sanity: read back from storage and confirm the write.
        require(cf.defaultVirtualEthReserve() == virtEth, "virt not applied");
        require(cf.defaultGraduationTargetEth() == gradEth, "grad not applied");
        require(cf.defaultCurveSupply() == supply, "supply drifted");
        require(cf.defaultVirtualTokenReserve() == vTok, "vTok drifted");
        require(cf.defaultTradeFeeBps() == feeBps, "feeBps drifted");
    }
}
