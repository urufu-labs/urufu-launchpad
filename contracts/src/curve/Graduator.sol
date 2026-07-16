// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

/// Slim interface for the deployed MultiHookHost — just the setters Graduator calls per
/// graduation. Kept as a bare interface so we don't drag MultiHookHost's full ABI in.
interface IHookConfig {
    function setPoolConfig(
        PoolId id,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external;
    /// Set the per-pool creator address. Introduced with MultiHookHost v2 (per-pool
    /// creator revenue). Older hook deployments don't implement this — Graduator
    /// wraps the call in try/catch so pre-v2 hooks still function without it.
    function setCreator(
        PoolId id,
        address creator
    ) external;
}

/// @title  Graduator
/// @notice Takes a graduated BondingCurve's ETH + token reserves and mints them as a
///         full-range LP position in a Uniswap v4 pool with the platform's chosen hook.
///         The LP position ends up owned by this contract — since the hook is expected to
///         be `LPLockedHook` (or `MultiHookHost`), any `poolManager.modifyLiquidity` call
///         that removes liquidity reverts forever. LP locked by construction.
///
/// @dev    Called by `BondingCurve._graduate()` in the same transaction: BondingCurve
///         `.approve()`s this contract to pull its tokens, then calls `execute` with the
///         ETH value alongside. Execute does the whole v4 dance in one shot.
///
///         Fee tier + tick spacing are configurable at deploy time. Defaults match the
///         common 0.3% tier that Uniswap v4 examples use, giving reasonable liquidity
///         concentration for the initial LP.
contract Graduator is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    error Graduator__NotPoolManager();
    error Graduator__EthMismatch(uint256 sent, uint256 expected);
    error Graduator__ZeroAmount();

    event Graduated(
        address indexed token,
        address indexed hook,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );

    IPoolManager public immutable poolManager;
    IHooks public immutable defaultHook;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    // Full-range tick bounds, aligned to tickSpacing at construction.
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    constructor(
        IPoolManager _poolManager,
        IHooks _defaultHook,
        uint24 _fee,
        int24 _tickSpacing
    ) {
        poolManager = _poolManager;
        defaultHook = _defaultHook;
        fee = _fee;
        tickSpacing = _tickSpacing;
        tickLower = (TickMath.MIN_TICK / _tickSpacing + 1) * _tickSpacing;
        tickUpper = (TickMath.MAX_TICK / _tickSpacing) * _tickSpacing;
    }

    /// @notice Graduate a curve. Caller must have already approved `tokenAmount` of `token`.
    /// @param  antiSniperBlocks  swaps on the new pool revert for N blocks after init. 0 = disabled.
    /// @param  buybackBurnBps    slice of every BUY's token output sent to 0xdead. 0 = disabled.
    /// @param  launcher          address that gets installed as the pool's per-pool creator
    ///                           on the v4 hook — receives the creator share of post-grad
    ///                           swap fees. Zero-address falls back to hook's default
    ///                           creator (typical for pre-launcher-tracking curves).
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable {
        if (ethAmount == 0 || tokenAmount == 0) revert Graduator__ZeroAmount();
        if (msg.value != ethAmount) revert Graduator__EthMismatch(msg.value, ethAmount);

        // Pull the tokens — safeTransferFrom guards against non-compliant ERC20s that
        // silently return false (USDT-family) rather than reverting. Solady's assembly
        // wrapper reverts on any failure; Slither can't see through the asm.
        // slither-disable-next-line unchecked-transfer
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);

        // v4 orders currencies numerically: address(0) < any 20-byte address, so native ETH
        // is always currency0.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: defaultHook
        });

        // Write per-pool hook config BEFORE initialize — once initialize fires it stamps
        // the hook's `launchBlock` and the setPoolConfig call would revert with
        // ConfigFrozen. Wrapped in try/catch so a graduation still succeeds even if the
        // hook contract doesn't implement setPoolConfig (e.g. an older MultiHookHost
        // deployment mid-migration); the pool just launches without anti-sniper / buyback.
        PoolId poolId = key.toId();
        if (antiSniperBlocks > 0 || buybackBurnBps > 0) {
            try IHookConfig(address(defaultHook)).setPoolConfig(poolId, antiSniperBlocks, buybackBurnBps) {
            // config landed
            }
                catch {
                // silently continue — the pool still opens without the extra behaviors.
            }
        }

        // Assign the per-pool creator BEFORE initialize — same freeze window as
        // setPoolConfig. Zero-address launcher (legacy path) skips the setter so the
        // hook's constructor fallback receives the creator share. Try/catch keeps
        // graduations working against pre-v2 MultiHookHost deployments that don't
        // implement setCreator — they'll accrue the whole creator share to their
        // immutable `creator` slot like before.
        if (launcher != address(0)) {
            try IHookConfig(address(defaultHook)).setCreator(poolId, launcher) {
            // creator landed
            }
                catch {
                // pre-v2 hook — creator share flows to the immutable fallback.
            }
        }

        // Uniswap v4 pricing convention:
        //   sqrtPriceX96 = sqrt(price) * 2^96, where price = amount1 / amount0
        // Here currency0 = native ETH, currency1 = token, so:
        //   price = tokenAmount / ethAmount     (atomic units)
        //   sqrtPriceX96 = sqrt(tokenAmount * 2^192 / ethAmount)
        //              = sqrt(tokenAmount) * 2^96 / sqrt(ethAmount)
        //
        // An earlier version of this contract had tokenAmount + ethAmount swapped, which
        // initialized every graduated pool at the wrong sqrtPriceX96 and stranded most of
        // the LP-side tokens outside the concentrated position. Fork tests missed it
        // because they only asserted `sqrtPriceX96 > 0`; the practical breakage only shows
        // up when the pool tries to trade at anything resembling the intended reserves.
        uint160 sqrtPriceX96 = uint160((FixedPointMathLib.sqrt(tokenAmount) << 96) / FixedPointMathLib.sqrt(ethAmount));

        poolManager.initialize(key, sqrtPriceX96);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, ethAmount, tokenAmount);

        poolManager.unlock(abi.encode(key, uint256(liquidity), ethAmount, tokenAmount, token));
        emit Graduated(token, address(defaultHook), ethAmount, tokenAmount, sqrtPriceX96, liquidity);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Graduator__NotPoolManager();
        (PoolKey memory key, uint256 liquidity,,, address token) =
            abi.decode(data, (PoolKey, uint256, uint256, uint256, address));

        // modifyLiquidity returns the CALLER's delta. For adding liquidity both amounts are
        // negative — the exact wei we need to settle to close the position. Using the exact
        // returned delta (vs. the pre-computed intended amounts) protects against rounding
        // mismatches between LiquidityAmounts.getLiquidityForAmounts and v4's internal
        // amount-for-liquidity computation.
        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = _amount0(callerDelta);
        int128 delta1 = _amount1(callerDelta);

        // Settle currency0 (native ETH).
        if (delta0 < 0) {
            uint256 owed = uint256(uint128(-delta0));
            poolManager.settle{value: owed}();
        } else if (delta0 > 0) {
            poolManager.take(key.currency0, address(this), uint256(uint128(delta0)));
        }

        // Settle currency1 (the launched token). safeTransfer for the same USDT-style guard.
        if (delta1 < 0) {
            uint256 owed = uint256(uint128(-delta1));
            poolManager.sync(Currency.wrap(token));
            // slither-disable-next-line unchecked-transfer
            SafeTransferLib.safeTransfer(token, address(poolManager), owed);
            poolManager.settle();
        } else if (delta1 > 0) {
            poolManager.take(key.currency1, address(this), uint256(uint128(delta1)));
        }

        return "";
    }

    function _amount0(
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d) >> 128));
    }

    function _amount1(
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d)));
    }

    receive() external payable {}
}
