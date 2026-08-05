// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title  GraduatorLauncherRefundPullTest
/// @notice Audit round 2, FINDING 6 (MEDIUM): pre-fix, `GraduatorV2.execute`
///         PUSHED any residual ETH straight to the launcher with a synchronous
///         `SafeTransferLib.safeTransferETH`. Contract-wallet launchers whose
///         `receive()` reverts (Safe, DAO treasury, custody solutions) would
///         then revert the whole graduation atomically, permanently bricking
///         the curve.
///
///         Fix: credit the residual to a `claimableRefunds[launcher]` ledger
///         and let the launcher drain it later via `claimRefund()` /
///         `claimRefundTo(recipient)`. Graduation no longer touches the
///         launcher's ETH-receiving code path.
contract GraduatorLauncherRefundPullTest is LocalV4Stack {
    address internal buyer = makeAddr("finding6-buyer");

    function setUp() public {
        _deployStack();
        vm.deal(buyer, 100 ether);
    }

    // =====================================================================
    // AC 5(a): EOA launcher graduates and can claim the credited refund.
    // =====================================================================
    function test_EoaLauncher_GraduatesAndCanClaim() public {
        address launcher = makeAddr("finding6-eoa-launcher");

        (address tokenAddr, BondingCurve curve) = _launchWithLauncher("EOA Launcher", "EOAL", launcher);
        StackToken token = StackToken(tokenAddr);

        // Seed the graduator with a wei so the residual-credit path is
        // guaranteed to fire even if the LP-math absorbs every wei of the
        // curve's own contribution. This mirrors the real-world case where
        // rounding-dust survives the LP add (rare but the whole point of
        // the belt).
        vm.deal(address(this), 1 ether);
        SafeTransferLib.safeTransferETH(address(graduator), 1 ether);

        _driveToGraduation(curve);

        // Availability: graduation completed.
        assertTrue(curve.graduated(), "curve failed to graduate");

        // Credit landed on the ledger, unallocated ETH accounted for.
        uint256 credit = graduator.claimableRefunds(launcher);
        assertGt(credit, 0, "expected refund credited to launcher");
        assertEq(graduator.totalClaimable(), credit, "totalClaimable should track the sole credit");
        assertEq(
            address(graduator).balance,
            graduator.totalClaimable(),
            "graduator balance must equal outstanding claim balance"
        );

        // Claim: EOA calls claimRefund, gets paid, ledger + aggregate zeroed.
        uint256 balBefore = launcher.balance;
        vm.prank(launcher);
        graduator.claimRefund();
        assertEq(launcher.balance - balBefore, credit, "claim did not deliver credited amount");
        assertEq(graduator.claimableRefunds(launcher), 0, "ledger entry not zeroed after claim");
        assertEq(graduator.totalClaimable(), 0, "totalClaimable not zeroed after claim");

        // Second claim reverts.
        vm.prank(launcher);
        vm.expectRevert(GraduatorV2.Graduator__NothingToClaim.selector);
        graduator.claimRefund();

        // Silence unused warning on token.
        token;
    }

    // =====================================================================
    // AC 5(b): contract launcher that rejects `receive()` still graduates,
    //          refund shows up in the ledger, sync push would have reverted.
    // =====================================================================
    function test_ContractWalletLauncher_RejectsEth_GraduatesWithCredit() public {
        RejectingLauncher launcher = new RejectingLauncher();

        (address tokenAddr, BondingCurve curve) = _launchWithLauncher("Rejecting Wallet", "RWAL", address(launcher));
        StackToken token = StackToken(tokenAddr);

        vm.deal(address(this), 1 ether);
        SafeTransferLib.safeTransferETH(address(graduator), 1 ether);

        // Preflight sanity: a synchronous push into RejectingLauncher does
        // in fact revert. If this passes without the deliberate revert, the
        // whole test premise is wrong and the availability claim below is
        // meaningless.
        vm.deal(address(this), 1 wei);
        vm.expectRevert(RejectingLauncher.Reject__NoEth.selector);
        SafeTransferLib.safeTransferETH(address(launcher), 1 wei);

        _driveToGraduation(curve);

        // Availability: graduation succeeded despite launcher rejecting ETH.
        assertTrue(curve.graduated(), "contract-launcher graduation must not brick");

        uint256 credit = graduator.claimableRefunds(address(launcher));
        assertGt(credit, 0, "expected refund credited despite rejecting receive()");
        assertEq(address(launcher).balance, 0, "no ETH should have been pushed to rejecting launcher");
        assertEq(address(graduator).balance, graduator.totalClaimable(), "graduator balance must equal totalClaimable");

        // Silence unused warning.
        token;
    }

    // =====================================================================
    // AC 5(c): same rejecting contract calls `claimRefundTo(someEOA)` and
    //          gets paid — the pull-via-delegate route for custody wallets.
    // =====================================================================
    function test_ContractWalletLauncher_ClaimRefundTo_PaysDelegate() public {
        RejectingLauncher launcher = new RejectingLauncher();
        address payoutEoa = makeAddr("finding6-payout-eoa");

        (, BondingCurve curve) = _launchWithLauncher("Rejecting Route", "RRTE", address(launcher));

        vm.deal(address(this), 0.5 ether);
        SafeTransferLib.safeTransferETH(address(graduator), 0.5 ether);

        _driveToGraduation(curve);
        assertTrue(curve.graduated(), "curve failed to graduate");

        uint256 credit = graduator.claimableRefunds(address(launcher));
        assertGt(credit, 0, "no credit to claim");

        // Zero-address recipient reverts.
        vm.prank(address(launcher));
        vm.expectRevert(GraduatorV2.Graduator__ZeroAddress.selector);
        graduator.claimRefundTo(address(0));

        // Contract launcher pulls to the EOA it controls.
        uint256 balBefore = payoutEoa.balance;
        vm.prank(address(launcher));
        graduator.claimRefundTo(payoutEoa);

        assertEq(payoutEoa.balance - balBefore, credit, "delegate did not receive credited amount");
        assertEq(address(launcher).balance, 0, "no ETH should ever land on rejecting launcher");
        assertEq(graduator.claimableRefunds(address(launcher)), 0, "ledger not zeroed after delegated claim");
        assertEq(graduator.totalClaimable(), 0, "totalClaimable not zeroed after delegated claim");

        // Second delegated claim reverts.
        vm.prank(address(launcher));
        vm.expectRevert(GraduatorV2.Graduator__NothingToClaim.selector);
        graduator.claimRefundTo(payoutEoa);
    }

    // =====================================================================
    // AC 5(d) hardening: sweep() never drains a credited refund.
    // =====================================================================
    function test_Sweep_LeavesCreditedRefundsUntouched() public {
        address launcher = makeAddr("finding6-sweep-launcher");
        (, BondingCurve curve) = _launchWithLauncher("Sweep Guard", "SWGD", launcher);

        vm.deal(address(this), 2 ether);
        SafeTransferLib.safeTransferETH(address(graduator), 2 ether);

        _driveToGraduation(curve);
        uint256 credit = graduator.claimableRefunds(launcher);
        assertGt(credit, 0, "expected a credit to guard");

        // Slip an extra unaccounted-for wei onto the graduator so sweep has
        // something to lift AND we can prove it stops at the reserved line.
        vm.deal(address(this), 0.3 ether);
        SafeTransferLib.safeTransferETH(address(graduator), 0.3 ether);

        address payable sink = payable(makeAddr("finding6-sweep-sink"));
        vm.prank(admin);
        graduator.sweep(sink);

        // Sink got the unreserved slice.
        assertEq(sink.balance, 0.3 ether, "sweep should have delivered exactly the unreserved slice");
        // Ledger still funded for the launcher.
        assertEq(graduator.claimableRefunds(launcher), credit, "sweep must not shrink launcher's credit");
        assertEq(graduator.totalClaimable(), credit, "sweep must not shrink totalClaimable");
        assertEq(address(graduator).balance, credit, "post-sweep balance must equal reserved credits");

        // And the launcher can still claim their credit in full.
        uint256 balBefore = launcher.balance;
        vm.prank(launcher);
        graduator.claimRefund();
        assertEq(launcher.balance - balBefore, credit, "launcher claim after sweep did not pay full credit");
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    /// Launch a fresh curve owned by an arbitrary launcher (contract or
    /// EOA). Uses the direct CurveFactory entrypoint because LocalV4Stack
    /// already whitelists this test as a trusted router.
    function _launchWithLauncher(
        string memory name_,
        string memory sym_,
        address launcher
    ) internal returns (address token, BondingCurve curve) {
        (StackToken t, BondingCurve c) = _newTokenWithCurve(name_, sym_, launcher);
        token = address(t);
        curve = c;
    }

    /// Buy in steps until the curve graduates. Same shape as
    /// ModuleLaunchGraduationTest's helper, kept local to keep this test
    /// self-contained.
    function _driveToGraduation(
        BondingCurve curve
    ) internal {
        uint256 step = 0.5 ether;
        for (uint256 i = 0; i < 80 && !curve.graduated(); ++i) {
            uint256 need = curve.graduationTargetEth() - curve.ethReserve();
            uint256 amt = need + (need / 50) + 1;
            if (amt > step) amt = step;
            vm.prank(buyer);
            try curve.buy{value: amt}(0) {}
            catch {
                step /= 2;
                if (step == 0) break;
            }
        }
        assertTrue(curve.graduated(), "helper: curve did not graduate");
    }
}

/// Minimal contract wallet that unconditionally rejects any incoming ETH.
/// Stands in for a Safe / DAO treasury / custody solution whose `receive()`
/// path would revert a synchronous push from the graduator.
contract RejectingLauncher {
    error Reject__NoEth();

    receive() external payable {
        revert Reject__NoEth();
    }

    fallback() external payable {
        revert Reject__NoEth();
    }
}
