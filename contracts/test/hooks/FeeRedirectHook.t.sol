// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {FeeRedirectHook} from "src/hooks/FeeRedirectHook.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract FeeRedirectHookTest is Test {
    FeeRedirectHook internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal swapper = makeAddr("swapper");

    Currency internal c0 = Currency.wrap(address(0x1));
    Currency internal c1 = Currency.wrap(address(0x2));

    uint16 internal constant PLAT_BPS = 100; // 1%
    uint16 internal constant CREA_BPS = 100; // 1%

    function setUp() public {
        hook = new FeeRedirectHook(IPoolManager(mockPM), platform, creator, PLAT_BPS, CREA_BPS);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function test_Init_StoresParams() public view {
        assertEq(hook.platform(), platform);
        assertEq(hook.creator(), creator);
        assertEq(hook.platformBps(), PLAT_BPS);
        assertEq(hook.creatorBps(), CREA_BPS);
    }

    function test_Init_RevertsOnZeroPlatform() public {
        vm.expectRevert(FeeRedirectHook.FeeRedirectHook__ZeroAddress.selector);
        new FeeRedirectHook(IPoolManager(mockPM), address(0), creator, PLAT_BPS, CREA_BPS);
    }

    function test_Init_RevertsOnBpsOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(FeeRedirectHook.FeeRedirectHook__BpsTooHigh.selector, uint256(3001)));
        new FeeRedirectHook(IPoolManager(mockPM), platform, creator, 1500, 1501);
    }

    function test_Init_RevertsOnZeroTotalBps() public {
        vm.expectRevert(abi.encodeWithSelector(FeeRedirectHook.FeeRedirectHook__BpsTooHigh.selector, uint256(0)));
        new FeeRedirectHook(IPoolManager(mockPM), platform, creator, 0, 0);
    }

    function test_Permissions_AfterSwapAndReturnDelta() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterSwap);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.beforeSwap);
        assertFalse(p.beforeRemoveLiquidity);
    }

    function test_AfterSwap_ExactInputZeroForOne_CreditsOutputSide() public {
        // Swapper wants to swap exactInput of c0 → receives c1.
        // Delta: amount0 = -1000 (spent), amount1 = +1000 (received).
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");

        // 2% total of 1000 = 20; split 10/10 between platform/creator.
        assertEq(hook.owed(c1, platform), 10);
        assertEq(hook.owed(c1, creator), 10);
        assertEq(hook.owed(c0, platform), 0);
        assertEq(hookDelta, int128(20));
    }

    function test_AfterSwap_ExactInputOneForZero_CreditsOutputSide() public {
        // Swapper: oneForZero, exactInput. Amount0 = +1000 (received), amount1 = -1000.
        BalanceDelta delta = toBalanceDelta(1000, -1000);
        SwapParams memory params = SwapParams({zeroForOne: false, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");

        assertEq(hook.owed(c0, platform), 10);
        assertEq(hook.owed(c0, creator), 10);
        assertEq(hookDelta, int128(20));
    }

    function test_AfterSwap_RevertsFromNonPoolManager() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        vm.prank(swapper);
        hook.afterSwap(swapper, _key(), params, delta, "");
    }

    function test_AfterSwap_ZeroOutput_NoOp() public {
        BalanceDelta delta = toBalanceDelta(1000, 0);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");
        assertEq(hookDelta, 0);
        assertEq(hook.owed(c1, platform), 0);
    }

    function test_Claim_RevertsWithNothing() public {
        vm.expectRevert(FeeRedirectHook.FeeRedirectHook__NothingToClaim.selector);
        vm.prank(platform);
        hook.claim(c1);
    }

    function test_Claim_CallsUnlockWithEncodedPayload() public {
        // Seed the owed mapping first.
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.prank(mockPM);
        hook.afterSwap(swapper, _key(), params, delta, "");

        // Mock PoolManager.unlock to just return empty bytes.
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.unlock.selector), abi.encode(bytes("")));

        // Expect the exact unlock call with encoded (currency, recipient, amount).
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.unlock, (abi.encode(c1, platform, uint256(10)))));
        vm.prank(platform);
        hook.claim(c1);

        // Owed cleared.
        assertEq(hook.owed(c1, platform), 0);
    }

    function test_UnlockCallback_RevertsFromNonPoolManager() public {
        bytes memory data = abi.encode(c1, platform, uint256(10));
        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        hook.unlockCallback(data);
    }

    function test_UnlockCallback_CallsTakeWithArgs() public {
        bytes memory data = abi.encode(c1, platform, uint256(42));
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.take, (c1, platform, 42)));
        vm.prank(mockPM);
        hook.unlockCallback(data);
    }
}
