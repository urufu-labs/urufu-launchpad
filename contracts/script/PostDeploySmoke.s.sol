// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC20SmokeView {
    function balanceOf(
        address
    ) external view returns (uint256);
    function symbol() external view returns (string memory);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @notice Broadcast smoke for a freshly deployed rehearsal stack. Reads
///         `deployment.<chainid>.json`, calls Router.launchAndBuy on the bare
///         ERC20 curve path, then sells half of the purchased tokens back.
contract PostDeploySmoke is Script {
    bytes32 internal constant BARE_ERC20 = keccak256(abi.encode("ERC20", ""));

    function run() external {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        require(vm.exists(path), "no address book -- run DeployFreshLocal first");
        string memory book = vm.readFile(path);

        Router router = Router(payable(vm.parseJsonAddress(book, ".Router")));
        CurveFactory cf = CurveFactory(vm.parseJsonAddress(book, ".CurveFactory"));

        console2.log("=========================================================");
        console2.log("Post-deploy launchAndBuy smoke");
        console2.log("=========================================================");
        console2.log("  Router       :", address(router));
        console2.log("  CurveFactory :", address(cf));
        console2.log("  Graduator    :", cf.graduator());

        _smokeERC20(router, cf);

        console2.log("---------------------------------------------------------");
        console2.log("Smoke pass complete. ERC20 launch, buy, approve, and sell succeeded.");
    }

    function _smokeERC20(
        Router router,
        CurveFactory cf
    ) internal {
        string memory tName = string.concat("Smoke20 ", vm.toString(block.number));
        string memory tTicker = string.concat("S20", vm.toString(uint256(block.number % 10_000)));

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = tName;
        p.ticker = tTicker;
        p.configHash = BARE_ERC20;
        p.initData = abi.encode(cf.defaultCurveSupply(), address(router), new bytes[](0));
        p.moduleCount = 0;
        p.installHook = false;
        p.installGovernance = false;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        uint256 fee = router.quote(p);
        uint256 buyAmount = vm.envOr("SMOKE_BUY_WEI", uint256(0.001 ether));
        require(buyAmount > 0, "SMOKE_BUY_WEI must be > 0");

        console2.log("---------------------------------------------------------");
        console2.log("[1/1] ERC20 curve launchAndBuy");
        console2.log("  Launch fee   :", fee);
        console2.log("  Initial buy  :", buyAmount);

        vm.startBroadcast();
        address token = router.launchAndBuy{value: fee + buyAmount}(p, buyAmount, 0, msg.sender);
        address curveAddr = cf.curveFor(token);
        BondingCurve curve = BondingCurve(payable(curveAddr));

        console2.log("  Launched     :", token);
        console2.log("  Symbol       :", IERC20SmokeView(token).symbol());
        console2.log("  Curve        :", curveAddr);
        console2.log("  ETH reserve  :", curve.ethReserve());

        uint256 bought = IERC20SmokeView(token).balanceOf(msg.sender);
        console2.log("  Bought tokens:", bought);
        uint256 sellIn = bought / 2;
        require(sellIn > 0, "buy returned too few tokens to sell");
        (uint256 sellQuote,) = curve.quoteSell(sellIn);
        console2.log("  Quote sell   :", sellQuote);
        require(IERC20SmokeView(token).approve(curveAddr, sellIn), "approve failed");
        uint256 ethOut = curve.sell(sellIn, 0);
        console2.log("  Sold tokens  :", sellIn);
        console2.log("  ETH out      :", ethOut);

        if (vm.envOr("SMOKE_GRADUATE", uint256(0)) == 1 && cf.graduator() != address(0)) {
            uint256 target = curve.graduationTargetEth();
            uint256 have = curve.ethReserve();
            if (target > have) {
                uint256 needed = ((target - have) * 12) / 10;
                console2.log("  Graduating buy:", needed);
                curve.buy{value: needed}(0);
            }
            console2.log("  Graduated?   :", curve.graduated());
        }
        vm.stopBroadcast();
    }
}
