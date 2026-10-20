// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

import {FairTestBase, IERC20Min, AggregatorExecutor} from "./FairTestBase.sol";

/// Router that swaps FIRST and pulls the seller's tokens only after (the Universal
/// Router + Permit2 order). The creator's balance is still full during the hook
/// callbacks, which is exactly the case the pending-fee design exists for.
contract LatePayRouter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(
        IPoolManager _pm
    ) {
        pm = _pm;
    }

    function sellExactIn(
        PoolKey calldata key,
        uint256 amount
    ) external {
        pm.unlock(abi.encode(key, amount, msg.sender));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        (PoolKey memory key, uint256 amount, address user) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta d = pm.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 ethOut = uint256(uint128(int128(int256(BalanceDelta.unwrap(d) >> 128))));
        pm.sync(key.currency1);
        IERC20Min(Currency.unwrap(key.currency1)).transferFrom(user, address(pm), amount);
        pm.settle();
        pm.take(key.currency0, user, ethOut);
        return "";
    }
}

/// Creator wallet that dumps and then tries to claim its fees in the same tx.
contract DumpAndClaimCreator is IUnlockCallback {
    FairHookHost public hook;
    IPoolManager public pm;

    constructor(
        FairHookHost h,
        IPoolManager p
    ) {
        hook = h;
        pm = p;
    }

    function launch(
        address factory,
        string calldata name
    ) external payable returns (address token, address curve, address batch) {
        (bool ok, bytes memory ret) =
            factory.call{value: msg.value}(abi.encodeWithSignature("launch(string,string)", name, "DUMP"));
        require(ok, "launch");
        (token, curve, batch) = abi.decode(ret, (address, address, address));
    }

    /// Sell `amount` through an aggregator, then claim in the same tx.
    function dumpAndClaim(
        AggregatorExecutor agg,
        PoolKey calldata key,
        address token,
        uint256 amount
    ) external returns (uint256 ethClaimed) {
        IERC20Min(token).approve(address(agg), amount);
        agg.swap(key, false, -int256(amount), amount);
        uint256 before = address(this).balance;
        try hook.claimCreatorFees(_id(key)) {} catch {}
        ethClaimed = address(this).balance - before;
    }

    /// Same, but through a pay-after-swap router: the dump swap itself sees a full
    /// balance, so only the claim's own check (outside the unlock) can catch it.
    function dumpLateAndClaim(
        LatePayRouter r,
        PoolKey calldata key,
        address token,
        uint256 amount
    ) external returns (uint256 ethClaimed) {
        IERC20Min(token).approve(address(r), amount);
        r.sellExactIn(key, amount);
        uint256 before = address(this).balance;
        try hook.claimCreatorFees(_id(key)) {} catch {}
        ethClaimed = address(this).balance - before;
    }

    /// Try to claim from INSIDE a PoolManager unlock (mid-swap). Must revert.
    function claimMidUnlock(
        PoolKey calldata key
    ) external {
        pm.unlock(abi.encode(_id(key)));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        PoolId id = abi.decode(data, (PoolId));
        hook.claimCreatorFees(id);
        return "";
    }

    function _id(
        PoolKey calldata key
    ) private pure returns (PoolId) {
        return PoolIdLibrary.toId(key);
    }

    receive() external payable {}
}

/// Tests for the four loophole fixes of 2026-10-20 (docs/REVIEW-fair-launch-2026-10-20.md):
///   L-2 a dev's own dumping trade no longer earns them that trade's fee
///   L-3 no holdings, no fee
///   L-4 burn bank cannot be sandwiched, and each burn is size-capped
/// (L-1, wallets funded by the dev, is an off-chain warning on the trade page.)
/// forge-config: default.isolate = true
contract FairLaneLoopholesTest is FairTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal trader = makeAddr("lh-trader");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
    }

    function _graduated(
        string memory name,
        uint256 creatorDeposit
    ) internal returns (address token, PoolKey memory key) {
        FairBondingCurve curve;
        OpeningBatch batch;
        (token, curve, batch) = _launch(name, creatorDeposit);
        _warpPast(batch);
        batch.settle();
        key = _graduate(curve);
        vm.warp(vm.getBlockTimestamp() + 301); // past the sniper tax
    }

    function _buy(
        PoolKey memory key,
        uint256 eth
    ) internal {
        vm.deal(trader, trader.balance + eth);
        vm.prank(trader);
        agg.swap{value: eth}(key, true, -int256(eth), eth);
    }

    // ================================================================ L-2

    function test_L2_DumpTradeFee_IsClawedBack_NextTx() public {
        (address token, PoolKey memory key) = _graduated("Clawback", 0.5 ether);
        PoolId id = key.toId();
        _buy(key, 0.1 ether);
        hook.pokeForfeit(id); // confirms the honest buy's fee
        uint256 confirmedTok = _creatorClaimable(token, false);
        assertGt(confirmedTok, 0);

        // Creator dumps half through a pay-after-swap router (Uniswap app order), so the
        // hook still sees the full balance during the dump. Exact-in sell: fee in ETH.
        LatePayRouter late = new LatePayRouter(pm);
        uint256 half = _bal(token, creator) / 2;
        vm.prank(creator);
        IERC20Min(token).approve(address(late), half);
        vm.prank(creator);
        late.sellExactIn(key, half);
        (uint128 pEth,,,) = hook.creatorFees(id);
        assertGt(pEth, 0, "dump fee should sit as pending");
        (,,,,,,, bool forfeitedYet,) = hook.pools(id);
        assertFalse(forfeitedYet, "cannot be known until the dump settles");

        // Next tx (anyone's swap) sees the dump: forfeit + the dump's fee is burned.
        uint256 bank0 = hook.bankedEth(id);
        _buy(key, 0.01 ether);
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "dump not caught");
        (uint128 pEthAfter, uint128 pTokAfter, uint128 cEth, uint128 cTok) = hook.creatorFees(id);
        assertEq(pEthAfter, 0);
        assertEq(pTokAfter, 0);
        assertEq(cEth, 0, "dump fee reached the creator");
        assertEq(cTok, confirmedTok, "fees confirmed before the dump must stay claimable");
        assertGe(hook.bankedEth(id) - bank0, pEth, "dump fee not sent to the burn bank");
        _assertHookSolvent(token, creator);
    }

    function test_L2_DumpAndClaimSameTx_GetsNothingFromDump() public {
        DumpAndClaimCreator c = new DumpAndClaimCreator(hook, pm);
        vm.deal(address(this), 1 ether);
        (address token, address cv, address b) = c.launch{value: 0.5 ether}(address(factory), "DumpClaim");
        _warpPast(OpeningBatch(payable(b)));
        OpeningBatch(payable(b)).settle();
        PoolKey memory key = _graduate(FairBondingCurve(payable(cv)));
        vm.warp(vm.getBlockTimestamp() + 301);
        PoolId id = key.toId();
        uint256 half = _bal(token, address(c)) / 2;
        uint256 got = c.dumpAndClaim(agg, key, token, half);
        assertEq(got, 0, "creator claimed its own dump fee in the same tx");
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "claim's own check should catch the settled dump");
        (uint128 pEth,, uint128 cEth,) = hook.creatorFees(id);
        assertEq(pEth, 0);
        assertEq(cEth, 0);
    }

    function test_L2_LateDumpAndClaimSameTx_GetsNothingFromDump() public {
        DumpAndClaimCreator c = new DumpAndClaimCreator(hook, pm);
        vm.deal(address(this), 1 ether);
        (address token, address cv, address b) = c.launch{value: 0.5 ether}(address(factory), "LateDump");
        _warpPast(OpeningBatch(payable(b)));
        OpeningBatch(payable(b)).settle();
        PoolKey memory key = _graduate(FairBondingCurve(payable(cv)));
        vm.warp(vm.getBlockTimestamp() + 301);
        PoolId id = key.toId();
        LatePayRouter late = new LatePayRouter(pm);
        uint256 bank0 = hook.bankedEth(id);
        uint256 got = c.dumpLateAndClaim(late, key, token, _bal(token, address(c)) / 2);
        assertEq(got, 0, "creator claimed its own dump fee in the same tx");
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited);
        assertEq(_creatorEarned(token, true), 0);
        assertGt(hook.bankedEth(id), bank0, "dump fee not burned");
    }

    function test_L2_ClaimAndPokeRefuseMidUnlock() public {
        DumpAndClaimCreator c = new DumpAndClaimCreator(hook, pm);
        vm.deal(address(this), 1 ether);
        (, address cv, address b) = c.launch{value: 0.5 ether}(address(factory), "MidUnlock");
        _warpPast(OpeningBatch(payable(b)));
        OpeningBatch(payable(b)).settle();
        PoolKey memory key = _graduate(FairBondingCurve(payable(cv)));
        vm.expectRevert(FairHookHost.FairHookHost__PoolManagerUnlocked.selector);
        c.claimMidUnlock(key);
    }

    function test_L2_AggregatorDump_CaughtInTheDumpItself() public {
        (address token, PoolKey memory key) = _graduated("AggDump", 0.5 ether);
        PoolId id = key.toId();
        uint256 half = _bal(token, creator) / 2;
        uint256 bank0 = hook.bankedEth(id);
        vm.startPrank(creator);
        IERC20Min(token).approve(address(agg), half);
        agg.swap(key, false, -int256(half), half); // tokens leave the wallet before the swap
        vm.stopPrank();
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertTrue(forfeited, "pull-first dump not caught immediately");
        assertEq(_creatorEarned(token, true), 0);
        assertGt(hook.bankedEth(id), bank0, "dump fee not burned");
    }

    function test_L2_HonestCreatorStillGetsPaid() public {
        (address token, PoolKey memory key) = _graduated("Honest", 0.5 ether);
        PoolId id = key.toId();
        _buy(key, 0.1 ether);
        _buy(key, 0.1 ether); // second tx confirms the first tx's fee
        uint256 before = _bal(token, creator);
        hook.claimCreatorFees(id); // runs its own check and confirms the rest
        assertGt(_bal(token, creator) - before, 0, "honest creator not paid");
        assertEq(_creatorEarned(token, false), 0);
        (,,,,,,, bool forfeited,) = hook.pools(id);
        assertFalse(forfeited);
    }

    // ================================================================ L-3

    function test_L3_ZeroHoldingCreator_EarnsNothing() public {
        (address token, PoolKey memory key) = _graduated("ZeroHold", 0);
        PoolId id = key.toId();
        (,,,,,,, bool forfeited, uint256 baseline) = hook.pools(id);
        assertTrue(forfeited, "no holdings must mean no fee");
        assertEq(baseline, 0);
        uint256 dead0 = _bal(token, DEAD);
        _buy(key, 0.1 ether);
        assertEq(_creatorEarned(token, false), 0);
        assertGt(_bal(token, DEAD), dead0, "creator share not burned");
    }

    function test_L3_DustHoldingCreator_EarnsNothing() public {
        // 1e9 wei of ETH buys far less than 0.1% of supply.
        (address token, PoolKey memory key) = _graduated("DustHold", 1e9);
        (,,,,,,, bool forfeited,) = hook.pools(key.toId());
        assertTrue(forfeited, "dust holder treated as holding");
        assertGt(_bal(token, creator), 0);
    }

    function test_L3_SmallRealHolding_StillEarns() public {
        // 0.01 ETH in the batch is ~0.4% of supply at the batch price.
        (address token, PoolKey memory key) = _graduated("SmallHold", 0.01 ether);
        (,,,,,,, bool forfeited,) = hook.pools(key.toId());
        assertFalse(forfeited, "a real (small) holder should earn");
        _buy(key, 0.1 ether);
        assertGt(_creatorEarned(token, false), 0);
    }

    // ================================================================ L-4

    function test_L4_SandwichedBurnRefused() public {
        (, PoolKey memory key) = _taxedBank("Sandwich");
        PoolId id = key.toId();
        assertGt(hook.bankedEth(id), 0);
        vm.warp(vm.getBlockTimestamp() + 1);

        // Attacker front-runs in the same second with a big buy, then triggers the burn.
        address attacker = makeAddr("lh-attacker");
        vm.deal(attacker, 5 ether);
        vm.prank(attacker);
        agg.swap{value: 1 ether}(key, true, -1 ether, 1 ether);
        vm.expectRevert();
        hook.burnBank(id, 0);

        // Next second (no front-run in it): the burn runs.
        vm.warp(vm.getBlockTimestamp() + 1);
        assertGt(hook.burnBank(id, 0), 0);
    }

    function test_L4_EachBurnIsImpactCapped_AndPerSecondBounded() public {
        (, PoolKey memory key) = _taxedBank("Capped");
        PoolId id = key.toId();
        vm.warp(vm.getBlockTimestamp() + 1);
        (uint160 s0,,,) = pm.getSlot0(id);
        uint256 bank0 = hook.bankedEth(id);
        hook.burnBank(id, 0);
        (uint160 s1,,,) = pm.getSlot0(id);
        assertGe(uint256(s1) * 10_000, uint256(s0) * (10_000 - 51), "one burn moved price past the cap");
        assertGt(hook.bankedEth(id), 0, "cap should leave the rest banked");
        assertLt(hook.bankedEth(id), bank0);
        // More burns in the SAME second stop once the total move passes the bound.
        bool refused;
        for (uint256 i = 0; i < 6 && hook.bankedEth(id) > 0; i++) {
            try hook.burnBank(id, 0) {}
            catch {
                refused = true;
                break;
            }
        }
        assertTrue(refused, "burns in one second were not bounded");
        (uint160 s2,,,) = pm.getSlot0(id);
        assertGe(uint256(s2) * 10_000, uint256(s0) * (10_000 - 160), "per-second burn impact too large");
    }

    // ================================================================ helpers

    /// A graduated pool whose bank holds sniper-tax ETH from a sell in the tax window.
    function _taxedBank(
        string memory name
    ) internal returns (address token, PoolKey memory key) {
        FairBondingCurve curve;
        OpeningBatch batch;
        (token, curve, batch) = _launch(name, 0.5 ether);
        _warpPast(batch);
        batch.settle();
        key = _graduate(curve);
        address whale = makeAddr("fair-grad-whale");
        uint256 amt = _bal(token, whale) / 3;
        vm.startPrank(whale);
        IERC20Min(token).approve(address(agg), amt);
        agg.swap(key, false, -int256(amt), amt);
        vm.stopPrank();
    }
}
