// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
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
contract UruBuybackVault is Ownable, ReentrancyGuard {
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
    /// URU-A11: same propose/activate pattern as UruDepositSink for keeper /
    /// swapTarget / rate changes. Prevents a compromised owner from routing
    /// ETH through a malicious `swapTarget` in the same tx as authorizing it.
    error UruBuybackVault__AdminChangeNotProposed(bytes32 changeId);
    error UruBuybackVault__AdminChangeNotReady(bytes32 changeId, uint256 readyAt);

    event Received(address indexed from, uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapTargetSet(address indexed target, bool allowed);
    event DistributionSinkSet(address indexed sink);
    event DistributionSinkProposed(address indexed sink, uint256 readyAt);
    event MinUruPerEthSet(uint256 rate);
    event BuybackExecuted(uint256 ethIn, uint256 uruOut);
    event UruSwept(address indexed to, uint256 amount);
    event EthSwept(address indexed to, uint256 amount);
    /// URU-A11: telemetry for propose/activate/cancel of admin changes.
    event AdminChangeProposed(bytes32 indexed changeId, uint256 readyAt);
    event AdminChangeCancelled(bytes32 indexed changeId);
    /// URU-A11 AC #4: emitted when the setter consumes a matured proposal.
    /// Off-chain monitoring joins Proposed - Cancelled - Applied to enumerate
    /// the set of currently-pending admin changes.
    event AdminChangeApplied(bytes32 indexed changeId);

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
    /// URU-A11: mirrors UruDepositSink.adminChangeReadyAt. See that file for
    /// full docstring; identical semantics here.
    mapping(bytes32 => uint256) public adminChangeReadyAt;

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
    ) external nonReentrant {
        // URU-A14 additional-defect close: nonReentrant. The pre/post URU
        // balance-delta pattern is safe against a well-behaved ERC-20 (URU
        // is standard, no callbacks) but slither correctly flags that a
        // reentrant token or a rogue swapTarget could mint fake URU during
        // the callback and inflate `uruOut`. Guard closes the theoretical
        // path and matches the on-chain-enforcement principle in the spec.
        if (!isKeeper[msg.sender]) revert UruBuybackVault__NotKeeper();
        if (!isSwapTarget[swapTarget]) revert UruBuybackVault__TargetNotAllowed(swapTarget);
        if (ethIn == 0) revert UruBuybackVault__ZeroSwap();
        // Force keeper to prove near-market execution - a compromised keeper
        // can't pass minUruOut = 1 to strip protocol value.
        {
            uint256 rateFloor = (ethIn * minUruPerEth) / 1e18;
            if (minUruOut < rateFloor) revert UruBuybackVault__BelowMinRate(minUruOut, rateFloor);
        }

        // slither-disable-start reentrancy-eth,reentrancy-benign,reentrancy-no-eth,reentrancy-events,reentrancy-balance
        // Balance-delta pattern is safe under `nonReentrant` (added above):
        // a reentrant token or hostile swapTarget cannot re-enter this
        // function, so uruBefore/uruAfter cannot be manipulated between the
        // reads. Slither's static detector cannot see the modifier's runtime
        // guarantee — disable is scoped to just this block.
        uint256 uruBefore = uru.balanceOf(address(this));
        (bool ok,) = swapTarget.call{value: ethIn}(swapData);
        if (!ok) revert UruBuybackVault__SwapFailed();
        uint256 uruAfter = uru.balanceOf(address(this));
        uint256 uruOut = uruAfter - uruBefore;
        if (uruOut < minUruOut) revert UruBuybackVault__SlippageExceeded(uruOut, minUruOut);
        // slither-disable-end reentrancy-eth,reentrancy-benign,reentrancy-no-eth,reentrancy-events,reentrancy-balance

        // Forward the acquired URU to the fixed distribution sink. URU-A17
        // Low: SafeTransferLib enforces standard-ERC20 return-value semantics
        // (revert on false / missing return) so a non-standard URU deploy or
        // a hostile pausable token can't silently drop the sink credit.
        SafeTransferLib.safeTransfer(address(uru), distributionSink, uruOut);
        emit BuybackExecuted(ethIn, uruOut);
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================
    function setKeeper(
        address keeper,
        bool allowed
    ) external onlyOwner {
        // URU-A11: gated on a matured propose call. No-op when minConfigDelay == 0.
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
        // URU-A11: same propose/activate gate as keeper/target changes.
        _consumeAdminChange(rateChangeId(rate));
        minUruPerEth = rate;
        emit MinUruPerEthSet(rate);
    }

    // ============================================================
    // URU-A11 propose/activate — changeId helpers
    // ============================================================

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
        return keccak256(abi.encode("MIN_URU_PER_ETH", rate));
    }

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

    function _consumeAdminChange(
        bytes32 changeId
    ) internal {
        if (minConfigDelay == 0) return;
        uint256 readyAt = adminChangeReadyAt[changeId];
        if (readyAt == 0) revert UruBuybackVault__AdminChangeNotProposed(changeId);
        if (block.timestamp < readyAt) {
            revert UruBuybackVault__AdminChangeNotReady(changeId, readyAt);
        }
        delete adminChangeReadyAt[changeId];
        emit AdminChangeApplied(changeId);
    }

    /// Escape hatch: sweep stranded ETH that arrived outside a keeper cycle
    /// (residual dust, misdirected sends). Forces destination = distributionSink,
    /// mirroring UruDepositSink.flushEth's constraint - NOT a general drain.
    function sweepETH() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        SafeTransferLib.safeTransferETH(distributionSink, bal);
        emit EthSwept(distributionSink, bal);
    }

    /// Escape hatch for URU that arrived outside a buyback cycle. Without this,
    /// pre-transferred URU (accidental sends, or swap routers that pre-transfer
    /// before the delta window) is stranded forever - executeBuyback only
    /// forwards the balance-delta from the current swap. Forces destination =
    /// distributionSink so URU still lands in the flywheel. Uses SafeTransferLib
    /// so a token that returns false silently reverts instead of emitting a
    /// misleading UruSwept event with no actual balance change.
    function sweepURU() external onlyOwner {
        uint256 bal = uru.balanceOf(address(this));
        if (bal == 0) return;
        SafeTransferLib.safeTransfer(address(uru), distributionSink, bal);
        emit UruSwept(distributionSink, bal);
    }
}
