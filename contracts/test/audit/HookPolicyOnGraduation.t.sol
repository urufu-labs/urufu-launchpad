// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

import {PoolId} from "v4-core/types/PoolId.sol";

/// @title  HookPolicyOnGraduationTest
/// @notice GH-9: `GraduatorV2 -> MultiHookHost` flow must emit `HookPolicySet`
///         with the exact canonical struct at graduation. The wider
///         `ModuleLaunchGraduationTest._graduateAndSwap` helper covers the
///         same invariant via a post-hoc `poolPolicy(id)` read (which is
///         equivalent state evidence because the emit is coupled to the
///         mapping write) — this file uses `vm.recordLogs` + a direct log
///         scan to prove the EVENT ITSELF fires with the pinned topic + data
///         so aggregators indexing by `HookPolicySet` cannot silently miss
///         it. Kept separate to keep the shared helper cheap.
contract HookPolicyOnGraduationTest is LocalV4Stack {
    address internal launcher = makeAddr("gh9-launcher");
    address internal buyer = makeAddr("gh9-buyer");

    function setUp() public {
        _deployStack();
        vm.deal(buyer, 500 ether);
    }

    /// Positive case: the launcher IS the per-pool creator recipient.
    function test_Graduation_EmitsHookPolicySet_WithLauncherAsRecipient() public {
        (StackToken tk, BondingCurve c) = _newTokenWithCurve("GH9 Launcher", "GH9L", launcher);
        _assertHookPolicySetEmitted(address(tk), c, launcher);
    }

    /// Negative case: launcher == address(0). The Graduator skips setCreator
    /// entirely, and the fallback `constructor.creator` (== admin here) must
    /// end up in the emitted policy's creatorRecipient slot.
    function test_Graduation_EmitsHookPolicySet_WithFallbackRecipient() public {
        (StackToken tk, BondingCurve c) = _newTokenWithCurve("GH9 Fallback", "GH9F", address(0));
        // constructor creator == admin (per LocalV4Stack._deployStack)
        _assertHookPolicySetEmitted(address(tk), c, admin);
    }

    // --- helpers ------------------------------------------------------------

    function _assertHookPolicySetEmitted(
        address token,
        BondingCurve curve,
        address expectedRecipient
    ) internal {
        PoolId id = _poolIdFor(token);
        uint256 expectedLaunchBlock = block.number;
        // Snapshot the constructor immutables the hook will echo into the
        // emitted policy. Pinned into an expected struct below.
        uint16 expectedPlatformBps = mhh.platformBps();
        uint16 expectedCreatorBps = mhh.creatorBps();

        vm.recordLogs();
        _driveToGraduation(curve);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 topic = MultiHookHost.HookPolicySet.selector;
        uint256 hits;
        MultiHookHost.PoolPolicy memory decoded;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(mhh)) continue;
            if (logs[i].topics.length == 0 || logs[i].topics[0] != topic) continue;
            // topic1 == indexed poolId
            assertEq(logs[i].topics[1], PoolId.unwrap(id), "GH-9: emitted poolId mismatch");
            decoded = abi.decode(logs[i].data, (MultiHookHost.PoolPolicy));
            hits++;
        }
        assertEq(hits, 1, "GH-9: HookPolicySet must fire exactly once per graduation");

        // Pin every field of the emitted struct.
        assertEq(uint256(decoded.antiSniperBlocks), 0, "GH-9: unexpected antiSniperBlocks");
        assertEq(uint256(decoded.buybackBurnBps), 0, "GH-9: unexpected buybackBurnBps");
        assertEq(uint256(decoded.platformFeeBps), uint256(expectedPlatformBps), "GH-9: platformFeeBps mismatch");
        assertEq(uint256(decoded.creatorFeeBps), uint256(expectedCreatorBps), "GH-9: creatorFeeBps mismatch");
        assertEq(decoded.creatorRecipient, expectedRecipient, "GH-9: creatorRecipient mismatch");
        assertEq(uint256(decoded.launchBlock), expectedLaunchBlock, "GH-9: launchBlock mismatch");
        assertTrue(decoded.immutableAfterLaunch, "GH-9: immutableAfterLaunch not set");

        // And the mapping accessor returns the same tuple.
        (
            uint16 mAnti,
            uint16 mBurn,
            uint16 mPlat,
            uint16 mCreat,
            address mRecipient,
            uint64 mLaunchBlock,
            bool mFrozen
        ) = mhh.poolPolicy(id);
        assertEq(uint256(mAnti), uint256(decoded.antiSniperBlocks));
        assertEq(uint256(mBurn), uint256(decoded.buybackBurnBps));
        assertEq(uint256(mPlat), uint256(decoded.platformFeeBps));
        assertEq(uint256(mCreat), uint256(decoded.creatorFeeBps));
        assertEq(mRecipient, decoded.creatorRecipient);
        assertEq(uint256(mLaunchBlock), uint256(decoded.launchBlock));
        assertEq(mFrozen, decoded.immutableAfterLaunch);
    }

    function _driveToGraduation(
        BondingCurve curve
    ) internal {
        uint256 step = 0.5 ether;
        for (uint256 i = 0; i < 80 && !curve.graduated(); ++i) {
            uint256 need = curve.graduationTargetEth() - curve.ethReserve();
            uint256 amt = need + (need / 50) + 1;
            if (amt > step) amt = step;
            vm.prank(buyer);
            try curve.buy{value: amt}(0) {}
            catch {
                step /= 2;
                if (step == 0) break;
            }
        }
        assertTrue(curve.graduated(), "helper: curve did not graduate");
    }
}
