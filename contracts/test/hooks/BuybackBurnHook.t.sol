// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {BuybackBurnHook} from "src/hooks/BuybackBurnHook.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract BuybackBurnHookTest is Test {
    BuybackBurnHook internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal swapper = makeAddr("swapper");

    Currency internal launched = Currency.wrap(address(0xABCD));
    Currency internal other = Currency.wrap(address(0x1234));

    uint16 internal constant BURN_BPS = 200; // 2%

    function setUp() public {
        hook = new BuybackBurnHook(IPoolManager(mockPM), launched, BURN_BPS);
    }

    function _keyLaunchedIsC1() internal view returns (PoolKey memory) {
        return
            PoolKey({currency0: other, currency1: launched, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function _keyLaunchedIsC0() internal view returns (PoolKey memory) {
        return
            PoolKey({currency0: launched, currency1: other, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function test_Init_StoresParams() public view {
        assertEq(Currency.unwrap(hook.launchedToken()), Currency.unwrap(launched));
        assertEq(hook.burnBps(), BURN_BPS);
    }

    function test_Init_RevertsOnZeroToken() public {
        vm.expectRevert(BuybackBurnHook.BuybackBurnHook__ZeroToken.selector);
        new BuybackBurnHook(IPoolManager(mockPM), Currency.wrap(address(0)), BURN_BPS);
    }

    function test_Init_RevertsOnBpsOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(BuybackBurnHook.BuybackBurnHook__BpsTooHigh.selector, uint256(2001)));
        new BuybackBurnHook(IPoolManager(mockPM), launched, 2001);
    }

    function test_Permissions_AfterSwapAndReturnDelta() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterSwap);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.beforeSwap);
    }

    function test_AfterSwap_BurnsWhenLaunchedIsOutput() public {
        // Swapper receives launched (c1). Unspec = c1 = launched.
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.unlock.selector), abi.encode(bytes("")));
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.unlock, (abi.encode(launched, uint256(20)))));

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _keyLaunchedIsC1(), params, delta, "");
        // 2% of 1000 = 20.
        assertEq(hookDelta, int128(20));
    }

    function test_AfterSwap_NoOpWhenLaunchedIsInput() public {
        // Reverse direction: swapper is SELLING launched. Unspec = other, hook does nothing.
        BalanceDelta delta = toBalanceDelta(-1000, 1000); // c0 in, c1 out
        // launched is c0, so this is `zeroForOne=true` = selling launched. Unspec = c1 = other.
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _keyLaunchedIsC0(), params, delta, "");
        assertEq(hookDelta, 0);
    }

    function test_AfterSwap_NoOpWhenOutputIsZero() public {
        BalanceDelta delta = toBalanceDelta(-1000, 0);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _keyLaunchedIsC1(), params, delta, "");
        assertEq(hookDelta, 0);
    }

    function test_AfterSwap_RevertsFromNonPoolManager() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        hook.afterSwap(swapper, _keyLaunchedIsC1(), params, delta, "");
    }

    function test_UnlockCallback_TakesToDead() public {
        bytes memory data = abi.encode(launched, uint256(50));
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.take, (launched, hook.DEAD(), 50)));
        vm.prank(mockPM);
        hook.unlockCallback(data);
    }

    function test_UnlockCallback_RevertsFromNonPoolManager() public {
        bytes memory data = abi.encode(launched, uint256(50));
        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        hook.unlockCallback(data);
    }
}
