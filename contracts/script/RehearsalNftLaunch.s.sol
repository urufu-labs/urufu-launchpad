// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {NftLaunchFactory} from "src/nft/NftLaunchFactory.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";

/// @notice Rehearsal launches against the freshly-deployed NftLaunchFactory.
///         One entry-point per test-matrix row; invoke with `--sig runXxx()`.
///         Every entry-point uses tiny prices so the operator can throw money
///         at every mint path without wasting real capital.
///
///         Factory address is read from `deployment-nft.<chainid>.json`.
///         Every rehearsal-launched collection should be added to
///         `web/src/lib/hiddenNftCollections.ts` after broadcast so it stays
///         off public feeds.
contract RehearsalNftLaunch is Script {
    // Row 1 — Fixed price, ETH-paid, no whitelist, no tiers. (Already
    // executed by the initial rehearsal.)
    function run() external returns (address token, address mintModule, address wlModule) {
        return _launch(_defaults());
    }

    // Row 2 — LinearStep pricing, ETH-paid, no whitelist. Proves the
    // step-up formula on real chain: mint N tokens, each priced base +
    // step * (mintedBefore + i).
    function runLinearStep() external returns (address token, address mintModule, address wlModule) {
        NftLaunchFactory.LaunchParams memory p = _defaults();
        p.name = "Rehearsal Linear Step";
        p.ticker = "REHL";
        p.mintMode = NftMintModule.MintMode.LinearStep;
        p.basePriceWei = 0.0001 ether;
        p.priceStepWei = 0.00002 ether;   // each subsequent mint costs 20% more of base
        return _launch(p);
    }

    // Row 3 — Fixed price, URU-paid, no whitelist. Proves the URU
    // approve → mint → launcherBalanceUru accrual → withdrawUru() flow.
    function runUruPaid() external returns (address token, address mintModule, address wlModule) {
        NftLaunchFactory.LaunchParams memory p = _defaults();
        p.name = "Rehearsal URU Fixed";
        p.ticker = "REHU";
        p.payWithUru = true;
        p.basePriceWei = 1e18;            // 1 URU (18 decimals) per mint
        return _launch(p);
    }

    // Row 4 — Fixed price, ETH-paid, WalletList whitelist (merkle-based).
    // Uses a single-wallet merkle root: the deployer, so the deployer can
    // mint inside the WL window. Non-WL wallets revert.
    function runWlMerkle(bytes32 root, uint256 windowEnd) external returns (address token, address mintModule, address wlModule) {
        NftLaunchFactory.LaunchParams memory p = _defaults();
        p.name = "Rehearsal WL Merkle";
        p.ticker = "REHW";
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = windowEnd;
        return _launch(p);
    }

    // Row 5 — Fixed price, ETH-paid, no whitelist gate, but a WalletList
    // DISCOUNT tier. Buyers on the tier's merkle list pay less.
    function runWalletListDiscountTier(bytes32 tierRoot) external returns (address token, address mintModule, address wlModule) {
        NftLaunchFactory.LaunchParams memory p = _defaults();
        p.name = "Rehearsal WL Discount";
        p.ticker = "REHD";
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.WalletList,
            walletListRoot: tierRoot,
            externalCollection: address(0),
            externalChainId: 0,
            percentPerNftBps: 0,
            maxCountedNfts: 0,
            fixedDiscountBps: 2000            // 20% off; may be clamped by floor
        });
        p.tiers = tiers;
        return _launch(p);
    }

    // Row 6 — Fixed price, ETH-paid, no whitelist gate, but an
    // ExternalNft DISCOUNT tier keyed on urufu gemu nft holdings.
    // Buyers who hold >= minHoldings of the external NFT get discount.
    // Requires the compile-service /api/nft-discount/attest endpoint to
    // sign the attestation at mint time — the mint call includes the sig.
    function runExternalNftDiscountTier() external returns (address token, address mintModule, address wlModule) {
        NftLaunchFactory.LaunchParams memory p = _defaults();
        p.name = "Rehearsal Ext NFT Discount";
        p.ticker = "REHX";
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](1);
        tiers[0] = NftMintModule.DiscountTier({
            kind: NftMintModule.TierKind.ExternalNft,
            walletListRoot: bytes32(0),
            externalCollection: 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17,  // urufu gemu nft
            externalChainId: 4663,
            percentPerNftBps: 1000,           // 10% off per gemu held
            maxCountedNfts: 5,                // cap at 50% total (floor also caps at 50%)
            fixedDiscountBps: 0
        });
        p.tiers = tiers;
        return _launch(p);
    }

    // ---- helpers ---------------------------------------------------------

    function _defaults() internal pure returns (NftLaunchFactory.LaunchParams memory p) {
        NftMintModule.DiscountTier[] memory noTiers = new NftMintModule.DiscountTier[](0);
        p = NftLaunchFactory.LaunchParams({
            name: "OVERRIDE ME",
            ticker: "OVR",
            baseURI: "ipfs://rehearsal-placeholder/",
            maxSupply: 20,
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: 0.0001 ether,
            priceStepWei: 0,
            discountFloorBps: 5000,          // 50% floor
            perWalletMintCap: 10,
            payWithUru: false,
            tiers: noTiers,
            wlFlavor: NftWhitelistModule.Flavor.Off,
            wlHoldersTarget: address(0),
            wlHoldersTargetChainId: 0,
            wlHoldersMinCount: 0,
            wlWalletListRoot: bytes32(0),
            wlWindowEnd: 0,
            uruAmount: 0
        });
    }

    function _launch(NftLaunchFactory.LaunchParams memory p) internal returns (address token, address mintModule, address wlModule) {
        string memory chainId = vm.toString(block.chainid);
        string memory bookPath = string.concat("deployment-nft.", chainId, ".json");
        string memory book = vm.readFile(bookPath);
        address factoryAddr = vm.parseJsonAddress(book, ".NftLaunchFactory");
        NftLaunchFactory factory = NftLaunchFactory(factoryAddr);

        vm.startBroadcast();
        (token, mintModule, wlModule) = factory.launch(p);
        vm.stopBroadcast();

        console2.log("=== Rehearsal collection launched ===");
        console2.log("name             :", p.name);
        console2.log("ticker           :", p.ticker);
        console2.log("collection       :", token);
        console2.log("mint module      :", mintModule);
        console2.log("whitelist module :", wlModule);
        console2.log("mint mode (0=Fix,1=Lin):", uint256(p.mintMode));
        console2.log("payWithUru       :", p.payWithUru);
        console2.log("basePrice        :", p.basePriceWei);
        console2.log("priceStep        :", p.priceStepWei);
        console2.log("perWalletCap     :", p.perWalletMintCap);
    }
}
