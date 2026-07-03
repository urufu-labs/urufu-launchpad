// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  BaseHook
/// @notice Thin implementation of `IHooks` that reverts on every callback by default.
///         Subclasses override only the callbacks they enable in `getHookPermissions()`.
///         The v4 `PoolManager` inspects the hook address's low bits to decide which
///         callbacks to invoke — this base intentionally does NOT self-enforce the
///         permission bits at deploy time; the deployer is responsible for mining a
///         CREATE2 salt that yields an address whose low bits match `getHookPermissions()`.
///         See `docs/SPEC-v4-hooks.md` for the mining flow.
/// @dev    Only the `PoolManager` may call these hooks. `_onlyPoolManager()` enforces it.
abstract contract BaseHook is IHooks {
    IPoolManager public immutable poolManager;

    error BaseHook__NotPoolManager();
    error BaseHook__NotImplemented();

    constructor(
        IPoolManager _poolManager
    ) {
        poolManager = _poolManager;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert BaseHook__NotPoolManager();
        _;
    }

    struct Permissions {
        bool beforeInitialize;
        bool afterInitialize;
        bool beforeAddLiquidity;
        bool afterAddLiquidity;
        bool beforeRemoveLiquidity;
        bool afterRemoveLiquidity;
        bool beforeSwap;
        bool afterSwap;
        bool beforeDonate;
        bool afterDonate;
        bool beforeSwapReturnDelta;
        bool afterSwapReturnDelta;
        bool afterAddLiquidityReturnDelta;
        bool afterRemoveLiquidityReturnDelta;
    }

    /// @notice Override to advertise which callbacks are enabled.
    function getHookPermissions() public pure virtual returns (Permissions memory);

    // Default reverts — subclasses override the ones enabled in getHookPermissions().
    function beforeInitialize(
        address,
        PoolKey calldata,
        uint160
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }

    function afterInitialize(
        address,
        PoolKey calldata,
        uint160,
        int24
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert BaseHook__NotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert BaseHook__NotImplemented();
    }

    function beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) external virtual returns (bytes4, BeforeSwapDelta, uint24) {
        revert BaseHook__NotImplemented();
    }

    function afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, int128) {
        revert BaseHook__NotImplemented();
    }

    function beforeDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }

    function afterDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    ) external virtual returns (bytes4) {
        revert BaseHook__NotImplemented();
    }
}
