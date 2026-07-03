// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";

contract ERC1155FactoryTest is Test {
    ERC1155Factory internal factory;
    ERC1155Template internal impl;

    address internal owner = makeAddr("owner");
    address internal router = makeAddr("router");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BARE_CONFIG = keccak256("bare-ERC1155");
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        factory = new ERC1155Factory(owner, router, registrar);
        impl = new ERC1155Template();
        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    function _initData(
        string memory uri
    ) internal pure returns (bytes memory) {
        return abi.encode(uri, new bytes[](0));
    }

    // Constructor
    function test_Constructor_RevertsOnZeroRouter() public {
        vm.expectRevert(ERC1155Factory.ERC1155Factory__ZeroAddress.selector);
        new ERC1155Factory(owner, address(0), registrar);
    }

    function test_Constructor_RevertsOnZeroRegistrar() public {
        vm.expectRevert(ERC1155Factory.ERC1155Factory__ZeroAddress.selector);
        new ERC1155Factory(owner, router, address(0));
    }

    // registerImpl
    function test_RegisterImpl_HappyPath() public {
        ERC1155Factory fresh = new ERC1155Factory(owner, router, registrar);
        vm.prank(registrar);
        fresh.registerImpl(BARE_CONFIG, address(impl));
        assertEq(fresh.implFor(BARE_CONFIG), address(impl));
    }

    function test_RegisterImpl_RevertsIfNotRegistrar() public {
        vm.expectRevert(ERC1155Factory.ERC1155Factory__NotRegistrar.selector);
        vm.prank(stranger);
        factory.registerImpl(keccak256("x"), address(impl));
    }

    function test_RegisterImpl_RevertsOnDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(ERC1155Factory.ERC1155Factory__AlreadyRegistered.selector, BARE_CONFIG));
        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    // deploy
    function test_Deploy_HappyPath() public {
        vm.prank(router);
        address token = factory.deploy("Collectible", "COLL", BARE_CONFIG, _initData("ipfs://c/{id}.json"), launcher);

        ERC1155Template t = ERC1155Template(token);
        assertEq(t.name(), "Collectible");
        assertEq(t.symbol(), "COLL");
        assertEq(t.uri(0), "ipfs://c/{id}.json");
        assertEq(t.owner(), router);
        assertEq(factory.usageCount(BARE_CONFIG), 1);
    }

    function test_Deploy_RevertsIfNotRouter() public {
        vm.expectRevert(ERC1155Factory.ERC1155Factory__NotRouter.selector);
        vm.prank(stranger);
        factory.deploy("N", "N", BARE_CONFIG, _initData(""), launcher);
    }

    function test_Deploy_EmptyInitDataDefaults() public {
        vm.prank(router);
        address token = factory.deploy("N", "N", BARE_CONFIG, hex"", launcher);
        assertEq(ERC1155Template(token).uri(0), "");
    }

    function test_Deploy_DuplicateSaltReverts() public {
        vm.prank(router);
        factory.deploy("D", "D", BARE_CONFIG, _initData(""), launcher);
        vm.expectRevert();
        vm.prank(router);
        factory.deploy("D", "D", BARE_CONFIG, _initData(""), launcher);
    }

    // predictAddress
    function test_PredictAddress_MatchesActualDeploy() public {
        address predicted = factory.predictAddress(launcher, "P", "P", BARE_CONFIG);
        vm.prank(router);
        address actual = factory.deploy("P", "P", BARE_CONFIG, _initData(""), launcher);
        assertEq(predicted, actual);
    }

    function test_PredictAddress_ZeroIfUnregistered() public view {
        assertEq(factory.predictAddress(launcher, "X", "X", keccak256("nope")), address(0));
    }

    // Admin
    function test_SetRegistrar_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        factory.setRegistrar(makeAddr("new"));
    }

    function test_SetRouter_ZeroReverts() public {
        vm.expectRevert(ERC1155Factory.ERC1155Factory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setRouter(address(0));
    }
}
