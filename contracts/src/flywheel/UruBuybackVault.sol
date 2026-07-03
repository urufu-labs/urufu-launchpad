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

    event Received(address indexed from, uint256 amount);
    event KeeperSet(address indexed keeper, bool allowed);
    event SwapTargetSet(address indexed target, bool allowed);
    event DistributionSinkSet(address indexed sink);
    event BuybackExecuted(uint256 ethIn, uint256 uruOut);

    IERC20Minimal public immutable uru;
    address public distributionSink;

    mapping(address => bool) public isKeeper;
    mapping(address => bool) public isSwapTarget;

    constructor(
        address initialOwner,
        address uru_,
        address distributionSink_
    ) {
        if (initialOwner == address(0) || uru_ == address(0) || distributionSink_ == address(0)) {
            revert UruBuybackVault__ZeroAddress();
        }
        _initializeOwner(initialOwner);
        uru = IERC20Minimal(uru_);
        distributionSink = distributionSink_;
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

    function setDistributionSink(
        address sink
    ) external onlyOwner {
        if (sink == address(0)) revert UruBuybackVault__ZeroAddress();
        distributionSink = sink;
        emit DistributionSinkSet(sink);
    }

    // Escape hatch: sweep any stuck ETH (shouldn't happen but safety).
    function sweepETH(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert UruBuybackVault__ZeroAddress();
        SafeTransferLib.safeTransferETH(to, address(this).balance);
    }
}
