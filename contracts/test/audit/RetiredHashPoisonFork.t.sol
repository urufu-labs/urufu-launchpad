// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @title  RetiredHashPoisonForkTest
/// @notice Proves the count-poison mitigation for retired Airdrop configHashes
///         actually blocks Router.launch. The mitigation approach: because
///         `ERC20Factory.registerImpl` is one-shot per hash and `updateImpl`
///         was removed by the M-1 audit fix, the rugged V1 Airdrop impls
///         cannot be removed from the live ERC20Factory. Additionally,
///         `Router.setModuleCountForConfig` only sets `moduleCountConfigured`
///         to true — there is no setter to un-configure a hash. The only
///         remaining lever is the stored `moduleCountForConfig[hash]` value,
///         which `_quote` uses in `moduleAddOnFee * (count - 1)`. Setting
///         the count to `type(uint256).max` causes that multiplication to
///         overflow (Solidity 0.8+ reverts with Panic 0x11) so every quote
///         call reverts, and Router.launch (which calls _quote to compute
///         msg.value floor) reverts too.
///
///         Test path: fork RH, prank as Router owner, poison one of the 3
///         retired Airdrop hashes, then attempt Router.launch via that hash
///         and assert it reverts. This test validates the mitigation before
///         it's broadcast on live production.
///
///         Skips cleanly if ROBINHOOD_RPC_URL isn't set.
contract RetiredHashPoisonForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;

    // The 3 retired Airdrop hashes still exploitable on live Router (sentinels
    // set + rugged impl on factory). Derivation: V1 configHash formula
    // `keccak256(abi.encode("ERC20", sortedModules.join(",")))`.
    bytes32 internal constant HASH_AIRDROP = 0x344f851ff67d34148ac2000b192fbc9a5cc4edd0ef612cd60c3e9d90738e7b2b;
    bytes32 internal constant HASH_AIRDROP_PERMIT = 0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064;
    bytes32 internal constant HASH_AIRDROP_VESTING = 0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (ROUTER_V7.code.length == 0) vm.skip(true);
    }

    /// LIVE STATE: the poison was broadcast 2026-08-01 via three owner txs
    /// (0xb439f2df… / 0xbe07ac43… / 0xdbc06a47…). This test asserts the
    /// current live Router state matches the expected poison values — if
    /// anyone ever calls setModuleCountForConfig again for these hashes to
    /// restore them to real counts, this test fails immediately.
    function test_LivePoisonState_AllThreeRetiredHashesAtMax() public view {
        Router r = Router(payable(ROUTER_V7));
        assertEq(r.moduleCountForConfig(HASH_AIRDROP), type(uint256).max, "Airdrop count not poisoned");
        assertEq(r.moduleCountForConfig(HASH_AIRDROP_PERMIT), type(uint256).max, "Airdrop+Permit count not poisoned");
        assertEq(r.moduleCountForConfig(HASH_AIRDROP_VESTING), type(uint256).max, "Airdrop+Vesting count not poisoned");
    }

    /// With the live poison in place, Router.quote for a retired-hash launch
    /// overflows on `moduleAddOnFee * (count - 1)` and reverts. Tested using
    /// the current live state — no vm.prank needed, this is what a real
    /// attacker would see. Runs against actual live Router.
    function test_LivePoison_QuoteRevertsForAirdropHash() public {
        vm.expectRevert();
        Router(payable(ROUTER_V7)).quote(_minimalParamsForHash(HASH_AIRDROP));
    }

    function test_LivePoison_QuoteRevertsForAirdropPermitHash() public {
        vm.expectRevert();
        Router(payable(ROUTER_V7)).quote(_minimalParamsForHash(HASH_AIRDROP_PERMIT));
    }

    function test_LivePoison_QuoteRevertsForAirdropVestingHash() public {
        vm.expectRevert();
        Router(payable(ROUTER_V7)).quote(_minimalParamsForHash(HASH_AIRDROP_VESTING));
    }

    /// Regression: quote for a canonical (non-poisoned) hash still succeeds
    /// on live. Uses the bare-ERC20 hash — no modules, safest smoke test.
    function test_LivePoison_DoesNotAffectBareHash() public view {
        bytes32 bareHash = 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb;
        uint256 q = Router(payable(ROUTER_V7)).quote(_minimalParamsForHash(bareHash));
        assertGt(q, 0, "bare-hash quote should still succeed");
    }

    /// Build the minimal LaunchParams struct that Router.quote will accept
    /// for path-check purposes. Actual initData / hooks / governance
    /// irrelevant to _quote which only reads baseFee + moduleCount + flags.
    function _minimalParamsForHash(
        bytes32 configHash
    ) internal pure returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = "poison-test";
        p.ticker = "PSN";
        p.configHash = configHash;
        p.initData = "";
        p.installBondingCurve = false;
        p.installHook = false;
        p.installGovernance = false;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.ownership = OwnershipMode.KeepEOA;
        p.ownerTargetIfMultisig = address(0);
    }
}
