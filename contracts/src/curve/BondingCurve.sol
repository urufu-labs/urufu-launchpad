// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

interface IGraduator {
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount
    ) external payable;
}

/// @title  BondingCurve
/// @notice pump.fun-style constant-product bonding curve, one per token launch. Uses virtual
///         reserves so early buys start at a well-defined non-zero price and price scales
///         predictably up to the graduation target. When accumulated ETH reserve reaches
///         `graduationTargetEth`, the curve is closed for new buys and `Graduated` fires —
///         a Phase-3 graduation router then pulls the ETH + remaining tokens into a Uniswap
///         v4 pool with the launcher's pre-selected hook.
/// @dev    Cloneable via LibClone or deployed straight from `CurveFactory`. Fees are skimmed
///         on both sides and forwarded to the platform `feeReceiver` (same address used by
///         the launch Router). Immutable-after-init: no admin knobs, no upgrades.
contract BondingCurve is ReentrancyGuard {
    // ============================================================
    // Errors
    // ============================================================
    error BondingCurve__AlreadyInitialized();
    error BondingCurve__ZeroAmount();
    error BondingCurve__Graduated();
    error BondingCurve__Slippage(uint256 got, uint256 min);
    error BondingCurve__ExceedsSupply(uint256 requested, uint256 available);
    error BondingCurve__ZeroAddress();

    // ============================================================
    // Events — the trade UI streams these into an OHLC chart
    // ============================================================
    event CurveInitialized(
        address indexed token,
        address indexed feeReceiver,
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps
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
    event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp);

    // ============================================================
    // Immutable-after-init state (LibClone friendly — no constructor args)
    // ============================================================
    address public token;
    address public feeReceiver;
    uint256 public curveSupply;
    uint256 public virtualTokenReserve;
    uint256 public virtualEthReserve;
    uint256 public graduationTargetEth;
    uint16 public tradeFeeBps;
    /// Optional graduation router — when set, `_graduate()` transfers reserves out and
    /// invokes the router to spin up a Uniswap v4 pool. When unset, `_graduate()` just
    /// flags the curve done and holds funds for a keeper to withdraw later.
    address public graduator;

    // ============================================================
    // Live state
    // ============================================================
    uint256 public ethReserve;
    uint256 public tokenReserve;
    bool public graduated;
    uint8 private _initialized;

    // ============================================================
    // Init — called once by the factory right after `cloneDeterministic`
    // ============================================================
    function initialize(
        address token_,
        address feeReceiver_,
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_,
        address graduator_
    ) external {
        if (_initialized != 0) revert BondingCurve__AlreadyInitialized();
        _initialized = 1;
        if (token_ == address(0) || feeReceiver_ == address(0)) revert BondingCurve__ZeroAddress();

        token = token_;
        feeReceiver = feeReceiver_;
        curveSupply = curveSupply_;
        virtualTokenReserve = virtualTokenReserve_;
        virtualEthReserve = virtualEthReserve_;
        graduationTargetEth = graduationTargetEth_;
        tradeFeeBps = tradeFeeBps_;
        graduator = graduator_;

        tokenReserve = curveSupply_;
        ethReserve = 0;

        emit CurveInitialized(
            token_,
            feeReceiver_,
            curveSupply_,
            virtualTokenReserve_,
            virtualEthReserve_,
            graduationTargetEth_,
            tradeFeeBps_
        );
    }

    // ============================================================
    // Quoting — pure math, cheap to call off-chain and pre-trade
    // ============================================================
    function quoteBuy(
        uint256 ethIn
    ) public view returns (uint256 tokensOut, uint256 fee) {
        if (graduated) return (0, 0);
        fee = (ethIn * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = ethIn - fee;
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        if (tokensOut > tokenReserve) tokensOut = tokenReserve;
    }

    function quoteSell(
        uint256 tokensIn
    ) public view returns (uint256 ethOut, uint256 fee) {
        if (graduated) return (0, 0);
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
    }

    /// @notice Current spot price in wei-per-token (18-decimal fixed-point).
    function priceWeiPerToken() external view returns (uint256) {
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        return (effEth * 1e18) / effToken;
    }

    // ============================================================
    // Buy / sell
    // ============================================================
    function buy(
        uint256 minTokensOut
    ) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert BondingCurve__Graduated();
        if (msg.value == 0) revert BondingCurve__ZeroAmount();

        uint256 fee = (msg.value * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = msg.value - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        if (tokensOut > tokenReserve) revert BondingCurve__ExceedsSupply(tokensOut, tokenReserve);
        if (tokensOut < minTokensOut) revert BondingCurve__Slippage(tokensOut, minTokensOut);

        tokenReserve -= tokensOut;
        ethReserve += ethAfterFee;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, msg.sender, tokensOut);

        emit Trade(msg.sender, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        if (ethReserve >= graduationTargetEth || tokenReserve == 0) {
            _graduate();
        }
    }

    function sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) external nonReentrant returns (uint256 ethOut) {
        if (graduated) revert BondingCurve__Graduated();
        if (tokensIn == 0) revert BondingCurve__ZeroAmount();

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokensIn);

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        uint256 fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
        if (ethOut < minEthOut) revert BondingCurve__Slippage(ethOut, minEthOut);

        tokenReserve += tokensIn;
        ethReserve -= ethGross;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransferETH(msg.sender, ethOut);

        emit Trade(msg.sender, false, ethOut, tokensIn, ethReserve, tokenReserve, block.timestamp);
    }

    // ============================================================
    // Graduation — stub. Phase 3 replaces this with a v4 pool creation call
    // that pulls ethReserve + tokenReserve out and mints an LP position with
    // the launcher's chosen hook attached.
    // ============================================================
    function _graduate() internal {
        graduated = true;
        uint256 ethOut = ethReserve;
        uint256 tokenOut = tokenReserve;
        emit Graduated(ethOut, tokenOut, block.timestamp);

        // If a graduator is wired, ship the reserves into a v4 pool + zero the on-curve
        // state to reflect the transfer. Without a graduator, funds stay on the curve
        // (stub behavior — the pre-v4 unit tests rely on this).
        if (graduator != address(0) && ethOut > 0 && tokenOut > 0) {
            ethReserve = 0;
            tokenReserve = 0;
            SafeTransferLib.safeApprove(token, graduator, tokenOut);
            IGraduator(graduator).execute{value: ethOut}(token, ethOut, tokenOut);
        }
    }

    // Accept refunds from failed transfers etc.
    receive() external payable {}
}
