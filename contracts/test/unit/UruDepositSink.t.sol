// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {UruDepositSink} from "src/router/UruDepositSink.sol";

contract MockUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// Mock swap target — takes URU in via `transferFrom(sink, this, uruIn)`, sends
/// ETH out at a fixed 1 URU = 0.001 ETH rate. Exercises the same call shape as
/// a real UR swap (opaque calldata, allowance-based pull, ETH refund).
contract MockSwapTarget {
    MockUru public immutable uru;
    uint256 public constant RATE_NUM = 1; // 1 URU → 0.001 ETH
    uint256 public constant RATE_DEN = 1000;

    constructor(
        MockUru _uru
    ) {
        uru = _uru;
    }

    function swap(
        uint256 uruIn
    ) external {
        uru.transferFrom(msg.sender, address(this), uruIn);
        uint256 ethOut = (uruIn * RATE_NUM) / RATE_DEN;
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth send failed");
    }

    receive() external payable {}
}

contract UruDepositSinkTest is Test {
    UruDepositSink internal sink;
    MockUru internal uru;
    MockSwapTarget internal swapTarget;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal distribution = makeAddr("distribution");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        uru = new MockUru();
        sink = new UruDepositSink(owner, address(uru), distribution);
        swapTarget = new MockSwapTarget(uru);
        // Prefund the swap target with ETH so it can pay out ETH proceeds.
        vm.deal(address(swapTarget), 100 ether);
    }

    function test_Init_Stored() public view {
        assertEq(address(sink.uru()), address(uru));
        assertEq(sink.distributionSink(), distribution);
        assertEq(sink.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroAddress.selector);
        new UruDepositSink(address(0), address(uru), distribution);
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroAddress.selector);
        new UruDepositSink(owner, address(0), distribution);
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroAddress.selector);
        new UruDepositSink(owner, address(uru), address(0));
    }

    function test_Deposit_PullsURU() public {
        uru.mint(depositor, 500e18);
        vm.startPrank(depositor);
        uru.approve(address(sink), 500e18);
        sink.deposit(300e18);
        vm.stopPrank();
        assertEq(uru.balanceOf(address(sink)), 300e18);
    }

    function test_Deposit_RevertsOnZero() public {
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroSwap.selector);
        sink.deposit(0);
    }

    function test_ExecuteConversion_HappyPath() public {
        // Push 1000 URU into the sink (as if RouterV2 did it via transferFrom).
        uru.mint(address(sink), 1000e18);

        vm.prank(owner);
        sink.setKeeper(keeper, true);
        vm.prank(owner);
        sink.setSwapTarget(address(swapTarget), true);

        bytes memory swapData = abi.encodeCall(MockSwapTarget.swap, (1000e18));

        uint256 distBefore = distribution.balance;
        vm.prank(keeper);
        sink.executeConversion(address(swapTarget), 1000e18, swapData, 1 ether);

        // 1000 URU * 0.001 ETH/URU = 1 ETH — all forwarded to distribution.
        assertEq(distribution.balance - distBefore, 1 ether);
        assertEq(address(sink).balance, 0);
        // Allowance cleared post-swap to prevent residual drain.
        assertEq(uru.allowance(address(sink), address(swapTarget)), 0);
    }

    function test_ExecuteConversion_RevertsOnNonKeeper() public {
        uru.mint(address(sink), 1000e18);
        vm.prank(owner);
        sink.setSwapTarget(address(swapTarget), true);
        vm.expectRevert(UruDepositSink.UruDepositSink__NotKeeper.selector);
        sink.executeConversion(address(swapTarget), 1000e18, "", 0);
    }

    function test_ExecuteConversion_RevertsOnUnallowedTarget() public {
        uru.mint(address(sink), 1000e18);
        vm.prank(owner);
        sink.setKeeper(keeper, true);
        vm.expectRevert(
            abi.encodeWithSelector(UruDepositSink.UruDepositSink__TargetNotAllowed.selector, address(swapTarget))
        );
        vm.prank(keeper);
        sink.executeConversion(address(swapTarget), 1000e18, "", 0);
    }

    function test_ExecuteConversion_RevertsOnZeroSwap() public {
        vm.prank(owner);
        sink.setKeeper(keeper, true);
        vm.prank(owner);
        sink.setSwapTarget(address(swapTarget), true);
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroSwap.selector);
        vm.prank(keeper);
        sink.executeConversion(address(swapTarget), 0, "", 0);
    }

    function test_ExecuteConversion_RevertsOnSlippage() public {
        uru.mint(address(sink), 1000e18);
        vm.prank(owner);
        sink.setKeeper(keeper, true);
        vm.prank(owner);
        sink.setSwapTarget(address(swapTarget), true);
        bytes memory swapData = abi.encodeCall(MockSwapTarget.swap, (1000e18));
        // Actual ETH out is 1 ether at the mock rate; require 2 → slippage revert.
        vm.expectRevert(
            abi.encodeWithSelector(UruDepositSink.UruDepositSink__SlippageExceeded.selector, 1 ether, 2 ether)
        );
        vm.prank(keeper);
        sink.executeConversion(address(swapTarget), 1000e18, swapData, 2 ether);
    }

    function test_SetKeeper_OwnerOnly() public {
        vm.expectRevert();
        sink.setKeeper(keeper, true);
        vm.prank(owner);
        sink.setKeeper(keeper, true);
        assertTrue(sink.isKeeper(keeper));
    }

    function test_SetSwapTarget_OwnerOnly() public {
        vm.expectRevert();
        sink.setSwapTarget(address(swapTarget), true);
        vm.prank(owner);
        sink.setSwapTarget(address(swapTarget), true);
        assertTrue(sink.isSwapTarget(address(swapTarget)));
    }

    function test_SetDistributionSink_OwnerOnly() public {
        vm.expectRevert();
        sink.setDistributionSink(address(1));
        vm.prank(owner);
        sink.setDistributionSink(address(1));
        assertEq(sink.distributionSink(), address(1));
    }

    function test_SetDistributionSink_RevertsOnZero() public {
        vm.expectRevert(UruDepositSink.UruDepositSink__ZeroAddress.selector);
        vm.prank(owner);
        sink.setDistributionSink(address(0));
    }

    function test_FlushEth_ForwardsToDistribution() public {
        // Directly send ETH to sink (bypasses the swap path)
        vm.deal(address(sink), 3 ether);
        uint256 distBefore = distribution.balance;
        vm.prank(owner);
        sink.flushEth();
        assertEq(distribution.balance - distBefore, 3 ether);
        assertEq(address(sink).balance, 0);
    }
}
