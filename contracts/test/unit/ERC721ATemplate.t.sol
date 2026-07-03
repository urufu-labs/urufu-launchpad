// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";

contract ERC721ATemplateTest is Test {
    ERC721ATemplate internal impl;
    ERC721ATemplate internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;

    function setUp() public {
        impl = new ERC721ATemplate();
        token = ERC721ATemplate(LibClone.clone(address(impl)));
    }

    function _initData(
        address owner_,
        string memory name_,
        string memory symbol_,
        string memory baseURI_,
        uint256 maxSupply_
    ) internal pure returns (bytes memory) {
        return abi.encode(owner_, name_, symbol_, baseURI_, maxSupply_, new bytes[](0));
    }

    // =========================================================
    // Initialize
    // =========================================================

    function test_Initialize_SetsMetadata() public {
        token.initialize(_initData(owner, "Cool NFT", "COOL", "ipfs://Qm.../", 100));
        assertEq(token.name(), "Cool NFT");
        assertEq(token.symbol(), "COOL");
        assertEq(token.baseURI(), "ipfs://Qm.../");
        assertEq(token.maxSupply(), 100);
        assertEq(token.owner(), owner);
    }

    function test_Initialize_ZeroMaxSupply_MeansUncapped() public {
        token.initialize(_initData(owner, "N", "N", "", 0));
        assertEq(token.maxSupply(), 0);

        vm.prank(owner);
        token.mintBatch(alice, 10_000); // no cap → succeeds
        assertEq(token.balanceOf(alice), 10_000);
    }

    function test_Initialize_RevertsOnDoubleInit() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.expectRevert(ERC721ATemplate.ERC721ATemplate__AlreadyInitialized.selector);
        token.initialize(_initData(owner, "N2", "N2", "", 100));
    }

    function test_Initialize_RevertsOnZeroOwner() public {
        vm.expectRevert(ERC721ATemplate.ERC721ATemplate__ZeroOwner.selector);
        token.initialize(_initData(address(0), "N", "N", "", 100));
    }

    function test_Initialize_EmitsInitializedEvent() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit ERC721ATemplate.Initialized("Emit", "EMT", owner, 200);
        token.initialize(_initData(owner, "Emit", "EMT", "", 200));
    }

    // =========================================================
    // Mint
    // =========================================================

    function test_Mint_HappyPath() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.prank(owner);
        token.mintBatch(alice, 5);
        assertEq(token.balanceOf(alice), 5);
        assertEq(token.totalSupply(), 5);
        assertEq(token.totalMinted(), 5);
    }

    function test_Mint_OnlyOwner() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.mintBatch(alice, 1);
    }

    function test_Mint_RevertsOnZeroQuantity() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.expectRevert(ERC721ATemplate.ERC721ATemplate__ZeroQuantity.selector);
        vm.prank(owner);
        token.mintBatch(alice, 0);
    }

    function test_Mint_RespectsMaxSupply() public {
        token.initialize(_initData(owner, "N", "N", "", 10));

        vm.prank(owner);
        token.mintBatch(alice, 7);
        assertEq(token.totalMinted(), 7);

        vm.expectRevert(abi.encodeWithSelector(ERC721ATemplate.ERC721ATemplate__MaxSupplyExceeded.selector, 5, 3));
        vm.prank(owner);
        token.mintBatch(alice, 5);
    }

    function test_Mint_ExactSupplyBoundary() public {
        token.initialize(_initData(owner, "N", "N", "", 10));
        vm.prank(owner);
        token.mintBatch(alice, 10);
        assertEq(token.totalMinted(), 10);
    }

    // =========================================================
    // Transfers
    // =========================================================

    function test_Transfer_TokenId() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.prank(owner);
        token.mintBatch(alice, 3);
        // ERC-721A defaults to _startTokenId() = 0 → token IDs are 0, 1, 2.
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(token.ownerOf(1), bob);
        assertEq(token.balanceOf(alice), 2);
        assertEq(token.balanceOf(bob), 1);
    }

    // =========================================================
    // BaseURI
    // =========================================================

    function test_SetBaseURI_OnlyOwner() public {
        token.initialize(_initData(owner, "N", "N", "ipfs://old/", 100));
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        token.setBaseURI("ipfs://new/");
    }

    function test_SetBaseURI_EmitsAndUpdates() public {
        token.initialize(_initData(owner, "N", "N", "ipfs://old/", 100));
        vm.expectEmit(false, false, false, true, address(token));
        emit ERC721ATemplate.BaseURISet("ipfs://old/", "ipfs://new/");
        vm.prank(owner);
        token.setBaseURI("ipfs://new/");
        assertEq(token.baseURI(), "ipfs://new/");
    }

    function test_TokenURI_ConcatenatesBaseAndId() public {
        token.initialize(_initData(owner, "N", "N", "ipfs://base/", 100));
        vm.prank(owner);
        token.mintBatch(alice, 3);
        assertEq(token.tokenURI(1), "ipfs://base/1");
    }

    // =========================================================
    // Ownership
    // =========================================================

    function test_TransferOwnership() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);
    }

    function test_RenounceOwnership() public {
        token.initialize(_initData(owner, "N", "N", "", 100));
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
        assertEq(impl.maxSupply(), 0);
    }

    function test_Clones_HaveIndependentState() public {
        ERC721ATemplate t1 = ERC721ATemplate(LibClone.clone(address(impl)));
        ERC721ATemplate t2 = ERC721ATemplate(LibClone.clone(address(impl)));
        t1.initialize(_initData(owner, "One", "ONE", "ipfs://one/", 50));
        t2.initialize(_initData(owner, "Two", "TWO", "ipfs://two/", 500));
        assertEq(t1.name(), "One");
        assertEq(t2.name(), "Two");
        assertEq(t1.maxSupply(), 50);
        assertEq(t2.maxSupply(), 500);
    }
}
