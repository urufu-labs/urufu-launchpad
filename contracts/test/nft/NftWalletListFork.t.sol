// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {NftLaunchFactory} from "../../src/nft/NftLaunchFactory.sol";
import {NftMintModule} from "../../src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "../../src/nft/NftWhitelistModule.sol";

interface IUruWl {
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// NFT whitelists end to end against the LIVE NftLaunchFactory on a fork.
///
/// Wallet lists: the root and proofs below come from compile-service's
/// buildWalletList (src/nft-wallet-list.ts, golden test) and the web copy
/// (web/src/lib/nftWalletList.ts); this proves the contracts accept them.
///
/// Holder whitelists: the module address is deterministic (salt = launcher,
/// name, ticker), so a script signs compile-service's wlAttestationHash with
/// the live signer key ahead of time and passes it in via env:
///   HOLDERS_WALLET, HOLDERS_COUNT, HOLDERS_EXPIRY, HOLDERS_SIG
/// (test_holders_* skip when HOLDERS_SIG is unset).
///
/// Run: ROBINHOOD_RPC_URL=... forge test --match-contract NftWalletListFork -vv
contract NftWalletListFork is Test {
    NftLaunchFactory constant FACTORY = NftLaunchFactory(0x6B90670a3Af0EBc0D12e006Fe25C07160e3F9486);
    address constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address constant GEMU = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

    bytes32 constant GOLDEN_ROOT = 0x5669480fe09d7355743bbc2eda7ef9e612d273e656749685d6a4eb7536381a3e;
    address constant LISTED_A = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address constant LISTED_B = 0x61D0CFB665179f24fFF054E4e5d0a9435fb4416E;
    address constant LISTED_C = 0x142F9398C909B1566DC0B7AE509BCfD4Edfd10E7;

    uint256 constant PRICE = 0.001 ether;

    bool forked;
    address launcher;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        launcher = makeAddr("wl-launcher");
        deal(URU, launcher, 10_000_000 ether);
        vm.prank(launcher);
        IUruWl(URU).approve(address(FACTORY), type(uint256).max);
    }

    function _proofA() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x591cde83d028ceb9484442cafb373a2cc1c28d4b68ef870f76a14833b233d29a;
        p[1] = 0xb9f3aefe05043e74c1f0caa6a0296c692d5697930b4e331cf899b2e26f728f88;
    }

    function _proofB() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = 0x9cd2c2976511218b27fea093ce31d9dc8792e0b3d025536d9b46b3a03af1d422;
        p[1] = 0xb9f3aefe05043e74c1f0caa6a0296c692d5697930b4e331cf899b2e26f728f88;
    }

    function _proofC() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = 0x0b8f346ef810a850f17d62600643bef0ed5d65f02992aa6f4c55b1e5a7697ca9;
    }

    function _base(
        string memory name,
        string memory ticker
    ) internal view returns (NftLaunchFactory.LaunchParams memory p) {
        p.name = name;
        p.ticker = ticker;
        p.baseURI = "ipfs://bafybeigfxtiyjpd5nzb3ch5cbtwace7as7ipsu5t5ipeygqrk4gfb7coym/";
        p.maxSupply = 100;
        p.basePriceWei = PRICE;
        p.discountFloorBps = 1000;
        p.uruAmount = FACTORY.minUruFeeFor(launcher);
    }

    function _launch(
        NftLaunchFactory.LaunchParams memory p
    ) internal returns (NftMintModule mm, address wl) {
        vm.prank(launcher);
        (, address m, address w) = FACTORY.launch(p);
        mm = NftMintModule(payable(m));
        wl = w;
    }

    function _mint(
        NftMintModule mm,
        address who,
        bytes32[] memory wlProof
    ) internal {
        vm.deal(who, 1 ether);
        vm.prank(who);
        mm.mint{value: PRICE}(1, wlProof, 0, 0, "", new NftMintModule.TierProof[](0));
    }

    // ---- wallet-list whitelist ----

    function test_walletList_listedMintDuringWindow_unlistedBlocked_thenPublic() public {
        if (!forked) return;
        NftLaunchFactory.LaunchParams memory p = _base("WL Fork", "WLF");
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = GOLDEN_ROOT;
        p.wlWindowEnd = block.timestamp + 1 hours;
        (NftMintModule mm,) = _launch(p);

        _mint(mm, LISTED_A, _proofA());
        _mint(mm, LISTED_B, _proofB());
        _mint(mm, LISTED_C, _proofC());

        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        mm.mint{value: PRICE}(1, _proofA(), 0, 0, "", new NftMintModule.TierProof[](0));

        // A listed wallet can't borrow another wallet's proof either.
        vm.prank(LISTED_C);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        mm.mint{value: PRICE}(1, _proofA(), 0, 0, "", new NftMintModule.TierProof[](0));

        vm.warp(block.timestamp + 1 hours + 1);
        _mint(mm, stranger, new bytes32[](0));
    }

    // ---- wallet-list discount tier ----

    function test_walletListDiscountTier_givesFixedDiscount() public {
        if (!forked) return;
        NftLaunchFactory.LaunchParams memory p = _base("WL Tier Fork", "WLT");
        p.tiers = new NftMintModule.DiscountTier[](1);
        p.tiers[0].kind = NftMintModule.TierKind.WalletList;
        p.tiers[0].walletListRoot = GOLDEN_ROOT;
        p.tiers[0].fixedDiscountBps = 2000;
        (NftMintModule mm,) = _launch(p);

        NftMintModule.TierProof[] memory tp = new NftMintModule.TierProof[](1);
        tp[0].tierId = 0;
        tp[0].merkleProof = _proofB();

        vm.deal(LISTED_B, 1 ether);
        uint256 before = LISTED_B.balance;
        vm.prank(LISTED_B);
        mm.mint{value: PRICE}(1, new bytes32[](0), 0, 0, "", tp);
        assertEq(before - LISTED_B.balance, (PRICE * 8000) / 10_000, "20% off not applied");

        // Not on the list: the tier proof is rejected.
        address stranger = makeAddr("stranger2");
        vm.deal(stranger, 1 ether);
        tp[0].merkleProof = _proofB();
        vm.prank(stranger);
        vm.expectRevert();
        mm.mint{value: PRICE}(1, new bytes32[](0), 0, 0, "", tp);
    }

    // ---- holder whitelist ----

    function _holdersParams() internal view returns (NftLaunchFactory.LaunchParams memory p) {
        p = _base("Holders Fork", "HLF");
        p.wlFlavor = NftWhitelistModule.Flavor.Holders;
        p.wlHoldersTarget = GEMU;
        p.wlHoldersTargetChainId = 4663;
        p.wlHoldersMinCount = 1;
        p.wlWindowEnd = block.timestamp + 1 days;
    }

    /// Prints the whitelist module address the holders launch will get, so a
    /// script can sign for it before the mint test runs.
    function test_holders_printModule() public {
        if (!forked) return;
        (, address wl) = _launch(_holdersParams());
        console2.log("HOLDERS_MODULE", wl);
        console2.log("HOLDERS_COLLECTION", NftWhitelistModule(wl).ourCollection());
    }

    function test_holders_signedHolderMints_othersBlocked() public {
        if (!forked) return;
        bytes memory sig = vm.envOr("HOLDERS_SIG", bytes(""));
        if (sig.length == 0) return;
        address holder = vm.envAddress("HOLDERS_WALLET");
        uint256 count = vm.envUint("HOLDERS_COUNT");
        uint256 expiry = vm.envUint("HOLDERS_EXPIRY");
        (NftMintModule mm,) = _launch(_holdersParams());

        vm.deal(holder, 1 ether);
        vm.prank(holder);
        mm.mint{value: PRICE}(1, new bytes32[](0), count, expiry, sig, new NftMintModule.TierProof[](0));

        // Same signature from another wallet is rejected.
        address stranger = makeAddr("stranger3");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(NftMintModule.NftMintModule__NotWhitelisted.selector);
        mm.mint{value: PRICE}(1, new bytes32[](0), count, expiry, sig, new NftMintModule.TierProof[](0));
    }
}
