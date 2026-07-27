// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface INameRegistryRead {
    function isNameAvailable(
        string calldata name
    ) external view returns (bool);
    function isTickerAvailable(
        string calldata ticker
    ) external view returns (bool);
}

interface IERC20Like {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function owner() external view returns (address);
}

/// @title  V6SmokeLaunch
/// @notice One-shot bare-ERC20 launch through the newly-deployed V6 Router.
///         Proves the full path: fee quote → factory.deploy → NameRegistry
///         reservation → ownership dispatch → Launched event. Ownership is
///         KeepEOA so the deployer keeps the token afterwards.
///
///         Costs: launch fee (1e15 wei) + gas ~0.001 ETH total.
///
/// Env vars (required):
///   V6_ROUTER_V2                deployed V6 RouterV2 (0x2dfA...)
///   NAME_REGISTRY               live NameRegistry
///   SMOKE_NAME                  optional, defaults to "V6 Smoke Test"
///   SMOKE_TICKER                optional, defaults to "V6SMOKE"
contract V6SmokeLaunch is Script {
    function run() external {
        address v6 = vm.envAddress("V6_ROUTER_V2");
        address nrAddr = vm.envAddress("NAME_REGISTRY");

        string memory launchName = vm.envOr("SMOKE_NAME", string("V6 Smoke Test"));
        string memory launchTicker = vm.envOr("SMOKE_TICKER", string("V6SMOKE"));

        // Pre-flight: ensure name + ticker aren't already taken.
        require(INameRegistryRead(nrAddr).isNameAvailable(launchName), "name taken - pick a different SMOKE_NAME");
        require(
            INameRegistryRead(nrAddr).isTickerAvailable(launchTicker), "ticker taken - pick a different SMOKE_TICKER"
        );

        RouterV2 router = RouterV2(payable(v6));

        // Bare-ERC20 initData: (uint256 initialSupply, address initialRecipient, bytes[] moduleData)
        // 1M supply to deployer, no modules.
        bytes memory initData = abi.encode(uint256(1_000_000e18), msg.sender, new bytes[](0));

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = launchName;
        p.ticker = launchTicker;
        p.configHash = keccak256(abi.encode("ERC20", ""));
        p.initData = initData;
        p.moduleCount = 1;
        p.installHook = false;
        p.installGovernance = false;
        p.installBondingCurve = false;
        p.ownership = OwnershipMode.KeepEOA;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        uint256 fee = router.quote(p);
        console2.log("Launch fee (wei):", fee);

        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        vm.stopBroadcast();

        require(token != address(0), "smoke launch: token address is zero");
        require(token.code.length > 0, "smoke launch: token has no code");
        require(IERC20Like(token).totalSupply() == 1_000_000e18, "smoke launch: totalSupply mismatch");
        require(
            IERC20Like(token).balanceOf(msg.sender) == 1_000_000e18, "smoke launch: deployer balance != full supply"
        );
        require(IERC20Like(token).owner() == msg.sender, "smoke launch: ownership dispatch did not target deployer");

        console2.log("=========================================================");
        console2.log("V6 smoke launch SUCCESSFUL");
        console2.log("=========================================================");
        console2.log("  Token address:", token);
        console2.log("  Name:         ", IERC20Like(token).name());
        console2.log("  Symbol:       ", IERC20Like(token).symbol());
        console2.log("  Total supply: ", IERC20Like(token).totalSupply());
        console2.log("  Owner:        ", IERC20Like(token).owner());
    }
}
