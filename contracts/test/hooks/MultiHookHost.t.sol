// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract MultiHookHostTest is Test {
    MultiHookHost internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal swapper = makeAddr("swapper");

    Currency internal c0 = Currency.wrap(address(0x1));
    Currency internal c1 = Currency.wrap(address(0x2));

    function setUp() public {
        hook = new MultiHookHost(IPoolManager(mockPM), platform, creator, 100, 100);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function test_Permissions_LPLockAndFeeRedirect() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeRemoveLiquidity);
        assertTrue(p.afterSwap);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.beforeSwap);
    }

    function test_RemoveLiquidity_AlwaysReverts() public {
        ModifyLiquidityParams memory params =
            ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -100, salt: bytes32(0)});
        vm.expectRevert(MultiHookHost.MultiHookHost__LiquidityLocked.selector);
        vm.prank(mockPM);
        hook.beforeRemoveLiquidity(swapper, _key(), params, "");
    }

    function test_AfterSwap_CreditsBothRecipients() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");

        assertEq(hook.owed(c1, platform), 10);
        assertEq(hook.owed(c1, creator), 10);
        assertEq(hookDelta, int128(20));
    }

    function test_Claim_UsesUnlockPath() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.prank(mockPM);
        hook.afterSwap(swapper, _key(), params, delta, "");

        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.unlock.selector), abi.encode(bytes("")));
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.unlock, (abi.encode(c1, platform, uint256(10)))));
        vm.prank(platform);
        hook.claim(c1);
        assertEq(hook.owed(c1, platform), 0);
    }

    function test_UnlockCallback_TakesForRecipient() public {
        bytes memory data = abi.encode(c1, platform, uint256(7));
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.take, (c1, platform, 7)));
        vm.prank(mockPM);
        hook.unlockCallback(data);
    }

    function test_Init_RevertsOnBpsOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__BpsTooHigh.selector, uint256(3001)));
        new MultiHookHost(IPoolManager(mockPM), platform, creator, 1500, 1501);
    }

    function test_Init_RevertsOnZeroAddress() public {
        vm.expectRevert(MultiHookHost.MultiHookHost__ZeroAddress.selector);
        new MultiHookHost(IPoolManager(mockPM), address(0), creator, 100, 100);
    }
}
