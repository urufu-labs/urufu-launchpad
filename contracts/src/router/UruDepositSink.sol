// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20Minimal {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  UruDepositSink
/// @notice Holding pool for URU paid as launchpad deploy fees. Deposits push URU here
///         (RouterV2 does the transferFrom); an off-chain keeper periodically drains
///         the URU balance by swapping URU → ETH on an allowlisted swap target and
///         forwarding the resulting ETH to `distributionSink` (typically the
///         `FeeSplitter` — which then splits ETH into buyback + NFT + treasury).
///
///         Mirrors `UruBuybackVault` in reverse: buyback takes ETH → keeper swaps to
///         URU. Sink takes URU → keeper swaps to ETH. Same allowlist + slippage
///         controls. Same swapTarget shape (opaque calldata built off-chain so the
///         keeper can switch routers without a contract change).
///
/// @dev    Only trusted keeper addresses can trigger `executeConversion`. Owner
///         (multisig) manages the keeper list and the swap-target allowlist. There is
///         NO admin function to move URU or ETH to arbitrary destinations — proceeds
///         only forward to the fixed `distributionSink`.
contract UruDepositSink is Ownable {
    error UruDepositSink__ZeroAddress();
    error UruDepositSink__NotKeeper();
    error UruDepositSink__TargetNotAllowed(address target);
    error UruDepositSink__SwapFailed();
    error UruDepositSink__SlippageExceeded(uint256 got, uint256 min);
    error UruDepositSink__ZeroSwap();
    /// Keeper set `minEthOut` below the on-chain slippage floor — the vault's
    /// `minEthPerUru` price rejects zero-slippage-attack `swapData`.
    error UruDepositSink__BelowMinRate(uint256 minEthOut, uint256 rateFloor);
    /// setDistributionSink timelock — proposed rotation hasn't matured yet.
    error UruDepositSink__ConfigDelayNotPassed(uint256 readyAt);
    /// No proposal exists (or was reset).
    error UruDepositSink__NoPendingSink();

    event Deposited(address indexed from, uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapTargetSet(address indexed target, bool allowed);
    event DistributionSinkSet(address indexed sink);
    event DistributionSinkProposed(address indexed sink, uint256 readyAt);
    event MinEthPerUruSet(uint256 minEthPerUru);
    event ConversionExecuted(uint256 uruIn, uint256 ethOut);

    IERC20Minimal public immutable uru;
    address public distributionSink;

    /// Timelock delay for `distributionSink` rotation. Mirrors FeeSplitter's
    /// minConfigDelay pattern — even a compromised owner can't instantly
    /// redirect proceeds.
    uint256 public immutable minConfigDelay;

    /// Two-step distributionSink rotation. `proposeDistributionSink` records a
    /// pending target + earliest activation timestamp; `activateDistributionSink`
    /// promotes it once `minConfigDelay` has passed. Original setDistributionSink
    /// keeps working for compat but is now internal-only.
    address public pendingDistributionSink;
    uint256 public pendingDistributionSinkTs;

    /// Minimum ETH-per-URU rate the keeper's swap must clear. Denominated so
    /// that `expected = uruIn * minEthPerUru / 1e18` — i.e. minEthPerUru is
    /// scaled by 1e18. Set by the owner tracking the URU/WETH spot at deploy
    /// time; adjust when the market moves. Zero disables the floor for the
    /// first block after deploy (bootstrapping) but should be raised ASAP.
    uint256 public minEthPerUru;

    mapping(address => bool) public isKeeper;
    mapping(address => bool) public isSwapTarget;

    constructor(
        address initialOwner,
        address uru_,
        address distributionSink_,
        uint256 minConfigDelay_
    ) {
        if (initialOwner == address(0) || uru_ == address(0) || distributionSink_ == address(0)) {
            revert UruDepositSink__ZeroAddress();
        }
        _initializeOwner(initialOwner);
        uru = IERC20Minimal(uru_);
        distributionSink = distributionSink_;
        minConfigDelay = minConfigDelay_;
    }

    /// @notice Optional explicit deposit path — RouterV2 uses direct transferFrom() into
    ///         this contract, but external integrators can call this to log attribution.
    function deposit(
        uint256 amount
    ) external {
        if (amount == 0) revert UruDepositSink__ZeroSwap();
        SafeTransferLib.safeTransferFrom(address(uru), msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Keeper triggers a URU → ETH conversion. `swapTarget` must be on the
    ///         allowlist. Vault approves `swapTarget` for `uruIn` and calls it with
    ///         `swapData` (opaque, prepared off-chain by the keeper's routing logic).
    ///         `minEthOut` protects against MEV/slippage; enforced by comparing the
    ///         ETH balance delta. Post-swap the ETH proceeds forward to the
    ///         distributionSink (typically FeeSplitter).
    function executeConversion(
        address swapTarget,
        uint256 uruIn,
        bytes calldata swapData,
        uint256 minEthOut
    ) external {
        if (!isKeeper[msg.sender]) revert UruDepositSink__NotKeeper();
        if (!isSwapTarget[swapTarget]) revert UruDepositSink__TargetNotAllowed(swapTarget);
        if (uruIn == 0) revert UruDepositSink__ZeroSwap();
        // On-chain slippage floor — even a compromised keeper can't pass
        // `minEthOut = 1` to strip protocol value. `minEthPerUru == 0` disables
        // the floor for the first-block bootstrap; owner sets a real value ASAP.
        {
            uint256 rateFloor = (uruIn * minEthPerUru) / 1e18;
            if (minEthOut < rateFloor) revert UruDepositSink__BelowMinRate(minEthOut, rateFloor);
        }

        // Reset approval to zero first, then set to `uruIn` — belt-and-braces against
        // routers that read residual allowance non-idempotently.
        // slither-disable-next-line unchecked-transfer
        uru.approve(swapTarget, 0);
        // slither-disable-next-line unchecked-transfer
        uru.approve(swapTarget, uruIn);

        uint256 ethBefore = address(this).balance;
        (bool ok,) = swapTarget.call(swapData);
        if (!ok) revert UruDepositSink__SwapFailed();
        uint256 ethAfter = address(this).balance;
        uint256 ethOut = ethAfter - ethBefore;
        if (ethOut < minEthOut) revert UruDepositSink__SlippageExceeded(ethOut, minEthOut);

        // Clear any residual allowance so a compromised swapTarget can't drain URU
        // between conversion runs.
        // slither-disable-next-line unchecked-transfer
        uru.approve(swapTarget, 0);

        SafeTransferLib.safeTransferETH(distributionSink, ethOut);
        emit ConversionExecuted(uruIn, ethOut);
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================
    function setKeeper(
        address keeper,
        bool allowed
    ) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setSwapTarget(
        address target,
        bool allowed
    ) external onlyOwner {
        isSwapTarget[target] = allowed;
        emit SwapTargetSet(target, allowed);
    }

    /// Two-step rotation of distributionSink. Owner proposes → wait
    /// `minConfigDelay` → owner activates. Even a compromised owner-key rotation
    /// can't instantly redirect proceeds; the flywheel has a window to react.
    function proposeDistributionSink(
        address sink
    ) external onlyOwner {
        if (sink == address(0)) revert UruDepositSink__ZeroAddress();
        pendingDistributionSink = sink;
        pendingDistributionSinkTs = block.timestamp + minConfigDelay;
        emit DistributionSinkProposed(sink, pendingDistributionSinkTs);
    }

    function activateDistributionSink() external onlyOwner {
        address pending = pendingDistributionSink;
        if (pending == address(0)) revert UruDepositSink__NoPendingSink();
        uint256 readyAt = pendingDistributionSinkTs;
        if (block.timestamp < readyAt) revert UruDepositSink__ConfigDelayNotPassed(readyAt);
        distributionSink = pending;
        pendingDistributionSink = address(0);
        pendingDistributionSinkTs = 0;
        emit DistributionSinkSet(pending);
    }

    /// Owner sets the ETH-per-URU slippage floor. Denomination: 1e18 = 1 ETH per
    /// 1 URU. Practical values on RH: around URU/WETH spot × 0.95 (5% max
    /// tolerance for the keeper's route). Owner tunes as market moves.
    function setMinEthPerUru(
        uint256 rate
    ) external onlyOwner {
        minEthPerUru = rate;
        emit MinEthPerUruSet(rate);
    }

    /// Escape hatch for stranded ETH (residual from rounding, or direct sends before a
    /// keeper run). Owner-only, forwards to distributionSink so ETH still lands in the
    /// flywheel — this is NOT a general drain to an arbitrary address.
    function flushEth() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        SafeTransferLib.safeTransferETH(distributionSink, bal);
    }

    receive() external payable {
        // Accept ETH pushed in accidentally so the flushEth path can recover it.
    }
}
