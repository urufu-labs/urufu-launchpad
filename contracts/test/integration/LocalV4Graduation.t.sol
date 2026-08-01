// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

/// @title  LocalV4GraduationTest
/// @notice Fork-free end-to-end of the graduation path against a real, locally
///         deployed `v4-core` PoolManager. Proves the whole curve → Graduator →
///         v4 pool → swap lane works without touching a live network, and pins
///         the post-incident accounting guarantees (no stranded ETH, no stranded
///         tokens, LP locked forever).
contract LocalV4GraduationTest is LocalV4Stack {
    using StateLibrary for IPoolManager;

    address internal launcher = makeAddr("local-launcher");
    address internal buyer = makeAddr("local-buyer");
    address internal trader = makeAddr("local-trader");

    function setUp() public {
        _deployStack();
        vm.deal(buyer, 100 ether);
        vm.deal(trader, 100 ether);
    }

    function test_FullGraduationLifecycle_OnLocalV4() public {
        (address tokenAddr, BondingCurve curve) = _launchViaRouter("Local", "LCL", launcher);
        StackToken token = StackToken(tokenAddr);

        uint256 target = curve.graduationTargetEth();
        assertEq(curve.ethReserve(), 0, "fresh curve should hold no ETH");
        assertFalse(curve.graduated(), "fresh curve should not be graduated");

        // ---- drive the curve to graduation -------------------------------
        vm.startPrank(buyer);
        curve.buy{value: 1 ether}(0);
        assertFalse(curve.graduated(), "graduated far too early");

        uint256 remaining = target - curve.ethReserve();
        curve.buy{value: (remaining * 115) / 100}(0);
        vm.stopPrank();

        assertTrue(curve.graduated(), "curve failed to graduate");

        // ---- post-incident accounting guarantees -------------------------
        // The V7 Graduator stranded ~4 ETH per graduation with no recovery
        // path. Both of these must be exactly zero, every time.
        assertEq(address(graduator).balance, 0, "graduator stranded ETH");
        assertEq(token.balanceOf(address(graduator)), 0, "graduator stranded tokens");

        assertEq(curve.ethReserve(), 0, "curve ethReserve not zeroed at graduation");
        assertEq(curve.tokenReserve(), 0, "curve tokenReserve not zeroed at graduation");

        // ---- the v4 pool actually exists and holds the liquidity ----------
        PoolId poolId = _poolIdFor(address(token));
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(poolId);
        uint128 liquidity = ipm.getLiquidity(poolId);

        assertGt(sqrtPriceX96, 0, "v4 pool was never initialized");
        assertGt(liquidity, 0, "v4 pool has no liquidity");
        console2.log("pool sqrtPriceX96:", sqrtPriceX96);
        console2.log("pool liquidity   :", liquidity);

        // ---- swap both directions through the real PoolManager ------------
        PoolKey memory key = _poolKeyFor(address(token));

        vm.prank(trader);
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.5 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(bought, 0, "v4 buy returned zero tokens");
        assertEq(token.balanceOf(trader), bought, "trader did not receive tokens");

        vm.startPrank(trader);
        token.approve(address(swapRouter), bought / 2);
        uint256 ethOut = swapRouter.swapExactTokenForETH(key, bought / 2, 0, trader, block.timestamp + 600);
        vm.stopPrank();
        assertGt(ethOut, 0, "v4 sell returned zero ETH");

        console2.log("bought for 0.5 ETH:", bought);
        console2.log("eth back for half :", ethOut);
    }

    /// The core anti-rug claim: LP is locked forever. `MultiHookHost`'s
    /// `beforeRemoveLiquidity` reverts unconditionally, so nobody — not the
    /// launcher, not the graduator, not the hook owner — can pull the pool.
    function test_LiquidityCanNeverBeRemoved() public {
        (address tokenAddr, BondingCurve curve) = _launchViaRouter("Locked", "LOCK", launcher);
        StackToken token = StackToken(tokenAddr);

        vm.startPrank(buyer);
        curve.buy{value: (curve.graduationTargetEth() * 120) / 100}(0);
        vm.stopPrank();
        assertTrue(curve.graduated(), "setup: curve did not graduate");

        PoolId poolId = _poolIdFor(address(token));
        uint128 liquidityBefore = ipm.getLiquidity(poolId);
        assertGt(liquidityBefore, 0, "setup: no liquidity to try removing");

        LiquidityRemover remover = new LiquidityRemover(ipm);
        // Read everything BEFORE arming the cheatcode — Solidity evaluates call
        // arguments first, so an inline `graduator.tickLower()` here would be
        // the call `expectRevert` latches onto, not the removal attempt.
        PoolKey memory key = _poolKeyFor(address(token));
        int24 lower = graduator.tickLower();
        int24 upper = graduator.tickUpper();

        // v4 does not bubble a hook's revert verbatim — it re-throws it wrapped
        // as CustomRevert.WrappedError(hook, failingSelector, reason, details).
        // Assert the full chain so this stays honest: a future change that makes
        // removal fail for some UNRELATED reason (bad ticks, empty position)
        // would still pass a bare `expectRevert`, and would silently stop
        // testing the lock at all.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(mhh),
                IHooks.beforeRemoveLiquidity.selector,
                abi.encodeWithSelector(MultiHookHost.MultiHookHost__LiquidityLocked.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        remover.tryRemove(key, lower, upper);

        assertEq(ipm.getLiquidity(poolId), liquidityBefore, "liquidity changed despite the lock");
    }
}

/// Minimal unlock-callback harness that attempts a negative `liquidityDelta`.
/// Exists purely so the removal attempt originates from a real `unlock` context,
/// which is the only way v4 lets `modifyLiquidity` be called at all.
contract LiquidityRemover {
    IPoolManager internal immutable pm;

    constructor(
        IPoolManager _pm
    ) {
        pm = _pm;
    }

    function tryRemove(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper
    ) external {
        pm.unlock(abi.encode(key, tickLower, tickUpper));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        (PoolKey memory key, int24 tickLower, int24 tickUpper) = abi.decode(data, (PoolKey, int24, int24));
        pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: -1, salt: bytes32(0)}),
            ""
        );
        return "";
    }
}
