// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {NftLaunchFactory} from "src/nft/NftLaunchFactory.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";

/// @notice Rehearsal: launch a tiny cheap NFT collection through the freshly
///         deployed NftLaunchFactory. Cheap so the operator can throw money
///         at every mint path without wasting real capital.
///
///         Collection knobs (hardcoded, intentional — this is a rehearsal):
///           name:            "Rehearsal Ephemeral"
///           ticker:          "REH"
///           basePriceWei:    0.0001 ETH        <-- deliberately tiny
///           maxSupply:       10
///           perWalletMintCap: 5
///           discountFloorBps: 5000 (50% floor)
///           mintMode:        Fixed
///           payWithUru:      false (ETH-priced)
///           tiers:           none
///           whitelist:       Off
///           uruAmount:       0                 <-- matches MIN_URU_LAUNCH_FEE
///
///         Reads factory address from `deployment-nft.4663.json`.
contract RehearsalNftLaunch is Script {
    function run() external returns (address token, address mintModule, address wlModule) {
        string memory chainId = vm.toString(block.chainid);
        string memory bookPath = string.concat("deployment-nft.", chainId, ".json");
        string memory book = vm.readFile(bookPath);
        address factoryAddr = vm.parseJsonAddress(book, ".NftLaunchFactory");

        NftLaunchFactory factory = NftLaunchFactory(factoryAddr);

        NftMintModule.DiscountTier[] memory noTiers = new NftMintModule.DiscountTier[](0);

        NftLaunchFactory.LaunchParams memory p = NftLaunchFactory.LaunchParams({
            name: "Rehearsal Ephemeral 2",
            ticker: "REH2",
            baseURI: "ipfs://rehearsal-placeholder/",
            maxSupply: 10,
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: 0.0001 ether,
            priceStepWei: 0,
            discountFloorBps: 5000,
            perWalletMintCap: 5,
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

        vm.startBroadcast();
        (token, mintModule, wlModule) = factory.launch(p);
        vm.stopBroadcast();

        console2.log("=== Rehearsal collection launched ===");
        console2.log("collection (ERC-721):", token);
        console2.log("mint module        :", mintModule);
        console2.log("whitelist module   :", wlModule);
        console2.log("base price (wei)   :", uint256(0.0001 ether));
        console2.log("max supply         :", uint256(10));
        console2.log("per-wallet cap     :", uint256(5));
    }
}
