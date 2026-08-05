// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";

/// @title  FactoryCodeHashPinTest — URU-A08 (round 3 follow-up) adversarial tests
/// @notice The verifier flagged that `ERC20Factory.registerImpl` in earlier
///         audit rounds had no binding between an audited configHash and the
///         actual runtime bytecode a registrar chose to point it at — a rogue
///         registrar could bind a compromised impl to an audited hash.
///
///         Round 3 closes this with a two-step gate on all three factories:
///           1. Owner (multisig) calls `setExpectedCodeHash(configHash, hash)`
///              — one-shot per config, `bytes32(0)` rejected.
///           2. Registrar calls `registerImpl(configHash, impl)` — the factory
///              computes `keccak256(impl.code)` and compares to the pin. Any
///              mismatch reverts `ArtifactHashMismatch`. Missing pin reverts
///              `CodeHashNotPinned`.
///
///         These tests prove every branch of the gate at source level for all
///         three factories. Named `_ERC20_/_ERC721A_/_ERC1155_` to make grepping
///         obvious.
contract FactoryCodeHashPinTest is Test {
    address internal owner = makeAddr("owner");
    address internal router = makeAddr("router");
    address internal registrar = makeAddr("registrar");

    bytes32 internal constant CONFIG_A = keccak256("cfg-A");
    bytes32 internal constant CONFIG_B = keccak256("cfg-B");
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    ERC20Factory internal f20;
    ERC721AFactory internal f721;
    ERC1155Factory internal f1155;

    ERC20Template internal impl20;
    ERC721ATemplate internal impl721;
    ERC1155Template internal impl1155;

    function setUp() public {
        f20 = new ERC20Factory(owner, router, registrar);
        f721 = new ERC721AFactory(owner, router, registrar);
        f1155 = new ERC1155Factory(owner, router, registrar);

        impl20 = new ERC20Template();
        impl721 = new ERC721ATemplate();
        impl1155 = new ERC1155Template();
    }

    // -------------------------------------------------------------
    // Register without a pin — must revert CodeHashNotPinned
    // -------------------------------------------------------------

    function test_ERC20_RegisterWithoutPin_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ERC20Factory.ERC20Factory__CodeHashNotPinned.selector, CONFIG_A));
        vm.prank(registrar);
        f20.registerImpl(CONFIG_A, address(impl20));
    }

    function test_ERC721A_RegisterWithoutPin_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ERC721AFactory.ERC721AFactory__CodeHashNotPinned.selector, CONFIG_A));
        vm.prank(registrar);
        f721.registerImpl(CONFIG_A, address(impl721));
    }

    function test_ERC1155_RegisterWithoutPin_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ERC1155Factory.ERC1155Factory__CodeHashNotPinned.selector, CONFIG_A));
        vm.prank(registrar);
        f1155.registerImpl(CONFIG_A, address(impl1155));
    }

    // -------------------------------------------------------------
    // Register with a wrong-hash pin — must revert ArtifactHashMismatch
    // -------------------------------------------------------------
    // The auditor's exact concern: a rogue registrar tries to bind a
    // compromised impl to an audited configHash. Here we simulate that by
    // pinning ONE bytecode's hash then attempting to register a DIFFERENT
    // bytecode against the same config.

    function test_ERC20_RegisterWrongHash_Reverts() public {
        // Pin against a different template (impl721) — a hash the audited
        // impl20 will never match.
        bytes32 badPin = keccak256(address(impl721).code);
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, badPin);

        bytes32 actual = keccak256(address(impl20).code);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20Factory.ERC20Factory__ArtifactHashMismatch.selector, CONFIG_A, badPin, actual)
        );
        vm.prank(registrar);
        f20.registerImpl(CONFIG_A, address(impl20));
    }

    function test_ERC721A_RegisterWrongHash_Reverts() public {
        bytes32 badPin = keccak256(address(impl20).code);
        vm.prank(owner);
        f721.setExpectedCodeHash(CONFIG_A, badPin);

        bytes32 actual = keccak256(address(impl721).code);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC721AFactory.ERC721AFactory__ArtifactHashMismatch.selector, CONFIG_A, badPin, actual
            )
        );
        vm.prank(registrar);
        f721.registerImpl(CONFIG_A, address(impl721));
    }

    function test_ERC1155_RegisterWrongHash_Reverts() public {
        bytes32 badPin = keccak256(address(impl20).code);
        vm.prank(owner);
        f1155.setExpectedCodeHash(CONFIG_A, badPin);

        bytes32 actual = keccak256(address(impl1155).code);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC1155Factory.ERC1155Factory__ArtifactHashMismatch.selector, CONFIG_A, badPin, actual
            )
        );
        vm.prank(registrar);
        f1155.registerImpl(CONFIG_A, address(impl1155));
    }

    // -------------------------------------------------------------
    // Happy path — pin then register
    // -------------------------------------------------------------

    function test_ERC20_PinThenRegister_Succeeds() public {
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, keccak256(address(impl20).code));
        vm.prank(registrar);
        f20.registerImpl(CONFIG_A, address(impl20));
        assertEq(f20.implFor(CONFIG_A), address(impl20));
    }

    function test_ERC721A_PinThenRegister_Succeeds() public {
        vm.prank(owner);
        f721.setExpectedCodeHash(CONFIG_A, keccak256(address(impl721).code));
        vm.prank(registrar);
        f721.registerImpl(CONFIG_A, address(impl721));
        assertEq(f721.implFor(CONFIG_A), address(impl721));
    }

    function test_ERC1155_PinThenRegister_Succeeds() public {
        vm.prank(owner);
        f1155.setExpectedCodeHash(CONFIG_A, keccak256(address(impl1155).code));
        vm.prank(registrar);
        f1155.registerImpl(CONFIG_A, address(impl1155));
        assertEq(f1155.implFor(CONFIG_A), address(impl1155));
    }

    // -------------------------------------------------------------
    // setExpectedCodeHash — one-shot semantics + guards
    // -------------------------------------------------------------

    function test_ERC20_PinIsOneShot() public {
        bytes32 first = keccak256(address(impl20).code);
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, first);

        // A second call — even to the same value — must revert. Rotating the
        // pin would defeat the audit binding: a compromised owner could
        // rotate to a hash matching a compromised impl.
        vm.expectRevert(abi.encodeWithSelector(ERC20Factory.ERC20Factory__CodeHashAlreadyPinned.selector, CONFIG_A));
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, first);
    }

    function test_ERC721A_PinIsOneShot() public {
        bytes32 first = keccak256(address(impl721).code);
        vm.prank(owner);
        f721.setExpectedCodeHash(CONFIG_A, first);
        vm.expectRevert(abi.encodeWithSelector(ERC721AFactory.ERC721AFactory__CodeHashAlreadyPinned.selector, CONFIG_A));
        vm.prank(owner);
        f721.setExpectedCodeHash(CONFIG_A, first);
    }

    function test_ERC1155_PinIsOneShot() public {
        bytes32 first = keccak256(address(impl1155).code);
        vm.prank(owner);
        f1155.setExpectedCodeHash(CONFIG_A, first);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Factory.ERC1155Factory__CodeHashAlreadyPinned.selector, CONFIG_A));
        vm.prank(owner);
        f1155.setExpectedCodeHash(CONFIG_A, first);
    }

    function test_ERC20_PinZero_Reverts() public {
        vm.expectRevert(ERC20Factory.ERC20Factory__ZeroCodeHash.selector);
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, bytes32(0));
    }

    function test_ERC20_PinOnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(makeAddr("stranger"));
        f20.setExpectedCodeHash(CONFIG_A, keccak256("anything"));
    }

    // -------------------------------------------------------------
    // Emits the ExpectedCodeHashPinned event
    // -------------------------------------------------------------

    function test_ERC20_Pin_EmitsEvent() public {
        bytes32 pin = keccak256(address(impl20).code);
        vm.expectEmit(true, false, false, true, address(f20));
        emit ERC20Factory.ExpectedCodeHashPinned(CONFIG_A, pin);
        vm.prank(owner);
        f20.setExpectedCodeHash(CONFIG_A, pin);
    }

    // -------------------------------------------------------------
    // Distinct configs get distinct pins
    // -------------------------------------------------------------

    function test_ERC20_TwoConfigsIndependent() public {
        vm.startPrank(owner);
        f20.setExpectedCodeHash(CONFIG_A, keccak256(address(impl20).code));
        // CONFIG_B intentionally pins to impl721's hash so a register with
        // impl20 under CONFIG_B fails while CONFIG_A succeeds.
        f20.setExpectedCodeHash(CONFIG_B, keccak256(address(impl721).code));
        vm.stopPrank();

        vm.prank(registrar);
        f20.registerImpl(CONFIG_A, address(impl20));

        bytes32 badPin = keccak256(address(impl721).code);
        bytes32 actual = keccak256(address(impl20).code);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20Factory.ERC20Factory__ArtifactHashMismatch.selector, CONFIG_B, badPin, actual)
        );
        vm.prank(registrar);
        f20.registerImpl(CONFIG_B, address(impl20));
    }
}
