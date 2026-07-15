// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title  V4SwapRouter
/// @notice Minimal Uniswap v4 swap router that handles our launchpad's graduated pools.
///         Two entry points — ETH → token and token → ETH — for pools whose currency0
///         is native ETH (which every graduated launchpad pool is, since the curve pairs
///         ETH ↔ token). Handles MultiHookHost's afterSwap fee delta correctly by reading
///         `currencyDelta` after the swap rather than trusting the raw swap return value:
///         the hook takes a slice of the output on top of what the pool paid out, and only
///         the transient delta reflects the net owed/owed-to-us after that adjustment.
///
///         Intentionally simple — no permit2, no multi-hop, no exact-output. Users approve
///         (for sells) then call the entry point; router does the unlock/swap/settle/take
///         dance in one shot. Deploy one per chain, register in the launchpad address book.
///
/// @dev    NOT a general-purpose router. Assumes:
///           - currency0 == address(0) (native ETH)
///           - currency1 == the token being traded
///           - Caller has approved the router for `amountIn` when calling
///             swapExactTokenForETH.
contract V4SwapRouter {
    using TransientStateLibrary for IPoolManager;

    error V4SwapRouter__NotPoolManager();
    error V4SwapRouter__InsufficientOutput(uint256 got, uint256 minOut);
    error V4SwapRouter__EthMismatch(uint256 sent, uint256 expected);

    event Swapped(
        address indexed user,
        address indexed token,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut
    );

    IPoolManager public immutable poolManager;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// Native-ETH refunds from failed transfers or PoolManager over-settle.
    receive() external payable {}

    /// @notice Buy the token side of a graduated pool with native ETH.
    /// @param  key       Pool identifier — must have currency0 == 0x0.
    /// @param  minOut    Minimum token amount to receive (slippage protection).
    /// @param  recipient Who receives the token output.
    /// @return amountOut Tokens taken and delivered to `recipient`.
    function swapExactETHForToken(
        PoolKey calldata key,
        uint256 minOut,
        address recipient
    ) external payable returns (uint256 amountOut) {
        if (msg.value == 0) revert V4SwapRouter__EthMismatch(0, 1);
        bytes memory data = abi.encode(true, key, msg.value, minOut, recipient, msg.sender);
        bytes memory ret = poolManager.unlock(data);
        amountOut = abi.decode(ret, (uint256));
    }

    /// @notice Sell the token side back to native ETH.
    /// @param  key       Pool identifier — must have currency0 == 0x0.
    /// @param  amountIn  Token amount to sell (caller must have `approve`d us).
    /// @param  minOut    Minimum ETH to receive.
    /// @param  recipient Who receives the ETH output.
    /// @return amountOut Wei of ETH delivered to `recipient`.
    function swapExactTokenForETH(
        PoolKey calldata key,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        // Pull tokens now so the unlock callback has them to settle with.
        SafeTransferLib.safeTransferFrom(Currency.unwrap(key.currency1), msg.sender, address(this), amountIn);
        bytes memory data = abi.encode(false, key, amountIn, minOut, recipient, msg.sender);
        bytes memory ret = poolManager.unlock(data);
        amountOut = abi.decode(ret, (uint256));
    }

    struct SwapCtx {
        bool isBuy;
        PoolKey key;
        uint256 amountIn;
        uint256 minOut;
        address recipient;
        address user;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert V4SwapRouter__NotPoolManager();
        SwapCtx memory c = abi.decode(data, (SwapCtx));

        poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.isBuy,
                amountSpecified: -int256(c.amountIn),
                sqrtPriceLimitX96: c.isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Deltas AFTER swap + afterSwap. MultiHookHost claims a slice of the output for
        // its fee split via return-delta — reading currencyDelta here gets the real
        // per-currency amount we (as the callback) owe/are owed.
        int256 d0 = TransientStateLibrary.currencyDelta(poolManager, address(this), c.key.currency0);
        int256 d1 = TransientStateLibrary.currencyDelta(poolManager, address(this), c.key.currency1);

        uint256 amountOut;
        if (c.isBuy) {
            // Owe ETH (d0 < 0), receive tokens (d1 > 0).
            if (d0 < 0) poolManager.settle{value: uint256(-d0)}();
            if (d1 > 0) {
                amountOut = uint256(d1);
                if (amountOut < c.minOut) revert V4SwapRouter__InsufficientOutput(amountOut, c.minOut);
                // Take to the router then forward via ERC20 transfer — same result for
                // an EOA recipient but works uniformly for smart-account recipients that
                // might not accept a direct `take` call (v4's native-take does a raw call).
                poolManager.take(c.key.currency1, address(this), amountOut);
                SafeTransferLib.safeTransfer(Currency.unwrap(c.key.currency1), c.recipient, amountOut);
            }
            // Refund any unused ETH (shouldn't happen for exact-input, but be safe).
            if (address(this).balance > 0) {
                SafeTransferLib.safeTransferETH(c.user, address(this).balance);
            }
            emit Swapped(c.user, Currency.unwrap(c.key.currency1), true, c.amountIn, amountOut);
        } else {
            // Owe tokens (d1 < 0), receive ETH (d0 > 0).
            if (d1 < 0) {
                // Router already holds the tokens (pulled in swapExactTokenForETH). Sync
                // + settle-with-transfer to credit the pool.
                poolManager.sync(c.key.currency1);
                SafeTransferLib.safeTransfer(Currency.unwrap(c.key.currency1), address(poolManager), uint256(-d1));
                poolManager.settle();
            }
            if (d0 > 0) {
                amountOut = uint256(d0);
                if (amountOut < c.minOut) revert V4SwapRouter__InsufficientOutput(amountOut, c.minOut);
                // Take native ETH to the router first, then forward. v4's take() for ETH
                // sends via low-level call; that works for EOAs but not all smart-account
                // recipient shapes. Two-step forward is uniformly safe.
                poolManager.take(c.key.currency0, address(this), amountOut);
                SafeTransferLib.safeTransferETH(c.recipient, amountOut);
            }
            emit Swapped(c.user, Currency.unwrap(c.key.currency1), false, c.amountIn, amountOut);
        }
        return abi.encode(amountOut);
    }
}
