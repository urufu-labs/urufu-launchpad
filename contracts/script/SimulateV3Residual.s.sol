// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {GraduatorV3} from "src/curve/GraduatorV3.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

/// @title  SimulateV3Residual
/// @notice Forked (vm.createSelectFork) mainnet simulation of a realistic
///         graduation path - many small curve buys until target is crossed
///         - to measure V3's actual ETH residual under organic user behavior,
///         NOT the synthetic single-10.6-ETH buy the ChunkyModuleMatrix test
///         used to trigger 5.23 ETH dust.
///
///         Runs with `forge script ... --rpc-url $RH_RPC` (no --broadcast),
///         so no on-chain state changes. Prints residual per graduation to
///         stdout for comparison.
contract SimulateV3Residual is Script {
    address constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address constant V3 = 0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23;
    bytes32 constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    function run() external {
        // Realistic curve defaults are already active: 4.2 ETH target, 800M
        // supply, 17 ETH / 800M token virtual reserves, 1% fee.
        _simulate("SCENARIO A: single 4.2 ETH buy (just over target)", 4.3 ether);
        _simulate("SCENARIO B: single 4.5 ETH buy (7% overshoot)", 4.5 ether);
        _simulate("SCENARIO C: single 5 ETH buy (19% overshoot)", 5 ether);
        _simulate("SCENARIO D: single 6 ETH buy (43% overshoot)", 6 ether);
        _simulate("SCENARIO E: single 10 ETH buy (138% overshoot - unrealistic)", 10 ether);
    }

    function _simulate(
        string memory label,
        uint256 buyValue
    ) internal {
        console2.log("");
        console2.log("=======================================================");
        console2.log(label);
        console2.log("  buyValue (ETH x1e18):", buyValue);

        uint256 preBal = V3.balance;
        uint256 preClaim = GraduatorV3(payable(V3)).totalClaimable();

        // Fresh launcher + buyer per scenario
        address launcher = address(uint160(uint256(keccak256(abi.encode(label, "L")))));
        address buyer = address(uint160(uint256(keccak256(abi.encode(label, "B")))));
        vm.deal(launcher, 5 ether);
        vm.deal(buyer, buyValue + 1 ether);

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "SIM";
        p.ticker = "SIM";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(uint256(800_000_000e18), ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = Router(payable(ROUTER)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(ROUTER)).launch{value: fee}(p);

        // Buyer sends buyValue in one tx - this is the "large overshoot"
        // pattern from ChunkyModuleMatrix. Real graduations have many small
        // buys with only the last one crossing the threshold.
        address curve = CurveFactory(CURVE_FACTORY).curveFor(token);
        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: buyValue}(0);

        require(BondingCurve(payable(curve)).graduated(), "did not graduate");

        uint256 postBal = V3.balance;
        uint256 postClaim = GraduatorV3(payable(V3)).totalClaimable();
        uint256 residual = postBal - preBal;
        uint256 credited = postClaim - preClaim;

        console2.log("  V3.balance delta:      ", residual);
        console2.log("  totalClaimable delta:  ", credited);
        console2.log("  strand (bal-claim):    ", residual - credited);
        console2.log("  residual as % of buy:  ", (residual * 10_000) / buyValue, "bps");
    }
}
