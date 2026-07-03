// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  MultiHookHost
/// @notice One deployable hook that combines `LPLocked` + `FeeRedirect` behavior. v4 encodes
///         the permission mask in the hook ADDRESS, and `PoolKey.hooks` is a single address —
///         so a pool can only ever point at one hook contract. To ship the launchpad's
///         "LP locked forever AND fees split to platform/creator" combo, both behaviors have
///         to live in the same contract at the same address. This is that contract.
/// @dev    Deploy at an address whose low bits set:
///           BEFORE_REMOVE_LIQUIDITY_FLAG (1 << 9)
///         | AFTER_SWAP_FLAG              (1 << 6)
///         | AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2)
///         The HookMiner CREATE2 utility computes the salt.
contract MultiHookHost is BaseHook, IUnlockCallback {
    // ---- LPLocked ----
    error MultiHookHost__LiquidityLocked();
    event MultiHookHostRemoveAttempt(address indexed sender, PoolKey key);

    // ---- FeeRedirect ----
    error MultiHookHost__BpsTooHigh(uint256 total);
    error MultiHookHost__ZeroAddress();
    error MultiHookHost__NothingToClaim();

    event FeeAccrued(Currency indexed currency, uint256 platformShare, uint256 creatorShare);
    event FeeClaimed(Currency indexed currency, address indexed to, uint256 amount);

    uint16 public constant MAX_TOTAL_BPS = 3000;

    address public immutable platform;
    address public immutable creator;
    uint16 public immutable platformBps;
    uint16 public immutable creatorBps;

    mapping(Currency => mapping(address => uint256)) public owed;

    constructor(
        IPoolManager _poolManager,
        address _platform,
        address _creator,
        uint16 _platformBps,
        uint16 _creatorBps
    ) BaseHook(_poolManager) {
        if (_platform == address(0) || _creator == address(0)) revert MultiHookHost__ZeroAddress();
        uint256 total = uint256(_platformBps) + uint256(_creatorBps);
        if (total == 0 || total > MAX_TOTAL_BPS) revert MultiHookHost__BpsTooHigh(total);
        platform = _platform;
        creator = _creator;
        platformBps = _platformBps;
        creatorBps = _creatorBps;
    }

    function getHookPermissions() public pure override returns (Permissions memory) {
        return Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
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

    // ---- LPLocked behavior ----
    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4) {
        emit MultiHookHostRemoveAttempt(sender, key);
        revert MultiHookHost__LiquidityLocked();
    }

    // ---- FeeRedirect behavior ----
    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);
        if (unspecDelta <= 0) return (this.afterSwap.selector, 0);
        uint256 outAmount = uint128(unspecDelta);
        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 totalFee = (outAmount * totalBps) / 10_000;
        if (totalFee == 0) return (this.afterSwap.selector, 0);

        uint256 platformShare = (totalFee * platformBps) / totalBps;
        uint256 creatorShare = totalFee - platformShare;
        owed[unspecCurrency][platform] += platformShare;
        owed[unspecCurrency][creator] += creatorShare;
        emit FeeAccrued(unspecCurrency, platformShare, creatorShare);
        return (this.afterSwap.selector, int128(int256(totalFee)));
    }

    function claim(
        Currency currency
    ) external {
        uint256 amount = owed[currency][msg.sender];
        if (amount == 0) revert MultiHookHost__NothingToClaim();
        owed[currency][msg.sender] = 0;
        poolManager.unlock(abi.encode(currency, msg.sender, amount));
        emit FeeClaimed(currency, msg.sender, amount);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert BaseHook__NotPoolManager();
        (Currency currency, address to, uint256 amount) = abi.decode(data, (Currency, address, uint256));
        poolManager.take(currency, to, amount);
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
