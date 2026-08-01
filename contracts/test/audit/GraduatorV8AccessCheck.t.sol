// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";

interface ICurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
}

/// Attempts to call `execute` on the LIVE V8 Graduator with an
/// unregistered / attacker-owned token. MUST revert with
/// Graduator__NotAuthorizedCurve.
contract GraduatorV8AccessCheckForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant LIVE_GRADUATOR = 0x0Db63b8Af346c5edabF79b16A236AEDA0428e712;
    address internal constant CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant LIVE_OWNER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

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

    /// Basic on-chain wiring sanity: Graduator owner must be non-zero
    /// (V7 lacked ownership entirely — that's how 4 ETH got stranded).
    function test_LiveGraduator_HasNonZeroOwner() public view {
        address o = GraduatorV2(payable(LIVE_GRADUATOR)).owner();
        assertTrue(o != address(0), "Graduator owner is zero");
        assertEq(o, LIVE_OWNER, "unexpected live owner");
        console2.log("Live Graduator.owner():", o);
    }

    /// Attacker calls execute() for an unregistered token.
    /// curveFactory.curveFor(fakeToken) returns address(0).
    /// Since msg.sender != address(0), it must revert with
    /// Graduator__NotAuthorizedCurve(caller, address(0)).
    function test_AttackerUnregisteredToken_Reverts() public {
        address attacker = makeAddr("attacker");
        address fakeToken = makeAddr("fakeToken");
        vm.deal(attacker, 1 ether);

        // Sanity: fake token is genuinely unknown to CurveFactory.
        address expected = ICurveFactoryLookup(CURVE_FACTORY).curveFor(fakeToken);
        assertEq(expected, address(0), "fake token unexpectedly registered");

        vm.expectRevert(
            abi.encodeWithSelector(GraduatorV2.Graduator__NotAuthorizedCurve.selector, attacker, address(0))
        );
        vm.prank(attacker);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 1}(fakeToken, 1, 1, 0, 0, address(0));
    }

    /// Even a token where curveFor(token) == some address, if the caller
    /// isn't that address, must revert.
    function test_AttackerImpersonatingCurve_Reverts() public {
        // Deploy an attacker-controlled mock that has a "real" curve address
        // returned by mocking CurveFactory. We use vm.mockCall to make
        // curveFactory.curveFor(fakeToken) return a plausible curve address
        // that ISN'T the caller.
        address attacker = makeAddr("impersonator");
        address fakeToken = makeAddr("fakeToken2");
        address realCurve = makeAddr("realCurveAddr");
        vm.deal(attacker, 1 ether);

        vm.mockCall(CURVE_FACTORY, abi.encodeWithSignature("curveFor(address)", fakeToken), abi.encode(realCurve));

        vm.expectRevert(abi.encodeWithSelector(GraduatorV2.Graduator__NotAuthorizedCurve.selector, attacker, realCurve));
        vm.prank(attacker);
        GraduatorV2(payable(LIVE_GRADUATOR)).execute{value: 1}(fakeToken, 1, 1, 0, 0, address(0));
    }
}
