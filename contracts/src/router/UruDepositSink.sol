// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
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
///         (Router does the transferFrom); an off-chain keeper periodically drains
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
contract UruDepositSink is Ownable, ReentrancyGuard {
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
    /// URU-A11: keeper / swap-target / rate change was applied without a
    /// matured proposal. Previously these were immediate — a compromised owner
    /// could route ETH through a malicious `swapTarget` and set `minEthPerUru`
    /// to 0 in the same tx, draining the vault. Now each change is a two-step
    /// propose + wait cycle keyed by `changeId`.
    error UruDepositSink__AdminChangeNotProposed(bytes32 changeId);
    error UruDepositSink__AdminChangeNotReady(bytes32 changeId, uint256 readyAt);

    event Deposited(address indexed from, uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapTargetSet(address indexed target, bool allowed);
    event DistributionSinkSet(address indexed sink);
    event DistributionSinkProposed(address indexed sink, uint256 readyAt);
    event MinEthPerUruSet(uint256 minEthPerUru);
    event ConversionExecuted(uint256 uruIn, uint256 ethOut);
    /// URU-A11: telemetry for propose/activate/cancel of admin changes.
    event AdminChangeProposed(bytes32 indexed changeId, uint256 readyAt);
    event AdminChangeCancelled(bytes32 indexed changeId);
    /// URU-A11 AC #4: emitted when `_consumeAdminChange` succeeds against a
    /// matured proposal. Together with `AdminChangeProposed`/`Cancelled`,
    /// off-chain monitoring can enumerate every pending admin change by
    /// joining the log stream (`Proposed - Cancelled - Applied`).
    event AdminChangeApplied(bytes32 indexed changeId);

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
    /// URU-A11: propose/activate state for keeper / swapTarget / rate changes.
    /// Change identity computed by `keeperChangeId` / `swapTargetChangeId` /
    /// `rateChangeId`. Non-zero readyAt = proposed; must be >= block.timestamp
    /// before consumption. Reset to 0 either on cancellation or consumption.
    mapping(bytes32 => uint256) public adminChangeReadyAt;

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

    /// @notice Optional explicit deposit path — Router uses direct transferFrom() into
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
    ) external nonReentrant {
        // URU-A14 additional-defect close (matches UruBuybackVault.executeBuyback):
        // pre/post balance-delta pattern + arbitrary external call needs a
        // guard so a reentrant token or hostile swapTarget can't inflate
        // `ethOut` mid-call.
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
        // routers that read residual allowance non-idempotently. URU-A17 Low:
        // safeApproveWithRetry enforces standard ERC-20 return-value semantics
        // AND handles the USDT-style tokens that require zero-first, in a
        // single call — kept as two calls here for zero-then-value clarity.
        SafeTransferLib.safeApproveWithRetry(address(uru), swapTarget, 0);
        SafeTransferLib.safeApproveWithRetry(address(uru), swapTarget, uruIn);

        uint256 ethBefore = address(this).balance;
        (bool ok,) = swapTarget.call(swapData);
        if (!ok) revert UruDepositSink__SwapFailed();
        uint256 ethAfter = address(this).balance;
        uint256 ethOut = ethAfter - ethBefore;
        if (ethOut < minEthOut) revert UruDepositSink__SlippageExceeded(ethOut, minEthOut);

        // Clear any residual allowance so a compromised swapTarget can't drain URU
        // between conversion runs.
        SafeTransferLib.safeApproveWithRetry(address(uru), swapTarget, 0);

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
        // URU-A11: propose/activate for keeper changes. `_consumeAdminChange`
        // is a no-op when `minConfigDelay == 0` (test path).
        _consumeAdminChange(keeperChangeId(keeper, allowed));
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setSwapTarget(
        address target,
        bool allowed
    ) external onlyOwner {
        _consumeAdminChange(swapTargetChangeId(target, allowed));
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
        // URU-A11: propose/activate the rate change too. Previously immediate,
        // which let a compromised owner set rate=0 in the same block as
        // routing swap through a malicious target.
        _consumeAdminChange(rateChangeId(rate));
        minEthPerUru = rate;
        emit MinEthPerUruSet(rate);
    }

    // ============================================================
    // URU-A11 propose/activate — changeId helpers
    // ============================================================

    /// Change identity for a keeper allowlist toggle. Hash includes the target
    /// bool so proposing "true" and later applying "false" requires two separate
    /// proposals — an owner can't propose an add and then flip it to a remove.
    function keeperChangeId(
        address keeper,
        bool allowed
    ) public pure returns (bytes32) {
        return keccak256(abi.encode("KEEPER", keeper, allowed));
    }

    function swapTargetChangeId(
        address target,
        bool allowed
    ) public pure returns (bytes32) {
        return keccak256(abi.encode("SWAP_TARGET", target, allowed));
    }

    function rateChangeId(
        uint256 rate
    ) public pure returns (bytes32) {
        return keccak256(abi.encode("MIN_ETH_PER_URU", rate));
    }

    /// URU-A11: stage a specific change by its ID. Overwriting a pending
    /// proposal's readyAt is allowed (reproposal resets the timer).
    function proposeAdminChange(
        bytes32 changeId
    ) external onlyOwner {
        uint256 readyAt = block.timestamp + minConfigDelay;
        adminChangeReadyAt[changeId] = readyAt;
        emit AdminChangeProposed(changeId, readyAt);
    }

    function cancelAdminChange(
        bytes32 changeId
    ) external onlyOwner {
        delete adminChangeReadyAt[changeId];
        emit AdminChangeCancelled(changeId);
    }

    /// Internal: called by each `set*` mutator. When `minConfigDelay == 0`
    /// (test / bootstrap mode), skip the check entirely so tests can wire
    /// keepers + rates without dance. In production, requires a matured
    /// proposal for the exact `changeId`.
    function _consumeAdminChange(
        bytes32 changeId
    ) internal {
        if (minConfigDelay == 0) return;
        uint256 readyAt = adminChangeReadyAt[changeId];
        if (readyAt == 0) revert UruDepositSink__AdminChangeNotProposed(changeId);
        if (block.timestamp < readyAt) {
            revert UruDepositSink__AdminChangeNotReady(changeId, readyAt);
        }
        delete adminChangeReadyAt[changeId];
        emit AdminChangeApplied(changeId);
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
