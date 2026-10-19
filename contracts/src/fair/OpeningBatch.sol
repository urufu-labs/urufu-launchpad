// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

interface IFairCurveBatch {
    function batchBuy() external payable returns (uint256 tokensOut, uint256 ethUsed);
    function quoteBatchBuy(
        uint256 ethIn
    ) external view returns (uint256 tokensOut, uint256 ethUsed, uint256 ethRefund);
}

/// @title  OpeningBatch
/// @notice The first `W` seconds of a Fair launch (docs/SPEC-fair-launch.md §1). Everyone
///         deposits ETH during the window, then one aggregate curve buy fills them all at
///         the same average price and the tokens are split pro rata:
///
///             yourTokens = tokensBought * yourEth / totalEth
///             yourRefund = (totalEth - ethSpent) * yourEth / totalEth
///
///         The split is linear in ETH, so 50 wallets funded from one bankroll get exactly
///         what one wallet would, and depositing first earns nothing extra. When deposits
///         exceed what the batch cap (25% of curve supply) costs, the curve fills the cap
///         and refunds the excess; each depositor gets their pro-rata share of that refund
///         in the same `claim`.
///
/// @dev    O(1) deposit, O(1) per-user claim, no loops over depositors. `settle` is
///         permissionless, idempotent and cannot be blocked: the curve's `batchBuy` never
///         reverts on size. Rounding is always down in the user's direction; the dust left
///         over can be burned with `sweepDust` after `SWEEP_DELAY`, and that sweep never
///         touches unclaimed entitlements.
contract OpeningBatch is ReentrancyGuard {
    // ============================================================ errors
    error OpeningBatch__AlreadyInitialized();
    error OpeningBatch__ZeroAddress();
    error OpeningBatch__WindowNotOpen();
    error OpeningBatch__WindowClosed(uint256 closeTs);
    error OpeningBatch__WindowStillOpen(uint256 closeTs);
    error OpeningBatch__ZeroAmount();
    error OpeningBatch__WalletCapHit(uint256 newTotal, uint256 cap);
    error OpeningBatch__NotFactory(address caller);
    error OpeningBatch__NotSettled();
    error OpeningBatch__NothingToClaim();
    error OpeningBatch__SweepTooEarly(uint256 opensAt);
    error OpeningBatch__UnexpectedEth(address from);

    // ============================================================ events
    event BatchInitialized(
        address indexed curve, address indexed token, address indexed creator, uint64 openTs, uint64 closeTs, uint256 walletCap
    );
    event Deposited(address indexed user, uint256 amount, uint256 userTotal, uint256 batchTotal);
    event Settled(address indexed caller, uint256 totalEth, uint256 ethSpent, uint256 tokensBought, uint256 ethRefund);
    event Claimed(address indexed user, uint256 tokens, uint256 ethRefund);
    event DustSwept(uint256 tokens, uint256 eth);

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// Dust (rounding remainders) can be burned this long after the window closes.
    uint256 public constant SWEEP_DELAY = 180 days;

    // ============================================================ config
    address public factory;
    address public curve;
    address public token;
    address public creator;
    uint64 public openTs;
    uint64 public closeTs;
    /// Optional per-wallet ETH cap, 0 = none. Bundling makes caps cosmetic, so off by default.
    uint256 public walletCap;
    uint8 private _initialized;

    // ============================================================ state
    uint256 public totalDeposited;
    bool public settled;
    uint256 public tokensBought;
    uint256 public ethSpent;
    /// Deposits whose owners have claimed, so dust math never touches unclaimed shares.
    uint256 public claimedDeposits;
    mapping(address => uint256) public deposits;
    mapping(address => bool) public claimed;

    function initialize(
        address factory_,
        address curve_,
        address token_,
        address creator_,
        uint64 closeTs_,
        uint256 walletCap_
    ) external {
        if (_initialized != 0) revert OpeningBatch__AlreadyInitialized();
        _initialized = 1;
        if (factory_ == address(0) || curve_ == address(0) || token_ == address(0)) revert OpeningBatch__ZeroAddress();
        factory = factory_;
        curve = curve_;
        token = token_;
        creator = creator_;
        openTs = uint64(block.timestamp);
        closeTs = closeTs_;
        walletCap = walletCap_;
        emit BatchInitialized(curve_, token_, creator_, uint64(block.timestamp), closeTs_, walletCap_);
    }

    // ============================================================ deposit

    function deposit() external payable {
        _deposit(msg.sender);
    }

    /// Factory-only: the creator's first deposit at launch (Fair-lane `launchAndBuy`).
    /// Same price as everyone else.
    function depositFor(
        address user
    ) external payable {
        if (msg.sender != factory) revert OpeningBatch__NotFactory(msg.sender);
        _deposit(user);
    }

    function _deposit(
        address user
    ) internal {
        if (_initialized == 0) revert OpeningBatch__WindowNotOpen();
        if (block.timestamp >= closeTs || settled) revert OpeningBatch__WindowClosed(closeTs);
        if (msg.value == 0) revert OpeningBatch__ZeroAmount();
        uint256 userTotal = deposits[user] + msg.value;
        uint256 cap = walletCap;
        if (cap != 0 && userTotal > cap) revert OpeningBatch__WalletCapHit(userTotal, cap);
        deposits[user] = userTotal;
        uint256 total = totalDeposited + msg.value;
        totalDeposited = total;
        emit Deposited(user, msg.value, userTotal, total);
    }

    // ============================================================ settle

    /// One aggregate curve buy with every deposited wei. Anyone can call once the window
    /// has closed; a second call is a no-op. With no deposits it just opens the curve.
    function settle() external nonReentrant {
        if (settled) return;
        uint256 c = closeTs;
        if (block.timestamp < c) revert OpeningBatch__WindowStillOpen(c);
        settled = true;
        uint256 total = totalDeposited;
        (uint256 tokensOut, uint256 used) = IFairCurveBatch(curve).batchBuy{value: total}();
        tokensBought = tokensOut;
        ethSpent = used;
        emit Settled(msg.sender, total, used, tokensOut, total - used);
    }

    // ============================================================ claim

    function claim() external nonReentrant returns (uint256 tokens, uint256 refund) {
        return _claim(msg.sender);
    }

    /// Keeper push: delivers `user`'s share to `user` (never to the caller).
    function claimFor(
        address user
    ) external nonReentrant returns (uint256 tokens, uint256 refund) {
        return _claim(user);
    }

    function _claim(
        address user
    ) internal returns (uint256 tokens, uint256 refund) {
        if (!settled) revert OpeningBatch__NotSettled();
        uint256 dep = deposits[user];
        if (dep == 0 || claimed[user]) revert OpeningBatch__NothingToClaim();
        claimed[user] = true;
        claimedDeposits += dep;
        (tokens, refund) = _shareOf(dep);
        if (tokens > 0) SafeTransferLib.safeTransfer(token, user, tokens);
        if (refund > 0) SafeTransferLib.safeTransferETH(user, refund);
        emit Claimed(user, tokens, refund);
    }

    // ============================================================ views

    /// What `user` gets on claim. Before settle this is an estimate at the current total.
    function pending(
        address user
    ) external view returns (uint256 tokens, uint256 refund) {
        uint256 dep = deposits[user];
        if (dep == 0 || claimed[user]) return (0, 0);
        if (settled) return _shareOf(dep);
        uint256 total = totalDeposited;
        (uint256 estTokens, uint256 estUsed,) = IFairCurveBatch(curve).quoteBatchBuy(total);
        tokens = FixedPointMathLib.mulDiv(estTokens, dep, total);
        refund = FixedPointMathLib.mulDiv(total - estUsed, dep, total);
    }

    /// Batch-wide estimate before settle: tokens the batch would buy, ETH it would spend,
    /// ETH it would refund.
    function quote() external view returns (uint256 tokensOut, uint256 ethUsed, uint256 ethRefund) {
        if (settled) return (tokensBought, ethSpent, totalDeposited - ethSpent);
        return IFairCurveBatch(curve).quoteBatchBuy(totalDeposited);
    }

    function secondsLeft() external view returns (uint256) {
        return block.timestamp >= closeTs ? 0 : closeTs - block.timestamp;
    }

    function _shareOf(
        uint256 dep
    ) internal view returns (uint256 tokens, uint256 refund) {
        uint256 total = totalDeposited;
        tokens = FixedPointMathLib.mulDiv(tokensBought, dep, total);
        refund = FixedPointMathLib.mulDiv(total - ethSpent, dep, total);
    }

    // ============================================================ dust

    /// Burn rounding dust after `SWEEP_DELAY`. Reserves the rounded-UP entitlement of
    /// every unclaimed deposit, so late claimers are always paid in full.
    function sweepDust() external nonReentrant {
        if (!settled) revert OpeningBatch__NotSettled();
        uint256 opensAt = uint256(closeTs) + SWEEP_DELAY;
        if (block.timestamp < opensAt) revert OpeningBatch__SweepTooEarly(opensAt);
        uint256 total = totalDeposited;
        uint256 unclaimed = total - claimedDeposits;
        uint256 reservedTokens = total == 0 ? 0 : FixedPointMathLib.mulDivUp(tokensBought, unclaimed, total);
        uint256 reservedEth = total == 0 ? 0 : FixedPointMathLib.mulDivUp(total - ethSpent, unclaimed, total);

        uint256 tokBal = _tokenBalance();
        uint256 ethBal = address(this).balance;
        uint256 tokDust = tokBal > reservedTokens ? tokBal - reservedTokens : 0;
        uint256 ethDust = ethBal > reservedEth ? ethBal - reservedEth : 0;
        if (tokDust > 0) SafeTransferLib.safeTransfer(token, BURN_ADDRESS, tokDust);
        if (ethDust > 0) SafeTransferLib.safeTransferETH(BURN_ADDRESS, ethDust);
        emit DustSwept(tokDust, ethDust);
    }

    function _tokenBalance() internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// Only the curve sends ETH back (the above-cap refund inside `batchBuy`).
    receive() external payable {
        if (msg.sender != curve) revert OpeningBatch__UnexpectedEth(msg.sender);
    }
}
