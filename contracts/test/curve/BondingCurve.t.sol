// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";

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

contract BondingCurveTest is Test {
    BondingCurve internal impl;
    BondingCurve internal curve;
    MockToken internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeReceiver = makeAddr("feeReceiver");

    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether; // low target so graduation tests fit
    uint16 internal constant FEE_BPS = 100;

    function setUp() public {
        impl = new BondingCurve();
        curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token = new MockToken();
        token.mint(address(curve), CURVE_SUPPLY);

        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(0),
            0,
            0
        );

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function test_Init_StoresParams() public view {
        assertEq(curve.token(), address(token));
        assertEq(curve.tokenReserve(), CURVE_SUPPLY);
        assertEq(curve.ethReserve(), 0);
        assertEq(curve.graduationTargetEth(), GRAD_TARGET);
        assertFalse(curve.graduated());
    }

    function test_Init_RevertsOnDoubleInit() public {
        vm.expectRevert(BondingCurve.BondingCurve__AlreadyInitialized.selector);
        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(0),
            0,
            0
        );
    }

    function test_Buy_HappyPath() public {
        (uint256 quoteOut, uint256 quoteFee) = curve.quoteBuy(0.1 ether);
        assertGt(quoteOut, 0);
        assertEq(quoteFee, 0.001 ether);

        vm.prank(alice);
        uint256 tokensOut = curve.buy{value: 0.1 ether}(0);

        assertEq(tokensOut, quoteOut);
        assertEq(token.balanceOf(alice), tokensOut);
        assertEq(curve.ethReserve(), 0.099 ether); // after 1% fee
        assertEq(feeReceiver.balance, 0.001 ether);
    }

    function test_Buy_PriceMovesUp() public {
        uint256 pBefore = curve.priceWeiPerToken();

        vm.prank(alice);
        curve.buy{value: 1 ether}(0);

        uint256 pAfter = curve.priceWeiPerToken();
        assertGt(pAfter, pBefore);
    }

    function test_Buy_SlippageProtection() public {
        (uint256 expected,) = curve.quoteBuy(0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BondingCurve__Slippage.selector, expected, expected + 1));
        vm.prank(alice);
        curve.buy{value: 0.1 ether}(expected + 1);
    }

    function test_Buy_RevertsOnZero() public {
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        vm.prank(alice);
        curve.buy{value: 0}(0);
    }

    function test_Sell_RoundTrip() public {
        // Alice buys.
        vm.prank(alice);
        uint256 tokensBought = curve.buy{value: 1 ether}(0);

        // Alice sells all back.
        vm.prank(alice);
        token.approve(address(curve), tokensBought);
        vm.prank(alice);
        uint256 ethBack = curve.sell(tokensBought, 0);

        // She should get slightly less than 1 ether due to fees on both sides.
        assertLt(ethBack, 1 ether);
        assertGt(ethBack, 0.97 ether); // roughly 1 ETH minus 2% (in + out fees)
        assertEq(token.balanceOf(alice), 0);
    }

    function test_Sell_RevertsOnZero() public {
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        vm.prank(alice);
        curve.sell(0, 0);
    }

    function test_Sell_SlippageProtection() public {
        vm.prank(alice);
        uint256 tokensBought = curve.buy{value: 1 ether}(0);
        vm.prank(alice);
        token.approve(address(curve), tokensBought);

        (uint256 expectedEth,) = curve.quoteSell(tokensBought);
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__Slippage.selector, expectedEth, expectedEth + 1)
        );
        vm.prank(alice);
        curve.sell(tokensBought, expectedEth + 1);
    }

    function test_Graduation_TriggersAtTarget() public {
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        assertTrue(curve.graduated());
        assertGe(curve.ethReserve(), GRAD_TARGET);
    }

    function test_Graduation_BlocksFurtherBuys() public {
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        assertTrue(curve.graduated());

        vm.expectRevert(BondingCurve.BondingCurve__Graduated.selector);
        vm.prank(bob);
        curve.buy{value: 0.1 ether}(0);
    }

    function test_Graduation_BlocksSells() public {
        vm.prank(alice);
        uint256 bought = curve.buy{value: 3 ether}(0);
        vm.prank(alice);
        token.approve(address(curve), bought);

        vm.expectRevert(BondingCurve.BondingCurve__Graduated.selector);
        vm.prank(alice);
        curve.sell(bought, 0);
    }

    function test_Graduation_EmitsEvent() public {
        vm.expectEmit(false, false, false, false, address(curve));
        emit BondingCurve.Graduated(0, 0, 0);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
    }

    function test_FeeReceiver_AccumulatesBothSides() public {
        vm.prank(alice);
        uint256 bought = curve.buy{value: 1 ether}(0);
        uint256 afterBuy = feeReceiver.balance;
        assertEq(afterBuy, 0.01 ether);

        vm.prank(alice);
        token.approve(address(curve), bought);
        vm.prank(alice);
        curve.sell(bought, 0);
        assertGt(feeReceiver.balance, afterBuy);
    }

    function test_PriceQuote_ReflectsReserves() public {
        uint256 p0 = curve.priceWeiPerToken();
        assertEq(p0, (VIRTUAL_ETH * 1e18) / (CURVE_SUPPLY + VIRTUAL_TOKEN));

        vm.prank(alice);
        curve.buy{value: 2 ether}(0);
        uint256 p1 = curve.priceWeiPerToken();
        assertGt(p1, p0);
    }
}
