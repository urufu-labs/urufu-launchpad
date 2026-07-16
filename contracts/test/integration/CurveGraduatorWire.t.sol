// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @dev Minimal graduator stand-in. Records the call, pulls the tokens in via the
///      curve's approve, and asserts the ETH callvalue matches the declared amount.
///      Not a v4 pool minter — just enough surface to prove the WIRE PATH from
///      `CurveFactory.setGraduator` → `BondingCurve._graduate` → `IGraduator.execute`.
contract MockGraduator {
    address public lastToken;
    uint256 public lastEth;
    uint256 public lastTokens;
    uint32 public lastAntiSniper;
    uint16 public lastBuybackBps;
    address public lastLauncher;
    uint256 public calls;

    error MockGraduator__EthMismatch();

    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable {
        if (msg.value != ethAmount) revert MockGraduator__EthMismatch();
        lastToken = token;
        lastEth = ethAmount;
        lastTokens = tokenAmount;
        lastAntiSniper = antiSniperBlocks;
        lastBuybackBps = buybackBurnBps;
        lastLauncher = launcher;
        calls += 1;
        IERC20(token).transferFrom(msg.sender, address(this), tokenAmount);
    }

    receive() external payable {}
}

/// @notice Verifies `CurveFactory.setGraduator` actually wires a graduator into freshly
///         installed curves, and that a curve that trips the graduation target calls the
///         graduator with the right ETH + token amounts. Complements `GraduationForkTest`
///         which drives the real v4 pool path against Sepolia — this one runs in-memory
///         so it lands on every developer's machine without an RPC.
contract CurveGraduatorWireTest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC20Template internal impl20;

    BondingCurve internal curveImpl;
    CurveFactory internal cf;
    MockGraduator internal graduator;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal buyer = makeAddr("buyer");

    uint256 internal constant BASE_FEE = 0.05 ether;
    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));

    function setUp() public {
        string[] memory reserved = new string[](1);
        reserved[0] = "ETH";
        registry = new NameRegistry(admin, treasury, reserved);
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );

        f20 = new ERC20Factory(admin, address(router), registrar);
        impl20 = new ERC20Template();

        curveImpl = new BondingCurve();
        cf = new CurveFactory(admin, address(feeReceiver), address(curveImpl));

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setCurveFactory(address(cf));
        registry.setRouter(address(router));
        // Lower graduation target so a handful of buys trips it in-test.
        cf.setDefaults(cf.defaultCurveSupply(), 800_000_000e18, 5 ether, 2 ether, 100);
        vm.stopPrank();

        vm.prank(registrar);
        f20.registerImpl(BARE_ERC20, address(impl20));

        graduator = new MockGraduator();
        vm.deal(launcher, 5 ether);
        vm.deal(buyer, 100 ether);
    }

    function _launchWithCurve() internal returns (address token, address curve) {
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Graduating",
            ticker: "GRAD",
            configHash: BARE_ERC20,
            initData: abi.encode(cf.defaultCurveSupply(), address(router), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        vm.prank(launcher);
        token = router.launch{value: BASE_FEE}(p);
        curve = cf.curveFor(token);
    }

    function test_SetGraduator_OnlyOwnerCanSet() public {
        vm.expectRevert();
        vm.prank(launcher);
        cf.setGraduator(address(graduator));
    }

    function test_SetGraduator_TakesEffectForNextCurve() public {
        vm.prank(admin);
        cf.setGraduator(address(graduator));
        assertEq(cf.graduator(), address(graduator));

        (, address curve) = _launchWithCurve();
        assertEq(BondingCurve(payable(curve)).graduator(), address(graduator));
    }

    function test_SetGraduator_ExistingCurveKeepsOldWire() public {
        // Launch WITHOUT a graduator first...
        (, address curveA) = _launchWithCurve();
        assertEq(BondingCurve(payable(curveA)).graduator(), address(0));

        // Then wire one — the pre-existing curve keeps its zero graduator (immutable wire
        // per curve), and only NEW curves see the updated address.
        vm.prank(admin);
        cf.setGraduator(address(graduator));
        assertEq(BondingCurve(payable(curveA)).graduator(), address(0));
    }

    function test_Graduation_CallsGraduatorWithReservesAndZeroesCurveState() public {
        vm.prank(admin);
        cf.setGraduator(address(graduator));

        (address token, address curveAddr) = _launchWithCurve();
        BondingCurve curve = BondingCurve(payable(curveAddr));
        assertFalse(curve.graduated());

        // Buy over the 2 ETH graduation target in one shot.
        vm.prank(buyer);
        curve.buy{value: 3 ether}(0);

        // Curve flipped and self-zeroed. Every wei + token now sits on the graduator.
        assertTrue(curve.graduated(), "curve did not graduate");
        assertEq(curve.ethReserve(), 0, "eth reserve not zeroed after graduation");
        assertEq(curve.tokenReserve(), 0, "token reserve not zeroed after graduation");

        // The mock got the exact reserves the curve was holding immediately before graduation.
        assertEq(graduator.calls(), 1, "graduator not called");
        assertEq(graduator.lastToken(), token);
        assertGt(graduator.lastEth(), 2 ether, "graduator got less than target eth");
        assertGt(graduator.lastTokens(), 0);
        assertEq(address(graduator).balance, graduator.lastEth());
        assertEq(IERC20(token).balanceOf(address(graduator)), graduator.lastTokens());
    }

    /// End-to-end proof that the launcher address propagates through the full stack:
    /// Router.launch(msg.sender=launcher) → CurveFactory.createCurveWithConfigFor →
    /// BondingCurve.launcher → BondingCurve._graduate → Graduator.execute(..., launcher).
    ///
    /// This is the critical wire-up for V2 hook per-pool creator revenue — if any link
    /// in the chain drops the launcher, post-grad swap fees would route the "creator"
    /// share to whichever wrong address (Router, curve, 0x0), and every launcher would
    /// silently earn nothing on their own token.
    function test_Graduation_PassesLauncherThroughToGraduator() public {
        vm.prank(admin);
        cf.setGraduator(address(graduator));

        (, address curveAddr) = _launchWithCurve();
        BondingCurve curve = BondingCurve(payable(curveAddr));

        // Launcher is recorded on the curve at init time — must equal the tx.origin-style
        // human that called Router.launch, NOT the Router or CurveFactory itself.
        assertEq(curve.launcher(), launcher, "curve stored wrong launcher");

        vm.prank(buyer);
        curve.buy{value: 3 ether}(0);

        // Graduator got the same launcher forwarded from the curve — this is what it
        // installs on the v4 hook as the per-pool creator via setCreator.
        assertEq(graduator.lastLauncher(), launcher, "graduator did not receive launcher");
    }

    function test_Graduation_NoGraduatorLeavesReservesOnCurve() public {
        // No setGraduator call — the pre-graduator stub behavior stays in place.
        (address token, address curveAddr) = _launchWithCurve();
        BondingCurve curve = BondingCurve(payable(curveAddr));

        vm.prank(buyer);
        curve.buy{value: 3 ether}(0);

        assertTrue(curve.graduated());
        assertEq(graduator.calls(), 0, "graduator called despite being unset");
        // Reserves remain on the curve (funds don't leave without a graduator).
        assertGt(curve.ethReserve(), 0);
        assertGt(curve.tokenReserve(), 0);
        assertEq(address(graduator).balance, 0);
        assertEq(IERC20(token).balanceOf(address(graduator)), 0);
    }
}
