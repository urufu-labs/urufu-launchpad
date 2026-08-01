// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {FeeReceiver} from "src/router/FeeReceiver.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

contract ProbeToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Probe";
    }

    function symbol() public pure override returns (string memory) {
        return "PRB";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @title  RhForkBalanceCheck
/// @notice Isolates a discrepancy seen only when driving the graduation flow
///         through an `anvil --fork-url <robinhood>` node: the buyer's entire
///         ETH balance reads as zero after the graduation-triggering buy, while
///         the very same script against an Ethereum-mainnet fork deducts exactly
///         the buy amount. The resulting v4 pool is byte-identical across both
///         (same sqrtPriceX96, tick, liquidity, burn residue), which already
///         suggests the contracts are fine and the node is not.
///
///         This test runs the same graduation against Robinhood via Foundry's
///         own fork backend — no anvil in the path. If the buyer's balance moves
///         by exactly the buy amount here, the zeroing is an anvil fork-caching
///         artifact on the Arbitrum-stack chain, not a contract defect.
contract RhForkBalanceCheck is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    uint160 internal constant MHH_FLAGS = 0x22C4;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    address internal admin = makeAddr("probe-admin");
    address internal buyer = makeAddr("probe-buyer");
    address internal launcher = makeAddr("probe-launcher");

    CurveFactory internal curveFactory;
    GraduatorV2 internal graduator;
    MultiHookHost internal mhh;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        require(RH_POOL_MANAGER.code.length > 0, "no v4 PoolManager on this fork");

        FeeReceiver feeReceiver = new FeeReceiver(admin);
        BondingCurve curveImpl = new BondingCurve();
        curveFactory = new CurveFactory(admin, address(feeReceiver), address(curveImpl));

        address hookAddr = address((uint160(0xBEEF) << 144) | MHH_FLAGS);
        deployCodeTo(
            "MultiHookHost.sol:MultiHookHost",
            abi.encode(IPoolManager(RH_POOL_MANAGER), address(feeReceiver), admin, uint16(100), uint16(100), admin),
            hookAddr
        );
        mhh = MultiHookHost(payable(hookAddr));

        graduator =
            new GraduatorV2(IPoolManager(RH_POOL_MANAGER), IHooks(hookAddr), 3000, 60, address(curveFactory), admin);

        vm.prank(admin);
        mhh.setInitializer(address(graduator));
        vm.prank(admin);
        curveFactory.setGraduator(address(graduator));
        vm.prank(admin);
        curveFactory.setTrustedRouter(address(this), true);
    }

    function test_BuyerBalanceMovesByExactlyTheBuyAmount() public {
        ProbeToken token = new ProbeToken();
        uint256 supply = curveFactory.defaultCurveSupply();
        token.mint(address(this), supply);
        token.approve(address(curveFactory), supply);
        BondingCurve curve =
            BondingCurve(payable(curveFactory.createCurveWithConfigFor(address(token), 0, 0, launcher)));

        vm.deal(buyer, 100 ether);

        // Warm-up buy, well short of the graduation target.
        uint256 balBefore = buyer.balance;
        vm.prank(buyer);
        curve.buy{value: 1 ether}(0);
        assertEq(balBefore - buyer.balance, 1 ether, "warm-up buy did not deduct exactly 1 ETH");
        assertFalse(curve.graduated(), "graduated too early");

        // The graduation-triggering buy — the exact call that zeroed the wallet
        // when driven through an anvil Robinhood fork.
        uint256 remaining = curve.graduationTargetEth() - curve.ethReserve();
        uint256 finalBuy = (remaining * 115) / 100;

        uint256 balBeforeGrad = buyer.balance;
        vm.prank(buyer);
        curve.buy{value: finalBuy}(0);

        assertTrue(curve.graduated(), "curve did not graduate");
        assertEq(balBeforeGrad - buyer.balance, finalBuy, "graduation buy moved more than the buy amount");
        assertGt(buyer.balance, 0, "buyer wallet was zeroed by the graduation buy");

        console2.log("buyer balance before grad :", balBeforeGrad);
        console2.log("buyer balance after  grad :", buyer.balance);
        console2.log("delta                     :", balBeforeGrad - buyer.balance);
        console2.log("graduator resting ETH     :", address(graduator).balance);
    }
}
