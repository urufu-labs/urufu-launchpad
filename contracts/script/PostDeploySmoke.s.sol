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
///         addresses from `deployment.<chainid>.json`, launches:
///
///           1. ERC-20 with bonding curve — buy, quote a sell, sell back a slice
///           2. Bare ERC-721A — verify it deployed (no mint, keeps fee small)
///           3. Bare ERC-1155 — verify it deployed
///
///         Every step prints the resulting state so an operator can eyeball correctness
///         in the broadcast log. If a graduator is wired into CurveFactory, the ERC-20
///         curve is buy-flooded to trip the graduation target so the wire path exercises
///         end-to-end.
///
///         Runs as a broadcast script — the sender pays gas + a small amount of ETH per
///         launch. Use a funded wallet.
///
/// Usage:
///   forge script script/PostDeploySmoke.s.sol:PostDeploySmoke \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY -vvvv
///
/// Env vars:
///   SMOKE_GRADUATE=1  — force a graduation-target buy (requires a wired graduator; will
///                        cost ~5 ETH on default settings)
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
        console2.log("  Graduator:   ", cf.graduator());

        _smokeERC20(router, cf);
        _smokeERC721A(router);
        _smokeERC1155(router);

        console2.log("---------------------------------------------------------");
        console2.log("Smoke pass complete. All three base types deployed + traded.");
    }

    // ------------------------------------------------------------ ERC-20 + curve

    function _smokeERC20(
        Router router,
        CurveFactory cf
    ) internal {
        bytes32 bareCfg = keccak256(abi.encode("ERC20", ""));
        string memory tName = string.concat("Smoke20 ", vm.toString(block.number));
        string memory tTicker = string.concat("S20", vm.toString(uint256(block.number % 10_000)));

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
        console2.log("---------------------------------------------------------");
        console2.log("[1/3] ERC-20 + curve");
        console2.log("  Launch fee:  ", fee);

        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        address curveAddr = cf.curveFor(token);
        BondingCurve curve = BondingCurve(payable(curveAddr));

        console2.log("  Launched:    ", token);
        console2.log("  Symbol:      ", IERC20View(token).symbol());
        console2.log("  Curve:       ", curveAddr);
        console2.log("  curve balance:", IERC20View(token).balanceOf(curveAddr));

        // Buy → sell round-trip so we exercise BOTH sides of the curve, not just buy.
        uint256 buyAmount = 0.01 ether;
        console2.log("  buying     :  ", buyAmount);
        uint256 tokensOut = curve.buy{value: buyAmount}(0);
        console2.log("  bought     :  ", tokensOut);

        // Sell half of what we just bought.
        uint256 sellIn = tokensOut / 2;
        (uint256 sellQuote,) = curve.quoteSell(sellIn);
        console2.log("  quote sell :  ", sellQuote);
        IERC20View(token); // silence unused warning if ever removed
        _approveAll(token, curveAddr, sellIn);
        uint256 ethOut = curve.sell(sellIn, 0);
        console2.log("  sold       :  ", sellIn);
        console2.log("  eth out    :  ", ethOut);

        // Optional: buy up to the graduation target to exercise the graduator wire path.
        if (vm.envOr("SMOKE_GRADUATE", uint256(0)) == 1 && cf.graduator() != address(0)) {
            uint256 target = curve.graduationTargetEth();
            uint256 have = curve.ethReserve();
            if (target > have) {
                uint256 needed = (target - have) * 12 / 10; // 20% cushion for fees
                console2.log("  graduating :  buying", needed, "wei");
                curve.buy{value: needed}(0);
                console2.log("  graduated? :  ", curve.graduated());
            }
        }
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------- ERC-721A (bare)

    function _smokeERC721A(
        Router router
    ) internal {
        bytes32 bareCfg = keccak256(abi.encode("ERC721A", ""));
        string memory tName = string.concat("Smoke721A ", vm.toString(block.number));
        string memory tTicker = string.concat("SNFT", vm.toString(uint256(block.number % 10_000)));

        // ERC-721A initData shape: (baseURI, maxSupply, modules[]) — matches PhaseCombosTest
        // and DeployPhase1's BARE_ERC721A_CONFIG registration.
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC721A,
            name: tName,
            ticker: tTicker,
            configHash: bareCfg,
            initData: abi.encode(string("ipfs://smoke/"), uint256(10_000), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });

        uint256 fee = router.quote(p);
        console2.log("---------------------------------------------------------");
        console2.log("[2/3] ERC-721A (bare)");
        console2.log("  Launch fee:  ", fee);

        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        vm.stopBroadcast();
        console2.log("  Launched:    ", token);
    }

    // ---------------------------------------------------------- ERC-1155 (bare)

    function _smokeERC1155(
        Router router
    ) internal {
        bytes32 bareCfg = keccak256(abi.encode("ERC1155", ""));
        string memory tName = string.concat("Smoke1155 ", vm.toString(block.number));
        string memory tTicker = string.concat("S1155", vm.toString(uint256(block.number % 10_000)));

        // ERC-1155 initData shape: (uri, modules[]) — matches PhaseCombosTest.
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC1155,
            name: tName,
            ticker: tTicker,
            configHash: bareCfg,
            initData: abi.encode(string("ipfs://smoke/{id}.json"), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });

        uint256 fee = router.quote(p);
        console2.log("---------------------------------------------------------");
        console2.log("[3/3] ERC-1155 (bare)");
        console2.log("  Launch fee:  ", fee);

        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        vm.stopBroadcast();
        console2.log("  Launched:    ", token);
    }

    /// @dev Broadcast-scoped IERC20.approve — called inside a startBroadcast/stopBroadcast
    ///      pair so the tx is signed by the same key.
    function _approveAll(
        address token,
        address spender,
        uint256 amount
    ) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok, "approve failed");
    }
}
