// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {BaseType} from "src/types/VMTypes.sol";

interface IFeeReceiver {
    function receiveFee(
        address launcher,
        BaseType base
    ) external payable;
}

/// @title  FeeReceiver
/// @notice Minimal ETH sink for Router launch fees. Emits a per-launch event with the launcher
///         and base type, and lets the owner sweep to treasury on demand.
/// @dev    No conversion, no swap, no forwarding. A v2 receiver (auto-swap-to-USDC, streaming
///         payout, etc.) can drop in without touching Router because Router only depends on
///         `IFeeReceiver`. See docs/SPEC-router.md §FeeReceiver.
contract FeeReceiver is IFeeReceiver, Ownable {
    // ============================================================
    // Errors
    // ============================================================

    error FeeReceiver__ZeroAddress();

    // ============================================================
    // Events
    // ============================================================

    event FeeReceived(address indexed launcher, BaseType indexed base, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    constructor(
        address initialOwner
    ) {
        _initializeOwner(initialOwner);
    }

    /// @notice Called by Router with the launch fee.
    function receiveFee(
        address launcher,
        BaseType base
    ) external payable {
        emit FeeReceived(launcher, base, msg.value);
    }

    /// @notice Sweep the full ETH balance to `to`. Owner-only.
    function sweep(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert FeeReceiver__ZeroAddress();
        uint256 amount = address(this).balance;
        SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    /// @dev Accept direct sends (e.g. accidental transfers) without reverting.
    ///      Credited to `launcher = address(0)` and `base = BaseType.ERC20` (default enum value)
    ///      so indexers can distinguish these from Router-mediated calls.
    receive() external payable {
        emit FeeReceived(address(0), BaseType.ERC20, msg.value);
    }
}
