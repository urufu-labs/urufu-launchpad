// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";

contract ERC20FactoryTest is Test {
    ERC20Factory internal factory;
    ERC20Template internal impl;

    address internal owner = makeAddr("owner");
    address internal router = makeAddr("router");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BARE_CONFIG = keccak256("bare-ERC20");
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        factory = new ERC20Factory(owner, router, registrar);
        impl = new ERC20Template();

        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    function _initData(
        uint256 supply,
        address recipient
    ) internal pure returns (bytes memory) {
        return abi.encode(supply, recipient, new bytes[](0));
    }

    // =========================================================
    // Constructor
    // =========================================================

    function test_Constructor_RevertsOnZeroRouter() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        new ERC20Factory(owner, address(0), registrar);
    }

    function test_Constructor_RevertsOnZeroRegistrar() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        new ERC20Factory(owner, router, address(0));
    }

    function test_Constructor_StoresState() public view {
        assertEq(factory.owner(), owner);
        assertEq(factory.router(), router);
        assertEq(factory.registrar(), registrar);
    }

    // =========================================================
    // registerImpl
    // =========================================================

    function test_RegisterImpl_HappyPath() public {
        ERC20Factory fresh = new ERC20Factory(owner, router, registrar);
        vm.expectEmit(true, true, false, true, address(fresh));
        emit ERC20Factory.ImplRegistered(BARE_CONFIG, address(impl), registrar);
        vm.prank(registrar);
        fresh.registerImpl(BARE_CONFIG, address(impl));
        assertEq(fresh.implFor(BARE_CONFIG), address(impl));
    }

    function test_RegisterImpl_RevertsIfNotRegistrar() public {
        bytes32 newConfig = keccak256("new");
        vm.expectRevert(ERC20Factory.ERC20Factory__NotRegistrar.selector);
        vm.prank(stranger);
        factory.registerImpl(newConfig, address(impl));
    }

    function test_RegisterImpl_RevertsOnDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(ERC20Factory.ERC20Factory__AlreadyRegistered.selector, BARE_CONFIG));
        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    function test_RegisterImpl_RevertsOnZeroImpl() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        vm.prank(registrar);
        factory.registerImpl(keccak256("z"), address(0));
    }

    function test_RegisterImpl_RevertsIfImplHasNoCode() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__NotAContract.selector);
        vm.prank(registrar);
        factory.registerImpl(keccak256("nc"), makeAddr("eoa"));
    }

    // =========================================================
    // updateImpl — owner-gated in-place rotation for V2 template refactors
    // =========================================================

    function test_UpdateImpl_HappyPath() public {
        ERC20Template newImpl = new ERC20Template();
        vm.expectEmit(true, true, true, true, address(factory));
        emit ERC20Factory.ImplUpdated(BARE_CONFIG, address(impl), address(newImpl));
        vm.prank(owner);
        factory.updateImpl(BARE_CONFIG, address(newImpl));
        assertEq(factory.implFor(BARE_CONFIG), address(newImpl), "impl swapped");
    }

    function test_UpdateImpl_RevertsIfNotOwner() public {
        ERC20Template newImpl = new ERC20Template();
        vm.expectRevert(ERC20Factory.ERC20Factory__NotOwner.selector);
        vm.prank(registrar);
        factory.updateImpl(BARE_CONFIG, address(newImpl));

        vm.expectRevert(ERC20Factory.ERC20Factory__NotOwner.selector);
        vm.prank(stranger);
        factory.updateImpl(BARE_CONFIG, address(newImpl));
    }

    function test_UpdateImpl_RevertsIfHashNotRegistered() public {
        ERC20Template newImpl = new ERC20Template();
        bytes32 unknown = keccak256("never-registered");
        vm.expectRevert(abi.encodeWithSelector(ERC20Factory.ERC20Factory__UnknownConfig.selector, unknown));
        vm.prank(owner);
        factory.updateImpl(unknown, address(newImpl));
    }

    function test_UpdateImpl_RevertsOnZeroImpl() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        vm.prank(owner);
        factory.updateImpl(BARE_CONFIG, address(0));
    }

    function test_UpdateImpl_RevertsIfNewImplHasNoCode() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__NotAContract.selector);
        vm.prank(owner);
        factory.updateImpl(BARE_CONFIG, makeAddr("eoa-not-a-contract"));
    }

    // =========================================================
    // deploy
    // =========================================================

    function test_Deploy_HappyPath() public {
        vm.prank(router);
        address token = factory.deploy("Test Token", "TEST", BARE_CONFIG, _initData(1000 ether, launcher), launcher);

        assertTrue(token != address(0));
        ERC20Template t = ERC20Template(token);
        assertEq(t.name(), "Test Token");
        assertEq(t.symbol(), "TEST");
        assertEq(t.owner(), router); // Router is temporarily the owner until dispatch
        assertEq(t.balanceOf(launcher), 1000 ether);

        assertEq(factory.usageCount(BARE_CONFIG), 1);
    }

    function test_Deploy_EmitsDeployedEvent() public {
        address predicted = factory.predictAddress(launcher, "Foo Token", "FOO", BARE_CONFIG);

        vm.expectEmit(true, true, true, true, address(factory));
        emit ERC20Factory.Deployed(predicted, launcher, BARE_CONFIG, address(impl), "Foo Token", "FOO");

        vm.prank(router);
        factory.deploy("Foo Token", "FOO", BARE_CONFIG, _initData(0, address(0)), launcher);
    }

    function test_Deploy_RevertsIfNotRouter() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__NotRouter.selector);
        vm.prank(stranger);
        factory.deploy("T", "T", BARE_CONFIG, _initData(0, address(0)), launcher);
    }

    function test_Deploy_RevertsOnUnknownConfig() public {
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(ERC20Factory.ERC20Factory__UnknownConfig.selector, unknown));
        vm.prank(router);
        factory.deploy("T", "T", unknown, _initData(0, address(0)), launcher);
    }

    function test_Deploy_RevertsIfInitDataMalformed() public {
        // A single-byte initData that isn't valid abi.encode(uint256,address,bytes) — decode throws.
        vm.expectRevert();
        vm.prank(router);
        factory.deploy("T", "T", BARE_CONFIG, hex"01", launcher);
    }

    function test_Deploy_EmptyInitDataDefaultsToZeroSupply() public {
        vm.prank(router);
        address token = factory.deploy("Empty", "EMP", BARE_CONFIG, hex"", launcher);
        assertEq(ERC20Template(token).totalSupply(), 0);
    }

    // =========================================================
    // predictAddress
    // =========================================================

    function test_PredictAddress_MatchesActualDeploy() public {
        address predicted = factory.predictAddress(launcher, "Pred", "PRD", BARE_CONFIG);
        vm.prank(router);
        address actual = factory.deploy("Pred", "PRD", BARE_CONFIG, _initData(0, address(0)), launcher);
        assertEq(predicted, actual);
    }

    function test_PredictAddress_ZeroIfUnregistered() public view {
        address predicted = factory.predictAddress(launcher, "N", "N", keccak256("nope"));
        assertEq(predicted, address(0));
    }

    function test_PredictAddress_DifferentLaunchersDifferentAddresses() public view {
        address a = factory.predictAddress(launcher, "Same", "SAME", BARE_CONFIG);
        address b = factory.predictAddress(stranger, "Same", "SAME", BARE_CONFIG);
        assertTrue(a != b);
    }

    function test_PredictAddress_SameParamsSameAddress() public view {
        address a = factory.predictAddress(launcher, "X", "X", BARE_CONFIG);
        address b = factory.predictAddress(launcher, "X", "X", BARE_CONFIG);
        assertEq(a, b);
    }

    // =========================================================
    // Duplicate deploy — CREATE2 collision reverts
    // =========================================================

    function test_Deploy_DuplicateSameSaltReverts() public {
        vm.prank(router);
        factory.deploy("Dup", "DUP", BARE_CONFIG, _initData(0, address(0)), launcher);
        // Same tuple: launcher, name, ticker, chainid → same salt → LibClone.cloneDeterministic reverts.
        vm.expectRevert();
        vm.prank(router);
        factory.deploy("Dup", "DUP", BARE_CONFIG, _initData(0, address(0)), launcher);
    }

    // =========================================================
    // Admin
    // =========================================================

    function test_SetRegistrar_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        factory.setRegistrar(makeAddr("new"));
    }

    function test_SetRegistrar_ZeroReverts() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setRegistrar(address(0));
    }

    function test_SetRegistrar_EmitsAndUpdates() public {
        address newRegistrar = makeAddr("new");
        vm.expectEmit(true, true, false, true, address(factory));
        emit ERC20Factory.RegistrarSet(registrar, newRegistrar);
        vm.prank(owner);
        factory.setRegistrar(newRegistrar);
        assertEq(factory.registrar(), newRegistrar);
    }

    function test_SetRouter_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        factory.setRouter(makeAddr("new"));
    }

    function test_SetRouter_ZeroReverts() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setRouter(address(0));
    }

    function test_SetRouter_EmitsAndUpdates() public {
        address newRouter = makeAddr("new");
        vm.expectEmit(true, true, false, true, address(factory));
        emit ERC20Factory.RouterSet(router, newRouter);
        vm.prank(owner);
        factory.setRouter(newRouter);
        assertEq(factory.router(), newRouter);
    }
}
