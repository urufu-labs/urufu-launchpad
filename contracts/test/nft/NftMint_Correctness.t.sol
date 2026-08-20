// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NftHarness} from "./NftHarness.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory} from "src/nft/NftLaunchFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";

/// @title  NftMint_Correctness
/// @notice Happy-path + boundary tests for NftMintModule + NftLaunchFactory.
///         Every function has a positive-case test and (where relevant) a
///         boundary/edge test. Adversarial tests live in NftMint_Security.
contract NftMint_Correctness is NftHarness {
    function setUp() public {
        _setupBase();
    }

    // --------------------------------------------------------------
    // Fixed-price mint
    // --------------------------------------------------------------

    function test_Mint_FixedPrice_Exact() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1, "balance");
    }

    function test_Mint_FixedPrice_Overpay_Refunds() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        uint256 startBal = buyer1.balance;
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.05 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        // Paid 0.01, sent 0.05, expected refund of 0.04.
        assertEq(buyer1.balance, startBal - 0.01 ether, "overpay refunded");
    }

    function test_Mint_FixedPrice_Underpay_Reverts() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__InsufficientPayment.selector, 0.01 ether, 0.005 ether)
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.005 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // --------------------------------------------------------------
    // Linear-step pricing
    // --------------------------------------------------------------

    function test_Mint_LinearStep_PriceMonoIncreases() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.mintMode = NftMintModule.MintMode.LinearStep;
        p.basePriceWei = 0.01 ether;
        p.priceStepWei = 0.001 ether;
        _launch(p);
        NftMintModule mm = NftMintModule(deployedMintModule);
        // First mint: 0.01 (base + step*0)
        // Second mint: 0.011 (base + step*1)
        // Third mint: 0.012 (base + step*2)
        assertEq(mm.grossPriceFor(1), 0.01 ether, "first mint = base");
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(mm.grossPriceFor(1), 0.011 ether, "second mint = base+step");
        vm.prank(buyer1);
        mm.mint{value: 0.011 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(mm.grossPriceFor(1), 0.012 ether, "third mint = base+2*step");
    }

    function test_Mint_LinearStep_MultiQtyBoundary() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.mintMode = NftMintModule.MintMode.LinearStep;
        p.basePriceWei = 0.01 ether;
        p.priceStepWei = 0.001 ether;
        _launch(p);
        NftMintModule mm = NftMintModule(deployedMintModule);
        // Buy 5 at once from minted=0. Sum of ids 0..4 = 0+1+2+3+4 = 10.
        // Total = 5*0.01 + 0.001 * 10 = 0.05 + 0.01 = 0.06.
        assertEq(mm.grossPriceFor(5), 0.06 ether, "5-mint sum");
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        mm.mint{value: 0.06 ether}(5, new bytes32[](0), 0, 0, "", _emptyProofs());
        // After 5 mints, next single mint is price(5) = 0.01 + 0.005 = 0.015.
        assertEq(mm.grossPriceFor(1), 0.015 ether, "post-batch next-mint price");
    }

    // --------------------------------------------------------------
    // Supply cap
    // --------------------------------------------------------------

    function test_Mint_MaxSupply_LastOk_NextReverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.maxSupply = 2;
        _launch(p);
        NftMintModule mm = NftMintModule(deployedMintModule);
        vm.deal(buyer1, 1 ether);
        vm.startPrank(buyer1);
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.expectRevert(abi.encodeWithSelector(NftMintModule.NftMintModule__MaxSupplyExceeded.selector, 1, 0));
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.stopPrank();
    }

    function test_Mint_QtyZero_Reverts() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__ZeroQuantity.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0}(0, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // --------------------------------------------------------------
    // Revenue split
    // --------------------------------------------------------------

    function test_Mint_Split_90Launcher_10Platform() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        NftMintModule mm = NftMintModule(deployedMintModule);
        assertEq(mm.launcherBalance(), 0.009 ether, "launcher accrues 90%");
        // FeeSplitter distributes on receive → to sinks. Total received = 0.001.
        assertEq(address(feeSplitter).balance, 0, "splitter passes through");
        // Sum of sinks = 0.001 (assuming no stuck balance).
        assertEq(
            address(buybackSink).balance + address(nftSink).balance + address(treasury).balance,
            0.001 ether,
            "platform slice = 10%"
        );
    }

    function test_Mint_LauncherWithdraw() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        uint256 startBal = launcher.balance;
        vm.prank(launcher);
        uint256 out = NftMintModule(deployedMintModule).withdraw();
        assertEq(out, 0.009 ether, "returned amount");
        assertEq(launcher.balance - startBal, 0.009 ether, "launcher received");
        assertEq(NftMintModule(deployedMintModule).launcherBalance(), 0, "balance zeroed");
    }

    function test_Mint_LauncherWithdraw_ZeroBalance_Reverts() public {
        _launch(_defaultLaunchParams());
        vm.expectRevert(NftMintModule.NftMintModule__NoBalance.selector);
        vm.prank(launcher);
        NftMintModule(deployedMintModule).withdraw();
    }

    function test_Mint_MultipleMints_LauncherBalanceAccumulates() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.startPrank(buyer1);
        NftMintModule mm = NftMintModule(deployedMintModule);
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.stopPrank();
        assertEq(mm.launcherBalance(), 0.027 ether, "3 mints x 0.009 accrue");
    }

    // --------------------------------------------------------------
    // Per-wallet cap
    // --------------------------------------------------------------

    function test_Mint_PerWalletCap_Enforced() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.perWalletMintCap = 2;
        _launch(p);
        NftMintModule mm = NftMintModule(deployedMintModule);
        vm.deal(buyer1, 1 ether);
        vm.startPrank(buyer1);
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.expectRevert(abi.encodeWithSelector(NftMintModule.NftMintModule__PerWalletCapExceeded.selector, 3, 2));
        mm.mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.stopPrank();
    }

    function test_Mint_FreeMint_WithCap_Works() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 0; // 100% discounts allowed
        p.perWalletMintCap = 3;
        p.basePriceWei = 0.01 ether;
        // Wallet-list tier with 100% discount.
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer1, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 10_000 // 100% off
        });
        p.tiers = tiers;
        _launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1, "free mint OK");
    }

    // --------------------------------------------------------------
    // Discount tiers
    // --------------------------------------------------------------

    function test_Mint_WalletList_Tier_AppliesDiscount() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer1, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 2000 // 20% off
        });
        p.tiers = tiers;
        _launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        vm.deal(buyer1, 1 ether);
        // 20% off 0.01 = pay 0.008
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1, "minted");
    }

    function test_Mint_ExternalNft_Tier_AppliesDiscount() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        // 5% off per NFT held, up to 10 → 50% max discount for owning 10.
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1, // ETH mainnet
            percentPerNftBps: 500, // 5%/nft
            maxCountedNfts: 10,
            fixedDiscountBps: 0
        });
        p.tiers = tiers;
        _launch(p);
        // Attestation: buyer1 holds 3 NFTs on chain 1.
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signAttestation(attSignerPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 3, expiry);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] =
            NftMintModule.TierProof({tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig});
        // 3 * 5% = 15% off. Base 0.01 → pay 0.0085.
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.0085 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    function test_Mint_ExternalNft_CountCap_Applied() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 5000; // ceiling = 50% (so cap tests are visible)
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1,
            percentPerNftBps: 500, // 5%/nft
            maxCountedNfts: 4, // cap at 4 → max discount 20%
            fixedDiscountBps: 0
        });
        p.tiers = tiers;
        _launch(p);
        // Attestation says buyer1 holds 100 NFTs → but cap counts only 4 → 20% off.
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signAttestation(attSignerPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 100, expiry);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] =
            NftMintModule.TierProof({tierId: 0, merkleProof: new bytes32[](0), count: 100, expiry: expiry, sig: sig});
        // 20% off 0.01 = 0.008. Any less should revert.
        vm.deal(buyer1, 1 ether);
        vm.expectRevert();
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.0079 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    function test_Mint_StackedTiers_ClampedAtCeiling() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 5000; // ceiling = 50%
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer1, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](2);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 4000 // 40%
        });
        tiers[1] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 4000 // another 40% → 80% raw
        });
        p.tiers = tiers;
        _launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](2);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        proofs[1] = NftMintModule.TierProof({tierId: 1, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        // Raw 80% but ceiling 50% → pay 50% of 0.01 = 0.005.
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.005 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    // --------------------------------------------------------------
    // Whitelist flavors
    // --------------------------------------------------------------

    function test_WL_Off_Everyone_CanMint() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.deal(buyer2, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.prank(buyer2);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer2), 1);
    }

    function test_WL_WalletList_ValidProof_MintOk() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer1, buyer2);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, proof1, 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    function test_WL_WalletList_NoProof_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 root,,) = _twoLeafMerkle(buyer1, buyer2);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        vm.deal(buyer3, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer3);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    function test_WL_Holders_ValidAttestation_MintOk() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.wlFlavor = NftWhitelistModule.Flavor.Holders;
        p.wlHoldersTarget = address(0xDEAD);
        p.wlHoldersTargetChainId = 1;
        p.wlHoldersMinCount = 1;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory sig =
            _signWlAttestation(attSignerPk, deployedWl, deployedToken, address(0xDEAD), 1, buyer1, 5, expiry);
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 5, expiry, sig, _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    function test_WL_Holders_ExpiredAttestation_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.wlFlavor = NftWhitelistModule.Flavor.Holders;
        p.wlHoldersTarget = address(0xDEAD);
        p.wlHoldersTargetChainId = 1;
        p.wlHoldersMinCount = 1;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory sig =
            _signWlAttestation(attSignerPk, deployedWl, deployedToken, address(0xDEAD), 1, buyer1, 5, expiry);
        // Warp past expiry
        vm.warp(expiry + 1);
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 5, expiry, sig, _emptyProofs());
    }

    function test_WL_AfterWindow_Bypass_Public() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 root,,) = _twoLeafMerkle(buyer1, buyer2);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        // Warp past window
        vm.warp(block.timestamp + 1 hours + 1);
        // buyer3 is NOT on WL but should still mint after window
        vm.deal(buyer3, 1 ether);
        vm.prank(buyer3);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer3), 1);
    }

    // --------------------------------------------------------------
    // Views
    // --------------------------------------------------------------

    function test_View_GrossPriceFor_Fixed() public {
        _launch(_defaultLaunchParams());
        assertEq(NftMintModule(deployedMintModule).grossPriceFor(0), 0);
        assertEq(NftMintModule(deployedMintModule).grossPriceFor(1), 0.01 ether);
        assertEq(NftMintModule(deployedMintModule).grossPriceFor(5), 0.05 ether);
    }

    function test_View_DiscountCeiling_TracksFloor() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 2500;
        _launch(p);
        assertEq(NftMintModule(deployedMintModule).discountCeilingBps(), 7500);
    }

    // --------------------------------------------------------------
    // baseURI + tokenURI (via ERC721A)
    // --------------------------------------------------------------

    function test_Mint_TokenURI_BaseURIPlusId() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        // ERC721A starts token IDs at 0
        string memory uri = ERC721ATemplate(deployedToken).tokenURI(0);
        assertEq(uri, "ipfs://cid/0", "baseURI + tokenId");
    }

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------
    function _emptyProofs() internal pure returns (NftMintModule.TierProof[] memory) {
        return new NftMintModule.TierProof[](0);
    }
}
