// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC1155Template} from "src/templates/ERC1155Template.sol";

contract ERC1155TemplateTest is Test {
    ERC1155Template internal impl;
    ERC1155Template internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        impl = new ERC1155Template();
        token = ERC1155Template(LibClone.clone(address(impl)));
    }

    function _initData(
        address owner_,
        string memory name_,
        string memory symbol_,
        string memory uri_
    ) internal pure returns (bytes memory) {
        return abi.encode(owner_, name_, symbol_, uri_, new bytes[](0));
    }

    // =========================================================
    // Initialize
    // =========================================================

    function test_Initialize_SetsMetadata() public {
        token.initialize(_initData(owner, "Cool Items", "COOL", "ipfs://Qm.../{id}.json"));
        assertEq(token.name(), "Cool Items");
        assertEq(token.symbol(), "COOL");
        assertEq(token.uri(0), "ipfs://Qm.../{id}.json");
        assertEq(token.uri(999), "ipfs://Qm.../{id}.json"); // same URI for every id
        assertEq(token.owner(), owner);
    }

    function test_Initialize_RevertsOnDoubleInit() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.expectRevert(ERC1155Template.ERC1155Template__AlreadyInitialized.selector);
        token.initialize(_initData(owner, "N2", "N2", "u2"));
    }

    function test_Initialize_RevertsOnZeroOwner() public {
        vm.expectRevert(ERC1155Template.ERC1155Template__ZeroOwner.selector);
        token.initialize(_initData(address(0), "N", "N", "u"));
    }

    function test_Initialize_EmitsInitializedEvent() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit ERC1155Template.Initialized("Emit", "EMT", "ipfs://x", owner);
        token.initialize(_initData(owner, "Emit", "EMT", "ipfs://x"));
    }

    // =========================================================
    // Single mint
    // =========================================================

    function test_Mint_HappyPath() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.prank(owner);
        token.mint(alice, 1, 100, "");
        assertEq(token.balanceOf(alice, 1), 100);
    }

    function test_Mint_OnlyOwner() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.mint(alice, 1, 100, "");
    }

    function test_Mint_RevertsOnZeroAmount() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.expectRevert(ERC1155Template.ERC1155Template__ZeroAmount.selector);
        vm.prank(owner);
        token.mint(alice, 1, 0, "");
    }

    // =========================================================
    // Batch mint
    // =========================================================

    function test_MintBatch_HappyPath() public {
        token.initialize(_initData(owner, "N", "N", "u"));

        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 10;
        amounts[1] = 20;
        amounts[2] = 30;

        vm.prank(owner);
        token.mintBatch(alice, ids, amounts, "");
        assertEq(token.balanceOf(alice, 1), 10);
        assertEq(token.balanceOf(alice, 2), 20);
        assertEq(token.balanceOf(alice, 3), 30);
    }

    function test_MintBatch_OnlyOwner() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.mintBatch(alice, ids, amounts, "");
    }

    // =========================================================
    // Transfers
    // =========================================================

    function test_SafeTransferFrom() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.prank(owner);
        token.mint(alice, 1, 100, "");

        vm.prank(alice);
        token.safeTransferFrom(alice, bob, 1, 40, "");

        assertEq(token.balanceOf(alice, 1), 60);
        assertEq(token.balanceOf(bob, 1), 40);
    }

    // =========================================================
    // URI admin
    // =========================================================

    function test_SetURI_OnlyOwner() public {
        token.initialize(_initData(owner, "N", "N", "ipfs://old/"));
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setURI("ipfs://new/");
    }

    function test_SetURI_EmitsAndUpdates() public {
        token.initialize(_initData(owner, "N", "N", "ipfs://old/"));
        vm.expectEmit(false, false, false, true, address(token));
        emit ERC1155Template.URISet("ipfs://old/", "ipfs://new/");
        vm.prank(owner);
        token.setURI("ipfs://new/");
        assertEq(token.uri(0), "ipfs://new/");
    }

    // =========================================================
    // Ownership
    // =========================================================

    function test_TransferOwnership() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);
    }

    function test_RenounceOwnership() public {
        token.initialize(_initData(owner, "N", "N", "u"));
        vm.prank(owner);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
    }

    // =========================================================
    // Impl vs. clone isolation
    // =========================================================

    function test_Impl_Uninitialized_HasNoState() public view {
        assertEq(impl.name(), "");
        assertEq(impl.symbol(), "");
        assertEq(impl.owner(), address(0));
        assertEq(impl.uri(0), "");
    }

    function test_Clones_HaveIndependentState() public {
        ERC1155Template t1 = ERC1155Template(LibClone.clone(address(impl)));
        ERC1155Template t2 = ERC1155Template(LibClone.clone(address(impl)));
        t1.initialize(_initData(owner, "One", "ONE", "ipfs://one/"));
        t2.initialize(_initData(owner, "Two", "TWO", "ipfs://two/"));
        assertEq(t1.name(), "One");
        assertEq(t2.name(), "Two");
        assertEq(t1.uri(0), "ipfs://one/");
        assertEq(t2.uri(0), "ipfs://two/");
    }
}
