// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

contract MultiHookHostTest is Test {
    using PoolIdLibrary for PoolKey;

    MultiHookHost internal hook;
    address internal mockPM = makeAddr("poolManager");
    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");
    address internal launcher = makeAddr("launcher");
    /// Stand-in Graduator for tests — every beforeInitialize/mockPM call passes this
    /// as the `sender` arg since the V3 hook requires an authorized initializer. When
    /// a test wants to prove the gate REJECTS a stranger, it uses `swapper` instead.
    address internal graduator = makeAddr("graduator");
    address internal swapper = makeAddr("swapper");

    Currency internal c0 = Currency.wrap(address(0x1));
    Currency internal c1 = Currency.wrap(address(0x2));

    function setUp() public {
        hook = new MultiHookHost(IPoolManager(mockPM), platform, creator, 100, 100, address(this));
        // V3 requires the initializer to be wired before any pool init. Every test
        // that stubs beforeInitialize uses `graduator` as the sender so the gate
        // approves the call. Attack tests override the sender with `swapper` and
        // assert UnauthorizedInitializer.
        hook.setInitializer(graduator);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function test_Permissions_LPLockAndFeeRedirect() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        // v2 permissions: beforeInitialize (stamp launchBlock) + beforeSwap (anti-sniper gate)
        // are now required in addition to the LP-lock + fee-redirect flags.
        assertTrue(p.beforeInitialize);
        assertTrue(p.beforeRemoveLiquidity);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
    }

    function test_RemoveLiquidity_AlwaysReverts() public {
        ModifyLiquidityParams memory params =
            ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -100, salt: bytes32(0)});
        vm.expectRevert(MultiHookHost.MultiHookHost__LiquidityLocked.selector);
        vm.prank(mockPM);
        hook.beforeRemoveLiquidity(swapper, _key(), params, "");
    }

    function test_AfterSwap_CreditsBothRecipientsAndTakesFee() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});

        // afterSwap now pulls the fee from the pool manager first (so its currency delta
        // nets to zero). Mock the take() so this unit test can run against a fake PM.
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.take, (c1, address(hook), 20)));

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");

        assertEq(hook.owed(c1, platform), 10);
        assertEq(hook.owed(c1, creator), 10);
        assertEq(hookDelta, int128(20));
    }

    /// Claim is now a plain balance transfer from the hook contract to the recipient — no
    /// PoolManager unlock. Test the ERC20 path: mint a fake token, seed it into the hook
    /// after afterSwap credits owed[], and assert the transfer happens.
    function test_Claim_TransfersFromHookBalance() public {
        // Set up: seed owed[] via afterSwap (with take mocked).
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.prank(mockPM);
        hook.afterSwap(swapper, _key(), params, delta, "");
        assertEq(hook.owed(c1, platform), 10);

        // The take() above was mocked so no real tokens landed. Give the hook a matching
        // balance of the ERC20 (c1 = 0x2, a fake ERC20 address) via mockCall of transfer.
        // Currency.transfer for a non-zero address calls SafeTransferLib on that address.
        vm.mockCall(
            Currency.unwrap(c1),
            abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), platform, uint256(10)),
            abi.encode(true)
        );

        vm.prank(platform);
        hook.claim(c1);
        assertEq(hook.owed(c1, platform), 0);
    }

    function test_Claim_RevertsWhenNothingOwed() public {
        vm.expectRevert(MultiHookHost.MultiHookHost__NothingToClaim.selector);
        vm.prank(platform);
        hook.claim(c1);
    }

    function test_Init_RevertsOnBpsOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__BpsTooHigh.selector, uint256(3001)));
        new MultiHookHost(IPoolManager(mockPM), platform, creator, 1500, 1501, address(this));
    }

    function test_Init_RevertsOnZeroAddress() public {
        vm.expectRevert(MultiHookHost.MultiHookHost__ZeroAddress.selector);
        new MultiHookHost(IPoolManager(mockPM), address(0), creator, 100, 100, address(this));
    }

    // ---- setCreator: per-pool creator revenue ---------------------------------

    /// setCreator populates the `creators[poolId]` slot before the pool is initialized.
    /// After beforeInitialize fires (stamps launchBlock), further setCreator calls for
    /// that same poolId revert with ConfigFrozen — same freeze contract as setPoolConfig.
    function test_SetCreator_StoresPerPoolAndFreezesAfterInit() public {
        PoolId id = _key().toId();
        assertEq(hook.creators(id), address(0));

        hook.setCreator(id, launcher);
        assertEq(hook.creators(id), launcher);

        // After the pool initializes, setCreator becomes uncallable for this poolId.
        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        vm.expectRevert(MultiHookHost.MultiHookHost__ConfigFrozen.selector);
        hook.setCreator(id, makeAddr("other"));
    }

    function test_SetCreator_RevertsOnZeroAddress() public {
        vm.expectRevert(MultiHookHost.MultiHookHost__ZeroAddress.selector);
        hook.setCreator(_key().toId(), address(0));
    }

    /// After setCreator(launcher), afterSwap must accrue the creator share to
    /// `launcher` instead of the constructor-provided fallback `creator`. This is the
    /// core V2 behavior — per-launch creator revenue.
    function test_AfterSwap_AccruesToPerPoolCreator() public {
        PoolId id = _key().toId();
        hook.setCreator(id, launcher);

        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.prank(mockPM);
        hook.afterSwap(swapper, _key(), params, delta, "");

        // Creator share goes to launcher — the constructor fallback `creator` stays at 0.
        assertEq(hook.owed(c1, launcher), 10, "per-pool launcher not credited");
        assertEq(hook.owed(c1, creator), 0, "constructor fallback should not have accrued");
        assertEq(hook.owed(c1, platform), 10);
    }

    /// A pool that never called setCreator (e.g. manual init outside the launchpad)
    /// must not lose its creator share — it falls back to the constructor `creator` so
    /// funds don't get stuck in an unclaimable slot.
    function test_AfterSwap_FallsBackToConstructorCreatorWhenUnset() public {
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1000, sqrtPriceLimitX96: 0});
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.prank(mockPM);
        hook.afterSwap(swapper, _key(), params, delta, "");

        // No setCreator was ever called for this poolId — creator share hits the fallback.
        assertEq(hook.owed(c1, creator), 10, "fallback creator not credited");
    }

    // ---- V3 initializer gate: block pool-init griefing ------------------------

    /// beforeInitialize must revert for any sender other than the wired Graduator.
    /// This is the DoS-defense: without the gate, an attacker who spots an imminent
    /// graduation in mempool could front-run `PoolManager.initialize` on the
    /// predictable pool key, permanently blocking the real graduation from working.
    function test_BeforeInitialize_RevertsForUnauthorizedSender() public {
        vm.prank(mockPM);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__UnauthorizedInitializer.selector, swapper));
        hook.beforeInitialize(swapper, _key(), 0);
    }

    /// setInitializer is a one-shot bootstrap: after the first call the deployer has
    /// no further authority. Second call reverts with InitializerAlreadySet.
    function test_SetInitializer_LocksAfterFirstCall() public {
        // setUp() already wired graduator — second call must revert.
        vm.expectRevert(MultiHookHost.MultiHookHost__InitializerAlreadySet.selector);
        hook.setInitializer(makeAddr("attackerGraduator"));
    }

    /// Only the wallet that deployed the hook can call setInitializer.
    function test_SetInitializer_OnlyDeployer() public {
        MultiHookHost fresh = new MultiHookHost(IPoolManager(mockPM), platform, creator, 100, 100, address(this));
        vm.prank(swapper);
        vm.expectRevert(MultiHookHost.MultiHookHost__NotDeployer.selector);
        fresh.setInitializer(graduator);
    }

    /// Between hook deploy and setInitializer, the hook is intentionally unusable —
    /// beforeInitialize reverts for everyone. This closes the race window: an
    /// attacker cannot bootstrap a pool with rogue config before we wire the
    /// Graduator.
    function test_BeforeInitialize_RevertsBeforeInitializerSet() public {
        MultiHookHost fresh = new MultiHookHost(IPoolManager(mockPM), platform, creator, 100, 100, address(this));
        vm.prank(mockPM);
        vm.expectRevert(MultiHookHost.MultiHookHost__InitializerNotSet.selector);
        fresh.beforeInitialize(graduator, _key(), 0);
    }
}
