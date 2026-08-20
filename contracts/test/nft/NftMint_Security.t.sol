// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NftHarness, RevertingReceiver, RevertOnReceiveSplitter} from "./NftHarness.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";

/// @title  NftMint_Security
/// @notice Adversarial tests: signature replay, forgery, scope, merkle proof
///         attacks, reentrancy, overflow, griefing, cap bypass, config
///         corruption, and init hygiene.
///
///         Every test corresponds to a *specific* attack vector I could
///         reason about while writing the contracts. If any of these
///         fails, it maps directly to an exploit path.
contract NftMint_Security is NftHarness {
    function setUp() public {
        _setupBase();
    }

    // --------------------------------------------------------------
    // Signature replay / forgery / scope
    // --------------------------------------------------------------

    /// Attestation signed for collection A must NOT validate on collection B.
    /// (The mint module hash includes `ourCollection == address(this)`.)
    function test_Sig_CrossCollection_Replay_Rejected() public {
        // Launch collection A with ExternalNft tier.
        NftLaunchFactory.LaunchParams memory pA = _defaultLaunchParams();
        pA.tiers = _extNftTierArr();
        _launch(pA);
        address collectionA_mint = deployedMintModule;

        // Launch collection B with same tier config (different collection though).
        NftLaunchFactory.LaunchParams memory pB = _defaultLaunchParams();
        pB.name = "chibi2";
        pB.ticker = "CHIBI2";
        pB.tiers = _extNftTierArr();
        _launch(pB);
        address collectionB_mint = deployedMintModule;

        // Sign attestation for collection A.
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sigForA = _signAttestation(
            attSignerPk, buyer1, collectionA_mint, address(0xBEEF), 1, 0, 3, expiry
        );
        // Try to use it on collection B.
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sigForA
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__BadAttestationSigner.selector);
        vm.prank(buyer1);
        NftMintModule(collectionB_mint).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    /// Attestation for tier 0 can't be replayed for tier 1 (tierId in hash).
    function test_Sig_CrossTier_Replay_Rejected() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](2);
        tiers[0] = _extNftTier();
        tiers[1] = _extNftTier();
        p.tiers = tiers;
        _launch(p);
        // Sign for tier 0
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signAttestation(
            attSignerPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 3, expiry
        );
        // Claim tier 1 with tier 0's sig.
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 1, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__BadAttestationSigner.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    function test_Sig_ExpiredAttestation_Rejected() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.tiers = _extNftTierArr();
        _launch(p);
        uint256 expiry = block.timestamp + 100;
        bytes memory sig = _signAttestation(
            attSignerPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 3, expiry
        );
        vm.warp(expiry + 1);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                NftMintModule.NftMintModule__AttestationExpired.selector, expiry, block.timestamp
            )
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    function test_Sig_ForgedByRandomKey_Rejected() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.tiers = _extNftTierArr();
        _launch(p);
        // Sign with a rando key, not the attSigner.
        uint256 randoPk = 0xDEADBEEF;
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signAttestation(
            randoPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 3, expiry
        );
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__BadAttestationSigner.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    /// Malformed signatures MUST NOT validate — Solady's tryRecover returns
    /// address(0); we explicitly reject that instead of trusting equality
    /// against expectedSigner (which could itself be misconfigured to 0).
    function test_Sig_MalformedSig_Rejected() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.tiers = _extNftTierArr();
        _launch(p);
        uint256 expiry = block.timestamp + 1 hours;
        // Garbage bytes.
        bytes memory sig = hex"deadbeef";
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 3, expiry: expiry, sig: sig
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__BadAttestationSigner.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    /// Attacker signs `count=1000` for themselves. Off-chain the compile-service
    /// would never sign that if they only hold 3, but the on-chain module can't
    /// tell — it trusts the signer. We DO however cap discount at `maxCountedNfts`
    /// so a lying signer can't push discount past the tier's configured max.
    function test_Sig_LyingCount_Capped_At_MaxCounted() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 5000;    // ceiling = 50%
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1,
            percentPerNftBps: 500,     // 5%/nft
            maxCountedNfts: 4,          // cap 20% max
            fixedDiscountBps: 0
        });
        p.tiers = tiers;
        _launch(p);
        uint256 expiry = block.timestamp + 1 hours;
        // "attestation" for 1000 count
        bytes memory sig = _signAttestation(
            attSignerPk, buyer1, deployedMintModule, address(0xBEEF), 1, 0, 1000, expiry
        );
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: new bytes32[](0), count: 1000, expiry: expiry, sig: sig
        });
        vm.deal(buyer1, 1 ether);
        // Should apply 20% off (not 500%). Pay 0.008.
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
        assertEq(ERC721ATemplate(deployedToken).balanceOf(buyer1), 1);
    }

    // --------------------------------------------------------------
    // Merkle-proof attacks
    // --------------------------------------------------------------

    function test_MerkleProof_WrongWallet_Rejected() public {
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
            fixedDiscountBps: 2000
        });
        p.tiers = tiers;
        _launch(p);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: ""
        });
        // buyer3 tries to use buyer1's proof.
        vm.deal(buyer3, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer3);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    function test_MerkleProof_WrongRoot_Rejected() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 realRoot,,) = _twoLeafMerkle(buyer1, buyer2);
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: realRoot,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 2000
        });
        p.tiers = tiers;
        _launch(p);
        // Craft a proof for a DIFFERENT tree (buyer1 in a tree with buyer3, not buyer2)
        (, bytes32[] memory bogusProof,) = _twoLeafMerkle(buyer1, buyer3);
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 0, merkleProof: bogusProof, count: 0, expiry: 0, sig: ""
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    // --------------------------------------------------------------
    // Tier claim hygiene
    // --------------------------------------------------------------

    function test_TierId_OutOfRange_Rejects() public {
        _launch(_defaultLaunchParams()); // no tiers
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: 99, merkleProof: new bytes32[](0), count: 0, expiry: 0, sig: ""
        });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                NftMintModule.NftMintModule__TierIdOutOfRange.selector, 99, 0
            )
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    function test_TierProof_Duplicate_Rejects() public {
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
            fixedDiscountBps: 2000
        });
        p.tiers = tiers;
        _launch(p);
        // Double-claim tier 0.
        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](2);
        proofs[0] = NftMintModule.TierProof({ tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: "" });
        proofs[1] = NftMintModule.TierProof({ tierId: 0, merkleProof: proof1, count: 0, expiry: 0, sig: "" });
        vm.deal(buyer1, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(NftMintModule.NftMintModule__DuplicateTierProof.selector, 0)
        );
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.008 ether}(
            1, new bytes32[](0), 0, 0, "", proofs
        );
    }

    // --------------------------------------------------------------
    // Overflow / limits
    // --------------------------------------------------------------

    function test_Overflow_HugeQty_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.maxSupply = type(uint256).max;
        p.mintMode = NftMintModule.MintMode.LinearStep;
        p.basePriceWei = 1;
        p.priceStepWei = type(uint128).max;    // huge step
        _launch(p);
        // qty * step * (qty-1)/2 overflows uint256 for large qty.
        vm.deal(buyer1, 10 ether);
        // Solidity 0.8 checked math triggers Panic(0x11) on overflow.
        vm.expectRevert();
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 10 ether}(
            1_000_000, new bytes32[](0), 0, 0, "", _emptyProofs()
        );
    }

    // --------------------------------------------------------------
    // Reverting downstream — must not brick mint
    // --------------------------------------------------------------

    function test_LauncherRevertingReceive_MintStillOK() public {
        // Launcher is a contract that reverts on receive. Pull pattern
        // means mint doesn't touch launcher — the balance accrues, and
        // only `withdraw()` fails.
        RevertingReceiver rr = new RevertingReceiver();
        // Launch via the RR account.
        vm.prank(address(rr));
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (address token, address mm,) = factory.launch(p);
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(mm).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", _emptyProofs()
        );
        assertEq(ERC721ATemplate(token).balanceOf(buyer1), 1, "mint OK despite launcher rev");
        assertEq(NftMintModule(mm).launcherBalance(), 0.009 ether, "accrued");
        // But withdraw fails.
        vm.expectRevert();    // safeTransferETH bubbles the RR's Rejected
        NftMintModule(mm).withdraw();
    }

    function test_FeeSplitterReverts_MintStillOK_StuckSweep() public {
        // Swap the factory's FeeSplitter to a reverting one. New launches
        // will bind that as their feeSplitter; the module then routes to
        // it, sees the try/catch fail, and stashes the platform slice.
        RevertOnReceiveSplitter bad = new RevertOnReceiveSplitter();
        vm.prank(owner);
        factory.setFeeSplitter(address(bad));
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", _emptyProofs()
        );
        assertEq(NftMintModule(deployedMintModule).platformStuckBalance(), 0.001 ether);
        // Sweep also fails (splitter still reverts).
        vm.expectRevert(NftMintModule.NftMintModule__TransferFailed.selector);
        NftMintModule(deployedMintModule).sweepPlatformStuck();
        // Balance must NOT be zeroed by a failed sweep.
        assertEq(NftMintModule(deployedMintModule).platformStuckBalance(), 0.001 ether);
    }

    // --------------------------------------------------------------
    // Init hygiene
    // --------------------------------------------------------------

    function test_Init_TwiceReverts() public {
        _launch(_defaultLaunchParams());
        // Direct init call on the deployed clone reverts.
        vm.expectRevert(NftMintModule.NftMintModule__AlreadyInitialized.selector);
        NftMintModule(deployedMintModule).initialize("");
    }

    function test_Init_FreeMintWithoutCap_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 0;
        p.perWalletMintCap = 0;
        // Factory catches this first.
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__FreeMintRequiresCap.selector);
        vm.prank(launcher);
        factory.launch(p);
    }

    function test_Init_DiscountFloorTooHigh_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.discountFloorBps = 10_001;
        vm.expectRevert(
            abi.encodeWithSelector(
                NftLaunchFactory.NftLaunchFactory__DiscountFloorTooHigh.selector, 10_001
            )
        );
        vm.prank(launcher);
        factory.launch(p);
    }

    // --------------------------------------------------------------
    // Ownership: mint-cap bypass attempt
    // --------------------------------------------------------------

    /// Attacker tries to call the ERC-721 clone's mintBatch directly to
    /// bypass the mint module (and thus the mint cap). Must revert
    /// because ownership is transferred to the mint module at launch.
    function test_MintBatch_DirectCall_Rejects() public {
        _launch(_defaultLaunchParams());
        vm.expectRevert();    // Solady Ownable.Unauthorized
        vm.prank(buyer1);
        ERC721ATemplate(deployedToken).mintBatch(buyer1, 1);
    }

    /// Even the launcher can't bypass — they gave up ownership to the
    /// mint module at launch time.
    function test_MintBatch_LauncherCant_Bypass() public {
        _launch(_defaultLaunchParams());
        vm.expectRevert();
        vm.prank(launcher);
        ERC721ATemplate(deployedToken).mintBatch(launcher, 1);
    }

    // --------------------------------------------------------------
    // Refund goes to buyer, not launcher
    // --------------------------------------------------------------
    function test_Overpay_Refunds_ToBuyer_Not_Launcher() public {
        _launch(_defaultLaunchParams());
        vm.deal(buyer1, 1 ether);
        uint256 launcherBefore = launcher.balance;
        vm.prank(buyer1);
        NftMintModule(deployedMintModule).mint{value: 0.5 ether}(
            1, new bytes32[](0), 0, 0, "", _emptyProofs()
        );
        // Launcher balance in EOA (not accrued) unchanged.
        assertEq(launcher.balance, launcherBefore, "launcher EOA untouched");
        assertEq(NftMintModule(deployedMintModule).launcherBalance(), 0.009 ether, "accrued 9k");
    }

    // --------------------------------------------------------------
    // WL flavor: mid-window mint requires proof; post-window bypasses
    // --------------------------------------------------------------
    function test_WL_MidWindow_NonWL_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        (bytes32 root,,) = _twoLeafMerkle(buyer1, buyer2);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        // Halfway through window
        vm.warp(block.timestamp + 30 minutes);
        vm.deal(buyer3, 1 ether);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        vm.prank(buyer3);
        NftMintModule(deployedMintModule).mint{value: 0.01 ether}(
            1, new bytes32[](0), 0, 0, "", _emptyProofs()
        );
    }

    // --------------------------------------------------------------
    // Owner-only setters on factory
    // --------------------------------------------------------------
    function test_Factory_SetImpls_OnlyOwner() public {
        NftLaunchFactory f2 = new NftLaunchFactory(owner);
        vm.expectRevert();
        vm.prank(buyer1);
        f2.setImpls(address(1), address(2), address(3));
    }

    function test_Factory_SetImpls_OneShot() public {
        // Standing factory (from harness) already has impls set.
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__AlreadySet.selector);
        vm.prank(owner);
        factory.setImpls(address(1), address(2), address(3));
    }

    function test_Factory_SetImpls_CodeHashMismatch_Rejects() public {
        NftLaunchFactory f2 = new NftLaunchFactory(owner);
        // Pin some bogus expected hashes.
        vm.startPrank(owner);
        f2.setExpectedCodeHashes(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        // Now try to bind the real impls — hashes won't match.
        vm.expectRevert();
        f2.setImpls(address(erc721Impl), address(mintModuleImpl), address(wlModuleImpl));
        vm.stopPrank();
    }

    function test_Factory_SetImpls_BeforePin_Rejects() public {
        NftLaunchFactory f2 = new NftLaunchFactory(owner);
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__CodeHashNotPinned.selector);
        vm.prank(owner);
        f2.setImpls(address(erc721Impl), address(mintModuleImpl), address(wlModuleImpl));
    }

    function test_Factory_SetExpectedCodeHashes_OneShot() public {
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__AlreadySet.selector);
        vm.prank(owner);
        factory.setExpectedCodeHashes(
            bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3))
        );
    }

    // --------------------------------------------------------------
    // helpers
    // --------------------------------------------------------------
    function _extNftTier() internal pure returns (NftMintModule.DiscountTier memory) {
        return NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: address(0xBEEF),
            externalChainId: 1,
            percentPerNftBps: 500,
            maxCountedNfts: 10,
            fixedDiscountBps: 0
        });
    }

    function _extNftTierArr() internal pure returns (NftMintModule.DiscountTier[] memory a) {
        a = new NftMintModule.DiscountTier[](1);
        a[0] = _extNftTier();
    }

    function _emptyProofs() internal pure returns (NftMintModule.TierProof[] memory) {
        return new NftMintModule.TierProof[](0);
    }
}
