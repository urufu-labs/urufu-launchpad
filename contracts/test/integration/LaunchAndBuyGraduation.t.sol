// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC20BalanceOf {
    function balanceOf(
        address who
    ) external view returns (uint256);
}

/// @title  LaunchAndBuyGraduationTest
/// @notice Phase 2 audit follow-up #1: prove `Router.launchAndBuy` is atomic
///         through graduation. If a single `initialBuyEth` is large enough to
///         push `curve.ethReserve()` past `graduationTargetEth`, the token
///         deploy + curve install + `buyFor` + `_graduate()` + v4 pool init
///         all land in one tx. If graduation itself fails (any downstream
///         revert inside GraduatorV2.execute or the v4 pool init), the whole
///         `launchAndBuy` tx unwinds and no partial state persists.
///
///         Uses `LocalV4Stack` so the graduator + PoolManager + hook are the
///         real production contracts, not mocks — the mock graduator used by
///         the sibling `LaunchAndBuy.t.sol` cannot exercise pool init.
contract LaunchAndBuyGraduationTest is LocalV4Stack {
    using StateLibrary for IPoolManager;

    address internal launcher = makeAddr("launch-and-buy-grad-launcher");
    address internal recipient = makeAddr("launch-and-buy-grad-recipient");

    function setUp() public {
        _deployStack();
        vm.deal(launcher, 100 ether);
    }

    // =========================================================
    // Phase 2 follow-up #1 — happy path atomic graduation
    // =========================================================

    function test_LaunchAndBuy_InitialBuyLargeEnoughToGraduate_AtomicPath() public {
        LaunchParams memory p = _atomicGradParams("Atomic Grad", "ATGR");
        uint256 fee = router.quote(p);

        // Send enough ETH to graduate immediately. LocalV4Stack uses the
        // Sepolia-friendly defaults: graduationTargetEth = 4 ether at a
        // 1% trade fee, so `ethAfterFee = ethIn * 0.99 >= 4` => ethIn >= ~4.04.
        // 5 ether gives a comfortable buffer against slippage / rounding.
        uint256 initialBuyEth = 5 ether;
        vm.deal(launcher, launcher.balance + fee + initialBuyEth);

        vm.prank(launcher);
        address tokenAddr = router.launchAndBuy{value: fee + initialBuyEth}(p, initialBuyEth, 0, recipient);

        // ---- deploy + install + registry all landed --------------------
        assertTrue(tokenAddr != address(0), "token must be deployed");
        bytes32 nameHash = keccak256(bytes("atomic grad"));
        assertEq(registry.reservationOf(nameHash).token, tokenAddr, "name must be reserved");
        address curveAddr = curveFactory.curveFor(tokenAddr);
        assertTrue(curveAddr != address(0), "curve must be installed");

        // ---- buy landed + graduation triggered in the SAME tx ----------
        BondingCurve curve = BondingCurve(payable(curveAddr));
        assertTrue(curve.graduated(), "curve must have graduated inside launchAndBuy");
        assertEq(curve.ethReserve(), 0, "ethReserve must be zeroed by _graduate");
        assertEq(curve.tokenReserve(), 0, "tokenReserve must be zeroed by _graduate");

        // ---- recipient (not launcher, not router) got the first-buy tokens
        assertGt(IERC20BalanceOf(tokenAddr).balanceOf(recipient), 0, "recipient must receive first-buy tokens");
        assertEq(IERC20BalanceOf(tokenAddr).balanceOf(launcher), 0, "launcher must NOT receive tokens");
        assertEq(IERC20BalanceOf(tokenAddr).balanceOf(address(router)), 0, "router must NOT retain tokens");

        // ---- v4 pool actually exists post-graduation -------------------
        PoolId poolId = _poolIdFor(tokenAddr);
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "v4 pool must be initialized (sqrtPriceX96 > 0)");
        assertGt(ipm.getLiquidity(poolId), 0, "v4 pool must hold liquidity from graduation");

        // ---- graduator accounting invariants (round-2 F6) --------------
        // Any residual dust is credited to the launcher's pull-refund ledger
        // (see GraduatorLauncherRefundPull.t.sol). The invariant is that no
        // un-credited ETH sits on the graduator and no tokens do.
        assertEq(address(graduator).balance, graduator.totalClaimable(), "graduator holds un-credited ETH");
        assertEq(StackToken(tokenAddr).balanceOf(address(graduator)), 0, "graduator stranded tokens");

        // ---- router did not retain ETH ---------------------------------
        assertEq(address(router).balance, 0, "router must not retain ETH after launchAndBuy");
    }

    // =========================================================
    // Phase 2 follow-up #1 (negative half) — atomic revert on graduation
    // If the graduation-adjacent code path reverts, the whole
    // launchAndBuy reverts and NO partial state persists:
    //   * name is not reserved
    //   * curve does not exist for the would-be token
    //   * recipient holds no tokens
    //   * launcher spent no ETH beyond gas
    //
    // Trigger a graduation revert by force-breaking the MHH initializer
    // gate: GraduatorV2 calls `MultiHookHost.initialize(...)` inside
    // `execute`, which reverts with `UnauthorizedInitializer` when the
    // caller is not the wired initializer. Point MHH's initializer at a
    // sentinel address so ANY graduation attempt reverts atomically.
    // =========================================================

    function test_LaunchAndBuy_LargeEnoughToGraduate_RevertsAtomicallyIfGraduationBreaks() public {
        // Break graduation: force the curve's downstream call to
        // `IGraduator(graduator).execute(...)` to revert. The curve invokes
        // that inside `_graduate` after crossing `graduationTargetEth`, so
        // a mocked revert here propagates back up through `_graduate` →
        // `buyFor` → `launchAndBuy`, unwinding the whole tx atomically.
        // The MHH-initializer approach doesn't work because MHH's
        // `setInitializer` is one-shot from the deployer.
        bytes4 executeSel = bytes4(keccak256("execute(address,uint256,uint256,uint32,uint16,address)"));
        vm.mockCallRevert(address(graduator), abi.encodeWithSelector(executeSel), bytes(""));

        LaunchParams memory p = _atomicGradParams("Atomic Grad Broken", "ATGB");
        uint256 fee = router.quote(p);
        uint256 initialBuyEth = 5 ether;
        vm.deal(launcher, launcher.balance + fee + initialBuyEth);

        // Snapshot pre-tx state so we can prove nothing persisted.
        bytes32 nameHash = keccak256(bytes("atomic grad broken"));
        assertEq(registry.reservationOf(nameHash).token, address(0), "precondition: name unreserved");
        uint256 balBefore = launcher.balance;
        uint256 feeRecvBefore = address(feeReceiver).balance;

        // The exact revert selector is downstream (MultiHookHost's own
        // Unauthorized* error), so we assert on any revert — the important
        // property is atomicity, not the exact selector.
        vm.expectRevert();
        vm.prank(launcher);
        router.launchAndBuy{value: fee + initialBuyEth}(p, initialBuyEth, 0, recipient);

        // Post-revert atomicity: NOTHING persisted.
        assertEq(
            registry.reservationOf(nameHash).token, address(0), "name must NOT be reserved after graduation revert"
        );
        assertEq(launcher.balance, balBefore, "launcher balance must be fully restored");
        assertEq(address(feeReceiver).balance, feeRecvBefore, "no fees must accrue when the launch reverts atomically");
        assertEq(address(router).balance, 0, "router must not retain ETH after atomic revert");
    }

    // =========================================================
    // Helpers
    // =========================================================

    /// Same shape as LocalV4Stack._launchViaRouter's params (bare ERC20,
    /// curve installed, renounce ownership). Duplicated here so the test
    /// can compute `router.quote(p)` before deciding how much ETH to send.
    function _atomicGradParams(
        string memory name_,
        string memory sym_
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = CH_BARE;
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }
}
