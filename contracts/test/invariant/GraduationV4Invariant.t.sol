// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant, console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

/// @notice Drives the full launchpad lane — curve trading, graduation into a real
///         Uniswap v4 pool, and post-graduation v4 swaps — under Foundry's
///         invariant fuzzer.
///
///         The handler owns the stack (it stands in for Router, so it must be the
///         CurveFactory's trusted router). It keeps a roster of launched tokens
///         and rolls a new launch whenever the active one graduates, so a single
///         fuzz campaign sweeps many independent curve→pool lifecycles instead of
///         stalling the moment the first curve graduates.
///
/// @dev    Every action is guarded so the fuzzer spends its budget on
///         state-changing calls rather than on reverts. `fail_on_revert` is
///         false in foundry.toml, so an unguarded handler would silently
///         degrade into a no-op sweep and the invariants would pass vacuously.
contract GraduationHandler is LocalV4Stack {
    using StateLibrary for IPoolManager;

    address[] public tokens;
    address[] public curves;
    mapping(address => bool) public isGraduated;

    address[] public actors;

    // ---- ghost accounting -------------------------------------------------
    uint256 public graduationCount;
    uint256 public launchCount;
    uint256 public curveBuyCount;
    uint256 public curveSellCount;
    uint256 public v4BuyCount;
    uint256 public v4SellCount;
    uint256 public feeReceiverEthSeen;

    constructor() {
        _deployStack();
        actors.push(makeAddr("g-alice"));
        actors.push(makeAddr("g-bob"));
        actors.push(makeAddr("g-carol"));
        for (uint256 i; i < actors.length; ++i) {
            vm.deal(actors[i], 1_000 ether);
        }
        _launch();
    }

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    /// Launch through the REAL `Router.launch()` — the same entrypoint the
    /// frontend calls — so the fuzz campaign covers name reservation, fee
    /// quoting, factory dispatch, curve install, and ownership renounce, not
    /// just the curve in isolation.
    function _launch() internal {
        uint256 n = tokens.length;
        (address t, BondingCurve c) = _launchViaRouter(
            string.concat("Inv", vm.toString(n)), string.concat("INV", vm.toString(n)), actors[0]
        );
        tokens.push(t);
        curves.push(address(c));
        launchCount++;
    }

    /// Index of the newest curve that has not graduated yet, or type(uint256).max.
    function _activeIdx() internal view returns (uint256) {
        for (uint256 i = curves.length; i > 0; --i) {
            if (!BondingCurve(payable(curves[i - 1])).graduated()) return i - 1;
        }
        return type(uint256).max;
    }

    // =====================================================================
    // Curve actions
    // =====================================================================

    function curveBuy(
        uint256 actorSeed,
        uint256 ethIn
    ) public {
        uint256 idx = _activeIdx();
        if (idx == type(uint256).max) return;
        BondingCurve curve = BondingCurve(payable(curves[idx]));

        address actor = actors[actorSeed % actors.length];
        if (actor.balance < 0.01 ether) return;
        uint256 cap = actor.balance / 4;
        if (cap < 0.001 ether) return;
        ethIn = bound(ethIn, 0.001 ether, cap > 3 ether ? 3 ether : cap);

        (uint256 out,) = curve.quoteBuy(ethIn);
        if (out == 0 || out > curve.tokenReserve()) return;

        vm.prank(actor);
        try curve.buy{value: ethIn}(0) {
            curveBuyCount++;
            if (curve.graduated()) {
                isGraduated[tokens[idx]] = true;
                graduationCount++;
                // Keep the campaign alive with a fresh curve.
                if (tokens.length < 6) _launch();
            }
        } catch {}
    }

    function curveSell(
        uint256 actorSeed,
        uint256 tokensIn
    ) public {
        uint256 idx = _activeIdx();
        if (idx == type(uint256).max) return;
        BondingCurve curve = BondingCurve(payable(curves[idx]));
        StackToken token = StackToken(tokens[idx]);

        address actor = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;
        tokensIn = bound(tokensIn, 1, bal);

        (uint256 ethOut,) = curve.quoteSell(tokensIn);
        if (ethOut == 0) return;

        vm.startPrank(actor);
        token.approve(address(curve), tokensIn);
        try curve.sell(tokensIn, 0) {
            curveSellCount++;
        } catch {}
        vm.stopPrank();
    }

    // =====================================================================
    // Post-graduation v4 actions
    // =====================================================================

    function v4Buy(
        uint256 actorSeed,
        uint256 tokenSeed,
        uint256 ethIn
    ) public {
        if (tokens.length == 0) return;
        uint256 idx = tokenSeed % tokens.length;
        address token = tokens[idx];
        if (!isGraduated[token]) return;

        address actor = actors[actorSeed % actors.length];
        if (actor.balance < 0.01 ether) return;
        uint256 cap = actor.balance / 8;
        if (cap < 0.001 ether) return;
        ethIn = bound(ethIn, 0.001 ether, cap > 2 ether ? 2 ether : cap);

        vm.prank(actor);
        try swapRouter.swapExactETHForToken{value: ethIn}(_poolKeyFor(token), 0, actor, block.timestamp + 1) {
            v4BuyCount++;
        } catch {}
    }

    function v4Sell(
        uint256 actorSeed,
        uint256 tokenSeed,
        uint256 amountIn
    ) public {
        if (tokens.length == 0) return;
        uint256 idx = tokenSeed % tokens.length;
        address token = tokens[idx];
        if (!isGraduated[token]) return;

        address actor = actors[actorSeed % actors.length];
        uint256 bal = StackToken(token).balanceOf(actor);
        if (bal == 0) return;
        amountIn = bound(amountIn, 1, bal);

        vm.startPrank(actor);
        StackToken(token).approve(address(swapRouter), amountIn);
        try swapRouter.swapExactTokenForETH(_poolKeyFor(token), amountIn, 0, actor, block.timestamp + 1) {
            v4SellCount++;
        } catch {}
        vm.stopPrank();
    }

    /// Hook fee claims — exercises the `owed` ledger drain path.
    function claimHookFees() public {
        vm.prank(address(feeReceiver));
        try mhh.claim(Currency.wrap(address(0))) {} catch {}
    }
}

/// @title  GraduationV4InvariantTest
/// @notice Properties that must hold across ANY interleaving of curve trades,
///         graduations, and v4 swaps — checked against a real, locally deployed
///         Uniswap v4 PoolManager.
contract GraduationV4InvariantTest is StdInvariant, Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    GraduationHandler internal handler;

    function setUp() public {
        handler = new GraduationHandler();

        bytes4[] memory sel = new bytes4[](5);
        sel[0] = GraduationHandler.curveBuy.selector;
        sel[1] = GraduationHandler.curveSell.selector;
        sel[2] = GraduationHandler.v4Buy.selector;
        sel[3] = GraduationHandler.v4Sell.selector;
        sel[4] = GraduationHandler.claimHookFees.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // =====================================================================
    // Graduator solvency — the 2026-07-30 incident class
    // =====================================================================

    /// The V7 Graduator opened the pool at a price that made tokens the limiting
    /// side, so the LP absorbed every token but only a fraction of the ETH. ~4 ETH
    /// per graduation was left on a contract with no withdraw path. GraduatorV2
    /// prices at the raw real ratio and refunds any dust to the launcher, so its
    /// resting balance must be exactly zero — not "small", zero.
    function invariant_GraduatorNeverHoldsEth() public view {
        assertEq(address(handler.graduator()).balance, 0, "graduator is holding ETH");
    }

    /// Same idea on the token side: anything the LP didn't absorb is burned.
    function invariant_GraduatorNeverHoldsTokens() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            StackToken t = StackToken(handler.tokens(i));
            assertEq(t.balanceOf(address(handler.graduator())), 0, "graduator is holding tokens");
        }
    }

    // =====================================================================
    // Curve accounting
    // =====================================================================

    /// A live curve's token balance is exactly its arithmetic reserve plus the
    /// whitelist-held slice. Drift here means the curve is pricing against
    /// liquidity it does not actually hold.
    function invariant_CurveTokenBalanceMatchesReserves() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            BondingCurve c = BondingCurve(payable(handler.curves(i)));
            StackToken t = StackToken(handler.tokens(i));
            if (c.graduated()) continue;
            assertEq(
                t.balanceOf(address(c)), c.tokenReserve() + c.wlHeldTotal(), "curve token balance != reserve + wlHeld"
            );
        }
    }

    /// A live curve must be able to honour a full drain of its ETH reserve.
    /// Trade fees are forwarded out on every trade, so balance tracks reserve
    /// exactly; anything less would mean sells could revert on transfer.
    function invariant_CurveEthBalanceCoversReserve() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            BondingCurve c = BondingCurve(payable(handler.curves(i)));
            if (c.graduated()) continue;
            assertGe(address(c).balance, c.ethReserve(), "curve ETH balance below its reserve");
        }
    }

    /// Graduation zeroes both reserves and hands them to the Graduator.
    function invariant_GraduatedCurvesAreDrained() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            BondingCurve c = BondingCurve(payable(handler.curves(i)));
            if (!c.graduated()) continue;
            assertEq(c.ethReserve(), 0, "graduated curve still reports an ETH reserve");
            assertEq(c.tokenReserve(), 0, "graduated curve still reports a token reserve");
        }
    }

    // =====================================================================
    // v4 pool integrity
    // =====================================================================

    /// Every graduated token has a real, initialized pool that still holds its
    /// full-range position. Liquidity is locked, so it can only ever go up.
    function invariant_GraduatedTokensHaveLiveV4Pools() public view {
        IPoolManager pm = IPoolManager(address(handler.poolManager()));
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            if (!handler.isGraduated(token)) continue;

            PoolId id = _poolIdFor(token);
            (uint160 sqrtPriceX96,,,) = pm.getSlot0(id);
            assertGt(sqrtPriceX96, 0, "graduated token has no initialized v4 pool");
            assertGt(pm.getLiquidity(id), 0, "graduated token's v4 pool lost its liquidity");
        }
    }

    // =====================================================================
    // Hook fee ledger
    // =====================================================================

    /// The hook can always pay out what it says it owes. If accrual ever
    /// outruns the ETH actually held, the last claimant eats the shortfall.
    function invariant_HookIsSolventForOwedEth() public view {
        address mhhAddr = address(handler.mhh());
        uint256 owedTotal = handler.mhh().owed(Currency.wrap(address(0)), address(handler.feeReceiver()))
            + handler.mhh().owed(Currency.wrap(address(0)), handler.admin());
        assertGe(mhhAddr.balance, owedTotal, "hook owes more ETH than it holds");
    }

    // =====================================================================
    // Supply conservation
    // =====================================================================

    /// Nothing mints after launch. Total supply is fixed for the token's life,
    /// through curve trading, graduation, burn-on-excess, and v4 swapping.
    function invariant_TotalSupplyIsFixed() public view {
        uint256 n = handler.tokensLength();
        uint256 expected = handler.curveFactory().defaultCurveSupply();
        for (uint256 i; i < n; ++i) {
            assertEq(StackToken(handler.tokens(i)).totalSupply(), expected, "token supply changed after launch");
        }
    }

    /// Graduation is terminal — a curve can never reopen for trading.
    function invariant_GraduationIsOneWay() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            if (!handler.isGraduated(token)) continue;
            assertTrue(BondingCurve(payable(handler.curves(i))).graduated(), "a graduated curve un-graduated");
        }
    }

    function invariant_CallSummary() public view {
        console2.log("curve buys :", handler.curveBuyCount());
        console2.log("curve sells:", handler.curveSellCount());
        console2.log("graduations:", handler.graduationCount());
        console2.log("v4 buys    :", handler.v4BuyCount());
        console2.log("v4 sells   :", handler.v4SellCount());
        console2.log("launches   :", handler.launchCount());
        console2.log("tokens     :", handler.tokensLength());
    }

    function _poolIdFor(
        address token
    ) internal view returns (PoolId) {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(handler.mhh()))
        });
        return key.toId();
    }
}
