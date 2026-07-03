// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";

/// @title  AntiSniperHook
/// @notice Uniswap v4 hook that blocks swaps for `gateBlocks` after a pool is initialized.
///         Day-0 bot protection: minters + LP providers can add liquidity as usual, but the
///         first `gateBlocks` worth of swap volume is closed for business. The gate window
///         auto-expires — after `initBlock + gateBlocks` the hook is a no-op forever.
/// @dev    Deploy at an address whose low bits set BEFORE_INITIALIZE_FLAG (1 << 13) and
///         BEFORE_SWAP_FLAG (1 << 7). Same HookMiner flow as the other hooks.
contract AntiSniperHook is BaseHook {
    using PoolIdLibrary for PoolKey;

    error AntiSniperHook__WindowActive(uint256 currentBlock, uint256 gateUntil);
    error AntiSniperHook__PoolAlreadyInitialized();

    event AntiSniperArmed(PoolId indexed pool, uint256 initBlock, uint256 gateUntil);

    uint256 public immutable gateBlocks;
    mapping(PoolId => uint256) public gateUntil;

    constructor(
        IPoolManager _poolManager,
        uint256 _gateBlocks
    ) BaseHook(_poolManager) {
        gateBlocks = _gateBlocks;
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeInitialize(
        address,
        PoolKey calldata key,
        uint160
    ) external override onlyPoolManager returns (bytes4) {
        PoolId id = key.toId();
        if (gateUntil[id] != 0) revert AntiSniperHook__PoolAlreadyInitialized();
        uint256 gate = block.number + gateBlocks;
        gateUntil[id] = gate;
        emit AntiSniperArmed(id, block.number, gate);
        return this.beforeInitialize.selector;
    }

    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        uint256 until = gateUntil[key.toId()];
        if (block.number < until) revert AntiSniperHook__WindowActive(block.number, until);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
