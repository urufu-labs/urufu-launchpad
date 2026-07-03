// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";

contract ERC721AFactoryTest is Test {
    ERC721AFactory internal factory;
    ERC721ATemplate internal impl;

    address internal owner = makeAddr("owner");
    address internal router = makeAddr("router");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BARE_CONFIG = keccak256("bare-ERC721A");
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        factory = new ERC721AFactory(owner, router, registrar);
        impl = new ERC721ATemplate();
        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    function _initData(
        string memory baseURI,
        uint256 maxSupply
    ) internal pure returns (bytes memory) {
        return abi.encode(baseURI, maxSupply, new bytes[](0));
    }

    // =========================================================
    // Constructor
    // =========================================================

    function test_Constructor_RevertsOnZeroRouter() public {
        vm.expectRevert(ERC721AFactory.ERC721AFactory__ZeroAddress.selector);
        new ERC721AFactory(owner, address(0), registrar);
    }

    function test_Constructor_RevertsOnZeroRegistrar() public {
        vm.expectRevert(ERC721AFactory.ERC721AFactory__ZeroAddress.selector);
        new ERC721AFactory(owner, router, address(0));
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
        ERC721AFactory fresh = new ERC721AFactory(owner, router, registrar);
        vm.prank(registrar);
        fresh.registerImpl(BARE_CONFIG, address(impl));
        assertEq(fresh.implFor(BARE_CONFIG), address(impl));
    }

    function test_RegisterImpl_RevertsOnDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(ERC721AFactory.ERC721AFactory__AlreadyRegistered.selector, BARE_CONFIG));
        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));
    }

    function test_RegisterImpl_RevertsIfNotRegistrar() public {
        vm.expectRevert(ERC721AFactory.ERC721AFactory__NotRegistrar.selector);
        vm.prank(stranger);
        factory.registerImpl(keccak256("x"), address(impl));
    }

    // =========================================================
    // deploy
    // =========================================================

    function test_Deploy_HappyPath() public {
        vm.prank(router);
        address token = factory.deploy("Cool NFT", "COOL", BARE_CONFIG, _initData("ipfs://base/", 500), launcher);

        assertTrue(token != address(0));
        ERC721ATemplate t = ERC721ATemplate(token);
        assertEq(t.name(), "Cool NFT");
        assertEq(t.symbol(), "COOL");
        assertEq(t.baseURI(), "ipfs://base/");
        assertEq(t.maxSupply(), 500);
        assertEq(t.owner(), router);
        assertEq(factory.usageCount(BARE_CONFIG), 1);
    }

    function test_Deploy_RevertsIfNotRouter() public {
        vm.expectRevert(ERC721AFactory.ERC721AFactory__NotRouter.selector);
        vm.prank(stranger);
        factory.deploy("N", "N", BARE_CONFIG, _initData("", 0), launcher);
    }

    function test_Deploy_RevertsOnUnknownConfig() public {
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(ERC721AFactory.ERC721AFactory__UnknownConfig.selector, unknown));
        vm.prank(router);
        factory.deploy("N", "N", unknown, _initData("", 0), launcher);
    }

    function test_Deploy_EmptyInitDataDefaults() public {
        vm.prank(router);
        address token = factory.deploy("N", "N", BARE_CONFIG, hex"", launcher);
        assertEq(ERC721ATemplate(token).maxSupply(), 0);
        assertEq(ERC721ATemplate(token).baseURI(), "");
    }

    function test_Deploy_DuplicateSameSaltReverts() public {
        vm.prank(router);
        factory.deploy("Dup", "DUP", BARE_CONFIG, _initData("", 0), launcher);
        vm.expectRevert();
        vm.prank(router);
        factory.deploy("Dup", "DUP", BARE_CONFIG, _initData("", 0), launcher);
    }

    // =========================================================
    // predictAddress
    // =========================================================

    function test_PredictAddress_MatchesActualDeploy() public {
        address predicted = factory.predictAddress(launcher, "Pred", "PRD", BARE_CONFIG);
        vm.prank(router);
        address actual = factory.deploy("Pred", "PRD", BARE_CONFIG, _initData("", 0), launcher);
        assertEq(predicted, actual);
    }

    function test_PredictAddress_ZeroIfUnregistered() public view {
        assertEq(factory.predictAddress(launcher, "X", "X", keccak256("nope")), address(0));
    }

    // =========================================================
    // Admin
    // =========================================================

    function test_SetRegistrar_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        factory.setRegistrar(makeAddr("new"));
    }

    function test_SetRouter_ZeroReverts() public {
        vm.expectRevert(ERC721AFactory.ERC721AFactory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setRouter(address(0));
    }
}
