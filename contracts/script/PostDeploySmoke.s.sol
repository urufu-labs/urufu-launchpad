// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC20View {
    function balanceOf(
        address
    ) external view returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

/// @notice Real end-to-end smoke test against a freshly broadcast Phase 1 stack. Reads
///         addresses from `deployment.<chainid>.json`, launches a bonding-curve token,
///         buys against the curve, sells back, and prints the resulting state.
///
///         Runs as a broadcast script — the sender pays gas + a small amount of ETH for
///         the launch fee + a test buy. Use a funded wallet.
///
/// Usage:
///   forge script script/PostDeploySmoke.s.sol:PostDeploySmoke \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY -vvvv
contract PostDeploySmoke is Script {
    function run() external {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        require(vm.exists(path), "no address book -- run DeployPhase1 first");
        string memory book = vm.readFile(path);

        Router router = Router(payable(vm.parseJsonAddress(book, ".Router")));
        CurveFactory cf = CurveFactory(vm.parseJsonAddress(book, ".CurveFactory"));

        console2.log("=========================================================");
        console2.log("Post-deploy smoke test");
        console2.log("=========================================================");
        console2.log("  Router:      ", address(router));
        console2.log("  CurveFactory:", address(cf));

        bytes32 bareCfg = keccak256(abi.encode("ERC20", ""));

        // Use a deterministic name+ticker per block so re-runs don't collide with prior tests.
        string memory tName = string.concat("Smoke ", vm.toString(block.number));
        string memory tTicker = string.concat("SM", vm.toString(uint256(block.number % 10_000)));

        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: tName,
            ticker: tTicker,
            configHash: bareCfg,
            initData: abi.encode(cf.defaultCurveSupply(), address(router), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0)
        });

        uint256 fee = router.quote(p);
        console2.log("  Launch fee:  ", fee);

        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        address curve = cf.curveFor(token);

        console2.log("---------------------------------------------------------");
        console2.log("Launched token:", token);
        console2.log("  name:  ", IERC20View(token).name());
        console2.log("  sym:   ", IERC20View(token).symbol());
        console2.log("Curve:", curve);
        console2.log("  curve balance:", IERC20View(token).balanceOf(curve));

        // Buy a tiny slice.
        uint256 buyAmount = 0.01 ether;
        console2.log("---------------------------------------------------------");
        console2.log("Buying", buyAmount, "wei ETH");
        BondingCurve(payable(curve)).buy{value: buyAmount}(0);
        console2.log("  bought tokens balance:", IERC20View(token).balanceOf(msg.sender));
        console2.log("  curve ethReserve:    ", BondingCurve(payable(curve)).ethReserve());
        console2.log("  curve tokenReserve:  ", BondingCurve(payable(curve)).tokenReserve());
        vm.stopBroadcast();

        console2.log("---------------------------------------------------------");
        console2.log("Smoke test passed. Open /trade/", token);
        console2.log("in the web app to see the live chart.");
    }
}
