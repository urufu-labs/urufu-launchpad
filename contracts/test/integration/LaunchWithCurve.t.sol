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

import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC20View {
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// @notice Verifies the single-transaction "launch + curve" flow: Router receives the initial
///         supply as `initialRecipient`, approves the CurveFactory, and createCurve pulls the
///         supply into a freshly deployed BondingCurve. After launch the launcher holds no
///         tokens; the curve holds them all, trading is open.
contract LaunchWithCurveTest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC20Template internal impl20;

    BondingCurve internal curveImpl;
    CurveFactory internal cf;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");

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
        vm.stopPrank();

        vm.prank(registrar);
        f20.registerImpl(BARE_ERC20, address(impl20));

        vm.deal(launcher, 5 ether);
    }

    function _paramsWithCurve() internal view returns (LaunchParams memory) {
        // Router is the initialRecipient so it can approve the curve factory.
        // Initial supply must equal defaultCurveSupply so the exact-amount approve consumes
        // all Router-held tokens.
        return LaunchParams({
            base: BaseType.ERC20,
            name: "Curve Launched",
            ticker: "CURVE",
            configHash: BARE_ERC20,
            initData: abi.encode(cf.defaultCurveSupply(), address(router), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });
    }

    function test_Launch_WithCurve_HappyPath() public {
        LaunchParams memory p = _paramsWithCurve();
        vm.prank(launcher);
        address token = router.launch{value: BASE_FEE}(p);

        assertTrue(token != address(0));
        address curve = cf.curveFor(token);
        assertTrue(curve != address(0), "curve was not created");

        // Curve holds the entire launch supply; launcher and router hold 0.
        assertEq(IERC20View(token).balanceOf(curve), cf.defaultCurveSupply());
        assertEq(IERC20View(token).balanceOf(launcher), 0);
        assertEq(IERC20View(token).balanceOf(address(router)), 0);

        // Curve is initialized and open for trading.
        BondingCurve c = BondingCurve(payable(curve));
        assertEq(c.tokenReserve(), cf.defaultCurveSupply());
        assertEq(c.ethReserve(), 0);
        assertFalse(c.graduated());
    }

    function test_Launch_WithCurve_EmitsCurveInstalled() public {
        LaunchParams memory p = _paramsWithCurve();
        vm.expectEmit(false, false, false, false, address(router));
        emit Router.CurveInstalled(address(0), address(0));
        vm.prank(launcher);
        router.launch{value: BASE_FEE}(p);
    }

    function test_Launch_WithCurve_RevertsIfFactoryUnset() public {
        // Redeploy Router without the curve factory pointer.
        Router bareRouter = new Router(
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
        vm.prank(admin);
        bareRouter.setFactory(BaseType.ERC20, address(f20));
        // f20 only trusts the original router — re-register with the new one.
        ERC20Factory f20b = new ERC20Factory(admin, address(bareRouter), registrar);
        ERC20Template implB = new ERC20Template();
        vm.prank(admin);
        bareRouter.setFactory(BaseType.ERC20, address(f20b));
        vm.prank(registrar);
        f20b.registerImpl(BARE_ERC20, address(implB));

        // NameRegistry only allows its wired router to reserve; point it at bareRouter.
        NameRegistry registry2 = new NameRegistry(admin, treasury, new string[](0));
        Router bareRouter2 = new Router(
            admin,
            registry2,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );
        vm.prank(admin);
        registry2.setRouter(address(bareRouter2));
        ERC20Factory f20c = new ERC20Factory(admin, address(bareRouter2), registrar);
        vm.prank(admin);
        bareRouter2.setFactory(BaseType.ERC20, address(f20c));
        ERC20Template implC = new ERC20Template();
        vm.prank(registrar);
        f20c.registerImpl(BARE_ERC20, address(implC));

        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "NoFactoryCurve",
            ticker: "NFC",
            configHash: BARE_ERC20,
            initData: abi.encode(cf.defaultCurveSupply(), address(bareRouter2), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });
        vm.deal(launcher, 5 ether);
        vm.expectRevert(Router.Router__CurveFactoryUnset.selector);
        vm.prank(launcher);
        bareRouter2.launch{value: BASE_FEE}(p);
    }

    function test_Launch_WithoutCurve_UnchangedFlow() public {
        // Sanity: existing flow (installBondingCurve=false) still works.
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "No Curve",
            ticker: "NCURV",
            configHash: BARE_ERC20,
            initData: abi.encode(uint256(1000 ether), launcher, new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });
        vm.prank(launcher);
        address token = router.launch{value: BASE_FEE}(p);
        assertEq(cf.curveFor(token), address(0), "no curve should exist");
        assertEq(IERC20View(token).balanceOf(launcher), 1000 ether);
    }

    function test_Buy_AfterAutoInstall() public {
        LaunchParams memory p = _paramsWithCurve();
        vm.prank(launcher);
        address token = router.launch{value: BASE_FEE}(p);
        address curve = cf.curveFor(token);

        // A buyer can immediately trade against the freshly created curve.
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 2 ether);
        vm.prank(buyer);
        uint256 tokensOut = BondingCurve(payable(curve)).buy{value: 1 ether}(0);
        assertGt(tokensOut, 0);
        assertEq(IERC20View(token).balanceOf(buyer), tokensOut);
    }
}
