// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NftHarness} from "./NftHarness.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory} from "src/nft/NftLaunchFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";

/// @title  NftMint_UruPayment
/// @notice URU-priced mint path tests. Confirms:
///           - deployer picks payWithUru at launch
///           - buyer pays URU via safeTransferFrom (not msg.value)
///           - 90/10 split routes URU to launcher + UruDepositSink
///           - ETH `mint()` reverts on URU-mode collections
///           - URU `mintWithUru()` reverts on ETH-mode collections
///           - discount + WL flows work identically to ETH path
contract NftMint_UruPayment is NftHarness {
    function setUp() public {
        _setupBase();
    }

    function _uruLaunch() internal returns (NftLaunchFactory.LaunchParams memory p) {
        p = _defaultLaunchParams();
        p.payWithUru = true;
        p.basePriceWei = 100e18; // 100 URU per mint
    }

    // --------------------------------------------------------------
    // Happy path
    // --------------------------------------------------------------

    function test_UruMint_HappyPath() public {
        _launch(_uruLaunch());
        // Fund buyer with URU, approve mint module.
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        // Mint 1 at 100 URU.
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
        assertEq(uru.balanceOf(buyer1), 900e18, "buyer debited exact");
    }

    function test_UruMint_Split_90Launcher_10Sink() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        NftMintModule mm = NftMintModule(deployedMintModule);
        assertEq(mm.launcherBalanceUru(), 90e18, "launcher 90% URU");
        assertEq(uru.balanceOf(address(uruSink)), 10e18, "sink 10% URU");
    }

    function test_UruMint_WithdrawUru_PaysLauncher() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        uint256 launcherStart = uru.balanceOf(launcher);
        vm.prank(launcher);
        NftMintModule(deployedMintModule).withdrawUru();
        assertEq(uru.balanceOf(launcher) - launcherStart, 90e18);
    }

    // --------------------------------------------------------------
    // Exact-pay enforcement (URU path can't refund excess)
    // --------------------------------------------------------------

    function test_UruMint_Overpay_Reverts() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__InsufficientPayment.selector, 100e18, 101e18)
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 101e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    function test_UruMint_Underpay_Reverts() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__InsufficientPayment.selector, 100e18, 99e18)
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 99e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    function test_UruMint_MissingAllowance_Reverts() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        // No approve.
        vm.expectRevert(); // SafeTransferLib TransferFromFailed
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // --------------------------------------------------------------
    // Cross-mode gates
    // --------------------------------------------------------------

    function test_EthMint_On_UruCollection_Reverts() public {
        _launch(_uruLaunch());
        // Deal enough ETH that the send itself doesn't hit "insufficient
        // funds" before my check fires.
        vm.deal(buyer1, 200e18);
        vm.expectRevert(NftMintModule.NftMintModule__EthNotConfigured.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 100e18}(1, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    function test_UruMint_On_EthCollection_Reverts() public {
        _launch(_defaultLaunchParams()); // ETH-priced
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.expectRevert(NftMintModule.NftMintModule__UruNotConfigured.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // --------------------------------------------------------------
    // WL + discount still work on URU path (spot-check parity)
    // --------------------------------------------------------------

    function test_UruMint_WithWalletListDiscount() public {
        NftLaunchFactory.LaunchParams memory p = _uruLaunch();
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
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""});
        // 20% off 100 URU = 80 URU.
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 80e18, new bytes32[](0), 0, 0, "", proofs);
        assertEq(NftMintModule(deployedMintModule).launcherBalanceUru(), 72e18, "90% of 80");
    }

    function test_UruMint_WithWLGate_NonListed_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _uruLaunch();
        (bytes32 root,,) = _twoLeafMerkle(buyer1, buyer2);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        uru.mint(buyer3, 1000e18);
        vm.prank(buyer3);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer3);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
    }

    // --------------------------------------------------------------
    // Balance isolation — URU-mode collection has zero ETH accounting.
    // --------------------------------------------------------------

    function test_UruMint_LauncherEthBalance_Untouched() public {
        _launch(_uruLaunch());
        uru.mint(buyer1, 1000e18);
        vm.prank(buyer1);
        uru.approve(deployedMintModule, type(uint256).max);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());
        assertEq(NftMintModule(deployedMintModule).launcherBalance(), 0, "no ETH accrual");
        // ETH withdraw reverts (no balance).
        vm.expectRevert(NftMintModule.NftMintModule__NoBalance.selector);
        NftMintModule(deployedMintModule).withdraw();
    }

    // --------------------------------------------------------------
    // Config-time init errors
    // --------------------------------------------------------------

    function test_UruLaunch_MissingUruSink_Reverts_Elsewhere() public {
        // Factory always sets uruDepositSink from its own state when
        // payWithUru is true. If factory's uruSink is zero'd out
        // (impossible normally, but simulate via test-only path) the
        // mint module init reverts. We can't easily null uruSink on
        // the factory (setUruConfig requires non-zero) so this is a
        // guard-behavior test at the module level via direct init.
        NftMintModule stray = new NftMintModule();
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](0);
        NftMintModule.InitParams memory ip = NftMintModule.InitParams({
            token: address(1),
            launcher: address(2),
            feeSplitter: address(0),
            attestationSigner: address(3),
            whitelistModule: address(0),
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: 100e18,
            priceStepWei: 0,
            discountFloorBps: 1000,
            perWalletMintCap: 0,
            tiers: tiers,
            paymentToken: address(uru),
            uruDepositSink: address(0)
        });
        vm.expectRevert(NftMintModule.NftMintModule__ZeroSink.selector);
        stray.initialize(abi.encode(ip));
    }

    // --------------------------------------------------------------
    // helpers
    // --------------------------------------------------------------
    function _emptyProofs() internal pure returns (NftMintModule.TierProof[] memory) {
        return new NftMintModule.TierProof[](0);
    }
}
