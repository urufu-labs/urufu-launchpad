// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

/// @title  LocalV4GraduationTest
/// @notice Fork-free end-to-end of the graduation path against a real, locally
///         deployed `v4-core` PoolManager. Proves the whole curve → Graduator →
///         v4 pool → swap lane works without touching a live network, and pins
///         the post-incident accounting guarantees (no stranded ETH, no stranded
///         tokens, and the graduation LP position stays put across third-party
///         LP add + remove cycles).
contract LocalV4GraduationTest is LocalV4Stack {
    using StateLibrary for IPoolManager;

    address internal launcher = makeAddr("local-launcher");
    address internal buyer = makeAddr("local-buyer");
    address internal trader = makeAddr("local-trader");

    function setUp() public {
        _deployStack();
        vm.deal(buyer, 100 ether);
        vm.deal(trader, 100 ether);
    }

    function test_FullGraduationLifecycle_OnLocalV4() public {
        (address tokenAddr, BondingCurve curve) = _launchViaRouter("Local", "LCL", launcher);
        StackToken token = StackToken(tokenAddr);

        uint256 target = curve.graduationTargetEth();
        assertEq(curve.ethReserve(), 0, "fresh curve should hold no ETH");
        assertFalse(curve.graduated(), "fresh curve should not be graduated");

        // ---- drive the curve to graduation -------------------------------
        vm.startPrank(buyer);
        curve.buy{value: 1 ether}(0);
        assertFalse(curve.graduated(), "graduated far too early");

        uint256 remaining = target - curve.ethReserve();
        curve.buy{value: (remaining * 115) / 100}(0);
        vm.stopPrank();

        assertTrue(curve.graduated(), "curve failed to graduate");

        // ---- post-incident accounting guarantees -------------------------
        // The V7 Graduator stranded ~4 ETH per graduation with no recovery
        // path. Post-fix, any residual dust is credited to the launcher's
        // pull-based refund ledger (FINDING 6 round 2). The invariant is
        // that NO un-credited ETH sits on the graduator, and no tokens do.
        assertEq(address(graduator).balance, graduator.totalClaimable(), "graduator holds un-credited ETH");
        assertEq(token.balanceOf(address(graduator)), 0, "graduator stranded tokens");

        assertEq(curve.ethReserve(), 0, "curve ethReserve not zeroed at graduation");
        assertEq(curve.tokenReserve(), 0, "curve tokenReserve not zeroed at graduation");

        // ---- the v4 pool actually exists and holds the liquidity ----------
        PoolId poolId = _poolIdFor(address(token));
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(poolId);
        uint128 liquidity = ipm.getLiquidity(poolId);

        assertGt(sqrtPriceX96, 0, "v4 pool was never initialized");
        assertGt(liquidity, 0, "v4 pool has no liquidity");
        console2.log("pool sqrtPriceX96:", sqrtPriceX96);
        console2.log("pool liquidity   :", liquidity);

        // ---- swap both directions through the real PoolManager ------------
        PoolKey memory key = _poolKeyFor(address(token));

        vm.prank(trader);
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.5 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(bought, 0, "v4 buy returned zero tokens");
        assertEq(token.balanceOf(trader), bought, "trader did not receive tokens");

        vm.startPrank(trader);
        token.approve(address(swapRouter), bought / 2);
        uint256 ethOut = swapRouter.swapExactTokenForETH(key, bought / 2, 0, trader, block.timestamp + 600);
        vm.stopPrank();
        assertGt(ethOut, 0, "v4 sell returned zero ETH");

        console2.log("bought for 0.5 ETH:", bought);
        console2.log("eth back for half :", ethOut);
    }

    /// FINDING 5 (audit round 2): third-party LPs must be able to add AND remove
    /// liquidity on a graduated pool. The old `MultiHookHost.beforeRemoveLiquidity`
    /// reverted unconditionally, freezing every third-party LP forever. It has been
    /// removed. Prove:
    ///   (a) a third-party LP can add liquidity to the graduated pool
    ///   (b) the SAME LP can remove all of it and receive their assets back
    ///   (c) the graduation LP position (owned by the Graduator, keyed at its
    ///       tickLower/tickUpper/salt=0) is untouched by that add + remove cycle
    ///
    /// The graduation LP is locked structurally: `GraduatorV2.sol` has no code
    /// path that calls `poolManager.modifyLiquidity` with a negative
    /// liquidityDelta, so no one can reduce that position.
    function test_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched() public {
        (address tokenAddr, BondingCurve curve) = _launchViaRouter("Free", "FREE", launcher);
        StackToken token = StackToken(tokenAddr);

        vm.startPrank(buyer);
        curve.buy{value: (curve.graduationTargetEth() * 120) / 100}(0);
        vm.stopPrank();
        assertTrue(curve.graduated(), "setup: curve did not graduate");

        // Buy some tokens off the pool so the third-party LP has both sides
        // (ETH already available; token needs a swap).
        PoolKey memory key = _poolKeyFor(address(token));
        vm.prank(trader);
        uint256 tokenIn = swapRouter.swapExactETHForToken{value: 1 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(tokenIn, 0, "setup: trader could not buy tokens");

        PoolId poolId = _poolIdFor(address(token));
        int24 gLower = graduator.tickLower();
        int24 gUpper = graduator.tickUpper();
        bytes32 gKey = keccak256(abi.encodePacked(address(graduator), gLower, gUpper, bytes32(0)));
        uint128 graduationLpBefore = ipm.getPositionLiquidity(poolId, gKey);
        assertGt(graduationLpBefore, 0, "setup: graduation LP position missing");

        // Third-party LP adds concentrated liquidity around the current price.
        // The full-range graduation position sits at MIN..MAX tick; the LP here
        // uses a narrower band so its position key differs from the graduation
        // position's key (unique per (owner, tickLower, tickUpper, salt)).
        int24 lpLower = -1200; // spaced-aligned (60 * -20)
        int24 lpUpper = 1200;
        uint128 lpLiquidity = 1e12; // small, deterministic
        LiquidityManager lp = new LiquidityManager(ipm);
        vm.deal(address(lp), 5 ether);
        vm.prank(trader);
        token.transfer(address(lp), tokenIn);

        // ---- add ---------------------------------------------------------
        lp.add(key, lpLower, lpUpper, int256(uint256(lpLiquidity)));
        bytes32 lpKey = keccak256(abi.encodePacked(address(lp), lpLower, lpUpper, bytes32(0)));
        assertEq(ipm.getPositionLiquidity(poolId, lpKey), lpLiquidity, "LP add did not credit position");

        // Graduation LP is still intact after the add.
        assertEq(ipm.getPositionLiquidity(poolId, gKey), graduationLpBefore, "graduation LP changed on third-party add");

        // ---- remove ------------------------------------------------------
        // The core proof for FINDING 5: this used to revert
        // MultiHookHost__LiquidityLocked. Post-fix it must succeed.
        uint256 lpEthBefore = address(lp).balance;
        uint256 lpTokenBefore = token.balanceOf(address(lp));
        lp.remove(key, lpLower, lpUpper, -int256(uint256(lpLiquidity)));

        assertEq(ipm.getPositionLiquidity(poolId, lpKey), 0, "LP remove did not zero position");
        // The LP should have received back at least one side. Both sides land
        // via take() inside the unlockCallback, so ETH balance rises or
        // token balance rises (usually both). Assert at least one moved.
        assertTrue(
            address(lp).balance > lpEthBefore || token.balanceOf(address(lp)) > lpTokenBefore,
            "LP received nothing back on remove"
        );

        // Graduation LP untouched by the whole add + remove cycle.
        assertEq(
            ipm.getPositionLiquidity(poolId, gKey), graduationLpBefore, "graduation LP changed after add + remove cycle"
        );
    }
}

/// @notice Small unlock-callback harness that adds and removes liquidity for the
///         caller in the pool. Exists purely because v4's `modifyLiquidity` is
///         only callable from within an `unlock` callback context.
contract LiquidityManager {
    IPoolManager internal immutable pm;

    constructor(
        IPoolManager _pm
    ) {
        pm = _pm;
    }

    receive() external payable {}

    function add(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external {
        pm.unlock(abi.encode(uint8(1), key, tickLower, tickUpper, liquidityDelta));
    }

    function remove(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external {
        pm.unlock(abi.encode(uint8(2), key, tickLower, tickUpper, liquidityDelta));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        (, PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (uint8, PoolKey, int24, int24, int256));

        (BalanceDelta callerDelta,) = pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = int128(int256(BalanceDelta.unwrap(callerDelta) >> 128));
        int128 delta1 = int128(int256(BalanceDelta.unwrap(callerDelta)));

        // currency0 is native ETH in this stack.
        if (delta0 < 0) {
            pm.settle{value: uint256(uint128(-delta0))}();
        } else if (delta0 > 0) {
            pm.take(key.currency0, address(this), uint256(uint128(delta0)));
        }

        // currency1 is the launched ERC-20.
        if (delta1 < 0) {
            uint256 owed = uint256(uint128(-delta1));
            address tokenAddr = Currency.unwrap(key.currency1);
            pm.sync(key.currency1);
            SafeTransferLib.safeTransfer(tokenAddr, address(pm), owed);
            pm.settle();
        } else if (delta1 > 0) {
            pm.take(key.currency1, address(this), uint256(uint128(delta1)));
        }

        return "";
    }
}
