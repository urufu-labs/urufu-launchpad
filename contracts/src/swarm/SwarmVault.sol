// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// The live FairLaunchFactory, as far as a swarm needs it.
interface IFairLaunchFactoryView {
    function predictAddresses(
        address launcher,
        string calldata name,
        string calldata symbol
    ) external view returns (address token, address curve, address batch);
    function nameSaltTaken(
        bytes32 saltKey
    ) external view returns (bool);
    function batchFor(
        address token
    ) external view returns (address);
}

/// The Fair lane OpeningBatch, as far as a swarm needs it.
interface IOpeningBatchSwarm {
    function factory() external view returns (address);
    function token() external view returns (address);
    function creator() external view returns (address);
    function closeTs() external view returns (uint64);
    function settled() external view returns (bool);
    function walletCap() external view returns (uint256);
    function deposits(
        address user
    ) external view returns (uint256);
    function refundOwed(
        address user
    ) external view returns (uint256);
    function claimed(
        address user
    ) external view returns (bool);
    function deposit() external payable;
    function settle() external;
    function claim() external returns (uint256 tokens, uint256 refund);
    function withdrawRefund(
        address to
    ) external;
}

/// @title  SwarmVault
/// @notice One swarm launch (docs/PLAN-agents-and-swarms.md §4). Members pool ETH, vote
///         with it, and if the vote passes the pool joins a named creator's Fair launch as
///         ONE opening-batch participant. Members then pull their pro-rata share of the
///         tokens and any ETH the batch refunds.
///
///             join / leave / approve   until joinDeadline (leave: until the pool joins)
///             joinBatch                anyone, after joinDeadline and before
///                                      launchDeadline, once the vote passed and the creator
///                                      launched, inside the batch's 60 s window
///             claimFromBatch           anyone, once the batch can settle
///             withdrawShare            each member, pull
///
///         Safety (plan §4.3):
///           - the vault never sells, swaps or makes arbitrary calls; its only external
///             target is the OpeningBatch the live factory will clone for (creator, name,
///             ticker), computed when the swarm is created. `joinBatch` re-checks that
///             batch's code, factory, token and creator, so a lookalike launch from
///             another wallet can't capture the pool;
///           - vote weight is the ETH a member has in the vault right now: leaving drops it,
///             and token balances never count, so flash loans buy nothing;
///           - payouts are pulled, one member at a time, with no loops over members;
///           - it only accepts ETH from its OpeningBatch (refunds), apart from deposits;
///           - rounding dust stays in the vault and can be burned 180 days after the
///             batch window closes, never touching unclaimed shares;
///           - no owner, no admin, no upgrade. A swarm that doesn't launch in time is
///             simply left: every member takes their full ETH back.
contract SwarmVault is ReentrancyGuard {
    // ============================================================ errors
    error SwarmVault__NotFactory(address caller);
    error SwarmVault__AlreadyInitialized();
    error SwarmVault__JoinClosed();
    error SwarmVault__BelowMinDeposit(uint256 amount, uint256 min);
    error SwarmVault__AboveMaxPool(uint256 newTotal, uint256 max);
    error SwarmVault__NotMember();
    error SwarmVault__AlreadyApproved();
    error SwarmVault__NotApproved();
    error SwarmVault__AlreadyJoined();
    error SwarmVault__VoteStillOpen(uint256 joinDeadline);
    error SwarmVault__LaunchDeadlinePassed(uint256 launchDeadline);
    error SwarmVault__VoteFailed(uint256 pool, uint256 approved);
    error SwarmVault__BatchMismatch();
    error SwarmVault__BatchWindowClosed();
    error SwarmVault__NothingToDeposit();
    error SwarmVault__NotJoined();
    error SwarmVault__AlreadyClaimed();
    error SwarmVault__NotClaimedFromBatch();
    error SwarmVault__NothingToWithdraw();
    error SwarmVault__SweepTooEarly(uint256 opensAt);
    error SwarmVault__UnexpectedEth(address from);

    // ============================================================ events
    event Joined(address indexed member, uint256 amount, uint256 memberTotal, uint256 pool);
    event Left(address indexed member, uint256 amount, uint256 pool);
    event Approved(address indexed member, uint256 weight, uint256 approvedEth);
    event Unapproved(address indexed member, uint256 weight, uint256 approvedEth);
    event BatchJoined(address indexed caller, address indexed batch, uint256 deposited, uint256 keptBack);
    event BatchClaimed(address indexed caller, uint256 tokens, uint256 eth);
    event ShareWithdrawn(address indexed member, uint256 tokens, uint256 eth);
    event DustSwept(uint256 tokens, uint256 eth);

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant SWEEP_DELAY = 180 days;
    uint256 internal constant BPS = 10_000;

    // ============================================================ wiring (impl immutables, shared by clones)
    address public immutable swarmFactory;
    IFairLaunchFactoryView public immutable fairFactory;

    // ============================================================ config (set once)
    address public creator;
    address public token;
    address public batch;
    uint64 public joinDeadline;
    uint64 public launchDeadline;
    uint16 public quorumBps;
    uint256 public minPool;
    /// 0 = no cap beyond the batch's own 25% curve cap.
    uint256 public maxPool;
    uint256 public minDeposit;
    string public name;
    string public ticker;
    bool private _initialized;

    // ============================================================ state
    uint256 public pool;
    uint256 public approvedEth;
    mapping(address => uint256) public deposits;
    mapping(address => bool) public approved;

    bool public joined;
    /// ETH sent into the batch, and the pool size it was split against.
    uint256 public deposited;
    uint256 public poolAtJoin;
    uint64 public batchCloseTs;

    bool public batchClaimed;
    uint256 public tokensReceived;
    /// Batch refund plus any pool ETH held back by the batch's wallet cap.
    uint256 public ethReceived;
    uint256 public withdrawnDeposits;
    mapping(address => bool) public withdrawn;

    struct Config {
        address creator;
        string name;
        string ticker;
        uint64 joinDeadline;
        uint64 launchDeadline;
        uint16 quorumBps;
        uint256 minPool;
        uint256 maxPool;
        uint256 minDeposit;
    }

    constructor(
        address swarmFactory_,
        IFairLaunchFactoryView fairFactory_
    ) {
        swarmFactory = swarmFactory_;
        fairFactory = fairFactory_;
        _initialized = true; // the implementation itself is never a swarm
    }

    /// Factory-only, once per clone. Bounds are checked by the factory.
    function initialize(
        Config calldata c
    ) external {
        if (msg.sender != swarmFactory) revert SwarmVault__NotFactory(msg.sender);
        if (_initialized) revert SwarmVault__AlreadyInitialized();
        _initialized = true;
        (address token_,, address batch_) = fairFactory.predictAddresses(c.creator, c.name, c.ticker);
        creator = c.creator;
        name = c.name;
        ticker = c.ticker;
        token = token_;
        batch = batch_;
        joinDeadline = c.joinDeadline;
        launchDeadline = c.launchDeadline;
        quorumBps = c.quorumBps;
        minPool = c.minPool;
        maxPool = c.maxPool;
        minDeposit = c.minDeposit;
    }

    // ============================================================ join / leave / vote

    function join() external payable nonReentrant {
        if (joined || block.timestamp >= joinDeadline) revert SwarmVault__JoinClosed();
        if (msg.value < minDeposit) revert SwarmVault__BelowMinDeposit(msg.value, minDeposit);
        uint256 newPool = pool + msg.value;
        uint256 cap = maxPool;
        if (cap != 0 && newPool > cap) revert SwarmVault__AboveMaxPool(newPool, cap);
        pool = newPool;
        uint256 memberTotal = deposits[msg.sender] + msg.value;
        deposits[msg.sender] = memberTotal;
        if (approved[msg.sender]) approvedEth += msg.value;
        emit Joined(msg.sender, msg.value, memberTotal, newPool);
    }

    /// Take all your ETH back. Allowed until the pool has joined the batch, including
    /// after the vote and after the launch deadline (that is how a failed swarm refunds).
    function leave() external nonReentrant {
        if (joined) revert SwarmVault__AlreadyJoined();
        uint256 amount = deposits[msg.sender];
        if (amount == 0) revert SwarmVault__NotMember();
        deposits[msg.sender] = 0;
        pool -= amount;
        if (approved[msg.sender]) {
            approved[msg.sender] = false;
            approvedEth -= amount;
        }
        SafeTransferLib.safeTransferETH(msg.sender, amount);
        emit Left(msg.sender, amount, pool);
    }

    /// Vote yes with everything you have in the vault (now and later deposits).
    function approve() external {
        if (block.timestamp >= joinDeadline) revert SwarmVault__JoinClosed();
        uint256 weight = deposits[msg.sender];
        if (weight == 0) revert SwarmVault__NotMember();
        if (approved[msg.sender]) revert SwarmVault__AlreadyApproved();
        approved[msg.sender] = true;
        approvedEth += weight;
        emit Approved(msg.sender, weight, approvedEth);
    }

    function unapprove() external {
        if (block.timestamp >= joinDeadline) revert SwarmVault__JoinClosed();
        if (!approved[msg.sender]) revert SwarmVault__NotApproved();
        uint256 weight = deposits[msg.sender];
        approved[msg.sender] = false;
        approvedEth -= weight;
        emit Unapproved(msg.sender, weight, approvedEth);
    }

    /// The vote passes with at least minPool in the vault and quorumBps of it voting yes.
    function passed() public view returns (bool) {
        uint256 p = pool;
        return p != 0 && p >= minPool && approvedEth * BPS >= p * quorumBps;
    }

    // ============================================================ launch

    /// Anyone (our keeper, a member, the creator) can call this once the named creator has
    /// launched the token: it puts the pool into that launch's opening batch. Fails closed
    /// on anything unexpected; if it can never succeed, members simply leave.
    function joinBatch() external nonReentrant {
        if (joined) revert SwarmVault__AlreadyJoined();
        uint256 jd = joinDeadline;
        if (block.timestamp < jd) revert SwarmVault__VoteStillOpen(jd);
        uint256 ld = launchDeadline;
        if (block.timestamp >= ld) revert SwarmVault__LaunchDeadlinePassed(ld);
        uint256 p = pool;
        if (!passed()) revert SwarmVault__VoteFailed(p, approvedEth);

        address b = batch;
        address t = token;
        if (b.code.length == 0) revert SwarmVault__BatchMismatch();
        IOpeningBatchSwarm ob = IOpeningBatchSwarm(b);
        if (
            ob.factory() != address(fairFactory) || ob.token() != t || ob.creator() != creator
                || fairFactory.batchFor(t) != b
        ) revert SwarmVault__BatchMismatch();
        uint64 close = ob.closeTs();
        if (block.timestamp >= close || ob.settled()) revert SwarmVault__BatchWindowClosed();

        // The batch may cap ETH per wallet; anything above it is kept back and paid out
        // with the refund.
        uint256 amount = p;
        uint256 cap = ob.walletCap();
        if (cap != 0) {
            uint256 room = cap > ob.deposits(address(this)) ? cap - ob.deposits(address(this)) : 0;
            if (amount > room) amount = room;
        }
        if (amount == 0) revert SwarmVault__NothingToDeposit();

        joined = true;
        poolAtJoin = p;
        deposited = amount;
        batchCloseTs = close;
        ob.deposit{value: amount}();
        emit BatchJoined(msg.sender, b, amount, p - amount);
    }

    /// Anyone, once the batch window has closed: settles the batch if nobody has, claims
    /// the vault's tokens and refund, and pulls a refund the batch couldn't push.
    ///
    /// OpeningBatch.claimFor is permissionless, so someone may already have pushed the
    /// vault's share in (a keeper, or a griefer). Each step is skipped if it has already
    /// happened, and the payout pot is what the vault HOLDS afterwards, not what arrived in
    /// this call. Before this point the vault can only hold the ETH the wallet cap kept
    /// back (members can't add or remove anything once the pool joined), so the balance is
    /// exactly that plus the batch share, plus anything donated, which then goes to members.
    function claimFromBatch() external nonReentrant {
        if (!joined) revert SwarmVault__NotJoined();
        if (batchClaimed) revert SwarmVault__AlreadyClaimed();
        batchClaimed = true;
        IOpeningBatchSwarm ob = IOpeningBatchSwarm(batch);
        if (!ob.settled()) ob.settle(); // reverts while the window is open
        if (!ob.claimed(address(this))) ob.claim();
        if (ob.refundOwed(address(this)) != 0) ob.withdrawRefund(address(this));
        uint256 tok = _tokenBalance();
        uint256 eth = address(this).balance;
        tokensReceived = tok;
        ethReceived = eth;
        emit BatchClaimed(msg.sender, tok, eth);
    }

    /// Each member pulls their share: tokens and ETH, pro rata to their pool deposit.
    function withdrawShare() external nonReentrant returns (uint256 tokens, uint256 eth) {
        if (!batchClaimed) revert SwarmVault__NotClaimedFromBatch();
        uint256 dep = deposits[msg.sender];
        if (dep == 0 || withdrawn[msg.sender]) revert SwarmVault__NothingToWithdraw();
        withdrawn[msg.sender] = true;
        withdrawnDeposits += dep;
        (tokens, eth) = shareOf(msg.sender);
        if (tokens > 0) SafeTransferLib.safeTransfer(token, msg.sender, tokens);
        if (eth > 0) SafeTransferLib.safeTransferETH(msg.sender, eth);
        emit ShareWithdrawn(msg.sender, tokens, eth);
    }

    /// What `member` gets from withdrawShare (0 before claimFromBatch).
    function shareOf(
        address member
    ) public view returns (uint256 tokens, uint256 eth) {
        uint256 dep = deposits[member];
        uint256 p = poolAtJoin;
        if (!batchClaimed || dep == 0 || p == 0) return (0, 0);
        tokens = FixedPointMathLib.mulDiv(tokensReceived, dep, p);
        eth = FixedPointMathLib.mulDiv(ethReceived, dep, p);
    }

    // ============================================================ dust

    /// Burn rounding dust 180 days after the batch window closed. Reserves the rounded-UP
    /// share of every member who hasn't withdrawn, so late members are always paid in full.
    function sweepDust() external nonReentrant {
        if (!batchClaimed) revert SwarmVault__NotClaimedFromBatch();
        uint256 opensAt = uint256(batchCloseTs) + SWEEP_DELAY;
        if (block.timestamp < opensAt) revert SwarmVault__SweepTooEarly(opensAt);
        uint256 p = poolAtJoin;
        uint256 unclaimed = p - withdrawnDeposits;
        uint256 reservedTok = FixedPointMathLib.mulDivUp(tokensReceived, unclaimed, p);
        uint256 reservedEth = FixedPointMathLib.mulDivUp(ethReceived, unclaimed, p);
        uint256 tokBal = _tokenBalance();
        uint256 ethBal = address(this).balance;
        uint256 tokDust = tokBal > reservedTok ? tokBal - reservedTok : 0;
        uint256 ethDust = ethBal > reservedEth ? ethBal - reservedEth : 0;
        if (tokDust > 0) SafeTransferLib.safeTransfer(token, BURN_ADDRESS, tokDust);
        if (ethDust > 0) SafeTransferLib.safeTransferETH(BURN_ADDRESS, ethDust);
        emit DustSwept(tokDust, ethDust);
    }

    function _tokenBalance() internal view returns (uint256) {
        address t = token;
        if (t.code.length == 0) return 0;
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// Only the OpeningBatch sends ETH in (its refund); deposits come through join().
    receive() external payable {
        if (msg.sender != batch) revert SwarmVault__UnexpectedEth(msg.sender);
    }
}
