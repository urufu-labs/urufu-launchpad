// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";

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

/// Mock swap router — takes ETH in, credits `uru` out to `to`.
contract MockSwapRouter {
    MockUru public immutable uru;
    uint256 public constant RATE = 1000; // 1 ETH → 1000 URU

    constructor(
        MockUru _uru
    ) {
        uru = _uru;
    }

    function swap(
        address to
    ) external payable {
        uint256 out = msg.value * RATE;
        uru.mint(to, out);
    }
}

contract UruBuybackVaultTest is Test {
    UruBuybackVault internal vault;
    MockUru internal uru;
    MockSwapRouter internal swapRouter;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal distribution = makeAddr("distribution");

    function setUp() public {
        uru = new MockUru();
        vault = new UruBuybackVault(owner, address(uru), distribution);
        swapRouter = new MockSwapRouter(uru);
        vm.deal(address(this), 100 ether);
    }

    function test_Init_Stored() public view {
        assertEq(address(vault.uru()), address(uru));
        assertEq(vault.distributionSink(), distribution);
    }

    function test_Receive_LogsIt() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_ExecuteBuyback_HappyPath() public {
        (bool ok,) = address(vault).call{value: 2 ether}("");
        assertTrue(ok);

        vm.prank(owner);
        vault.setKeeper(keeper, true);
        vm.prank(owner);
        vault.setSwapTarget(address(swapRouter), true);

        bytes memory swapData = abi.encodeCall(MockSwapRouter.swap, (address(vault)));

        vm.prank(keeper);
        vault.executeBuyback(address(swapRouter), 2 ether, swapData, 1000e18);

        assertEq(uru.balanceOf(distribution), 2000e18);
        assertEq(uru.balanceOf(address(vault)), 0);
    }

    function test_ExecuteBuyback_RevertsOnNonKeeper() public {
        (bool ok,) = address(vault).call{value: 2 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vault.setSwapTarget(address(swapRouter), true);
        vm.expectRevert(UruBuybackVault.UruBuybackVault__NotKeeper.selector);
        vault.executeBuyback(address(swapRouter), 2 ether, "", 0);
    }

    function test_ExecuteBuyback_RevertsOnUnallowedTarget() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vault.setKeeper(keeper, true);

        vm.expectRevert(
            abi.encodeWithSelector(UruBuybackVault.UruBuybackVault__TargetNotAllowed.selector, address(swapRouter))
        );
        vm.prank(keeper);
        vault.executeBuyback(address(swapRouter), 1 ether, "", 0);
    }

    function test_ExecuteBuyback_RevertsOnSlippage() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(owner);
        vault.setKeeper(keeper, true);
        vm.prank(owner);
        vault.setSwapTarget(address(swapRouter), true);

        bytes memory swapData = abi.encodeCall(MockSwapRouter.swap, (address(vault)));

        vm.expectRevert(
            abi.encodeWithSelector(UruBuybackVault.UruBuybackVault__SlippageExceeded.selector, 1000e18, 2000e18)
        );
        vm.prank(keeper);
        vault.executeBuyback(address(swapRouter), 1 ether, swapData, 2000e18);
    }

    function test_SetDistributionSink_OwnerOnly() public {
        vm.expectRevert();
        vault.setDistributionSink(address(1));
        vm.prank(owner);
        vault.setDistributionSink(address(1));
        assertEq(vault.distributionSink(), address(1));
    }
}
