// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

/// @title  LPLockedHook
/// @notice Uniswap v4 hook that reverts every `beforeRemoveLiquidity` call, so LP positions
///         minted to a pool with this hook can never withdraw. The pool's LP is locked
///         forever — rug-proof by construction. Adding liquidity, swapping, and donating
///         all remain unaffected.
/// @dev    Deploy at an address whose low bits set BEFORE_REMOVE_LIQUIDITY_FLAG (1 << 9).
///         The launchpad's HookMiner tooling is expected to compute the CREATE2 salt.
contract LPLockedHook is BaseHook {
    error LPLockedHook__LiquidityLocked();

    event LPLockedHookRemoveAttempt(address indexed sender, PoolKey key);

    constructor(
        IPoolManager _poolManager
    ) BaseHook(_poolManager) {}

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4) {
        emit LPLockedHookRemoveAttempt(sender, key);
        revert LPLockedHook__LiquidityLocked();
    }
}
