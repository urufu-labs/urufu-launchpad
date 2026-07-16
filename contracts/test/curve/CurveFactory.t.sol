// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

contract MockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract CurveFactoryTest is Test {
    BondingCurve internal impl;
    CurveFactory internal factory;
    MockToken internal token;

    address internal owner = makeAddr("owner");
    address internal feeReceiver = makeAddr("feeReceiver");
    address internal launcher = makeAddr("launcher");

    function setUp() public {
        impl = new BondingCurve();
        factory = new CurveFactory(owner, feeReceiver, address(impl));
        token = new MockToken();
        token.mint(launcher, factory.defaultCurveSupply());
    }

    function test_Init_StoresConfig() public view {
        assertEq(factory.implementation(), address(impl));
        assertEq(factory.feeReceiver(), feeReceiver);
        assertEq(factory.owner(), owner);
        assertEq(factory.defaultCurveSupply(), 800_000_000e18);
    }

    function test_CreateCurve_DeploysAndFunds() public {
        vm.prank(launcher);
        token.approve(address(factory), type(uint256).max);
        vm.prank(launcher);
        address curveAddr = factory.createCurve(address(token));

        assertTrue(curveAddr != address(0));
        assertEq(factory.curveFor(address(token)), curveAddr);
        assertEq(token.balanceOf(curveAddr), factory.defaultCurveSupply());

        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(c.token(), address(token));
        assertEq(c.feeReceiver(), feeReceiver);
        assertEq(c.tokenReserve(), factory.defaultCurveSupply());
    }

    function test_CreateCurve_RevertsOnDuplicate() public {
        vm.prank(launcher);
        token.approve(address(factory), type(uint256).max);
        vm.prank(launcher);
        factory.createCurve(address(token));

        token.mint(launcher, factory.defaultCurveSupply());
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(CurveFactory.CurveFactory__CurveExists.selector, address(token)));
        factory.createCurve(address(token));
    }

    /// V2 CurveFactory pulls the launcher's ACTUAL balance (whatever's left after
    /// reserve modules carved out their share), not a hardcoded defaultCurveSupply.
    /// If the launcher has 0 tokens after modules ate the whole supply, we still
    /// revert loudly with NotEnoughSupply — no zero-supply curves. If they have
    /// SOME tokens but haven't approved the factory to transfer them, the underlying
    /// safeTransferFrom reverts with TransferFromFailed. Both are legit fail modes.
    function test_CreateCurve_RevertsWhenLauncherHasZeroBalance() public {
        MockToken poor = new MockToken();
        // No mint to launcher at all — balance is 0.
        vm.expectRevert(
            abi.encodeWithSelector(CurveFactory.CurveFactory__NotEnoughSupply.selector, factory.defaultCurveSupply(), 0)
        );
        vm.prank(launcher);
        factory.createCurve(address(poor));
    }

    function test_PredictAddress_MatchesActual() public {
        address predicted = factory.predictCurveAddress(address(token));
        vm.prank(launcher);
        token.approve(address(factory), type(uint256).max);
        vm.prank(launcher);
        address actual = factory.createCurve(address(token));
        assertEq(predicted, actual);
    }

    function test_SetDefaults_OnlyOwner() public {
        vm.expectRevert();
        factory.setDefaults(1e18, 1e18, 1e18, 1e18, 100);

        vm.prank(owner);
        factory.setDefaults(500_000_000e18, 100_000_000e18, 0.5 ether, 10 ether, 50);
        assertEq(factory.defaultCurveSupply(), 500_000_000e18);
        assertEq(factory.defaultTradeFeeBps(), 50);
    }

    function test_SetFeeReceiver_OnlyOwner() public {
        vm.expectRevert();
        factory.setFeeReceiver(launcher);

        vm.prank(owner);
        factory.setFeeReceiver(launcher);
        assertEq(factory.feeReceiver(), launcher);
    }
}
