// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";

interface ICurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
}

/// @title  Graduator LIVE access-check + owner + sweep audit
/// @notice Fork-tests the CURRENT LIVE Graduator at
///         0x0Db63b8Af346c5edabF79b16A236AEDA0428e712 for the four invariants
///         the audit prompt calls out:
///           1. Unregistered-token attacker path → Graduator__NotAuthorizedCurve
///           2. Legitimate curve (curveFactory.curveFor(token)==msg.sender)
///              passes the auth gate (proved by the revert location moving
///              past the auth-check into ZeroAmount / ETH-mismatch land).
///           3. Owner is non-zero AND owner can call sweep().
///           4. Non-owner sweep MUST revert with Graduator__NotOwner.
contract GraduatorLiveAccessAndSweepForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant LIVE_GRADUATOR = 0x0Db63b8Af346c5edabF79b16A236AEDA0428e712;
    address internal constant LIVE_CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant LIVE_MHH = 0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4;
    address internal constant EXPECTED_OWNER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (LIVE_GRADUATOR.code.length == 0) vm.skip(true);
    }

    // ----- 1. Attacker path: unregistered token → NotAuthorizedCurve --------
    function test_AttackerUnregisteredToken_RevertsNotAuthorized() public {
        address attacker = makeAddr("attacker");
        address fakeToken = makeAddr("fakeToken_unregistered");
        vm.deal(attacker, 1 ether);

        address resolved = ICurveFactoryLookup(LIVE_CURVE_FACTORY).curveFor(fakeToken);
        assertEq(resolved, address(0), "sanity: fake token must be unregistered");

        vm.expectRevert(
            abi.encodeWithSelector(GraduatorV2.Graduator__NotAuthorizedCurve.selector, attacker, address(0))
        );
        vm.prank(attacker);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 1}(fakeToken, 1, 1, 0, 0, address(0));
    }

    /// Attacker with mocked CF that names a DIFFERENT curve address must
    /// still be rejected because msg.sender != authorized.
    function test_AttackerImpersonatingCurve_RevertsNotAuthorized() public {
        address attacker = makeAddr("impersonator");
        address fakeToken = makeAddr("fakeToken_impersonated");
        address realCurve = makeAddr("realCurveAddr");
        vm.deal(attacker, 1 ether);

        vm.mockCall(LIVE_CURVE_FACTORY, abi.encodeWithSignature("curveFor(address)", fakeToken), abi.encode(realCurve));

        vm.expectRevert(abi.encodeWithSelector(GraduatorV2.Graduator__NotAuthorizedCurve.selector, attacker, realCurve));
        vm.prank(attacker);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 1}(fakeToken, 1, 1, 0, 0, address(0));
    }

    // ----- 2. Legitimate curve passes the auth check ------------------------
    /// Prove the check `curveFor(token) == msg.sender` accepts the correct
    /// caller by mocking CF to name our `spoofedCurve` and pranking it. The
    /// call still reverts (ZeroAmount / hook wiring / etc.) because we don't
    /// actually own the token supply — but the revert MUST be something
    /// OTHER than Graduator__NotAuthorizedCurve, proving the auth gate is
    /// passed.
    function test_LegitimateCurvePassesAuthGate() public {
        address spoofedCurve = makeAddr("spoofedCurve");
        address fakeToken = makeAddr("fakeToken_legit");
        vm.deal(spoofedCurve, 1 ether);

        vm.mockCall(
            LIVE_CURVE_FACTORY, abi.encodeWithSignature("curveFor(address)", fakeToken), abi.encode(spoofedCurve)
        );

        // Path (a): pass ethAmount=0 → hits Graduator__ZeroAmount (past auth).
        vm.expectRevert(GraduatorV2.Graduator__ZeroAmount.selector);
        vm.prank(spoofedCurve);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 0}(fakeToken, 0, 0, 0, 0, address(0));

        // Path (b): msg.value != ethAmount → hits Graduator__EthMismatch (past auth).
        vm.expectRevert(
            abi.encodeWithSelector(
                GraduatorV2.Graduator__EthMismatch.selector,
                uint256(2), // msg.value
                uint256(1) // ethAmount
            )
        );
        vm.prank(spoofedCurve);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 2}(fakeToken, 1, 1, 0, 0, address(0));
    }

    // ----- 3. Owner path: owner() non-zero AND owner can sweep --------------
    function test_LiveGraduator_OwnerNonZero() public view {
        address o = GraduatorV2(payable(LIVE_GRADUATOR)).owner();
        assertTrue(o != address(0), "Graduator.owner() is zero");
        assertEq(o, EXPECTED_OWNER, "unexpected live owner (expected deployer)");
        console2.log("LIVE Graduator.owner():", o);
    }

    function test_OwnerCanSweep_EmptyBalance() public {
        address o = GraduatorV2(payable(LIVE_GRADUATOR)).owner();
        address payable dest = payable(makeAddr("sweepDest"));
        // With zero balance sweep is a no-op that MUST still succeed.
        vm.prank(o);
        GraduatorV2(payable(LIVE_GRADUATOR)).sweep(dest);
        assertEq(dest.balance, 0, "no ETH should have moved");
    }

    function test_OwnerCanSweep_StrandedEth() public {
        address o = GraduatorV2(payable(LIVE_GRADUATOR)).owner();
        address payable dest = payable(makeAddr("sweepDestFunded"));

        // Simulate the V7-era stranded 4 ETH scenario.
        vm.deal(LIVE_GRADUATOR, 4 ether);
        assertEq(LIVE_GRADUATOR.balance, 4 ether, "deal precondition failed");

        vm.prank(o);
        GraduatorV2(payable(LIVE_GRADUATOR)).sweep(dest);

        assertEq(LIVE_GRADUATOR.balance, 0, "sweep left ETH behind");
        assertEq(dest.balance, 4 ether, "sweep did not deliver 4 ETH");
    }

    // ----- 4. Non-owner sweep MUST revert -----------------------------------
    function test_NonOwnerSweep_Reverts() public {
        address attacker = makeAddr("randomAttacker");
        address payable dest = payable(makeAddr("attackerDest"));
        vm.deal(LIVE_GRADUATOR, 1 ether);

        // NOTE: prompt named the error "Unauthorized"; the source contract
        // actually uses Graduator__NotOwner. Both selectors verified against
        // the deployed runtime bytecode (0x2a8722dd).
        vm.expectRevert(GraduatorV2.Graduator__NotOwner.selector);
        vm.prank(attacker);
        GraduatorV2(payable(LIVE_GRADUATOR)).sweep(dest);

        assertEq(dest.balance, 0, "attacker should not have received any ETH");
        assertEq(LIVE_GRADUATOR.balance, 1 ether, "graduator balance unchanged");
    }

    /// Wiring cross-check: LIVE Graduator points at the LIVE CurveFactory
    /// and LIVE MultiHookHost per the audit brief.
    function test_LiveGraduator_WiringMatchesLiveStack() public view {
        GraduatorV2 g = GraduatorV2(payable(LIVE_GRADUATOR));
        assertEq(address(g.curveFactory()), LIVE_CURVE_FACTORY, "Graduator.curveFactory drift");
        assertEq(address(g.defaultHook()), LIVE_MHH, "Graduator.defaultHook drift");
        assertEq(uint256(g.fee()), 3000, "Graduator.fee drift");
        assertEq(uint256(int256(g.tickSpacing())), 60, "Graduator.tickSpacing drift");
    }
}
