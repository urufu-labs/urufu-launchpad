// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

interface IFairGraduator {
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        address launcher,
        bool creatorSold
    ) external payable;
}

interface IOpeningBatchSettle {
    function settle() external;
}

/// @title  FairBondingCurve
/// @notice Fair-lane copy of `BondingCurve` (same virtual-reserve constant-product math,
///         same fee skim, same `tokenReserve - 1` graduation floor, same atomic
///         graduation). Differences, all from docs/SPEC-fair-launch.md:
///
///           * Trading is locked until the launch's `OpeningBatch` settles. The batch
///             makes one aggregate buy through `batchBuy`, capped at `batchCapTokens`;
///             any ETH above the cap is refunded to the batch in the same call.
///           * The first direct trade after the batch window also triggers
///             `OpeningBatch.settle()`, so the curve can never stay locked.
///           * `creatorSold` flips to true the first time the launcher wallet sells on
///             the curve. The graduator passes it to `FairHookHost`, so a
///             pre-graduation dump forfeits the creator fee from the start.
///           * No whitelist path, and the graduator gets the Fair-lane `execute`.
///
/// @dev    Cloned per launch by `FairLaunchFactory`; immutable after `initialize`.
///         The frozen V10 `BondingCurve` is not touched.
contract FairBondingCurve is ReentrancyGuard {
    // ============================================================ errors
    error FairCurve__AlreadyInitialized();
    error FairCurve__ZeroAmount();
    error FairCurve__ZeroAddress();
    error FairCurve__ZeroRecipient();
    error FairCurve__Graduated();
    error FairCurve__Slippage(uint256 got, uint256 min);
    error FairCurve__ExceedsSupply(uint256 requested, uint256 available);
    error FairCurve__GraduatorUnset();
    error FairCurve__GraduationReserveRequired();
    /// Direct trade attempted while the opening batch window is still open.
    error FairCurve__BatchWindowOpen(uint256 opensAt);
    error FairCurve__NotBatch(address caller);
    error FairCurve__BatchAlreadySettled();
    error FairCurve__BatchSettleFailed();
    error FairCurve__BadBatchCap(uint256 cap, uint256 supply);

    // ============================================================ events
    event CurveInitialized(
        address indexed token,
        address indexed feeReceiver,
        address indexed batch,
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps,
        uint256 batchCapTokens,
        uint64 batchCloseTs
    );
    event Trade(
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );
    event BoughtFor(address indexed payer, address indexed recipient, uint256 ethAmount, uint256 tokensOut);
    /// The batch's single aggregate buy. `ethRefunded` is the slice above the cap.
    event BatchFilled(uint256 ethIn, uint256 ethUsed, uint256 tokensOut, uint256 ethRefunded);
    event CreatorSold(address indexed creator, uint256 tokensIn);
    event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp);

    // ============================================================ init-time config
    address public token;
    address public feeReceiver;
    address public graduator;
    address public launcher;
    address public batch;
    uint256 public curveSupply;
    uint256 public virtualTokenReserve;
    uint256 public virtualEthReserve;
    uint256 public graduationTargetEth;
    /// Hard cap on tokens the opening batch can take (spec D2: 25% of curve supply).
    uint256 public batchCapTokens;
    uint64 public batchCloseTs;
    uint16 public tradeFeeBps;

    // ============================================================ live state
    uint256 public ethReserve;
    uint256 public tokenReserve;
    bool public graduated;
    bool public batchSettled;
    bool public creatorSold;
    /// Tokens the launcher wallet bought on the curve for itself. The graduator compares
    /// the creator's balance against this (plus its batch share) to catch a creator who
    /// moved tokens to another wallet before graduation.
    uint256 public creatorBought;
    uint8 private _initialized;

    struct InitParams {
        address token;
        address feeReceiver;
        address graduator;
        address launcher;
        address batch;
        uint256 curveSupply;
        uint256 virtualTokenReserve;
        uint256 virtualEthReserve;
        uint256 graduationTargetEth;
        uint256 batchCapTokens;
        uint64 batchCloseTs;
        uint16 tradeFeeBps;
    }

    function initialize(
        InitParams calldata p
    ) external {
        if (_initialized != 0) revert FairCurve__AlreadyInitialized();
        _initialized = 1;
        if (p.token == address(0) || p.feeReceiver == address(0) || p.batch == address(0)) {
            revert FairCurve__ZeroAddress();
        }
        if (p.graduator == address(0) || p.graduator.code.length == 0) revert FairCurve__GraduatorUnset();
        if (p.batchCapTokens >= p.curveSupply) revert FairCurve__BadBatchCap(p.batchCapTokens, p.curveSupply);

        token = p.token;
        feeReceiver = p.feeReceiver;
        graduator = p.graduator;
        launcher = p.launcher;
        batch = p.batch;
        curveSupply = p.curveSupply;
        virtualTokenReserve = p.virtualTokenReserve;
        virtualEthReserve = p.virtualEthReserve;
        graduationTargetEth = p.graduationTargetEth;
        batchCapTokens = p.batchCapTokens;
        batchCloseTs = p.batchCloseTs;
        tradeFeeBps = p.tradeFeeBps;
        tokenReserve = p.curveSupply;

        emit CurveInitialized(
            p.token,
            p.feeReceiver,
            p.batch,
            p.curveSupply,
            p.virtualTokenReserve,
            p.virtualEthReserve,
            p.graduationTargetEth,
            p.tradeFeeBps,
            p.batchCapTokens,
            p.batchCloseTs
        );
    }

    // ============================================================ quoting

    function quoteBuy(
        uint256 ethIn
    ) public view returns (uint256 tokensOut, uint256 fee) {
        if (graduated) return (0, 0);
        fee = (ethIn * tradeFeeBps) / 10_000;
        tokensOut = _tokensForEth(ethIn - fee);
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) tokensOut = available;
    }

    function quoteSell(
        uint256 tokensIn
    ) public view returns (uint256 ethOut, uint256 fee) {
        if (graduated) return (0, 0);
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 newEffEth = (effEth * effToken) / (effToken + tokensIn);
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
    }

    /// What the batch's aggregate buy would do with `ethIn` right now: tokens it gets
    /// (capped), ETH actually spent (fee included), ETH refunded above the cap.
    function quoteBatchBuy(
        uint256 ethIn
    ) public view returns (uint256 tokensOut, uint256 ethUsed, uint256 ethRefund) {
        if (graduated || batchSettled) return (0, 0, ethIn);
        return _batchFill(ethIn);
    }

    function priceWeiPerToken() external view returns (uint256) {
        return ((ethReserve + virtualEthReserve) * 1e18) / (tokenReserve + virtualTokenReserve);
    }

    /// True once the batch has settled (direct buys and sells allowed).
    function tradingOpen() external view returns (bool) {
        return batchSettled && !graduated;
    }

    // ============================================================ opening batch

    /// The batch's one aggregate buy. Tokens go to the batch for the pro-rata split.
    /// Never reverts on size: a fill below one token wei refunds everything, a fill above
    /// the cap is clipped to the cap and the rest is refunded. Settling must not be
    /// blockable, or the curve could stay locked.
    function batchBuy() external payable nonReentrant returns (uint256 tokensOut, uint256 ethUsed) {
        address b = batch;
        if (msg.sender != b) revert FairCurve__NotBatch(msg.sender);
        if (batchSettled) revert FairCurve__BatchAlreadySettled();
        batchSettled = true;

        uint256 ethRefund;
        (tokensOut, ethUsed, ethRefund) = _batchFill(msg.value);

        if (tokensOut > 0) {
            uint256 fee = (ethUsed * tradeFeeBps) / 10_000;
            uint256 ethAfterFee = ethUsed - fee;
            tokenReserve -= tokensOut;
            ethReserve += ethAfterFee;
            if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
            SafeTransferLib.safeTransfer(token, b, tokensOut);
            emit Trade(b, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);
        }
        if (ethRefund > 0) SafeTransferLib.safeTransferETH(b, ethRefund);
        emit BatchFilled(msg.value, ethUsed, tokensOut, ethRefund);

        if (tokensOut > 0 && ethReserve >= graduationTargetEth) _graduate();
    }

    function _batchFill(
        uint256 ethIn
    ) internal view returns (uint256 tokensOut, uint256 ethUsed, uint256 ethRefund) {
        if (ethIn == 0) return (0, 0, 0);
        uint256 fee = (ethIn * tradeFeeBps) / 10_000;
        tokensOut = _tokensForEth(ethIn - fee);
        ethUsed = ethIn;
        if (tokensOut > batchCapTokens) {
            ethUsed = _grossEthForTokens(batchCapTokens);
            if (ethUsed > ethIn) ethUsed = ethIn;
            fee = (ethUsed * tradeFeeBps) / 10_000;
            tokensOut = _tokensForEth(ethUsed - fee);
            if (tokensOut > batchCapTokens) tokensOut = batchCapTokens;
        }
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) tokensOut = available;
        if (tokensOut == 0) return (0, 0, ethIn);
        ethRefund = ethIn - ethUsed;
    }

    /// Settles the batch first if its window has closed. Reverts while it is open.
    function _openIfDue() internal {
        if (batchSettled) return;
        uint256 closeTs = batchCloseTs;
        if (block.timestamp < closeTs) revert FairCurve__BatchWindowOpen(closeTs);
        IOpeningBatchSettle(batch).settle();
        if (!batchSettled) revert FairCurve__BatchSettleFailed();
    }

    // ============================================================ buy / sell

    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256 tokensOut) {
        _openIfDue();
        return _buy(msg.sender, minTokensOut);
    }

    /// Same as `buy` but tokens go to `recipient`. Trade event credits the recipient.
    function buyFor(
        address recipient,
        uint256 minTokensOut
    ) external payable returns (uint256 tokensOut) {
        if (recipient == address(0)) revert FairCurve__ZeroRecipient();
        _openIfDue();
        tokensOut = _buy(recipient, minTokensOut);
        emit BoughtFor(msg.sender, recipient, msg.value - (msg.value * tradeFeeBps) / 10_000, tokensOut);
    }

    function _buy(
        address recipient,
        uint256 minTokensOut
    ) internal nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert FairCurve__Graduated();
        if (msg.value == 0) revert FairCurve__ZeroAmount();

        uint256 fee = (msg.value * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = msg.value - fee;
        tokensOut = _tokensForEth(ethAfterFee);
        // URU-A04 floor: never consume the last token wei, so graduation always has LP.
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert FairCurve__ExceedsSupply(tokensOut, available);
        if (tokensOut == 0) revert FairCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert FairCurve__Slippage(tokensOut, minTokensOut);

        tokenReserve -= tokensOut;
        ethReserve += ethAfterFee;
        if (recipient == launcher) creatorBought += tokensOut;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, recipient, tokensOut);

        emit Trade(recipient, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        if (ethReserve >= graduationTargetEth) _graduate();
    }

    function sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) external returns (uint256 ethOut) {
        _openIfDue();
        return _sell(tokensIn, minEthOut);
    }

    function _sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) internal nonReentrant returns (uint256 ethOut) {
        if (graduated) revert FairCurve__Graduated();
        if (tokensIn == 0) revert FairCurve__ZeroAmount();

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokensIn);

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 newEffEth = (effEth * effToken) / (effToken + tokensIn);
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        uint256 fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
        if (ethOut < minEthOut) revert FairCurve__Slippage(ethOut, minEthOut);

        tokenReserve += tokensIn;
        ethReserve -= ethGross;

        if (msg.sender == launcher && !creatorSold) {
            creatorSold = true;
            emit CreatorSold(msg.sender, tokensIn);
        }

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransferETH(msg.sender, ethOut);

        emit Trade(msg.sender, false, ethOut, tokensIn, ethReserve, tokenReserve, block.timestamp);
    }

    // ============================================================ graduation

    function _graduate() internal {
        uint256 ethOut = ethReserve;
        uint256 tokenOut = tokenReserve;
        if (tokenOut == 0) revert FairCurve__GraduationReserveRequired();
        address g = graduator;
        if (g == address(0) || g.code.length == 0) revert FairCurve__GraduatorUnset();

        graduated = true;
        ethReserve = 0;
        tokenReserve = 0;
        SafeTransferLib.safeApprove(token, g, tokenOut);
        IFairGraduator(g).execute{value: ethOut}(token, ethOut, tokenOut, launcher, creatorSold);
        emit Graduated(ethOut, tokenOut, block.timestamp);
    }

    // ============================================================ math

    function _tokensForEth(
        uint256 ethAfterFee
    ) internal view returns (uint256) {
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        return effToken - (effEth * effToken) / (effEth + ethAfterFee);
    }

    /// Smallest gross ETH (fee included) whose fill reaches `tokens`. Rounds up at
    /// every step so the batch never pays less than the cap costs.
    function _grossEthForTokens(
        uint256 tokens
    ) internal view returns (uint256) {
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 newEffToken = effToken - tokens;
        uint256 k = effEth * effToken;
        uint256 newEffEth = (k + newEffToken - 1) / newEffToken;
        uint256 net = newEffEth - effEth;
        uint256 denom = 10_000 - uint256(tradeFeeBps);
        return (net * 10_000 + denom - 1) / denom;
    }

    receive() external payable {}
}
