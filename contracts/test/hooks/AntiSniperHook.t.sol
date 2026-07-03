// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {AntiSniperHook} from "src/hooks/AntiSniperHook.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract AntiSniperHookTest is Test {
    using PoolIdLibrary for PoolKey;

    AntiSniperHook internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal swapper = makeAddr("swapper");

    uint256 internal constant GATE = 5;

    function setUp() public {
        hook = new AntiSniperHook(IPoolManager(mockPM), GATE);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0x1)),
            currency1: Currency.wrap(address(0x2)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _swap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
    }

    function test_Permissions_InitAndBeforeSwap() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertTrue(p.beforeSwap);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterSwap);
    }

    function test_Init_ArmsGate() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);
        assertEq(hook.gateUntil(_key().toId()), 100 + GATE);
    }

    function test_Init_RevertsOnDoubleInit() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);
        vm.expectRevert(AntiSniperHook.AntiSniperHook__PoolAlreadyInitialized.selector);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);
    }

    function test_Init_RevertsFromNonPoolManager() public {
        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        hook.beforeInitialize(swapper, _key(), 0);
    }

    function test_Swap_RevertsInsideWindow() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);

        vm.roll(103); // still inside window (100 + 5 = 105)
        vm.expectRevert(
            abi.encodeWithSelector(AntiSniperHook.AntiSniperHook__WindowActive.selector, uint256(103), uint256(105))
        );
        vm.prank(mockPM);
        hook.beforeSwap(swapper, _key(), _swap(), "");
    }

    function test_Swap_AllowedAfterWindow() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);

        vm.roll(105); // window is `< until`, at boundary swap passes
        vm.prank(mockPM);
        hook.beforeSwap(swapper, _key(), _swap(), "");
    }

    function test_Swap_AllowedManyBlocksLater() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);

        vm.roll(10_000);
        vm.prank(mockPM);
        hook.beforeSwap(swapper, _key(), _swap(), "");
    }

    function test_Swap_RevertsFromNonPoolManager() public {
        vm.roll(100);
        vm.prank(mockPM);
        hook.beforeInitialize(swapper, _key(), 0);

        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        hook.beforeSwap(swapper, _key(), _swap(), "");
    }
}
