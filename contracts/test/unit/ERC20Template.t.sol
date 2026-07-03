// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20Template} from "src/templates/ERC20Template.sol";

contract ERC20TemplateTest is Test {
    ERC20Template internal impl;
    ERC20Template internal token;

    address internal owner = makeAddr("owner");
    address internal recipient = makeAddr("recipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        impl = new ERC20Template();
        token = ERC20Template(LibClone.clone(address(impl)));
    }

    function _initData(
        address owner_,
        string memory name_,
        string memory symbol_,
        uint256 supply,
        address to
    ) internal pure returns (bytes memory) {
        return abi.encode(owner_, name_, symbol_, supply, to, new bytes[](0));
    }

    // =========================================================
    // Initialize
    // =========================================================

    function test_Initialize_SetsMetadataAndOwner() public {
        token.initialize(_initData(owner, "Alpha", "ALP", 0, address(0)));
        assertEq(token.name(), "Alpha");
        assertEq(token.symbol(), "ALP");
        assertEq(token.owner(), owner);
    }

    function test_Initialize_MintsInitialSupplyToOwnerWhenRecipientZero() public {
        token.initialize(_initData(owner, "Beta", "BET", 1000 ether, address(0)));
        assertEq(token.balanceOf(owner), 1000 ether);
        assertEq(token.totalSupply(), 1000 ether);
    }

    function test_Initialize_MintsInitialSupplyToRecipient() public {
        token.initialize(_initData(owner, "Gamma", "GAM", 500 ether, recipient));
        assertEq(token.balanceOf(recipient), 500 ether);
        assertEq(token.balanceOf(owner), 0);
    }

    function test_Initialize_ZeroSupplyDoesNotMint() public {
        token.initialize(_initData(owner, "Delta", "DEL", 0, recipient));
        assertEq(token.totalSupply(), 0);
    }

    function test_Initialize_RevertsOnDoubleInit() public {
        token.initialize(_initData(owner, "Once", "ONC", 0, address(0)));
        vm.expectRevert(ERC20Template.ERC20Template__AlreadyInitialized.selector);
        token.initialize(_initData(owner, "Twice", "TWO", 0, address(0)));
    }

    function test_Initialize_RevertsOnZeroOwner() public {
        vm.expectRevert(ERC20Template.ERC20Template__ZeroOwner.selector);
        token.initialize(_initData(address(0), "NoOwner", "NON", 0, address(0)));
    }

    function test_Initialize_EmitsInitializedEvent() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit ERC20Template.Initialized("Emit", "EMT", owner, 42);
        token.initialize(_initData(owner, "Emit", "EMT", 42, address(0)));
    }

    // =========================================================
    // Transfers (bare template — no modules, no restrictions)
    // =========================================================

    function test_Transfer_HappyPath() public {
        token.initialize(_initData(owner, "T", "T", 100, address(0)));
        vm.prank(owner);
        token.transfer(alice, 40);
        assertEq(token.balanceOf(owner), 60);
        assertEq(token.balanceOf(alice), 40);
    }

    function test_TransferFrom_WithApproval() public {
        token.initialize(_initData(owner, "T", "T", 100, address(0)));
        vm.prank(owner);
        token.approve(bob, 30);
        vm.prank(bob);
        token.transferFrom(owner, alice, 25);
        assertEq(token.balanceOf(alice), 25);
        assertEq(token.allowance(owner, bob), 5);
    }

    // =========================================================
    // Ownership (via Solady Ownable)
    // =========================================================

    function test_TransferOwnership_OnlyOwner() public {
        token.initialize(_initData(owner, "T", "T", 0, address(0)));
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.transferOwnership(alice);
    }

    function test_TransferOwnership_HappyPath() public {
        token.initialize(_initData(owner, "T", "T", 0, address(0)));
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);
    }

    function test_RenounceOwnership() public {
        token.initialize(_initData(owner, "T", "T", 0, address(0)));
        vm.prank(owner);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
    }

    // =========================================================
    // Impl vs. clone isolation
    // =========================================================

    function test_Impl_Uninitialized_HasNoState() public view {
        // Impl was never initialized — name/symbol empty, owner zero, supply zero.
        assertEq(impl.name(), "");
        assertEq(impl.symbol(), "");
        assertEq(impl.owner(), address(0));
        assertEq(impl.totalSupply(), 0);
    }

    function test_Clones_HaveIndependentState() public {
        ERC20Template t1 = ERC20Template(LibClone.clone(address(impl)));
        ERC20Template t2 = ERC20Template(LibClone.clone(address(impl)));
        t1.initialize(_initData(owner, "One", "ONE", 100, address(0)));
        t2.initialize(_initData(owner, "Two", "TWO", 200, address(0)));

        assertEq(t1.name(), "One");
        assertEq(t2.name(), "Two");
        assertEq(t1.totalSupply(), 100);
        assertEq(t2.totalSupply(), 200);
    }
}
