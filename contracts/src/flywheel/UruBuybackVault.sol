// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20Minimal {
    function balanceOf(
        address
    ) external view returns (uint256);
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

/// @title  UruBuybackVault
/// @notice Receives ETH from `FeeSplitter` and executes ETH → URU buybacks via an approved
///         keeper. Purchased URU forwards to `distributionSink` (typically the
///         `NftRevenueVault`, which then merkle-drops the URU to gemu holders).
///
///         Design decisions:
///           - Buyback execution is **keeper-driven**, not user-triggered, so nobody can
///             frontrun or grief a live buyback.
///           - Keeper calls arbitrary `swapTarget` with arbitrary `swapData` — this lets us
///             swap on any router (Uniswap Universal Router, v4 quoter+swap, 0x, etc.)
///             without hardcoding an integration. Owner sets an ALLOWLIST of swap targets
///             so the keeper can't just drain funds to an arbitrary contract.
///           - After the swap, vault reads its URU balance delta and forwards to the
///             distribution sink. A `minUruOut` slippage floor is enforced by the keeper.
///
/// @dev    Only trusted keeper addresses can trigger `executeBuyback`. Owner (multisig)
///         manages the keeper list and the swap-target allowlist. There is NO admin
///         function to move URU to arbitrary destinations — only forwards to the fixed
///         `distributionSink`.
contract UruBuybackVault is Ownable {
    error UruBuybackVault__ZeroAddress();
    error UruBuybackVault__NotKeeper();
    error UruBuybackVault__TargetNotAllowed(address target);
    error UruBuybackVault__SwapFailed();
    error UruBuybackVault__SlippageExceeded(uint256 got, uint256 min);
    error UruBuybackVault__ZeroSwap();
    /// Keeper set `minUruOut` below the on-chain slippage floor.
    error UruBuybackVault__BelowMinRate(uint256 minUruOut, uint256 rateFloor);
    error UruBuybackVault__ConfigDelayNotPassed(uint256 readyAt);
    error UruBuybackVault__NoPendingSink();

    event Received(address indexed from, uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapTargetSet(address indexed target, bool allowed);
    event DistributionSinkSet(address indexed sink);
    event DistributionSinkProposed(address indexed sink, uint256 readyAt);
    event MinUruPerEthSet(uint256 rate);
    event BuybackExecuted(uint256 ethIn, uint256 uruOut);
    event UruSwept(address indexed to, uint256 amount);

    IERC20Minimal public immutable uru;
    address public distributionSink;

    /// Timelock on rotating distributionSink. Same MEV / rug-protection story
    /// as UruDepositSink - even a compromised owner needs `minConfigDelay`
    /// before proceeds redirect.
    uint256 public immutable minConfigDelay;

    /// Two-step rotation state for distributionSink.
    address public pendingDistributionSink;
    uint256 public pendingDistributionSinkTs;

    /// On-chain URU-per-ETH floor for the keeper's swap. Denomination: 1e18 =
    /// 1 URU per 1 ETH. Set by owner tracking spot; forces the keeper to prove
    /// they hit near-market by requiring minUruOut >= ethIn * minUruPerEth / 1e18.
    /// Zero disables (bootstrap only; raise ASAP).
    uint256 public minUruPerEth;

    mapping(address => bool) public isKeeper;
    mapping(address => bool) public isSwapTarget;

    constructor(
        address initialOwner,
        address uru_,
        address distributionSink_,
        uint256 minConfigDelay_
    ) {
        if (initialOwner == address(0) || uru_ == address(0) || distributionSink_ == address(0)) {
            revert UruBuybackVault__ZeroAddress();
        }
        _initializeOwner(initialOwner);
        uru = IERC20Minimal(uru_);
        distributionSink = distributionSink_;
        minConfigDelay = minConfigDelay_;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Keeper triggers a buyback. `swapTarget` must be on the allowlist. The
    ///         vault sends `ethIn` alongside the call; `swapData` is opaque, prepared
    ///         off-chain by the keeper's routing logic. `minUruOut` protects against
    ///         MEV/slippage; enforced by comparing URU balance delta.
    function executeBuyback(
        address swapTarget,
        uint256 ethIn,
        bytes calldata swapData,
        uint256 minUruOut
    ) external {
        if (!isKeeper[msg.sender]) revert UruBuybackVault__NotKeeper();
        if (!isSwapTarget[swapTarget]) revert UruBuybackVault__TargetNotAllowed(swapTarget);
        if (ethIn == 0) revert UruBuybackVault__ZeroSwap();
        // Force keeper to prove near-market execution - a compromised keeper
        // can't pass minUruOut = 1 to strip protocol value.
        {
            uint256 rateFloor = (ethIn * minUruPerEth) / 1e18;
            if (minUruOut < rateFloor) revert UruBuybackVault__BelowMinRate(minUruOut, rateFloor);
        }

        uint256 uruBefore = uru.balanceOf(address(this));
        (bool ok,) = swapTarget.call{value: ethIn}(swapData);
        if (!ok) revert UruBuybackVault__SwapFailed();
        uint256 uruAfter = uru.balanceOf(address(this));
        uint256 uruOut = uruAfter - uruBefore;
        if (uruOut < minUruOut) revert UruBuybackVault__SlippageExceeded(uruOut, minUruOut);

        // Forward the acquired URU to the fixed distribution sink.
        // slither-disable-next-line unchecked-transfer
        uru.transfer(distributionSink, uruOut);
        emit BuybackExecuted(ethIn, uruOut);
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

    /// Two-step rotation of distributionSink. Owner proposes -> wait
    /// `minConfigDelay` -> owner activates. Prevents an owner-key compromise
    /// from instantly redirecting bought URU to attacker.
    function proposeDistributionSink(
        address sink
    ) external onlyOwner {
        if (sink == address(0)) revert UruBuybackVault__ZeroAddress();
        pendingDistributionSink = sink;
        pendingDistributionSinkTs = block.timestamp + minConfigDelay;
        emit DistributionSinkProposed(sink, pendingDistributionSinkTs);
    }

    function activateDistributionSink() external onlyOwner {
        address pending = pendingDistributionSink;
        if (pending == address(0)) revert UruBuybackVault__NoPendingSink();
        uint256 readyAt = pendingDistributionSinkTs;
        if (block.timestamp < readyAt) revert UruBuybackVault__ConfigDelayNotPassed(readyAt);
        distributionSink = pending;
        pendingDistributionSink = address(0);
        pendingDistributionSinkTs = 0;
        emit DistributionSinkSet(pending);
    }

    /// Owner sets the URU-per-ETH swap-rate floor. See minUruPerEth docstring.
    function setMinUruPerEth(
        uint256 rate
    ) external onlyOwner {
        minUruPerEth = rate;
        emit MinUruPerEthSet(rate);
    }

    /// Escape hatch: sweep stranded ETH that arrived outside a keeper cycle
    /// (residual dust, misdirected sends). Forces destination = distributionSink,
    /// mirroring UruDepositSink.flushEth's constraint - NOT a general drain.
    function sweepETH() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        SafeTransferLib.safeTransferETH(distributionSink, bal);
    }

    /// Escape hatch for URU that arrived outside a buyback cycle. Without this,
    /// pre-transferred URU (accidental sends, or swap routers that pre-transfer
    /// before the delta window) is stranded forever - executeBuyback only
    /// forwards the balance-delta from the current swap. Forces destination =
    /// distributionSink so URU still lands in the flywheel.
    function sweepURU() external onlyOwner {
        uint256 bal = uru.balanceOf(address(this));
        if (bal == 0) return;
        // slither-disable-next-line unchecked-transfer
        uru.transfer(distributionSink, bal);
        emit UruSwept(distributionSink, bal);
    }
}
