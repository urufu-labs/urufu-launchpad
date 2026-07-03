// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithPermitGen} from "src/templates/composed/ERC20WithPermitGen.sol";

contract ERC20WithPermitGenTest is Test {
    ERC20WithPermitGen internal impl;
    ERC20WithPermitGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice;
    uint256 internal alicePk = 0xA11CE;
    address internal bob = makeAddr("bob");

    function setUp() public {
        alice = vm.addr(alicePk);
        impl = new ERC20WithPermitGen();
        token = ERC20WithPermitGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "Permit", "PMT", 1000 ether, alice, moduleData);
        token.initialize(initData);
    }

    function test_Init_EmitsPermitEnabled() public {
        ERC20WithPermitGen fresh = ERC20WithPermitGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = "";
        bytes memory initData = abi.encode(owner, "P", "P", 0, address(0), moduleData);

        vm.expectEmit(false, false, false, true, address(fresh));
        emit ERC20WithPermitGen.PermitEnabled();
        fresh.initialize(initData);
    }

    function test_DomainSeparator_NonZero() public view {
        bytes32 sep = token.DOMAIN_SEPARATOR();
        assertTrue(sep != bytes32(0));
    }

    function test_Nonces_StartZero() public view {
        assertEq(token.nonces(alice), 0);
    }

    function test_Permit_GrantsAllowance() public {
        uint256 value = 100 ether;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = token.nonces(alice);

        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(permitTypehash, alice, bob, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        token.permit(alice, bob, value, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), value);
        assertEq(token.nonces(alice), nonce + 1);
    }
}
