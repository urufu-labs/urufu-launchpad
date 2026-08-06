// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
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

    function test_Permissions_FeeRedirectAndGates() public view {
        BaseHook.Permissions memory p = hook.getHookPermissions();
        // Audit-round-2 FINDING 5: beforeRemoveLiquidity dropped so third-party
        // LPs can add + remove freely. Graduation LP is locked structurally by
        // the Graduator (no negative-liquidityDelta path in GraduatorV2), not by
        // this hook. beforeInitialize (stamp launchBlock + initializer gate) +
        // beforeSwap (anti-sniper + exact-output burn reject) remain.
        assertTrue(p.beforeInitialize);
        assertFalse(p.beforeRemoveLiquidity);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.afterInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterRemoveLiquidity);
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
    /// After beforeInitialize fires it stamps launchBlock AND freezes the
    /// canonical `poolPolicy` (GH-9). The freeze check is ordered so the
    /// canonical `PolicyFrozen(id)` selector wins over the legacy
    /// `ConfigFrozen` — aggregators + auditors see the same selector that
    /// documents the state.
    function test_SetCreator_StoresPerPoolAndFreezesAfterInit() public {
        PoolId id = _key().toId();
        assertEq(hook.creators(id), address(0));

        // URU-A12: setCreator is onlyInitializer — must prank as the wired
        // graduator address (the initializer, see setUp) to call it.
        vm.prank(graduator);
        hook.setCreator(id, launcher);
        assertEq(hook.creators(id), launcher);

        // After the pool initializes, setCreator becomes uncallable for this poolId.
        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        vm.prank(graduator);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__PolicyFrozen.selector, id));
        hook.setCreator(id, makeAddr("other"));
    }

    /// URU-A12: setCreator is `onlyInitializer`. When called by the initializer
    /// with address(0), it still reverts ZeroAddress (input validation preserved).
    function test_SetCreator_RevertsOnZeroAddress() public {
        vm.prank(graduator);
        vm.expectRevert(MultiHookHost.MultiHookHost__ZeroAddress.selector);
        hook.setCreator(_key().toId(), address(0));
    }

    /// URU-A12: setCreator called by anyone other than the wired initializer
    /// reverts NotInitializer, closing the pre-audit hole where any address
    /// could plant a creator recipient on an unclaimed pool.
    function test_SetCreator_RevertsFromUnauthorizedCaller() public {
        vm.prank(swapper);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__NotInitializer.selector, swapper));
        hook.setCreator(_key().toId(), launcher);
    }

    /// URU-A12 (round 3 gap coverage): setPoolConfig called by anyone other
    /// than the wired initializer reverts NotInitializer — symmetric with the
    /// setCreator gate. Prior to URU-A12 both setters were `external` with
    /// no auth, so any address could plant a config on an unclaimed pool.
    function test_SetPoolConfig_RevertsFromUnauthorizedCaller() public {
        vm.prank(swapper);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__NotInitializer.selector, swapper));
        hook.setPoolConfig(_key().toId(), 100, 100);
    }

    /// URU-A12: setPoolConfig with `antiSniperBlocks > MAX_ANTI_SNIPER_BLOCKS`
    /// reverts AntiSniperTooLong. Prevents a direct MHH call from locking pool
    /// swaps for years — mirrors the same cap on Router.launch's params.
    function test_SetPoolConfig_AntiSniperTooLong_Reverts() public {
        uint32 max = hook.MAX_ANTI_SNIPER_BLOCKS();
        vm.prank(graduator);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__AntiSniperTooLong.selector, max + 1, max));
        hook.setPoolConfig(_key().toId(), max + 1, 0);
    }

    /// Boundary: exactly the cap is accepted, one above reverts.
    function test_SetPoolConfig_AntiSniperAtCap_Accepted() public {
        uint32 max = hook.MAX_ANTI_SNIPER_BLOCKS();
        vm.prank(graduator);
        hook.setPoolConfig(_key().toId(), max, 0);
        // No revert = accepted; the state is written and readable via poolConfig.
        (, uint32 stored,) = hook.poolConfig(_key().toId());
        assertEq(stored, max);
    }

    // -----------------------------------------------------------------------
    // URU-P1-M04: exact-output BUY + buybackBurnBps > 0 must revert. The old
    // implementation applied the "burn" slice to the unspecified side which,
    // on exact-output BUYs, is ETH input — so ETH was destroyed while the
    // BuybackBurned event still reported the launched-token currency. That's
    // a misreporting bug and a real burn-of-wrong-asset. The new behavior:
    // reject the mode outright in beforeSwap. Non-BUY swaps + BUYs with the
    // feature disabled still pass; exact-input BUYs still burn tokens as
    // originally specified (covered by test_AfterSwap_* above).
    // -----------------------------------------------------------------------
    function test_BeforeSwap_ExactOutputBuyRevertsWhenBuybackBurnEnabled() public {
        vm.prank(graduator);
        hook.setPoolConfig(_key().toId(), 0, 100);

        // amountSpecified > 0 = exact-output. zeroForOne = true = BUY.
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: int256(1000), sqrtPriceLimitX96: 0});
        vm.prank(mockPM);
        vm.expectRevert(MultiHookHost.MultiHookHost__ExactOutputBuyUnsupportedWithBurn.selector);
        hook.beforeSwap(swapper, _key(), params, "");
    }

    /// URU-P1-M04: with buybackBurn disabled, exact-output BUYs still pass
    /// through beforeSwap. Feature is opt-in, so pools that don't want the
    /// restriction stay unaffected.
    function test_BeforeSwap_ExactOutputBuyAllowedWhenBuybackBurnDisabled() public {
        // Default poolConfig has buybackBurnBps = 0 — no need to setPoolConfig.
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: int256(1000), sqrtPriceLimitX96: 0});
        vm.prank(mockPM);
        // No revert expected. Ignore return values.
        hook.beforeSwap(swapper, _key(), params, "");
    }

    /// URU-P1-M04 regression: exact-input BUYs still burn OUTPUT TOKENS
    /// (unspecified currency = token) exactly as before. This is the
    /// spirit-preserving path — buyback-burn destroys launched-token supply
    /// on acquisition, not ETH.
    function test_AfterSwap_ExactInputBuyStillBurnsOutputTokens() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, 0, 100); // buybackBurnBps = 100 = 1%

        // Exact-input BUY: swapper spends 1000 ETH (amountSpecified < 0),
        // pool returns +1000 token (delta.amount1 > 0). Unspecified = token.
        BalanceDelta delta = toBalanceDelta(-1000, 1000);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: int256(-1000), sqrtPriceLimitX96: 0});

        // Expect take() of fee (2%) + burn (1%) = 30 tokens on c1.
        vm.mockCall(mockPM, abi.encodeWithSelector(IPoolManager.take.selector), "");
        vm.expectCall(mockPM, abi.encodeCall(IPoolManager.take, (c1, address(hook), 30)));

        // For the burn transfer at the end. c1 is currency(0x2) — an ERC-20
        // stand-in — so Currency.transfer routes through the ERC-20 path.
        vm.mockCall(
            Currency.unwrap(c1),
            abi.encodeWithSelector(
                bytes4(keccak256("transfer(address,uint256)")),
                address(0x000000000000000000000000000000000000dEaD),
                uint256(10)
            ),
            abi.encode(true)
        );

        vm.prank(mockPM);
        (, int128 hookDelta) = hook.afterSwap(swapper, _key(), params, delta, "");
        // hookDelta = fee (20) + burn (10) = 30 on unspecified side.
        assertEq(hookDelta, int128(30), "hookDelta should include both fee and burn");
    }

    /// After setCreator(launcher), afterSwap must accrue the creator share to
    /// `launcher` instead of the constructor-provided fallback `creator`. This is the
    /// core V2 behavior — per-launch creator revenue.
    function test_AfterSwap_AccruesToPerPoolCreator() public {
        PoolId id = _key().toId();
        // URU-A12: setCreator is onlyInitializer.
        vm.prank(graduator);
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

    // =====================================================================
    // GH-9: canonical on-chain PoolPolicy + HookPolicySet event
    // =====================================================================
    // Aggregators trust the auto-generated `poolPolicy(id)` accessor + the
    // one-shot `HookPolicySet` event instead of stitching PoolConfigSet +
    // CreatorSet + hook constants together. Every test below pins EXACT
    // struct values and EXACT selectors — the auditor reads the struct
    // layout and the pin, not a "state changed" claim.
    // =====================================================================

    /// AC #9: unqueried poolIds return the zero PoolPolicy tuple. Proves the
    /// mapping accessor is safe to read for any id without producing false
    /// positives on a launched-pool detector.
    function test_PoolPolicy_UnknownPoolIdReturnsZero() public view {
        PoolId unknown = PoolId.wrap(keccak256("no-such-pool"));
        (
            uint16 antiSniperBlocks,
            uint16 buybackBurnBps,
            uint16 platformFeeBps,
            uint16 creatorFeeBps,
            address creatorRecipient,
            uint64 launchBlock,
            bool immutableAfterLaunch
        ) = hook.poolPolicy(unknown);
        assertEq(antiSniperBlocks, uint16(0));
        assertEq(buybackBurnBps, uint16(0));
        assertEq(platformFeeBps, uint16(0));
        assertEq(creatorFeeBps, uint16(0));
        assertEq(creatorRecipient, address(0));
        assertEq(launchBlock, uint64(0));
        assertFalse(immutableAfterLaunch);
    }

    /// AC #1, #3, #4, #5: `beforeInitialize` emits HookPolicySet(id, policy)
    /// exactly once, with policy fields matching the on-chain state at the
    /// graduation block. `vm.expectEmit(true,true,true,true,mhh)` pins the
    /// indexed topic AND the full struct data segment.
    function test_BeforeInitialize_EmitsHookPolicySetWithExactStruct() public {
        PoolId id = _key().toId();
        uint16 anti = 42;
        uint16 burn = 250;
        vm.prank(graduator);
        hook.setPoolConfig(id, uint32(anti), burn);
        vm.prank(graduator);
        hook.setCreator(id, launcher);

        // Roll forward so the launchBlock captured in the event is a
        // non-trivial, verifiable value (not the default `1` in tests).
        vm.roll(123_456);

        MultiHookHost.PoolPolicy memory expected = MultiHookHost.PoolPolicy({
            antiSniperBlocks: anti,
            buybackBurnBps: burn,
            platformFeeBps: 100,
            creatorFeeBps: 100,
            creatorRecipient: launcher,
            launchBlock: uint64(123_456),
            immutableAfterLaunch: true
        });

        vm.expectEmit(true, false, false, true, address(hook));
        emit MultiHookHost.HookPolicySet(id, expected);

        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);
    }

    /// AC #1, #2: after beforeInitialize the auto-generated `poolPolicy`
    /// accessor returns the exact struct that was emitted. Positive side of
    /// the state-change (paired with `test_PoolPolicy_UnknownPoolIdReturnsZero`
    /// above as the negative side).
    function test_PoolPolicy_MappingStoresExactStructAfterInit() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, uint32(7), uint16(500));
        vm.prank(graduator);
        hook.setCreator(id, launcher);
        vm.roll(999);

        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        (
            uint16 antiSniperBlocks,
            uint16 buybackBurnBps,
            uint16 platformFeeBps,
            uint16 creatorFeeBps,
            address creatorRecipient,
            uint64 launchBlock,
            bool immutableAfterLaunch
        ) = hook.poolPolicy(id);
        assertEq(antiSniperBlocks, uint16(7));
        assertEq(buybackBurnBps, uint16(500));
        assertEq(platformFeeBps, uint16(100));
        assertEq(creatorFeeBps, uint16(100));
        assertEq(creatorRecipient, launcher);
        assertEq(launchBlock, uint64(999));
        assertTrue(immutableAfterLaunch);
    }

    /// AC #5: pre-init the policy is not `immutableAfterLaunch`. Split from
    /// the positive test above so each state (unfrozen -> frozen) has its
    /// own assertion pair rather than one test conflating both.
    function test_PoolPolicy_NotFrozenBeforeInit() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, uint32(7), uint16(500));
        vm.prank(graduator);
        hook.setCreator(id, launcher);

        (,,,,, uint64 launchBlock, bool immutableAfterLaunch) = hook.poolPolicy(id);
        assertEq(launchBlock, uint64(0), "launchBlock must be unset pre-init");
        assertFalse(immutableAfterLaunch, "policy must be mutable pre-init");
    }

    /// AC #4: launchBlock in the emitted + stored policy equals
    /// `block.number` at the moment of graduation. Rolls between setter
    /// calls and beforeInitialize to prove the stamp captures the init
    /// block, not the setter block.
    function test_PoolPolicy_LaunchBlockEqualsBlockNumberAtInit() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, 0, 0);
        // Advance BETWEEN setter and init to guarantee the stamp came from
        // beforeInitialize and not from any earlier setter call.
        vm.roll(block.number + 50);
        uint256 initBlock = block.number;

        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        (,,,,, uint64 launchBlock,) = hook.poolPolicy(id);
        assertEq(launchBlock, uint64(initBlock));
    }

    /// AC #6: after graduation, `setPoolConfig` reverts with the canonical
    /// `PolicyFrozen(id)` selector — the frozen-policy signal wins over the
    /// legacy `ConfigFrozen` so aggregators + auditors read one selector.
    function test_SetPoolConfig_RevertsPolicyFrozenAfterInit() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, uint32(5), uint16(200));
        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        vm.prank(graduator);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__PolicyFrozen.selector, id));
        hook.setPoolConfig(id, uint32(9), uint16(300));
    }

    /// AC #6 sibling: `setCreator` reverts the same selector after init.
    /// (The parent `test_SetCreator_StoresPerPoolAndFreezesAfterInit`
    /// above covers this path too; keeping this shorter test around so a
    /// regression in setCreator alone surfaces without the composite
    /// scenario clouding the signal.)
    function test_SetCreator_RevertsPolicyFrozenAfterInit() public {
        PoolId id = _key().toId();
        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        vm.prank(graduator);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__PolicyFrozen.selector, id));
        hook.setCreator(id, makeAddr("post-launch-plant"));
    }

    /// AC #7: pre-graduation writes to `poolPolicy` via the initializer are
    /// permitted. Modeled as: `setPoolConfig(id, ...)` from the wired
    /// initializer succeeds (state changes are visible on the legacy
    /// PoolConfig accessor) BEFORE any beforeInitialize call has fired.
    function test_PoolPolicy_InitializerCanWritePreGraduation() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, uint32(11), uint16(750));
        (, uint32 storedAnti, uint16 storedBurn) = hook.poolConfig(id);
        assertEq(storedAnti, uint32(11));
        assertEq(storedBurn, uint16(750));

        vm.prank(graduator);
        hook.setCreator(id, launcher);
        assertEq(hook.creators(id), launcher);
        // Pre-init the canonical policy has not been stamped yet.
        (,,,,,, bool frozen) = hook.poolPolicy(id);
        assertFalse(frozen, "policy must not be frozen before init");
    }

    /// AC #8: unauthorized callers cannot write pre-graduation either. This
    /// duplicates coverage from `test_SetPoolConfig_RevertsFromUnauthorizedCaller`
    /// + `test_SetCreator_RevertsFromUnauthorizedCaller` above but frames
    /// the pin in the GH-9 policy vocabulary so the auditor can trace both
    /// the write path AND the freeze path from one linked pair of tests.
    function test_PoolPolicy_UnauthorizedCannotWritePreGraduation() public {
        PoolId id = _key().toId();
        vm.prank(swapper);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__NotInitializer.selector, swapper));
        hook.setPoolConfig(id, uint32(1), uint16(1));

        vm.prank(swapper);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__NotInitializer.selector, swapper));
        hook.setCreator(id, launcher);
    }

    /// A pool that skipped `setCreator` still emits a policy — the
    /// creatorRecipient falls back to the constructor `creator`, mirroring
    /// what `afterSwap` will actually credit. Aggregators must see the
    /// resolved recipient, not `address(0)`.
    function test_HookPolicySet_CreatorRecipientFallback() public {
        PoolId id = _key().toId();
        vm.prank(graduator);
        hook.setPoolConfig(id, 0, 0);

        MultiHookHost.PoolPolicy memory expected = MultiHookHost.PoolPolicy({
            antiSniperBlocks: 0,
            buybackBurnBps: 0,
            platformFeeBps: 100,
            creatorFeeBps: 100,
            creatorRecipient: creator, // constructor fallback
            launchBlock: uint64(block.number),
            immutableAfterLaunch: true
        });
        vm.expectEmit(true, false, false, true, address(hook));
        emit MultiHookHost.HookPolicySet(id, expected);

        vm.prank(mockPM);
        hook.beforeInitialize(graduator, _key(), 0);

        (,,,, address recipient,,) = hook.poolPolicy(id);
        assertEq(recipient, creator, "fallback creator not written to poolPolicy");
    }
}
