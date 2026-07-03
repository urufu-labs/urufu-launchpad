// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {LPLockedHook} from "src/hooks/LPLockedHook.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract LPLockedHookTest is Test {
    LPLockedHook internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal alice = makeAddr("alice");

    function setUp() public {
        hook = new LPLockedHook(IPoolManager(mockPM));
    }

    function _sampleKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0x1)),
            currency1: Currency.wrap(address(0x2)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _sampleParams() internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -100, salt: bytes32(0)});
    }

    function test_Permissions_OnlyBeforeRemove() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        assertFalse(p.beforeInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertTrue(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.beforeSwap);
        assertFalse(p.afterSwap);
    }

    function test_BeforeRemove_RevertsWithLiquidityLocked() public {
        PoolKey memory key = _sampleKey();
        ModifyLiquidityParams memory params = _sampleParams();

        vm.expectRevert(LPLockedHook.LPLockedHook__LiquidityLocked.selector);
        vm.prank(mockPM);
        hook.beforeRemoveLiquidity(alice, key, params, "");
    }

    function test_BeforeRemove_RevertsIfNotPoolManager() public {
        PoolKey memory key = _sampleKey();
        ModifyLiquidityParams memory params = _sampleParams();

        vm.expectRevert(BaseHook.BaseHook__NotPoolManager.selector);
        vm.prank(alice);
        hook.beforeRemoveLiquidity(alice, key, params, "");
    }

    function test_UnimplementedHooks_Revert() public {
        PoolKey memory key = _sampleKey();
        // beforeSwap not enabled → default revert.
        vm.expectRevert(BaseHook.BaseHook__NotImplemented.selector);
        hook.beforeInitialize(alice, key, 0);
    }

    function test_PoolManagerAddress_StoredImmutable() public view {
        assertEq(address(hook.poolManager()), mockPM);
    }
}
