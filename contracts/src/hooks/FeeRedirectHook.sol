// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title  FeeRedirectHook
/// @notice Uniswap v4 hook that takes a bps slice of every swap's output currency and
///         routes it to a fixed platform + creator split. Accrual is per-currency /
///         per-recipient; recipients claim via `claim` which uses the v4 unlock/take
///         pattern to sweep the accumulated balance from the PoolManager.
/// @dev    Deploy at an address whose low bits set both AFTER_SWAP_FLAG (1 << 6) and
///         AFTER_SWAP_RETURNS_DELTA_FLAG (1 << 2). Fee bps are applied to the swap's
///         UNSPECIFIED currency (the output). platformBps + creatorBps must be ≤ 3000
///         (30%) — hard cap on total redirected fee.
contract FeeRedirectHook is BaseHook, IUnlockCallback {
    error FeeRedirectHook__BpsTooHigh(uint256 total);
    error FeeRedirectHook__ZeroAddress();
    error FeeRedirectHook__NothingToClaim();
    error FeeRedirectHook__OnlySelf();

    event FeeRedirectAccrued(
        Currency indexed currency,
        address indexed platform,
        address indexed creator,
        uint256 platformShare,
        uint256 creatorShare
    );
    event FeeRedirectClaimed(Currency indexed currency, address indexed to, uint256 amount);

    uint16 public constant MAX_TOTAL_BPS = 3000;

    address public immutable platform;
    address public immutable creator;
    uint16 public immutable platformBps;
    uint16 public immutable creatorBps;

    // owed[currency][recipient] = amount claimable
    mapping(Currency => mapping(address => uint256)) public owed;

    constructor(
        IPoolManager _poolManager,
        address _platform,
        address _creator,
        uint16 _platformBps,
        uint16 _creatorBps
    ) BaseHook(_poolManager) {
        if (_platform == address(0) || _creator == address(0)) revert FeeRedirectHook__ZeroAddress();
        uint256 total = uint256(_platformBps) + uint256(_creatorBps);
        if (total == 0 || total > MAX_TOTAL_BPS) revert FeeRedirectHook__BpsTooHigh(total);
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
        address, // sender
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata // hookData
    ) external override onlyPoolManager returns (bytes4, int128) {
        // Unspecified currency is what the swapper receives (output side).
        // exactInput swaps (amountSpecified < 0): specified = input, unspecified = output.
        // exactOutput swaps (amountSpecified > 0): specified = output, unspecified = input.
        // For fee-on-output semantics we always take from the swapper's output-side delta.
        (Currency unspecCurrency, int128 unspecDelta) = _unspecified(key, params, delta);

        // Swapper receives `unspecDelta > 0` amount. Take a slice from what they'd receive.
        if (unspecDelta <= 0) return (this.afterSwap.selector, 0);
        uint256 outAmount = uint128(unspecDelta);
        uint256 totalBps = uint256(platformBps) + uint256(creatorBps);
        uint256 totalFee = (outAmount * totalBps) / 10_000;
        if (totalFee == 0) return (this.afterSwap.selector, 0);

        uint256 platformShare = (totalFee * platformBps) / totalBps;
        uint256 creatorShare = totalFee - platformShare;
        owed[unspecCurrency][platform] += platformShare;
        owed[unspecCurrency][creator] += creatorShare;
        emit FeeRedirectAccrued(unspecCurrency, platform, creator, platformShare, creatorShare);

        // Positive delta = hook takes currency from the swapper's output.
        return (this.afterSwap.selector, int128(int256(totalFee)));
    }

    /// @notice Sweep accumulated fee for `msg.sender` in `currency` out of the PoolManager.
    function claim(
        Currency currency
    ) external {
        uint256 amount = owed[currency][msg.sender];
        if (amount == 0) revert FeeRedirectHook__NothingToClaim();
        owed[currency][msg.sender] = 0;
        poolManager.unlock(abi.encode(currency, msg.sender, amount));
        emit FeeRedirectClaimed(currency, msg.sender, amount);
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
        // If exactInput (amountSpecified < 0), the "specified" side is currency IN (the one they gave),
        // so "unspecified" is currency OUT (the one they got).
        // With zeroForOne=true: currency0 is input, currency1 is output.
        // Delta convention: BalanceDelta amount0/amount1 are the swapper's balance changes.
        // Positive amount1 in a zeroForOne swap = swapper received currency1.
        bool isExactInput = params.amountSpecified < 0;
        if (params.zeroForOne == isExactInput) {
            // zeroForOne + exactInput → unspecified = currency1
            // !zeroForOne + !exactInput (exactOutput) → unspecified = currency1
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
