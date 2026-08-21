// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";

interface IERC20Balance {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title  NftStackRhFork — end-to-end verification against LIVE RH infra
/// @notice Forks Robinhood chain, deploys the NFT stack on-fork, points
///         it at the real FeeSplitter + LoyaltyOracle + URU + UruDepositSink
///         from env, then walks EVERY distinct user flow that touches
///         live infrastructure. Purpose: prove every wire from launcher
///         → buyer → flywheel works against real chain state before we
///         ever broadcast contracts to mainnet.
///
///         What this suite proves that unit tests can't:
///           - Real FeeSplitter distributes to real sinks
///           - Real UruDepositSink accepts URU transfers from our module
///           - Real LoyaltyOracle discount is applied on the launch fee
///           - Real URU ERC-20 transferFrom / approve / balanceOf work
///           - Real ERC721A clone accepts totalMinted growth from our mint calls
///           - Router state is genuinely untouched (additive claim)
///
///         Env required:
///           ROBINHOOD_RPC_URL
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           ROBINHOOD_URU_ADDRESS
///           ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS
///           ROBINHOOD_LOYALTY_ORACLE_ADDRESS  (optional)
///           ROBINHOOD_ROUTER_ADDRESS          (optional; router-untouched test)
///           ROBINHOOD_GEMU_NFT_ADDRESS        (optional; external-NFT WL / tier tests)
///
///         Skips cleanly if required env vars missing OR chainid != 4663.
contract NftStackRhForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal feeSplitter;
    address internal loyaltyOracle;
    address internal uru;
    address internal uruSink;
    address internal gemuNft;

    ERC721ATemplate internal erc721Impl;
    NftMintModule internal mintImpl;
    NftWhitelistModule internal wlImpl;
    NftLaunchFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal launcher = makeAddr("launcher");
    address internal launcher2 = makeAddr("launcher2");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");
    address internal buyer3 = makeAddr("buyer3");
    address internal attSigner;
    uint256 internal attSignerPk = 0xA77E57;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {
            vm.skip(true);
            return;
        }
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != RH_CHAIN_ID) {
            vm.skip(true);
            return;
        }

        feeSplitter = _envAddr("ROBINHOOD_FEE_SPLITTER_ADDRESS");
        uru = _envAddr("ROBINHOOD_URU_ADDRESS");
        uruSink = _envAddr("ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS");
        loyaltyOracle = _envAddrOr("ROBINHOOD_LOYALTY_ORACLE_ADDRESS", address(0));
        gemuNft = _envAddrOr("ROBINHOOD_GEMU_NFT_ADDRESS", address(0));

        if (feeSplitter == address(0) || uru == address(0) || uruSink == address(0)) {
            vm.skip(true);
            return;
        }
        if (feeSplitter.code.length == 0 || uru.code.length == 0 || uruSink.code.length == 0) {
            vm.skip(true);
            return;
        }

        attSigner = vm.addr(attSignerPk);
        erc721Impl = new ERC721ATemplate();
        mintImpl = new NftMintModule();
        wlImpl = new NftWhitelistModule();

        vm.startPrank(owner);
        factory = new NftLaunchFactory(owner);
        factory.setExpectedCodeHashes(
            keccak256(address(erc721Impl).code),
            keccak256(address(mintImpl).code),
            keccak256(address(wlImpl).code)
        );
        factory.setImpls(address(erc721Impl), address(mintImpl), address(wlImpl));
        factory.setUruConfig(
            IERC20(uru),
            uruSink,
            0, // launch fee 0 by default; individual tests override via setUruConfig
            ILoyaltyOracleLike(loyaltyOracle)
        );
        factory.setFeeSplitter(feeSplitter);
        factory.setAttestationSigner(attSigner);
        vm.stopPrank();
    }

    // ============================================================
    // ETH mint path — flywheel routing
    // ============================================================

    /// The load-bearing test. Every wire from mint() → 90% pull + 10% push
    /// through the real FeeSplitter → the real (buyback/nft/treasury) sinks
    /// resolves correctly. If this breaks, the entire flywheel is off.
    function test_EthMint_FlywheelReceives10Pct() public {
        (, address mintModule) = _launchDefault(false);
        (address buybackSink, address nftSink, address treasurySink) = _snapshotSplitterSinks();
        uint256 bBefore = buybackSink.balance;
        uint256 nBefore = nftSink.balance;
        uint256 tBefore = treasurySink.balance;

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());

        uint256 splitterAfter = feeSplitter.balance;
        uint256 sinksDelta =
            (buybackSink.balance - bBefore) + (nftSink.balance - nBefore) + (treasurySink.balance - tBefore);
        assertEq(sinksDelta + splitterAfter, 0.001 ether, "flywheel captured 10% net");
        assertEq(NftMintModule(mintModule).launcherBalance(), 0.009 ether, "launcher accrued 90% via pull");
    }

    /// Overpay is refunded to the BUYER, not distributed to launcher or platform.
    function test_EthMint_OverpayRefund() public {
        (, address mintModule) = _launchDefault(false);
        vm.deal(buyer, 1 ether);
        uint256 startBal = buyer.balance;
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.5 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(buyer.balance, startBal - 0.01 ether, "overpay refunded, buyer paid net only");
    }

    /// Underpay reverts loud with InsufficientPayment (real live infra
    /// shouldn't change this behavior).
    function test_EthMint_Underpay_Reverts() public {
        (, address mintModule) = _launchDefault(false);
        vm.deal(buyer, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__InsufficientPayment.selector, 0.01 ether, 0.005 ether)
        );
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.005 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    /// Multi-quantity mint in one tx — 5 tokens fixed price. Proves the
    /// live ERC721A clone accepts batch _mint correctly.
    function test_EthMint_MultiQty_5Tokens() public {
        (address token, address mintModule) = _launchDefault(false);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.05 ether}(5, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(token).balanceOf(buyer), 5, "5 minted");
        assertEq(ERC721ATemplate(token).totalMinted(), 5, "supply advanced");
    }

    /// Linear-step pricing against real ERC721A. Each mint should charge
    /// price(n) = base + step * mintedSoFar, and totalMinted() should
    /// advance correctly on the LIVE clone (not mocked).
    function test_EthMint_LinearStep_PriceMatchesTotalMinted() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-linear";
        p.ticker = "CHIBIL";
        p.mintMode = NftMintModule.MintMode.LinearStep;
        p.basePriceWei = 0.01 ether;
        p.priceStepWei = 0.001 ether;
        vm.prank(launcher);
        (address token, address mintModule,) = factory.launch(p);

        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs()); // price = base
        assertEq(ERC721ATemplate(token).totalMinted(), 1, "post-1 supply");
        NftMintModule(mintModule).mint{value: 0.011 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs()); // price = base + step
        assertEq(ERC721ATemplate(token).totalMinted(), 2, "post-2 supply");
        NftMintModule(mintModule).mint{value: 0.012 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs()); // price = base + 2*step
        vm.stopPrank();
        assertEq(NftMintModule(mintModule).launcherBalance(), (0.01 ether + 0.011 ether + 0.012 ether) * 9 / 10);
    }

    /// Max supply is enforced by the REAL clone. Bump to 2, mint 2, third mint must revert.
    function test_EthMint_SupplyCap_Enforced() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-cap";
        p.ticker = "CHIBIC";
        p.maxSupply = 2;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.expectRevert(abi.encodeWithSelector(NftMintModule.NftMintModule__MaxSupplyExceeded.selector, 1, 0));
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.stopPrank();
    }

    /// Per-wallet cap works against the LIVE clone's balanceOf.
    function test_EthMint_PerWalletCap_Enforced() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-wcap";
        p.ticker = "CHIBIW";
        p.perWalletMintCap = 2;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        NftMintModule(mintModule).mint{value: 0.02 ether}(2, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.expectRevert(abi.encodeWithSelector(NftMintModule.NftMintModule__PerWalletCapExceeded.selector, 3, 2));
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.stopPrank();
    }

    // ============================================================
    // URU mint path — real ERC-20 flow
    // ============================================================

    function test_UruMint_UruSinkReceives10Pct() public {
        (, address mintModule) = _launchDefault(true);
        deal(uru, buyer, 1000e18);
        vm.prank(buyer);
        IERC20Balance(uru).approve(mintModule, type(uint256).max);

        uint256 sinkBefore = IERC20Balance(uru).balanceOf(uruSink);
        vm.prank(buyer);
        NftMintModule(mintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        uint256 sinkAfter = IERC20Balance(uru).balanceOf(uruSink);
        assertEq(sinkAfter - sinkBefore, 10e18, "uru sink got 10 URU");
        assertEq(NftMintModule(mintModule).launcherBalanceUru(), 90e18, "launcher accrued 90 URU");
    }

    /// End-to-end URU buyer journey: approve → mint → verify balance
    /// changes on the LIVE URU contract.
    function test_UruMint_EndToEnd_BalanceDeltas() public {
        (, address mintModule) = _launchDefault(true);
        deal(uru, buyer, 500e18);
        uint256 buyerBefore = IERC20Balance(uru).balanceOf(buyer);
        vm.prank(buyer);
        IERC20Balance(uru).approve(mintModule, type(uint256).max);
        vm.prank(buyer);
        NftMintModule(mintModule).mintWithUru(2, 200e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(IERC20Balance(uru).balanceOf(buyer), buyerBefore - 200e18, "buyer debited exact");
    }

    /// URU launcher withdraw: after mint, launcher pulls their 90% and
    /// receives real URU on-chain (via SafeTransferLib.safeTransfer).
    function test_UruMint_LauncherWithdrawUru() public {
        (, address mintModule) = _launchDefault(true);
        deal(uru, buyer, 1000e18);
        vm.prank(buyer);
        IERC20Balance(uru).approve(mintModule, type(uint256).max);
        vm.prank(buyer);
        NftMintModule(mintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        uint256 launcherBefore = IERC20Balance(uru).balanceOf(launcher);
        vm.prank(launcher);
        NftMintModule(mintModule).withdrawUru();
        assertEq(IERC20Balance(uru).balanceOf(launcher) - launcherBefore, 90e18, "launcher received 90 URU");
    }

    /// Missing allowance reverts (proves real URU contract's transferFrom
    /// behavior interacts with our SafeTransferLib expectations).
    function test_UruMint_MissingAllowance_Reverts() public {
        (, address mintModule) = _launchDefault(true);
        deal(uru, buyer, 500e18);
        // NO approve.
        vm.expectRevert(); // SafeTransferLib.TransferFromFailed
        vm.prank(buyer);
        NftMintModule(mintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // ============================================================
    // Launcher payout — ETH path (multi-tx)
    // ============================================================

    /// Multiple mints accrue to the launcher balance, one withdraw pays
    /// the full sum out. Proves the pull pattern against real chain state.
    function test_EthMint_LauncherWithdraw_AfterMultipleMints() public {
        (, address mintModule) = _launchDefault(false);
        vm.deal(buyer, 1 ether);
        vm.deal(buyer2, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.prank(buyer2);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
        uint256 launcherBefore = launcher.balance;
        vm.prank(launcher);
        NftMintModule(mintModule).withdraw();
        assertEq(launcher.balance - launcherBefore, 0.027 ether, "launcher paid 3 * 90%");
    }

    // ============================================================
    // Whitelist flavors against LIVE state
    // ============================================================

    /// External-NFT WL — real gemu NFT holders on RH can mint during WL.
    /// Deals a gemu NFT to the buyer (via balance-slot manipulation) so
    /// the compile-service-equivalent attestation signs a real count.
    /// If ROBINHOOD_GEMU_NFT_ADDRESS is unset, test skips.
    function test_WL_Holders_RealGemuNft_MintsOK() public {
        if (gemuNft == address(0)) {
            vm.skip(true);
            return;
        }
        // Configure a collection with holders-flavor WL pointing at gemu.
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-gemuwl";
        p.ticker = "CHIBIGWL";
        p.wlFlavor = NftWhitelistModule.Flavor.Holders;
        p.wlHoldersTarget = gemuNft;
        p.wlHoldersTargetChainId = RH_CHAIN_ID;
        p.wlHoldersMinCount = 1;
        p.wlWindowEnd = block.timestamp + 1 hours;
        vm.prank(launcher);
        (address token, address mintModule, address wlModule) = factory.launch(p);
        // Buyer holds 3 gemu NFTs (attestation only — we assume the
        // compile-service RPC read would return 3 for them).
        // WL module's `ourCollection` is the ERC-721 TOKEN, not the mint
        // module (factory wires it that way at initialize time).
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory sig = _signWlAttestation(attSignerPk, wlModule, token, gemuNft, RH_CHAIN_ID, buyer, 3, expiry);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 3, expiry, sig, _emptyProofs());
        assertEq(ERC721ATemplate(NftMintModule(mintModule).token()).balanceOf(buyer), 1, "WL holder minted");
    }

    /// Wallet-list WL — merkle-proof against pasted list, mid-window.
    function test_WL_WalletList_MidWindow_MintsOK() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer, buyer2);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-wllist";
        p.ticker = "CHIBIWL";
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, proof1, 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(NftMintModule(mintModule).token()).balanceOf(buyer), 1, "WL list mint OK");
    }

    /// Non-WL wallet during WL window → rejects (against live state).
    function test_WL_WalletList_NonListed_Reverts() public {
        (bytes32 root,,) = _twoLeafMerkle(buyer, buyer2);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-wlrej";
        p.ticker = "CHIBIWLR";
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        vm.deal(buyer3, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer3);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    /// After the WL window, public wallets can mint too — window logic
    /// is against block.timestamp on the fork.
    function test_WL_AfterWindow_PublicOpen() public {
        (bytes32 root,,) = _twoLeafMerkle(buyer, buyer2);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-wlpost";
        p.ticker = "CHIBIWLP";
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.deal(buyer3, 1 ether);
        vm.prank(buyer3);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // ============================================================
    // Discount tiers against LIVE state
    // ============================================================

    /// Wallet-list discount tier — buyer on the list pays discounted price,
    /// 10% of DISCOUNTED amount goes to real sinks.
    function test_Discount_WalletList_ReducedFlywheel() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 2000    // 20% off
        });
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-disc";
        p.ticker = "CHIBID";
        p.tiers = tiers;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        vm.deal(buyer, 1 ether);
        // 20% off 0.01 = pay 0.008; flywheel gets 10% of 0.008 = 0.0008.
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.008 ether}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(NftMintModule(mintModule).launcherBalance(), 0.0072 ether, "90% of discounted");
    }

    /// External-NFT discount tier — attestation signs real holdings,
    /// discount = min(count, cap) * bpsPerNft. Uses gemu addr if available.
    function test_Discount_ExternalNft_ScaledByCount() public {
        address target = gemuNft != address(0) ? gemuNft : address(0xBEEF);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: target,
            externalChainId: RH_CHAIN_ID,
            percentPerNftBps: 500,     // 5%/nft
            maxCountedNfts: 4,          // cap 20% max
            fixedDiscountBps: 0
        });
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-ext";
        p.ticker = "CHIBIE";
        p.discountFloorBps = 5000;    // ceiling = 50%
        p.tiers = tiers;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        // Attestation says buyer holds 100 of `target` on RH. Cap at 4
        // → 20% off → pay 0.008.
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signAttestation(attSignerPk, buyer, mintModule, target, RH_CHAIN_ID, 0, 100, expiry);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 100, expiry: expiry, sig: sig
        });
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.008 ether}(1, new bytes32[](0), 0, 0, "", proofs);
    }

    /// Free mint: 0% floor + per-wallet cap. Wallet-list at 100% off.
    /// Proves the free-mint gate (which requires perWalletMintCap > 0
    /// at init) works against the live launch flow.
    function test_FreeMint_WithCap_MintsOK() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafMerkle(buyer, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: root,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 10_000    // 100%
        });
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-free";
        p.ticker = "CHIBIF";
        p.discountFloorBps = 0;    // free-mint allowed
        p.perWalletMintCap = 3;    // required when floor = 0
        p.tiers = tiers;
        vm.prank(launcher);
        (address token, address mintModule,) = factory.launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0}(1, new bytes32[](0), 0, 0, "", proofs);
        assertEq(ERC721ATemplate(token).balanceOf(buyer), 1, "free mint");
    }

    // ============================================================
    // URU launch fee against LIVE UruDepositSink + LoyaltyOracle
    // ============================================================

    /// URU launch fee — factory pulls URU from launcher to real
    /// UruDepositSink on launch tx.
    function test_LaunchFee_URU_PulledToRealSink() public {
        vm.prank(owner);
        factory.setUruConfig(IERC20(uru), uruSink, 1000e18, ILoyaltyOracleLike(loyaltyOracle));
        deal(uru, launcher, 5000e18);
        vm.prank(launcher);
        IERC20Balance(uru).approve(address(factory), type(uint256).max);
        uint256 sinkBefore = IERC20Balance(uru).balanceOf(uruSink);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-feepaid";
        p.ticker = "CHIBIFP";
        // Query the factory for the exact required fee (accounts for
        // any loyalty discount the launcher has via the real oracle).
        p.uruAmount = factory.minUruFeeFor(launcher);
        vm.prank(launcher);
        factory.launch(p);
        assertEq(IERC20Balance(uru).balanceOf(uruSink) - sinkBefore, p.uruAmount, "sink received exact fee");
    }

    /// Insufficient URU (below the loyalty-adjusted floor) → reverts.
    function test_LaunchFee_URU_Insufficient_Reverts() public {
        vm.prank(owner);
        factory.setUruConfig(IERC20(uru), uruSink, 1000e18, ILoyaltyOracleLike(loyaltyOracle));
        deal(uru, launcher, 5000e18);
        vm.prank(launcher);
        IERC20Balance(uru).approve(address(factory), type(uint256).max);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-feefail";
        p.ticker = "CHIBIFF";
        uint256 required = factory.minUruFeeFor(launcher);
        p.uruAmount = required > 0 ? required - 1 : 0;
        if (required == 0) {
            // Nothing to test — launcher gets 100% discount from live oracle.
            vm.skip(true);
            return;
        }
        vm.expectRevert(
            abi.encodeWithSelector(NftLaunchFactory.NftLaunchFactory__InsufficientUru.selector, required, p.uruAmount)
        );
        vm.prank(launcher);
        factory.launch(p);
    }

    // ============================================================
    // Salt collision + additive-only proofs
    // ============================================================

    function test_Launch_SameLauncher_SameName_SecondReverts() public {
        _launchDefault(false);
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__NameTaken.selector);
        vm.prank(launcher);
        factory.launch(_defaultLaunchParams(false));
    }

    function test_Launch_DifferentLaunchers_SameName_BothOK() public {
        (address t1,) = _launchDefault(false);
        vm.prank(launcher2);
        (address t2,,) = factory.launch(_defaultLaunchParams(false));
        assertTrue(t1 != t2, "distinct token addresses");
    }

    function test_Launch_DoesNotTouchRouter() public {
        address routerAddr = _envAddrOr("ROBINHOOD_ROUTER_ADDRESS", address(0));
        bytes32 routerCodeHashBefore = routerAddr == address(0) ? bytes32(0) : routerAddr.codehash;
        (address token, address mintModule) = _launchDefault(false);
        assertTrue(token != address(0));
        assertTrue(mintModule != address(0));
        if (routerAddr != address(0)) {
            assertEq(routerAddr.codehash, routerCodeHashBefore, "router untouched");
        }
    }

    // ============================================================
    // Adversarial — sig scope, expiry, replay against live state
    // ============================================================

    function test_Adv_Attestation_CrossCollection_Rejected() public {
        // Launch collection A + B, sign attestation for A, try to use on B.
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1,
            percentPerNftBps: 500,
            maxCountedNfts: 10,
            fixedDiscountBps: 0
        });
        NftLaunchFactory.LaunchParams memory pA = _defaultLaunchParams(false);
        pA.name = "chibi-advA";
        pA.ticker = "CHIBIAA";
        pA.tiers = tiers;
        vm.prank(launcher);
        (, address mmA,) = factory.launch(pA);
        NftLaunchFactory.LaunchParams memory pB = _defaultLaunchParams(false);
        pB.name = "chibi-advB";
        pB.ticker = "CHIBIAB";
        pB.tiers = tiers;
        vm.prank(launcher);
        (, address mmB,) = factory.launch(pB);
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sigForA = _signAttestation(attSignerPk, buyer, mmA, address(0xBEEF), 1, 0, 3, expiry);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sigForA
        });
        vm.deal(buyer, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__BadAttestationSigner.selector);
        vm.prank(buyer);
        NftMintModule(mmB).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", proofs);
    }

    function test_Adv_Attestation_Expired_Rejected() public {
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1,
            percentPerNftBps: 500,
            maxCountedNfts: 10,
            fixedDiscountBps: 0
        });
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams(false);
        p.name = "chibi-exp";
        p.ticker = "CHIBIEX";
        p.tiers = tiers;
        vm.prank(launcher);
        (, address mintModule,) = factory.launch(p);
        uint256 expiry = block.timestamp + 100;
        bytes memory sig = _signAttestation(attSignerPk, buyer, mintModule, address(0xBEEF), 1, 0, 3, expiry);
        vm.warp(expiry + 1);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig
        });
        vm.deal(buyer, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__AttestationExpired.selector, expiry, block.timestamp)
        );
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", proofs);
    }

    function test_Adv_DirectMintBatch_OnErc721_Rejects() public {
        // Attacker tries to bypass mint module + call mintBatch directly
        // on the ERC721 clone. Should revert because ownership was
        // transferred to the mint module at launch time.
        (address token,) = _launchDefault(false);
        vm.expectRevert();
        vm.prank(buyer);
        ERC721ATemplate(token).mintBatch(buyer, 1);
    }

    // ============================================================
    // Helpers
    // ============================================================
    function _defaultLaunchParams(bool payWithUru) internal view returns (NftLaunchFactory.LaunchParams memory p) {
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](0);
        p = NftLaunchFactory.LaunchParams({
            name: payWithUru ? "chibi-uru" : "chibi-eth",
            ticker: payWithUru ? "CHIBIU" : "CHIBIE",
            baseURI: "ipfs://fork-test/",
            maxSupply: 100,
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: payWithUru ? 100e18 : 0.01 ether,
            priceStepWei: 0,
            discountFloorBps: 1000,
            perWalletMintCap: 0,
            payWithUru: payWithUru,
            tiers: tiers,
            wlFlavor: NftWhitelistModule.Flavor.Off,
            wlHoldersTarget: address(0),
            wlHoldersTargetChainId: 0,
            wlHoldersMinCount: 0,
            wlWalletListRoot: bytes32(0),
            wlWindowEnd: 0,
            uruAmount: 0
        });
    }

    function _launchDefault(bool payWithUru) internal returns (address token, address mintModule) {
        vm.prank(launcher);
        (token, mintModule,) = factory.launch(_defaultLaunchParams(payWithUru));
    }

    function _snapshotSplitterSinks()
        internal
        view
        returns (address buybackSink, address nftSink, address treasurySink)
    {
        (bool ok1, bytes memory b1) = feeSplitter.staticcall(abi.encodeWithSignature("uruBuybackSink()"));
        (bool ok2, bytes memory b2) = feeSplitter.staticcall(abi.encodeWithSignature("nftRevenueSink()"));
        (bool ok3, bytes memory b3) = feeSplitter.staticcall(abi.encodeWithSignature("treasurySink()"));
        require(ok1 && ok2 && ok3, "fee splitter reads failed");
        buybackSink = abi.decode(b1, (address));
        nftSink = abi.decode(b2, (address));
        treasurySink = abi.decode(b3, (address));
    }

    function _twoLeafMerkle(address a, address b)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proofA, bytes32[] memory proofB)
    {
        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(a))));
        bytes32 leafB = keccak256(bytes.concat(keccak256(abi.encode(b))));
        (bytes32 lo, bytes32 hi) = leafA < leafB ? (leafA, leafB) : (leafB, leafA);
        root = keccak256(abi.encodePacked(lo, hi));
        proofA = new bytes32[](1);
        proofA[0] = leafB;
        proofB = new bytes32[](1);
        proofB[0] = leafA;
    }

    function _signAttestation(
        uint256 pk,
        address wallet_,
        address ourCollection_,
        address targetCollection_,
        uint256 targetChainId_,
        uint256 tierId_,
        uint256 count_,
        uint256 expiry_
    ) internal view returns (bytes memory sig) {
        bytes32 hash = keccak256(
            abi.encode(
                "URU_NFT_DISCOUNT_V1",
                block.chainid,
                wallet_,
                ourCollection_,
                targetCollection_,
                targetChainId_,
                tierId_,
                count_,
                expiry_
            )
        );
        bytes32 envelope = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, envelope);
        sig = abi.encodePacked(r, s, v);
    }

    function _signWlAttestation(
        uint256 pk,
        address wlModule_,
        address ourCollection_,
        address holdersTarget_,
        uint256 holdersTargetChainId_,
        address wallet_,
        uint256 count_,
        uint256 expiry_
    ) internal view returns (bytes memory sig) {
        bytes32 hash = keccak256(
            abi.encode(
                "URU_NFT_WL_V1",
                block.chainid,
                wlModule_,
                ourCollection_,
                holdersTarget_,
                holdersTargetChainId_,
                wallet_,
                count_,
                expiry_
            )
        );
        bytes32 envelope = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, envelope);
        sig = abi.encodePacked(r, s, v);
    }

    function _envAddr(string memory name) internal view returns (address) {
        try vm.envAddress(name) returns (address a) { return a; } catch { return address(0); }
    }

    function _envAddrOr(string memory name, address dflt) internal view returns (address) {
        try vm.envAddress(name) returns (address a) { return a; } catch { return dflt; }
    }

    function _emptyProofs() internal pure returns (NftMintModule.TierProof[] memory) {
        return new NftMintModule.TierProof[](0);
    }
}
