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

/// URU-A05: BondingCurve._init requires `graduator.code.length > 0`, so the
/// tests need a real deployed contract as the wired graduator. Stub is a
/// no-op — none of the tests in this file cross the graduation target.
contract MockGraduator {
    function execute(
        address,
        uint256,
        uint256,
        uint32,
        uint16,
        address
    ) external payable {}

    /// URU-A14 (round 3): Router reads `graduator.poolManager()` on curve
    /// launches. Return address(this) as a benign placeholder.
    function poolManager() external view returns (address) {
        return address(this);
    }
}

contract BondingCurveTest is Test {
    BondingCurve internal impl;
    BondingCurve internal curve;
    MockToken internal token;
    MockGraduator internal mockGrad;

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

        // URU-A05: graduator must be a live contract on init.
        mockGrad = new MockGraduator();

        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(mockGrad),
            0,
            0,
            address(0)
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
            0,
            address(0)
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
        // URU-A05: graduation atomically transfers reserves to the graduator
        // (previously graduator=0 was allowed and _graduate silently no-op'd,
        // leaving the reserves stranded on the curve). Assert that (a) the
        // curve's reserves are now zero, and (b) the mock graduator received
        // AT LEAST the target ETH so we know the transfer path executed.
        assertEq(curve.ethReserve(), 0, "eth reserve must be zeroed on graduation");
        assertEq(curve.tokenReserve(), 0, "token reserve must be zeroed on graduation");
        assertGe(address(mockGrad).balance, GRAD_TARGET, "graduator did not receive target ETH");
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

    // =========================================================
    // GH #8 — buyFor (recipient-directed buy for launchAndBuy)
    // =========================================================

    /// AC #1: buyFor sends tokens to `recipient`, NOT `msg.sender`. Alice pays
    /// ETH, Bob receives the tokens. Verifies the payer/recipient split at the
    /// balance layer.
    function test_BuyFor_TokensGoToRecipientNotSender() public {
        vm.prank(alice);
        uint256 tokensOut = curve.buyFor{value: 0.1 ether}(bob, 0);
        assertGt(tokensOut, 0, "buy must produce non-zero tokensOut");
        assertEq(token.balanceOf(bob), tokensOut, "recipient must receive tokensOut");
        assertEq(token.balanceOf(alice), 0, "payer must NOT receive tokens");
    }

    /// AC #2: buyFor reverts on zero recipient with the dedicated selector.
    function test_BuyFor_RevertsOnZeroRecipient() public {
        vm.expectRevert(BondingCurve.BondingCurve__ZeroRecipient.selector);
        vm.prank(alice);
        curve.buyFor{value: 0.1 ether}(address(0), 0);
    }

    /// AC #3: zero-msg.value dust guard fires identically to `buy`.
    function test_BuyFor_RevertsOnZeroValue() public {
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        vm.prank(alice);
        curve.buyFor{value: 0}(bob, 0);
    }

    /// AC #4: slippage protection fires with the correct got/min pair.
    function test_BuyFor_RevertsOnSlippage() public {
        (uint256 expected,) = curve.quoteBuy(0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BondingCurve__Slippage.selector, expected, expected + 1));
        vm.prank(alice);
        curve.buyFor{value: 0.1 ether}(bob, expected + 1);
    }

    /// AC #5: a graduated curve rejects buyFor with the shared `Graduated`
    /// selector. Uses the low graduation target from setUp so a single 3-ETH
    /// buy pushes the curve over the line.
    function test_BuyFor_RevertsOnGraduated() public {
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        assertTrue(curve.graduated(), "precondition: curve must be graduated");
        vm.expectRevert(BondingCurve.BondingCurve__Graduated.selector);
        vm.prank(alice);
        curve.buyFor{value: 0.1 ether}(bob, 0);
    }

    /// AC #7: fee accrual is identical to `buy` — the 1% FEE_BPS forwards to
    /// `feeReceiver` on the same ethIn regardless of who the recipient is.
    function test_BuyFor_AccruesFeeToFeeReceiver() public {
        assertEq(feeReceiver.balance, 0, "precondition: fee receiver empty");
        vm.prank(alice);
        curve.buyFor{value: 1 ether}(bob, 0);
        assertEq(feeReceiver.balance, 0.01 ether, "1% fee must land at feeReceiver");
    }

    /// AC #8: reserve deltas identical to `buy` from the same starting state.
    /// Snapshot the state, run `buy`, snapshot deltas; revert; run `buyFor`
    /// from the same starting state and assert deltas match exactly.
    function test_BuyFor_ReserveDeltasIdenticalToBuy() public {
        uint256 snap = vm.snapshotState();

        // Baseline: alice runs the reference `buy`.
        vm.prank(alice);
        uint256 buyTokens = curve.buy{value: 0.5 ether}(0);
        uint256 buyEthReserve = curve.ethReserve();
        uint256 buyTokenReserve = curve.tokenReserve();

        // Roll back to pre-trade state and run buyFor with identical value.
        vm.revertToState(snap);

        vm.prank(alice);
        uint256 buyForTokens = curve.buyFor{value: 0.5 ether}(bob, 0);
        assertEq(buyForTokens, buyTokens, "tokensOut must match reference buy");
        assertEq(curve.ethReserve(), buyEthReserve, "ethReserve delta must match reference buy");
        assertEq(curve.tokenReserve(), buyTokenReserve, "tokenReserve delta must match reference buy");
    }

    /// AC — no-op sanity: `Trade` still fires so OHLC pipelines are unaffected.
    /// Also verifies the new `BoughtFor` event carries payer/recipient/amounts.
    /// Phase 2 audit fix: `Trade.trader` is the RECIPIENT (bob), not the
    /// payer (alice). Router.launchAndBuy is the primary caller of buyFor;
    /// attributing every atomic first-buy to Router in indexer feeds would
    /// misreport holder analytics. The full payer/recipient split is still
    /// available on the accompanying `BoughtFor` event.
    function test_BuyFor_EmitsBoughtForAndTrade() public {
        vm.prank(alice);
        (uint256 expectedOut, uint256 expectedFee) = curve.quoteBuy(0.2 ether);
        uint256 ethAfterFee = 0.2 ether - expectedFee;

        // Trade event: trader indexed on the recipient (bob), not the payer.
        // Only the indexed `trader` field is asserted here — non-indexed data
        // (isBuy/ethAmount/…/timestamp) is exercised by other tests.
        vm.expectEmit(true, false, false, false, address(curve));
        emit BondingCurve.Trade(bob, true, 0, 0, 0, 0, 0);
        // BoughtFor event assertion — payer + recipient both indexed.
        vm.expectEmit(true, true, false, true, address(curve));
        emit BondingCurve.BoughtFor(alice, bob, ethAfterFee, expectedOut);
        vm.prank(alice);
        curve.buyFor{value: 0.2 ether}(bob, 0);
    }
}

// =========================================================
// GH #8 — buyFor whitelist-window behavior
// =========================================================

/// AC #6 lives here — needs a WL-configured curve so the WL window fires. Split
/// out from the main test contract to avoid mutating the shared setUp fixture.
contract BondingCurveBuyForWlTest is Test {
    BondingCurve internal impl;
    BondingCurve internal curve;
    MockToken internal token;
    MockGraduator internal mockGrad;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal feeReceiver = makeAddr("feeReceiver");

    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;
    uint16 internal constant FEE_BPS = 100;

    function setUp() public {
        impl = new BondingCurve();
        curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token = new MockToken();
        token.mint(address(curve), CURVE_SUPPLY);
        mockGrad = new MockGraduator();

        // Configure a WL with a fallback 1 hour in the future so buyFor lands
        // during the exclusive window.
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: keccak256("wl-root"),
            reservedTokens: CURVE_SUPPLY / 4,
            maxWlPerAddress: 1_000_000e18,
            fallbackTs: uint64(block.timestamp + 3600),
            sourceTokenAddress: address(0),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 0
        });

        curve.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(mockGrad),
            0,
            0,
            address(0),
            wl
        );

        vm.deal(alice, 100 ether);
    }

    /// AC #6: during the WL-exclusive window, `buyFor` reverts with the same
    /// `WlWindowActive` guard as `buy`. This is CRITICAL — otherwise
    /// `buyFor` would be a WL-bypass vector for the Router path.
    function test_BuyFor_RevertsInWlWindow() public {
        uint64 fallbackTs = curve.fallbackTs();
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BondingCurve__WlWindowActive.selector, fallbackTs));
        vm.prank(alice);
        curve.buyFor{value: 0.1 ether}(bob, 0);
    }

    /// After the WL window elapses, buyFor works normally.
    function test_BuyFor_WorksAfterWlWindowElapses() public {
        vm.warp(curve.fallbackTs() + 1);
        vm.prank(alice);
        uint256 tokensOut = curve.buyFor{value: 0.1 ether}(bob, 0);
        assertGt(tokensOut, 0);
        assertEq(token.balanceOf(bob), tokensOut, "recipient must receive tokens post-window");
    }
}
