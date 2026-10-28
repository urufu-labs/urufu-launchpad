// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/PoolManager.sol";

import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {IFairLaunchFactoryView, SwarmVault} from "src/swarm/SwarmVault.sol";
import {SwarmVaultFactory} from "src/swarm/SwarmVaultFactory.sol";

import {FairTestBase, IERC20Min} from "../fair/FairTestBase.sol";

/// Tries to take its ETH twice by re-entering the vault from receive().
contract ReentrantMember {
    SwarmVault public vault;
    uint8 public mode; // 1 = leave, 2 = withdrawShare
    bool public reentered;

    constructor(
        SwarmVault v
    ) {
        vault = v;
    }

    function join() external payable {
        vault.join{value: msg.value}();
    }

    function approve() external {
        vault.approve();
    }

    function leave(
        uint8 m
    ) external {
        mode = m;
        vault.leave();
    }

    function withdraw(
        uint8 m
    ) external {
        mode = m;
        vault.withdrawShare();
    }

    receive() external payable {
        if (mode == 1) {
            mode = 0;
            reentered = true;
            vault.leave();
        } else if (mode == 2) {
            mode = 0;
            reentered = true;
            vault.withdrawShare();
        }
    }
}

/// A member contract with no way to receive ETH.
contract NoEthMember {
    SwarmVault public vault;

    constructor(
        SwarmVault v
    ) {
        vault = v;
    }

    function join() external payable {
        vault.join{value: msg.value}();
    }

    function approve() external {
        vault.approve();
    }

    function withdraw() external returns (uint256, uint256) {
        return vault.withdrawShare();
    }

    function pull(
        address to
    ) external {
        vault.withdrawEthOwed(to);
    }
}

/// @notice SwarmVault + factory on a local Fair stack (docs/PLAN-agents-and-swarms.md §4.4):
///         join / leave / vote math, quorum edges, deadlines, failed swarms, the batch
///         checks (lookalike tokens, missed window), payouts, reentrancy, wallet caps,
///         oversubscription refunds, rounding with tiny and 1,000-member pools, dust, fuzz.
contract SwarmVaultTest is FairTestBase {
    SwarmVaultFactory internal swarms;

    string internal constant NAME = "Swarm Coin";
    string internal constant TICKER = "SWRM";
    uint32 internal constant JOIN = 1 days;
    uint32 internal constant LAUNCH = 1 days;

    address internal proposer = makeAddr("proposer");
    address internal a = makeAddr("member-a");
    address internal b = makeAddr("member-b");
    address internal c = makeAddr("member-c");

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
        swarms = new SwarmVaultFactory(IFairLaunchFactoryView(address(factory)));
    }

    // ================================================================ helpers

    function _params() internal view returns (SwarmVaultFactory.Params memory) {
        return SwarmVaultFactory.Params({
            creator: creator,
            name: NAME,
            ticker: TICKER,
            joinSeconds: JOIN,
            launchSeconds: LAUNCH,
            quorumBps: 6000,
            minPool: 1 ether,
            maxPool: 0,
            minDeposit: 0.01 ether,
            metadataURI: "ipfs://idea"
        });
    }

    function _swarm() internal returns (SwarmVault v) {
        vm.prank(proposer);
        v = SwarmVault(payable(swarms.createSwarm(_params())));
    }

    function _join(
        SwarmVault v,
        address who,
        uint256 amount
    ) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        v.join{value: amount}();
    }

    function _approve(
        SwarmVault v,
        address who
    ) internal {
        vm.prank(who);
        v.approve();
    }

    /// A passing swarm: a 0.6, b 0.4 (both yes), c 0.5 (no) -> 1.0 / 1.5 = 66%.
    function _passingSwarm() internal returns (SwarmVault v) {
        v = _swarm();
        _join(v, a, 0.6 ether);
        _join(v, b, 0.4 ether);
        _join(v, c, 0.5 ether);
        _approve(v, a);
        _approve(v, b);
    }

    function _creatorLaunch(
        uint256 creatorDeposit
    ) internal returns (address token, OpeningBatch batch) {
        uint256 fee = factory.ethFeeFor(creator);
        vm.deal(creator, creator.balance + creatorDeposit + fee);
        vm.prank(creator);
        (address t,, address bAddr) = factory.launch{value: creatorDeposit + fee}(NAME, TICKER);
        return (t, OpeningBatch(payable(bAddr)));
    }

    function _toLaunch(
        SwarmVault v
    ) internal {
        vm.warp(uint256(v.joinDeadline()));
    }

    function _setWalletCap(
        uint256 cap
    ) internal {
        // Read first: a getter inside the call's arguments would use up the prank.
        uint256 supply = factory.defaultCurveSupply();
        uint256 vTok = factory.defaultVirtualTokenReserve();
        uint256 vEth = factory.defaultVirtualEthReserve();
        uint256 target = factory.defaultGraduationTargetEth();
        uint16 feeBps = factory.defaultTradeFeeBps();
        uint32 window = factory.batchWindowSecs();
        uint16 capBps = factory.batchCapBps();
        vm.prank(admin);
        factory.setDefaults(supply, vTok, vEth, target, feeBps, window, capBps, cap);
    }

    // ================================================================ factory

    function test_Factory_PredictsTheRealBatch() public {
        SwarmVault v = _swarm();
        assertTrue(swarms.isSwarm(address(v)));
        assertEq(v.creator(), creator);
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        assertEq(v.token(), token, "token predicted from (creator, name, ticker)");
        assertEq(v.batch(), address(batch), "batch predicted from (creator, name, ticker)");
    }

    function test_Factory_Bounds() public {
        SwarmVaultFactory.Params memory p = _params();
        p.creator = address(0);
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__ZeroAddress.selector);
        swarms.createSwarm(p);

        p = _params();
        p.name = "";
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadName.selector);
        swarms.createSwarm(p);

        p = _params();
        p.joinSeconds = 1 hours - 1;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadWindow.selector);
        swarms.createSwarm(p);

        p = _params();
        p.launchSeconds = 7 days + 1;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadWindow.selector);
        swarms.createSwarm(p);

        p = _params();
        p.minPool = 0.1 ether - 1;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadPool.selector);
        swarms.createSwarm(p);

        p = _params();
        p.maxPool = p.minPool - 1;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadPool.selector);
        swarms.createSwarm(p);

        p = _params();
        p.quorumBps = 4999;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadQuorum.selector);
        swarms.createSwarm(p);

        p = _params();
        p.quorumBps = 10_001;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadQuorum.selector);
        swarms.createSwarm(p);

        p = _params();
        p.minDeposit = 0.001 ether - 1;
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__BadMinDeposit.selector);
        swarms.createSwarm(p);
    }

    function test_Factory_RefusesATokenAlreadyLaunched() public {
        _creatorLaunch(0);
        vm.expectRevert(SwarmVaultFactory.SwarmVaultFactory__AlreadyLaunched.selector);
        swarms.createSwarm(_params());
    }

    function test_Init_OnlyFactoryOnce() public {
        SwarmVault v = _swarm();
        SwarmVault.Config memory cfg;
        vm.expectRevert(abi.encodeWithSelector(SwarmVault.SwarmVault__NotFactory.selector, address(this)));
        v.initialize(cfg);
        vm.prank(address(swarms));
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyInitialized.selector);
        v.initialize(cfg);
        SwarmVault impl = SwarmVault(payable(swarms.vaultImpl()));
        vm.prank(address(swarms));
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyInitialized.selector);
        impl.initialize(cfg);
    }

    // ================================================================ join / leave / vote

    function test_Join_MinDepositMaxPoolAndDeadline() public {
        SwarmVaultFactory.Params memory p = _params();
        p.maxPool = 2 ether;
        vm.prank(proposer);
        SwarmVault v = SwarmVault(payable(swarms.createSwarm(p)));

        vm.deal(a, 10 ether);
        vm.prank(a);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmVault.SwarmVault__BelowMinDeposit.selector, 0.01 ether - 1, 0.01 ether)
        );
        v.join{value: 0.01 ether - 1}();

        _join(v, a, 1.5 ether);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(SwarmVault.SwarmVault__AboveMaxPool.selector, 2.5 ether, 2 ether));
        v.join{value: 1 ether}();

        _toLaunch(v);
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__JoinClosed.selector);
        v.join{value: 0.1 ether}();
    }

    function test_Leave_FullRefundAndVoteWeightDrops() public {
        SwarmVault v = _passingSwarm();
        assertEq(v.approvedEth(), 1 ether);
        assertTrue(v.passed());
        uint256 before = a.balance;
        vm.prank(a);
        v.leave();
        assertEq(a.balance - before, 0.6 ether, "full ETH back");
        assertEq(v.pool(), 0.9 ether);
        assertEq(v.approvedEth(), 0.4 ether, "leaving drops the yes weight");
        assertFalse(v.approved(a));
        assertFalse(v.passed(), "0.4 / 0.9 is under 60%");
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__NotMember.selector);
        v.leave();
    }

    function test_Vote_RulesAndLaterDepositsCount() public {
        SwarmVault v = _swarm();
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__NotMember.selector);
        v.approve();
        _join(v, a, 0.5 ether);
        _approve(v, a);
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyApproved.selector);
        v.approve();
        _join(v, a, 0.5 ether);
        assertEq(v.approvedEth(), 1 ether, "deposits after a yes add to it");
        vm.prank(a);
        v.unapprove();
        assertEq(v.approvedEth(), 0);
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__NotApproved.selector);
        v.unapprove();
        _approve(v, a);
        _toLaunch(v);
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__JoinClosed.selector);
        v.unapprove();
    }

    function test_Quorum_ExactlyPassesOneWeiLessFails() public {
        SwarmVault v = _swarm();
        _join(v, a, 0.6 ether);
        _join(v, b, 0.4 ether);
        _approve(v, a);
        assertTrue(v.passed(), "exactly 60%");

        SwarmVault w = _swarmNamed("Swarm Two");
        _join(w, a, 0.6 ether - 1);
        _join(w, b, 0.4 ether + 1);
        _approve(w, a);
        assertFalse(w.passed(), "one wei under 60%");
    }

    function test_MinPool_NotMet() public {
        SwarmVault v = _swarm();
        _join(v, a, 1 ether - 1);
        _approve(v, a);
        assertFalse(v.passed(), "100% yes but under minPool");
        _toLaunch(v);
        _creatorLaunch(0);
        vm.expectRevert(abi.encodeWithSelector(SwarmVault.SwarmVault__VoteFailed.selector, 1 ether - 1, 1 ether - 1));
        v.joinBatch();
        vm.prank(a);
        v.leave();
        assertEq(a.balance, 1 ether - 1, "failed swarm: full refund");
    }

    // ================================================================ joinBatch

    function test_JoinBatch_Deadlines() public {
        SwarmVault v = _passingSwarm();
        vm.expectRevert(
            abi.encodeWithSelector(SwarmVault.SwarmVault__VoteStillOpen.selector, uint256(v.joinDeadline()))
        );
        v.joinBatch();
        // A launch at (or after) the launch deadline can't receive the pool.
        vm.warp(uint256(v.launchDeadline()));
        _creatorLaunch(0);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmVault.SwarmVault__LaunchDeadlinePassed.selector, uint256(v.launchDeadline()))
        );
        v.joinBatch();
    }

    /// Security review: a launch just before the launch deadline still gets its whole window.
    function test_JoinBatch_LaunchJustBeforeDeadline_StillJoins() public {
        SwarmVault v = _passingSwarm();
        vm.warp(uint256(v.launchDeadline()) - 1);
        (, OpeningBatch batch) = _creatorLaunch(0);
        vm.warp(uint256(v.launchDeadline()) + 30); // past the deadline, inside the batch window
        v.joinBatch();
        assertEq(batch.deposits(address(v)), 1.5 ether);
    }

    /// Security review: an early launch is fine when everyone in the pool voted yes...
    function test_JoinBatch_EarlyLaunch_UnanimousJoins() public {
        SwarmVault v = _swarm();
        _join(v, a, 0.6 ether);
        _join(v, b, 0.4 ether);
        _approve(v, a);
        _approve(v, b);
        (, OpeningBatch batch) = _creatorLaunch(0); // before joinDeadline
        v.joinBatch();
        assertEq(batch.deposits(address(v)), 1 ether);
        // ...and once joined, nobody can join or change votes.
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__JoinClosed.selector);
        v.unapprove();
        vm.deal(c, 1 ether);
        vm.prank(c);
        vm.expectRevert(SwarmVault.SwarmVault__JoinClosed.selector);
        v.join{value: 0.1 ether}();
    }

    /// ...but not when anyone in the pool hasn't voted yes: they can still leave.
    function test_JoinBatch_EarlyLaunch_NotUnanimousWaits() public {
        SwarmVault v = _passingSwarm(); // c is in the pool without a yes
        _creatorLaunch(0);
        vm.expectRevert(
            abi.encodeWithSelector(SwarmVault.SwarmVault__VoteStillOpen.selector, uint256(v.joinDeadline()))
        );
        v.joinBatch();
        uint256 before = c.balance;
        vm.prank(c);
        v.leave();
        assertEq(c.balance - before, 0.5 ether);
        v.joinBatch(); // now everyone left in the pool voted yes
        assertTrue(v.joined());
    }

    function test_JoinBatch_CreatorNeverLaunches_EveryoneLeaves() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        vm.expectRevert(SwarmVault.SwarmVault__BatchMismatch.selector);
        v.joinBatch();
        vm.warp(uint256(v.launchDeadline()) + 1);
        for (uint256 i; i < 3; i++) {
            address m = [a, b, c][i];
            uint256 dep = v.deposits(m);
            uint256 before = m.balance;
            vm.prank(m);
            v.leave();
            assertEq(m.balance - before, dep);
        }
        assertEq(address(v).balance, 0);
    }

    function test_JoinBatch_RefusesLookalikeFromAnotherCreator() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        // Someone else launches the exact same name and ticker.
        address imposter = makeAddr("imposter");
        vm.deal(imposter, 1 ether);
        vm.prank(imposter);
        (address fakeToken,, address fakeBatch) = factory.launch{value: factory.ethFeeFor(imposter)}(NAME, TICKER);
        assertTrue(fakeBatch != v.batch() && fakeToken != v.token(), "different addresses");
        vm.expectRevert(SwarmVault.SwarmVault__BatchMismatch.selector);
        v.joinBatch();
        assertEq(OpeningBatch(payable(fakeBatch)).deposits(address(v)), 0, "the lookalike got nothing");
    }

    function test_JoinBatch_MissedWindow_FullRefunds() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (, OpeningBatch batch) = _creatorLaunch(0);
        vm.warp(uint256(batch.closeTs()));
        vm.expectRevert(SwarmVault.SwarmVault__BatchWindowClosed.selector);
        v.joinBatch();
        uint256 before = c.balance;
        vm.prank(c);
        v.leave();
        assertEq(c.balance - before, 0.5 ether);
    }

    function test_JoinBatch_ThenNoJoinNoLeaveNoSecondJoin() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        assertTrue(v.joined());
        assertEq(batch.deposits(address(v)), 1.5 ether, "whole pool, one participant");
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyJoined.selector);
        v.leave();
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyJoined.selector);
        v.joinBatch();
        vm.deal(a, 1 ether);
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__JoinClosed.selector);
        v.join{value: 0.1 ether}();
    }

    // ================================================================ payouts

    function test_FullSwarm_ExactProRataAlongsideOthers() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0.3 ether);
        v.joinBatch();
        _deposit(batch, makeAddr("outsider-1"), 0.7 ether);
        _deposit(batch, makeAddr("outsider-2"), 1.1 ether);
        _warpPast(batch);

        vm.expectRevert(SwarmVault.SwarmVault__NotClaimedFromBatch.selector);
        vm.prank(a);
        v.withdrawShare();

        v.claimFromBatch();
        uint256 vaultTokens = batch.entitlement(address(v));
        assertEq(v.tokensReceived(), vaultTokens, "vault got exactly its batch entitlement");
        uint256 total = batch.totalDeposited();
        assertEq(
            v.ethReceived(), (total - batch.ethSpent()) * 1.5 ether / total, "vault got exactly its pro-rata refund"
        );

        uint256 paid;
        for (uint256 i; i < 3; i++) {
            address m = [a, b, c][i];
            vm.prank(m);
            (uint256 t,) = v.withdrawShare();
            assertEq(t, vaultTokens * v.deposits(m) / 1.5 ether, "pro rata");
            assertEq(IERC20Min(token).balanceOf(m), t);
            paid += t;
        }
        assertLe(paid, vaultTokens);
        assertLt(vaultTokens - paid, 3, "dust under one wei per member");
        vm.prank(a);
        vm.expectRevert(SwarmVault.SwarmVault__NothingToWithdraw.selector);
        v.withdrawShare();
        vm.expectRevert(SwarmVault.SwarmVault__AlreadyClaimed.selector);
        v.claimFromBatch();
    }

    function test_Oversubscribed_RefundsSplitProRata() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        // Far beyond what the 25% batch cap costs: the curve refunds the excess.
        _deposit(batch, makeAddr("whale"), 200 ether);
        _warpPast(batch);
        v.claimFromBatch();
        uint256 eth = v.ethReceived();
        assertGt(eth, 0, "batch refund reached the vault");
        uint256 paid;
        for (uint256 i; i < 3; i++) {
            address m = [a, b, c][i];
            uint256 before = m.balance;
            vm.prank(m);
            (, uint256 e) = v.withdrawShare();
            assertEq(m.balance - before, e);
            assertEq(e, eth * v.deposits(m) / 1.5 ether);
            paid += e;
        }
        assertLe(paid, eth);
        assertGe(address(v).balance, eth - paid, "vault keeps only dust");
    }

    function test_WalletCap_KeepsTheRestBackAndRefundsIt() public {
        _setWalletCap(1 ether);
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        assertEq(batch.deposits(address(v)), 1 ether, "capped at the batch wallet cap");
        assertEq(v.deposited(), 1 ether);
        assertEq(address(v).balance, 0.5 ether, "the rest waits in the vault");
        _warpPast(batch);
        v.claimFromBatch();
        uint256 total = batch.totalDeposited();
        uint256 batchRefund = (total - batch.ethSpent()) * 1 ether / total;
        assertEq(v.ethReceived(), 0.5 ether + batchRefund, "held-back ETH is paid out with the batch refund");
        uint256 before = c.balance;
        vm.prank(c);
        (, uint256 e) = v.withdrawShare();
        assertEq(e, v.ethReceived() * 0.5 ether / 1.5 ether);
        assertEq(c.balance - before, e);
    }

    // ================================================================ adversarial

    function test_Reentrancy_LeaveAndWithdraw() public {
        SwarmVault v = _swarm();
        ReentrantMember r = new ReentrantMember(v);
        vm.deal(address(r), 0);
        r.join{value: 0.8 ether}();
        _join(v, a, 0.5 ether);
        // Leaving re-enters leave(): the inner call reverts, so the whole leave reverts.
        vm.expectRevert();
        r.leave(1);
        assertEq(v.deposits(address(r)), 0.8 ether, "nothing left the vault");
        assertEq(address(v).balance, 1.3 ether);

        // Through to a payout: re-entering withdrawShare can't pay twice.
        r.approve();
        _approve(v, a);
        _toLaunch(v);
        (, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 200 ether); // forces an ETH refund leg
        _warpPast(batch);
        v.claimFromBatch();
        // Re-entering from receive() fails inside the gas-limited push, so the ETH leg is
        // parked instead of paid twice; the tokens arrive once.
        (, uint256 e) = v.shareOf(address(r));
        r.withdraw(2);
        assertTrue(v.withdrawn(address(r)));
        assertEq(v.ethOwed(address(r)), e, "ETH parked, not paid twice");
        vm.expectRevert(SwarmVault.SwarmVault__NothingToWithdraw.selector);
        r.withdraw(0);
    }

    /// Regression (security review): OpeningBatch.claimFor is permissionless. Someone pushes
    /// the vault's share in before claimFromBatch; the vault must still pay every member in
    /// full instead of locking the pool.
    function test_ClaimForGriefing_DoesNotLockThePool() public {
        _setWalletCap(1 ether); // also exercises the held-back ETH
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 1 ether);
        _warpPast(batch);
        address griefer = makeAddr("griefer");
        vm.startPrank(griefer);
        batch.settle();
        batch.claimFor(address(v));
        vm.stopPrank();
        assertTrue(batch.claimed(address(v)));

        v.claimFromBatch();
        assertEq(v.tokensReceived(), batch.entitlement(address(v)), "the pushed share is counted");
        uint256 total = batch.totalDeposited();
        uint256 batchRefund = (total - batch.ethSpent()) * 1 ether / total;
        assertEq(v.ethReceived(), 0.5 ether + batchRefund, "held-back ETH + pushed refund");
        uint256 tokPaid;
        uint256 ethPaid;
        for (uint256 i; i < 3; i++) {
            address m = [a, b, c][i];
            vm.prank(m);
            (uint256 t, uint256 e) = v.withdrawShare();
            assertGt(t, 0);
            tokPaid += t;
            ethPaid += e;
        }
        assertEq(tokPaid + IERC20Min(token).balanceOf(address(v)), v.tokensReceived());
        assertEq(ethPaid + address(v).balance, v.ethReceived());
    }

    /// Tokens or ETH forced into the vault before claimFromBatch go to members, not to burn.
    function test_DonationsBeforeClaimGoToMembers() public {
        SwarmVault v = _passingSwarm();
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0.2 ether);
        v.joinBatch();
        _warpPast(batch);
        // The creator claims its own batch tokens and gifts some to the vault.
        batch.settle();
        vm.prank(creator);
        (uint256 got,) = batch.claim();
        vm.prank(creator);
        IERC20Min(token).transfer(address(v), got / 2);
        v.claimFromBatch();
        assertEq(v.tokensReceived(), batch.entitlement(address(v)) + got / 2);
    }

    /// Security review: a member contract that rejects ETH still gets its tokens; the ETH is
    /// parked, pulled to any address, and never burned by the dust sweep.
    function test_EthRejectingMember_GetsTokensAndPullsEth() public {
        SwarmVault v = _passingSwarm();
        NoEthMember n = new NoEthMember(v);
        vm.deal(address(this), 1 ether);
        n.join{value: 0.5 ether}();
        n.approve();
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 200 ether); // forces an ETH leg
        _warpPast(batch);
        v.claimFromBatch();
        (uint256 t, uint256 e) = n.withdraw();
        assertGt(t, 0);
        assertGt(e, 0);
        assertEq(IERC20Min(token).balanceOf(address(n)), t, "tokens delivered");
        assertEq(v.ethOwed(address(n)), e, "ETH parked");

        vm.warp(uint256(batch.closeTs()) + 180 days);
        v.sweepDust();
        assertGe(address(v).balance, e, "sweep keeps parked ETH");

        address to = makeAddr("n-owner");
        n.pull(to);
        assertEq(to.balance, e);
        assertEq(v.ethOwed(address(n)), 0);
        vm.expectRevert(SwarmVault.SwarmVault__NoEthOwed.selector);
        n.pull(to);
    }

    function test_StrayEthRefused() public {
        SwarmVault v = _swarm();
        vm.deal(a, 1 ether);
        vm.prank(a);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertFalse(ok, "only the batch may send ETH");
    }

    function test_Dust_SweepWaitsAndNeverTouchesUnclaimed() public {
        SwarmVault v = _swarm();
        _join(v, a, 0.333_333_333_333_333_333 ether);
        _join(v, b, 0.333_333_333_333_333_334 ether);
        _join(v, c, 0.333_333_333_333_333_335 ether);
        _approve(v, a);
        _approve(v, b);
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 200 ether);
        _warpPast(batch);
        v.claimFromBatch();
        vm.prank(a);
        v.withdrawShare();

        vm.expectRevert(
            abi.encodeWithSelector(SwarmVault.SwarmVault__SweepTooEarly.selector, uint256(batch.closeTs()) + 180 days)
        );
        v.sweepDust();
        vm.warp(uint256(batch.closeTs()) + 180 days);
        v.sweepDust();
        // b and c still get their full share after the sweep.
        (uint256 tb, uint256 eb) = v.shareOf(b);
        (uint256 tc, uint256 ec) = v.shareOf(c);
        assertGe(IERC20Min(token).balanceOf(address(v)), tb + tc);
        assertGe(address(v).balance, eb + ec);
        vm.prank(b);
        v.withdrawShare();
        vm.prank(c);
        v.withdrawShare();
    }

    function test_ThousandMembers_RoundingStaysInTheVault() public {
        SwarmVault v = _swarm();
        uint256 total;
        for (uint256 i; i < 1000; i++) {
            address m = address(uint160(0x10000 + i));
            uint256 amt = 0.01 ether + (i * 7919) % 1e15 + 1;
            _join(v, m, amt);
            _approve(v, m);
            total += amt;
        }
        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 200 ether);
        _warpPast(batch);
        v.claimFromBatch();
        uint256 tokPaid;
        uint256 ethPaid;
        for (uint256 i; i < 1000; i++) {
            address m = address(uint160(0x10000 + i));
            vm.prank(m);
            (uint256 t, uint256 e) = v.withdrawShare();
            tokPaid += t;
            ethPaid += e;
        }
        assertEq(v.poolAtJoin(), total);
        assertLe(tokPaid, v.tokensReceived());
        assertLe(ethPaid, v.ethReceived());
        assertLt(v.tokensReceived() - tokPaid, 1000, "dust < 1 wei per member");
        assertLt(v.ethReceived() - ethPaid, 1000, "dust < 1 wei per member");
        assertEq(IERC20Min(token).balanceOf(address(v)), v.tokensReceived() - tokPaid, "payouts + dust == receipts");
    }

    /// Fuzz: payouts + dust == receipts; before launch nobody leaves with more than they put in.
    function testFuzz_PayoutsPlusDustEqualReceipts(
        uint96[5] memory amounts,
        uint8 leaver
    ) public {
        SwarmVault v = _swarm();
        address[5] memory ms;
        uint256 total;
        for (uint256 i; i < 5; i++) {
            ms[i] = address(uint160(0x20000 + i));
            uint256 amt = bound(uint256(amounts[i]), 0.01 ether, 5 ether);
            _join(v, ms[i], amt);
            _approve(v, ms[i]);
            total += amt;
        }
        // One member leaves before the launch: exactly their deposit, never more.
        address l = ms[leaver % 5];
        uint256 dep = v.deposits(l);
        uint256 before = l.balance;
        vm.prank(l);
        v.leave();
        assertEq(l.balance - before, dep);
        total -= dep;
        vm.assume(total >= 1 ether);

        _toLaunch(v);
        (address token, OpeningBatch batch) = _creatorLaunch(0);
        v.joinBatch();
        _deposit(batch, makeAddr("whale"), 50 ether);
        _warpPast(batch);
        v.claimFromBatch();
        uint256 tokPaid;
        uint256 ethPaid;
        for (uint256 i; i < 5; i++) {
            if (ms[i] == l) continue;
            vm.prank(ms[i]);
            (uint256 t, uint256 e) = v.withdrawShare();
            tokPaid += t;
            ethPaid += e;
        }
        assertEq(tokPaid + IERC20Min(token).balanceOf(address(v)), v.tokensReceived());
        assertEq(ethPaid + address(v).balance, v.ethReceived());
        assertLt(v.tokensReceived() - tokPaid, 5);
        assertLt(v.ethReceived() - ethPaid, 5);
    }

    function _swarmNamed(
        string memory n
    ) internal returns (SwarmVault v) {
        SwarmVaultFactory.Params memory p = _params();
        p.name = n;
        vm.prank(proposer);
        v = SwarmVault(payable(swarms.createSwarm(p)));
    }
}
