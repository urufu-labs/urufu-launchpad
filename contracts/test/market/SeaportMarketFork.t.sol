// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title  SeaportMarketFork: zero-fee marketplace orders against LIVE Seaport 1.6 on RH
/// @notice docs/SPEC-marketplace.md. No contract of ours is involved: the
///         marketplace is signed Seaport orders. These tests build orders in
///         exactly the shape shared/seaport.ts::buildListingOrder produces
///         (one ERC-721 offer, ETH to the seller, optional ERC-2981 royalty
///         item, FULL_OPEN, marker zone, no conduit) and fill them through the
///         real Seaport deployment on a Robinhood fork:
///           - NFT-lane collection (Launchpad Gallery Smoke): list + fill
///           - DN404 mirror ($SMOKE): list + fill, the unit tokens move with
///             the NFT, approval is on the mirror
///           - DN404 seller sells the tokens behind the NFT: NFT burns,
///             ownerOf reverts (what compile-service hides on), fill reverts
///           - royalty item paid to the ERC-2981 receiver
///           - cancel() and incrementCounter() kill a listing
///           - the marker zone shows up indexed in OrderFulfilled (indexer filter)
///
///         Env: ROBINHOOD_RPC_URL (falls back to the public RH RPC).
///         Skips cleanly if the fork isn't chain 4663.

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

struct OfferItem {
    uint8 itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

struct ConsiderationItem {
    uint8 itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address payable recipient;
}

struct OrderComponents {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    uint8 orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 counter;
}

struct OrderParameters {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    uint8 orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 totalOriginalConsiderationItems;
}

struct Order {
    OrderParameters parameters;
    bytes signature;
}

interface ISeaport {
    function fulfillOrder(
        Order calldata order,
        bytes32 fulfillerConduitKey
    ) external payable returns (bool);
    function cancel(
        OrderComponents[] calldata orders
    ) external returns (bool);
    function incrementCounter() external returns (uint256);
    function getCounter(
        address offerer
    ) external view returns (uint256);
    function getOrderHash(
        OrderComponents calldata order
    ) external view returns (bytes32);
    function getOrderStatus(
        bytes32 orderHash
    ) external view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize);
    function information()
        external
        view
        returns (string memory version, bytes32 domainSeparator, address conduitController);
}

interface IERC721Like {
    function ownerOf(
        uint256 id
    ) external view returns (address);
    function transferFrom(
        address from,
        address to,
        uint256 id
    ) external;
    function setApprovalForAll(
        address operator,
        bool approved
    ) external;
    function balanceOf(
        address who
    ) external view returns (uint256);
}

interface IDn404Mirror is IERC721Like {
    function baseERC20() external view returns (address);
}

interface IDn404Base {
    function balanceOf(
        address who
    ) external view returns (uint256);
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);
    function getSkipNFT(
        address owner
    ) external view returns (bool);
    function setSkipNFT(
        bool skipNFT
    ) external returns (bool);
}

interface IRoyaltyInfo {
    function royaltyInfo(
        uint256 tokenId,
        uint256 salePrice
    ) external view returns (address, uint256);
}

/// ERC-721 with ERC-2981, standing in for an NFT-lane launch that picked a
/// royalty template (no live urufu collection has one yet).
contract RoyaltyNft is ERC721, ERC2981 {
    constructor(
        address receiver,
        uint96 bps
    ) ERC721("Royalty Test", "RT") {
        _setDefaultRoyalty(receiver, bps);
    }

    function mint(
        address to,
        uint256 id
    ) external {
        _mint(to, id);
    }

    function supportsInterface(
        bytes4 id
    ) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }
}

contract SeaportMarketForkTest is Test {
    ISeaport internal constant SEAPORT = ISeaport(0x0000000000000068F116a894984e2DB1123eB395);
    /// shared/seaport.ts MARKET_ZONE = keccak256("urufu.market.zone.v1")[12:]
    address internal constant MARKET_ZONE = 0xcbaadd982f0770Cf24FbD39F598edD3F8c5E6693;
    /// Live NFT-lane collection "Launchpad Gallery Smoke" (NftLaunchFactory V5).
    address internal constant GALLERY_SMOKE = 0x9f9E3304C3878F9c62d0b067012Ab736301E8d83;
    /// Live DN404 $SMOKE pair (Dn404LaunchFactory 0x3026C7…, 2026-09-16).
    address internal constant SMOKE_MIRROR = 0x375f4D9CE84607dbE0FCe6B55B1c5B9335b87bA3;
    uint256 internal constant SMOKE_UNIT = 10_000 ether;

    address internal seller;
    uint256 internal sellerKey;
    address internal buyer = makeAddr("buyer");
    bool internal live;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        try vm.createSelectFork(rpc) {
            live = block.chainid == 4663 && address(SEAPORT).code.length > 0;
        } catch {
            live = false;
        }
        if (!live) {
            vm.skip(true);
            return;
        }
        (seller, sellerKey) = makeAddrAndKey("seller");
        vm.deal(buyer, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    /// Move token `id` of `nft` from its current holder to our seller key.
    function _giveToSeller(
        address nft,
        uint256 id
    ) internal {
        address holder = IERC721Like(nft).ownerOf(id);
        vm.prank(holder);
        IERC721Like(nft).transferFrom(holder, seller, id);
        assertEq(IERC721Like(nft).ownerOf(id), seller);
    }

    function _listing(
        address nft,
        uint256 id,
        uint256 price,
        address royaltyTo,
        uint256 royaltyAmt
    ) internal view returns (OrderComponents memory o) {
        o.offerer = seller;
        o.zone = MARKET_ZONE;
        o.offer = new OfferItem[](1);
        o.offer[0] = OfferItem(2, nft, id, 1, 1);
        bool hasRoyalty = royaltyAmt > 0;
        o.consideration = new ConsiderationItem[](hasRoyalty ? 2 : 1);
        o.consideration[0] =
            ConsiderationItem(0, address(0), 0, price - royaltyAmt, price - royaltyAmt, payable(seller));
        if (hasRoyalty) {
            o.consideration[1] = ConsiderationItem(0, address(0), 0, royaltyAmt, royaltyAmt, payable(royaltyTo));
        }
        o.orderType = 0; // FULL_OPEN
        o.startTime = block.timestamp - 60;
        o.endTime = block.timestamp + 30 days;
        o.zoneHash = bytes32(0);
        o.salt = uint256(keccak256(abi.encode(nft, id, price)));
        o.conduitKey = bytes32(0);
        o.counter = SEAPORT.getCounter(seller);
    }

    function _sign(
        OrderComponents memory o
    ) internal view returns (bytes memory) {
        (, bytes32 domainSeparator,) = SEAPORT.information();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, SEAPORT.getOrderHash(o)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _order(
        OrderComponents memory o
    ) internal view returns (Order memory) {
        return Order(
            OrderParameters(
                o.offerer,
                o.zone,
                o.offer,
                o.consideration,
                o.orderType,
                o.startTime,
                o.endTime,
                o.zoneHash,
                o.salt,
                o.conduitKey,
                o.consideration.length
            ),
            _sign(o)
        );
    }

    function _fill(
        OrderComponents memory o,
        uint256 price
    ) internal {
        Order memory ord = _order(o);
        vm.prank(buyer);
        SEAPORT.fulfillOrder{value: price}(ord, bytes32(0));
    }

    // ---------------------------------------------------------------- NFT lane

    function test_NftLane_ListAndFill_NoFee() public {
        uint256 id = 1;
        _giveToSeller(GALLERY_SMOKE, id);
        vm.prank(seller);
        IERC721Like(GALLERY_SMOKE).setApprovalForAll(address(SEAPORT), true);

        // M1: the NFT-lane template has no ERC-2981, so no royalty item.
        vm.expectRevert();
        IRoyaltyInfo(GALLERY_SMOKE).royaltyInfo(id, 1 ether);

        uint256 price = 0.25 ether;
        OrderComponents memory o = _listing(GALLERY_SMOKE, id, price, address(0), 0);
        uint256 sellerBefore = seller.balance;
        uint256 buyerBefore = buyer.balance;

        vm.recordLogs();
        _fill(o, price);

        assertEq(IERC721Like(GALLERY_SMOKE).ownerOf(id), buyer, "buyer owns the NFT");
        // Zero fee: every wei the buyer paid reached the seller.
        assertEq(seller.balance - sellerBefore, price, "seller got the full price");
        assertEq(buyerBefore - buyer.balance, price, "buyer paid exactly the price");
        (,, uint256 filled, uint256 size) = SEAPORT.getOrderStatus(SEAPORT.getOrderHash(o));
        assertEq(filled, size, "order fully filled");
        _assertZoneEmitted(SEAPORT.getOrderHash(o));
    }

    /// The indexer filters getLogs by topic2 (zone) of OrderFulfilled.
    function _assertZoneEmitted(
        bytes32 orderHash
    ) internal {
        bytes32 topic0 = keccak256(
            "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(SEAPORT) || logs[i].topics[0] != topic0) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(seller))), "offerer topic");
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(MARKET_ZONE))), "zone topic");
            (bytes32 h) = abi.decode(logs[i].data, (bytes32));
            assertEq(h, orderHash, "order hash in data");
            found = true;
        }
        assertTrue(found, "OrderFulfilled with marker zone emitted");
    }

    // ---------------------------------------------------------------- DN404

    function _dn404Base() internal view returns (IDn404Base) {
        return IDn404Base(IDn404Mirror(SMOKE_MIRROR).baseERC20());
    }

    function test_Dn404_ListAndFill_TokensMoveWithNft() public {
        IDn404Base base = _dn404Base();
        uint256 id = 1;
        _giveToSeller(SMOKE_MIRROR, id);
        assertEq(base.balanceOf(seller), SMOKE_UNIT, "one unit of tokens came with the NFT");
        assertFalse(base.getSkipNFT(buyer), "fresh EOA receives NFTs");

        // Approval is on the MIRROR (the ERC-721 side).
        vm.prank(seller);
        IERC721Like(SMOKE_MIRROR).setApprovalForAll(address(SEAPORT), true);

        // DN404 mirrors have no ERC-2981.
        vm.expectRevert();
        IRoyaltyInfo(SMOKE_MIRROR).royaltyInfo(id, 1 ether);

        uint256 price = 0.01 ether;
        OrderComponents memory o = _listing(SMOKE_MIRROR, id, price, address(0), 0);
        uint256 sellerBefore = seller.balance;
        vm.recordLogs();
        _fill(o, price);

        assertEq(IERC721Like(SMOKE_MIRROR).ownerOf(id), buyer, "buyer owns the NFT");
        assertEq(base.balanceOf(buyer), SMOKE_UNIT, "buyer got the unit of tokens");
        assertEq(base.balanceOf(seller), 0, "seller's tokens left with the NFT");
        assertEq(seller.balance - sellerBefore, price, "seller got the full price");
        _assertZoneEmitted(SEAPORT.getOrderHash(o));
    }

    /// Seller lists, then sells the tokens behind the NFT: DN404 burns the
    /// NFT, ownerOf reverts (compile-service hides the listing on exactly
    /// this), and the signed order can no longer be filled.
    function test_Dn404_BurnInvalidatesListing() public {
        IDn404Base base = _dn404Base();
        uint256 id = 2;
        _giveToSeller(SMOKE_MIRROR, id);
        vm.prank(seller);
        IERC721Like(SMOKE_MIRROR).setApprovalForAll(address(SEAPORT), true);
        OrderComponents memory o = _listing(SMOKE_MIRROR, id, 0.01 ether, address(0), 0);
        Order memory ord = _order(o);

        // Seller moves 1 wei of tokens out: below one unit, so the NFT burns.
        vm.prank(seller);
        base.transfer(makeAddr("dex"), 1);
        vm.expectRevert();
        IERC721Like(SMOKE_MIRROR).ownerOf(id);

        vm.prank(buyer);
        vm.expectRevert();
        SEAPORT.fulfillOrder{value: 0.01 ether}(ord, bytes32(0));
        assertEq(base.balanceOf(buyer), 0, "buyer got nothing");
    }

    /// A buyer with skipNFT on still gets the NFT (and the unit of tokens):
    /// DN404 moves a specific NFT by id regardless of the recipient's flag.
    /// Measured 2026-10-19 on live $SMOKE; the buy button only explains the
    /// flag, it doesn't block. If this ever flips to a revert, block in the UI.
    function test_Dn404_BuyerWithSkipNftOn() public {
        IDn404Base base = _dn404Base();
        uint256 id = 3;
        _giveToSeller(SMOKE_MIRROR, id);
        vm.prank(seller);
        IERC721Like(SMOKE_MIRROR).setApprovalForAll(address(SEAPORT), true);
        vm.prank(buyer);
        base.setSkipNFT(true);
        assertTrue(base.getSkipNFT(buyer));

        OrderComponents memory o = _listing(SMOKE_MIRROR, id, 0.01 ether, address(0), 0);
        Order memory ord = _order(o);
        vm.prank(buyer);
        SEAPORT.fulfillOrder{value: 0.01 ether}(ord, bytes32(0));
        assertEq(IERC721Like(SMOKE_MIRROR).ownerOf(id), buyer, "skipNFT buyer still holds the NFT");
        assertEq(base.balanceOf(buyer), SMOKE_UNIT, "and the tokens");
    }

    // ---------------------------------------------------------------- royalty

    function test_Royalty_PaidToErc2981Receiver() public {
        address receiver = makeAddr("creatorRoyalty");
        RoyaltyNft nft = new RoyaltyNft(receiver, 500); // 5%
        nft.mint(seller, 9);
        vm.prank(seller);
        nft.setApprovalForAll(address(SEAPORT), true);

        uint256 price = 1 ether;
        // Same rule as compile-service: royalty item = royaltyInfo(id, total price).
        (address to, uint256 amt) = nft.royaltyInfo(9, price);
        assertEq(to, receiver);
        assertEq(amt, 0.05 ether);

        OrderComponents memory o = _listing(address(nft), 9, price, to, amt);
        uint256 sellerBefore = seller.balance;
        _fill(o, price);

        assertEq(nft.ownerOf(9), buyer);
        assertEq(receiver.balance, 0.05 ether, "creator got the royalty");
        assertEq(seller.balance - sellerBefore, 0.95 ether, "seller got price minus royalty");
    }

    // ---------------------------------------------------------------- cancels

    function test_CancelAndIncrementCounter_KillListings() public {
        _giveToSeller(GALLERY_SMOKE, 1);
        vm.prank(seller);
        IERC721Like(GALLERY_SMOKE).setApprovalForAll(address(SEAPORT), true);

        OrderComponents memory a = _listing(GALLERY_SMOKE, 1, 0.1 ether, address(0), 0);
        Order memory ordA = _order(a);
        OrderComponents[] memory cancels = new OrderComponents[](1);
        cancels[0] = a;
        vm.prank(seller);
        SEAPORT.cancel(cancels);
        (, bool cancelled,,) = SEAPORT.getOrderStatus(SEAPORT.getOrderHash(a));
        assertTrue(cancelled);
        vm.prank(buyer);
        vm.expectRevert();
        SEAPORT.fulfillOrder{value: 0.1 ether}(ordA, bytes32(0));

        OrderComponents memory b = _listing(GALLERY_SMOKE, 1, 0.2 ether, address(0), 0);
        Order memory ordB = _order(b);
        vm.prank(seller);
        SEAPORT.incrementCounter();
        // Seaport 1.6 bumps the counter by a large pseudo-random step, not +1.
        assertGt(SEAPORT.getCounter(seller), b.counter, "counter moved past the signed one");
        vm.prank(buyer);
        vm.expectRevert();
        SEAPORT.fulfillOrder{value: 0.2 ether}(ordB, bytes32(0));
        assertEq(IERC721Like(GALLERY_SMOKE).ownerOf(1), seller);
    }
}
