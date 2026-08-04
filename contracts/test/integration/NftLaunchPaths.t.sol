// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack} from "test/helpers/LocalV4Stack.sol";
import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";
import {ERC721AWithRoyaltyGen} from "src/templates/composed/ERC721AWithRoyaltyGen.sol";
import {ERC721AWithSoulboundGen} from "src/templates/composed/ERC721AWithSoulboundGen.sol";
import {ERC1155WithSupplyGen} from "src/templates/composed/ERC1155WithSupplyGen.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC721Min {
    function ownerOf(
        uint256
    ) external view returns (address);
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function maxSupply() external view returns (uint256);
    function mintBatch(
        address,
        uint256
    ) external;
    function tokenURI(
        uint256
    ) external view returns (string memory);
    function royaltyInfo(
        uint256,
        uint256
    ) external view returns (address, uint256);
    function transferFrom(
        address,
        address,
        uint256
    ) external;
}

interface IERC1155Min {
    function balanceOf(
        address,
        uint256
    ) external view returns (uint256);
    function uri(
        uint256
    ) external view returns (string memory);
    function mint(
        address,
        uint256,
        uint256,
        bytes calldata
    ) external;
}

/// @title  NftLaunchPathsTest
/// @notice The ERC-721A and ERC-1155 launch lanes. Both share `Router.launch()`
///         with the ERC-20 path but use different factories, different init
///         payloads, and — critically — must be refused a bonding curve, since
///         the curve's constant-product math is ERC-20 only.
contract NftLaunchPathsTest is LocalV4Stack {
    ERC721AFactory internal f721;
    ERC1155Factory internal f1155;

    bytes32 internal constant CH_721_BARE = keccak256(abi.encode("ERC721A", ""));
    bytes32 internal constant CH_1155_BARE = keccak256(abi.encode("ERC1155", ""));
    bytes32 internal constant CH_721_ROYALTY = keccak256(abi.encode("ERC721A", "ERC2981Royalty"));
    bytes32 internal constant CH_721_SOULBOUND = keccak256(abi.encode("ERC721A", "Soulbound"));
    bytes32 internal constant CH_1155_SUPPLY = keccak256(abi.encode("ERC1155", "SupplyPerToken"));

    address internal launcher = makeAddr("nft-launcher");
    address internal collector = makeAddr("nft-collector");

    function setUp() public {
        _deployStack();

        f721 = new ERC721AFactory(admin, address(router), admin);
        f1155 = new ERC1155Factory(admin, address(router), admin);

        address i721Bare = address(new ERC721ATemplate());
        address i721Royalty = address(new ERC721AWithRoyaltyGen());
        address i721Soulbound = address(new ERC721AWithSoulboundGen());
        address i1155Bare = address(new ERC1155Template());
        address i1155Supply = address(new ERC1155WithSupplyGen());

        vm.startPrank(admin);
        // URU-A08 (round 3): pin the audited codehash before registerImpl.
        // Admin is both owner and registrar for these factories.
        f721.setExpectedCodeHash(CH_721_BARE, keccak256(i721Bare.code));
        f721.setExpectedCodeHash(CH_721_ROYALTY, keccak256(i721Royalty.code));
        f721.setExpectedCodeHash(CH_721_SOULBOUND, keccak256(i721Soulbound.code));
        f1155.setExpectedCodeHash(CH_1155_BARE, keccak256(i1155Bare.code));
        f1155.setExpectedCodeHash(CH_1155_SUPPLY, keccak256(i1155Supply.code));

        f721.registerImpl(CH_721_BARE, i721Bare);
        f721.registerImpl(CH_721_ROYALTY, i721Royalty);
        f721.registerImpl(CH_721_SOULBOUND, i721Soulbound);
        f1155.registerImpl(CH_1155_BARE, i1155Bare);
        f1155.registerImpl(CH_1155_SUPPLY, i1155Supply);

        router.setFactory(BaseType.ERC721A, address(f721));
        router.setFactory(BaseType.ERC1155, address(f1155));

        bytes32[5] memory hashes = [CH_721_BARE, CH_1155_BARE, CH_721_ROYALTY, CH_721_SOULBOUND, CH_1155_SUPPLY];
        for (uint256 i; i < hashes.length; ++i) {
            router.setModuleCountForConfig(hashes[i], i < 2 ? 1 : 2);
            router.setFlagsForConfig(hashes[i], 0);
        }
        vm.stopPrank();

        vm.deal(launcher, 100 ether);
    }

    function _launch721(
        bytes32 ch,
        string memory name_,
        string memory sym_,
        string memory baseURI,
        uint256 maxSupply_,
        bytes[] memory moduleData
    ) internal returns (address token) {
        LaunchParams memory p;
        p.base = BaseType.ERC721A;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = ch;
        p.initData = abi.encode(baseURI, maxSupply_, moduleData);
        p.moduleCount = 1;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
    }

    function _launch1155(
        bytes32 ch,
        string memory name_,
        string memory sym_,
        string memory uri_,
        bytes[] memory moduleData
    ) internal returns (address token) {
        LaunchParams memory p;
        p.base = BaseType.ERC1155;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = ch;
        p.initData = abi.encode(uri_, moduleData);
        p.moduleCount = 1;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
    }

    // =====================================================================
    // ERC-721A
    // =====================================================================

    function test_Erc721A_LaunchAndMint() public {
        address token = _launch721(CH_721_BARE, "Chibi Set", "CHIBI", "ipfs://base/", 1000, new bytes[](0));

        assertEq(IERC721Min(token).maxSupply(), 1000, "maxSupply not applied");
        assertFalse(registry.isNameAvailable("Chibi Set"), "name was not reserved by the launch");
        assertFalse(registry.isTickerAvailable("CHIBI"), "ticker was not reserved by the launch");

        vm.prank(launcher);
        IERC721Min(token).mintBatch(collector, 5);

        assertEq(IERC721Min(token).balanceOf(collector), 5, "collector did not receive the batch");
        assertEq(IERC721Min(token).ownerOf(0), collector, "first token not owned by collector");
        assertEq(IERC721Min(token).totalSupply(), 5, "totalSupply wrong after mint");
    }

    function test_Erc721A_MaxSupplyEnforced() public {
        address token = _launch721(CH_721_BARE, "Tiny Set", "TINY", "ipfs://t/", 3, new bytes[](0));

        vm.prank(launcher);
        IERC721Min(token).mintBatch(collector, 3);

        vm.prank(launcher);
        vm.expectRevert();
        IERC721Min(token).mintBatch(collector, 1);
    }

    function test_Erc721A_MintIsOwnerGated() public {
        address token = _launch721(CH_721_BARE, "Gated Set", "GATE", "ipfs://g/", 100, new bytes[](0));

        vm.prank(collector);
        vm.expectRevert();
        IERC721Min(token).mintBatch(collector, 1);
    }

    function test_Erc721A_WithRoyaltyModule() public {
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(launcher, uint96(500)); // 5% to launcher
        address token = _launch721(CH_721_ROYALTY, "Royal Set", "ROYAL", "ipfs://r/", 100, md);

        (address receiver, uint256 amount) = IERC721Min(token).royaltyInfo(1, 10_000);
        assertEq(receiver, launcher, "royalty receiver wrong");
        assertEq(amount, 500, "royalty amount wrong (expected 5%)");
    }

    function test_Erc721A_SoulboundBlocksTransfer() public {
        address token = _launch721(CH_721_SOULBOUND, "Bound Set", "BOUND", "ipfs://b/", 100, new bytes[](1));

        vm.prank(launcher);
        IERC721Min(token).mintBatch(collector, 1);
        // ERC721A does not override `_startTokenId`, so ids begin at 0.
        assertEq(IERC721Min(token).ownerOf(0), collector, "mint should still work when soulbound");

        vm.prank(collector);
        vm.expectRevert();
        IERC721Min(token).transferFrom(collector, launcher, 0);
    }

    // =====================================================================
    // ERC-1155
    // =====================================================================

    function test_Erc1155_LaunchAndMint() public {
        address token = _launch1155(CH_1155_BARE, "Multi Set", "MULTI", "ipfs://multi/{id}.json", new bytes[](0));

        assertFalse(registry.isNameAvailable("Multi Set"), "name was not reserved by the launch");
        assertFalse(registry.isTickerAvailable("MULTI"), "ticker was not reserved by the launch");

        vm.prank(launcher);
        IERC1155Min(token).mint(collector, 1, 50, "");

        assertEq(IERC1155Min(token).balanceOf(collector, 1), 50, "1155 mint did not land");
        assertEq(IERC1155Min(token).uri(1), "ipfs://multi/{id}.json", "uri not applied");
    }

    function test_Erc1155_MintIsOwnerGated() public {
        address token = _launch1155(CH_1155_BARE, "Gated Multi", "GMUL", "ipfs://gm/", new bytes[](0));

        vm.prank(collector);
        vm.expectRevert();
        IERC1155Min(token).mint(collector, 1, 1, "");
    }

    function test_Erc1155_WithSupplyModule() public {
        bytes[] memory md = new bytes[](1);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory caps = new uint256[](1);
        ids[0] = 1;
        caps[0] = 10;
        md[0] = abi.encode(ids, caps); // token id 1 capped at 10
        address token = _launch1155(CH_1155_SUPPLY, "Capped Multi", "CMUL", "ipfs://cm/", md);

        vm.prank(launcher);
        IERC1155Min(token).mint(collector, 1, 10, "");
        assertEq(IERC1155Min(token).balanceOf(collector, 1), 10, "capped mint did not land");

        vm.prank(launcher);
        vm.expectRevert();
        IERC1155Min(token).mint(collector, 1, 1, "");
    }

    // =====================================================================
    // Curve is ERC-20 only
    // =====================================================================

    function test_Erc721A_CurveInstallIsRejected() public {
        LaunchParams memory p;
        p.base = BaseType.ERC721A;
        p.name = "Curve NFT";
        p.ticker = "CNFT";
        p.configHash = CH_721_BARE;
        p.initData = abi.encode("ipfs://c/", uint256(100), new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        vm.expectRevert(Router.Router__CurveOnlyForERC20.selector);
        router.launch{value: fee}(p);
    }

    function test_Erc1155_CurveInstallIsRejected() public {
        LaunchParams memory p;
        p.base = BaseType.ERC1155;
        p.name = "Curve Multi";
        p.ticker = "CMLT";
        p.configHash = CH_1155_BARE;
        p.initData = abi.encode("ipfs://cm/", new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        vm.expectRevert(Router.Router__CurveOnlyForERC20.selector);
        router.launch{value: fee}(p);
    }

    // =====================================================================
    // Registry uniqueness holds across bases
    // =====================================================================

    function test_NameCollisionAcrossBasesIsRejected() public {
        _launch721(CH_721_BARE, "Shared Name", "SHR1", "ipfs://s/", 10, new bytes[](0));

        LaunchParams memory p;
        p.base = BaseType.ERC1155;
        p.name = "Shared Name";
        p.ticker = "SHR2";
        p.configHash = CH_1155_BARE;
        p.initData = abi.encode("ipfs://s2/", new bytes[](0));
        p.moduleCount = 1;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        vm.expectRevert();
        router.launch{value: fee}(p);
    }
}
