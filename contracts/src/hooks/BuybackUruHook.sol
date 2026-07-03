// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  BuybackUruHook
/// @notice Sibling of `BuybackBurnHook`: instead of burning a slice of every swap output
///         to `0xdead`, this hook routes the slice to `UruBuybackVault`, which the keeper
///         then swaps to URU and forwards to `NftRevenueVault` for distribution to gemu
///         holders. Deflationary flywheel meets ecosystem revenue-share.
///
///         Configured with the launched-token `Currency` at deploy time. Only acts when
///         that currency is the swap's output side; opposite direction is a no-op.
///
/// @dev    Deploy at an address whose low bits set AFTER_SWAP_FLAG (1 << 6) and
///         AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2). Same HookMiner flow as the other hooks.
///         The `UruBuybackVault` address is immutable at deploy time — swapping vaults
///         requires a hook redeploy at a new mined address (and a new pool).
contract BuybackUruHook is BaseHook, IUnlockCallback {
    error BuybackUruHook__BpsTooHigh(uint256 bps);
    error BuybackUruHook__ZeroToken();
    error BuybackUruHook__ZeroVault();

    event ToVault(Currency indexed launchedToken, uint256 amount);

    uint16 public constant MAX_BPS = 2000; // 20% cap — flywheel, not confiscation

    Currency public immutable launchedToken;
    address public immutable buybackVault;
    uint16 public immutable feeBps;

    constructor(
        IPoolManager _poolManager,
        Currency _launchedToken,
        address _buybackVault,
        uint16 _feeBps
    ) BaseHook(_poolManager) {
        if (Currency.unwrap(_launchedToken) == address(0)) revert BuybackUruHook__ZeroToken();
        if (_buybackVault == address(0)) revert BuybackUruHook__ZeroVault();
        if (_feeBps == 0 || _feeBps > MAX_BPS) revert BuybackUruHook__BpsTooHigh(_feeBps);
        launchedToken = _launchedToken;
        buybackVault = _buybackVault;
        feeBps = _feeBps;
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
        if (Currency.unwrap(unspecCurrency) != Currency.unwrap(launchedToken)) {
            return (this.afterSwap.selector, 0);
        }
        if (unspecDelta <= 0) return (this.afterSwap.selector, 0);
        uint256 outAmount = uint128(unspecDelta);
        uint256 slice = (outAmount * feeBps) / 10_000;
        if (slice == 0) return (this.afterSwap.selector, 0);

        // Route the slice to the buyback vault.
        poolManager.unlock(abi.encode(unspecCurrency, slice));
        emit ToVault(unspecCurrency, slice);
        return (this.afterSwap.selector, int128(int256(slice)));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert BaseHook__NotPoolManager();
        (Currency currency, uint256 amount) = abi.decode(data, (Currency, uint256));
        poolManager.take(currency, buybackVault, amount);
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
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d) >> 128));
    }

    function _amount1(
        BalanceDelta d
    ) private pure returns (int128) {
        return int128(int256(BalanceDelta.unwrap(d)));
    }
}
