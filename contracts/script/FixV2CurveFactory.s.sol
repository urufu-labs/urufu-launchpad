// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";

interface IRouter {
    function setCurveFactory(
        address factory
    ) external;
    function curveFactory() external view returns (address);
}

/// @title  FixV2CurveFactory
/// @notice Chain-agnostic hotfix: the V2 CurveFactories on every chain were pointing at
///         V1 BondingCurve impls (deployed months ago, before I added the `launcher`
///         field to BondingCurve.initialize). V2 CF calls initialize with 11 args but
///         V1 impl has 10 — every V2 launch reverted with a selector mismatch inside
///         the delegatecall. Caught by BaseForkV2E2E.t.sol before any real launcher
///         hit this.
///
///         This script:
///           1. Deploys a fresh BondingCurve V2 impl (with the launcher field) — same
///              behavior as V1 for non-reserve launches, adds launcher storage +
///              getter so V2 CurveFactory's initialize(..., launcher) matches.
///           2. Deploys a fresh CurveFactory pointing at the new V2 impl.
///           3. Copies defaults + feeReceiver + graduator from the broken V2 CF.
///           4. Router.setCurveFactory(new CF).
///
///         Broken V2 CF stays deployed (nothing points at it) — no cleanup needed.
///         ERC20Factory template registrations are unaffected. Any curve that
///         already exists (TEST, BALLS) keeps working — they're clones from OLD V1
///         CurveFactory's impl, unrelated to this hotfix.
///
/// Env vars (per chain, passed by deploy.sh):
///   EXISTING_ROUTER          — Router address on this chain (required)
///   BROKEN_V2_CURVE_FACTORY  — the V2 CF that has the wrong BondingCurve impl
///   EXISTING_FEE_RECEIVER    — FeeReceiver address
///   EXISTING_GRADUATOR       — V3 Graduator to wire into the new CF
///
/// Broadcast:
///   bash contracts/deploy.sh FixV2CurveFactory <chain>
contract FixV2CurveFactory is Script {
    function run() external returns (address newBondingCurveImpl, address newCurveFactory) {
        address router = vm.envAddress("EXISTING_ROUTER");
        address brokenCf = vm.envAddress("BROKEN_V2_CURVE_FACTORY");
        address feeReceiver = vm.envAddress("EXISTING_FEE_RECEIVER");
        address graduator = vm.envAddress("EXISTING_GRADUATOR");

        // Copy every default from the broken CF so behavior stays identical (curve
        // supply, virtual reserves, grad target, trade-fee bps — all preserved).
        CurveFactory broken = CurveFactory(brokenCf);
        uint256 curveSupply = broken.defaultCurveSupply();
        uint256 virtualToken = broken.defaultVirtualTokenReserve();
        uint256 virtualEth = broken.defaultVirtualEthReserve();
        uint256 gradTarget = broken.defaultGraduationTargetEth();
        uint16 tradeFeeBps = broken.defaultTradeFeeBps();

        vm.startBroadcast();

        // 1. Deploy V2 BondingCurve impl — has `launcher` field so V2 CF's
        //    initialize(..., launcher) call succeeds.
        newBondingCurveImpl = address(new BondingCurve());

        // 2. Deploy new CurveFactory pointing at V2 BondingCurve. Ctor:
        //    (owner, feeReceiver, curveImpl).
        newCurveFactory = address(new CurveFactory(msg.sender, feeReceiver, newBondingCurveImpl));
        CurveFactory fixed_ = CurveFactory(newCurveFactory);
        fixed_.setDefaults(curveSupply, virtualToken, virtualEth, gradTarget, tradeFeeBps);
        fixed_.setGraduator(graduator);

        // 3. Point Router at the fixed CF. Every launch from this tx forward uses
        //    the correct V2 BondingCurve impl via the correct V2 CurveFactory.
        IRouter(router).setCurveFactory(newCurveFactory);

        vm.stopBroadcast();

        console2.log("=========================================================");
        console2.log("V2 CurveFactory hotfix broadcast");
        console2.log("=========================================================");
        console2.log("  chainid:                    ", block.chainid);
        console2.log("  broken V2 CF (abandoned):   ", brokenCf);
        console2.log("  new BondingCurve V2 impl:   ", newBondingCurveImpl);
        console2.log("  new fixed CurveFactory:     ", newCurveFactory);
        console2.log("  V3 Graduator wired:         ", graduator);
        console2.log("  Router.curveFactory now:    ", IRouter(router).curveFactory());

        // Persist for sync-addresses / manual inspection.
        string memory obj = "fixCf";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "BondingCurveV2Impl", newBondingCurveImpl);
        string memory json = vm.serializeAddress(obj, "CurveFactoryV2Fixed", newCurveFactory);
        string memory path = string.concat("deployment-fixcf.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
