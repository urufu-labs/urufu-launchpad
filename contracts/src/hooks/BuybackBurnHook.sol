// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  BuybackBurnHook
/// @notice Uniswap v4 hook that skims a bps slice of every swap whose OUTPUT is the launched
///         token and routes the slice straight to a dead address. Every trade shrinks the
///         circulating supply of the launched token — pure deflationary flywheel, no keeper,
///         no separate buyback contract, no swap-through-a-pool complexity.
///
///         The hook is configured with the launched-token `Currency` at deploy time. It only
///         acts when that currency is the swap's output side; the opposite direction (buying
///         with the launched token) is a no-op.
///
/// @dev    Deploy at an address whose low bits set AFTER_SWAP_FLAG (1 << 6) and
///         AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2). The v4 `PoolManager.take` at the dead
///         address is what actually removes the tokens from the pool — the tokens end up
///         held by 0xdead and are effectively burned for any accounting purpose that reads
///         `totalSupply - balanceOf(dead)`.
contract BuybackBurnHook is BaseHook, IUnlockCallback {
    error BuybackBurnHook__BpsTooHigh(uint256 bps);
    error BuybackBurnHook__ZeroToken();

    event BuybackBurned(Currency indexed launchedToken, uint256 amount);

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant MAX_BPS = 2000; // 20% ceiling — deflation, not confiscation.

    Currency public immutable launchedToken;
    uint16 public immutable burnBps;

    constructor(
        IPoolManager _poolManager,
        Currency _launchedToken,
        uint16 _burnBps
    ) BaseHook(_poolManager) {
        if (Currency.unwrap(_launchedToken) == address(0)) revert BuybackBurnHook__ZeroToken();
        if (_burnBps == 0 || _burnBps > MAX_BPS) revert BuybackBurnHook__BpsTooHigh(_burnBps);
        launchedToken = _launchedToken;
        burnBps = _burnBps;
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);
        // Only act when the swap's output side is the launched token AND the swapper is receiving it.
        if (Currency.unwrap(unspecCurrency) != Currency.unwrap(launchedToken)) {
            return (this.afterSwap.selector, 0);
        }
        if (unspecDelta <= 0) return (this.afterSwap.selector, 0);
        uint256 outAmount = uint128(unspecDelta);
        uint256 burnAmount = (outAmount * burnBps) / 10_000;
        if (burnAmount == 0) return (this.afterSwap.selector, 0);

        // Route the burn slice out of the pool immediately — no accumulation, no keeper needed.
        // The hook takes ownership of the delta (+burnAmount), then unlocks to move it to DEAD.
        poolManager.unlock(abi.encode(unspecCurrency, burnAmount));
        emit BuybackBurned(unspecCurrency, burnAmount);
        return (this.afterSwap.selector, int128(int256(burnAmount)));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert BaseHook__NotPoolManager();
        (Currency currency, uint256 amount) = abi.decode(data, (Currency, uint256));
        poolManager.take(currency, DEAD, amount);
        return "";
    }

    function _unspecified(
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta
    ) internal pure returns (Currency currency, int128 amount) {
        bool isExactInput = params.amountSpecified < 0;
        if (params.zeroForOne == isExactInput) {
            currency = key.currency1;
            amount = _amount1(delta);
        } else {
            currency = key.currency0;
            amount = _amount0(delta);
        }
    }

    function _amount0(
        BalanceDelta delta
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(delta) >> 128));
    }

    function _amount1(
        BalanceDelta delta
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(delta)));
    }
}
