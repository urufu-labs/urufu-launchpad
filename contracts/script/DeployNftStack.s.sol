// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";

/// @title  DeployNftStack
/// @notice Deploys the full NFT launch stack in a single broadcast:
///           1. ERC721ATemplate impl
///           2. NftMintModule impl
///           3. NftWhitelistModule impl
///           4. NftLaunchFactory (owner = ADMIN or msg.sender)
///           5. Pins expected code hashes on the factory
///           6. Registers the impls with the factory
///           7. Sets URU config (uses existing UruDepositSink + LoyaltyOracle)
///           8. Sets FeeSplitter + attestation signer
///           9. Writes `deployment-nft.<chainid>.json` address book
///
///         Env vars:
///           ADMIN                — factory owner (defaults to msg.sender)
///           ATTESTATION_SIGNER   — address that signs cross-chain
///                                   external-NFT discount attestations
///           MIN_URU_LAUNCH_FEE   — min URU charged at collection deploy
///                                   (uint256, in URU smallest unit)
///
///         Reads (chain-scoped):
///           deployment.<chainid>.json           — for NameRegistry (unused
///                                                  here, kept for reference)
///           deployment-flywheel.<chainid>.json  — FeeSplitter, LoyaltyOracle
///           deployment.<chainid>.json           — URU addr, UruDepositSink
///                                                  (Router-managed)
///
///         Usage (dry-run, prints tx list):
///           forge script script/DeployNftStack.s.sol --rpc-url $ROBINHOOD_RPC_URL
///         Usage (broadcast):
///           forge script script/DeployNftStack.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///             --broadcast --private-key $DEV_PRIVATE_KEY
contract DeployNftStack is Script {
    error DeployNftStack__ZeroSigner();
    error DeployNftStack__NoFlywheelBook();
    error DeployNftStack__NoRouterBook();

    struct Deployed {
        address erc721Impl;
        address mintModuleImpl;
        address wlModuleImpl;
        address factory;
        address feeSplitter;
        address uru;
        address uruSink;
        address loyaltyOracle;
        address attestationSigner;
        uint256 minUruFee;
    }

    function run() external returns (Deployed memory out) {
        string memory chainId = vm.toString(block.chainid);
        string memory routerPath = string.concat("deployment.", chainId, ".json");
        string memory flywheelPath = string.concat("deployment-flywheel.", chainId, ".json");
        if (!vm.exists(routerPath)) revert DeployNftStack__NoRouterBook();
        if (!vm.exists(flywheelPath)) revert DeployNftStack__NoFlywheelBook();

        string memory routerJson = vm.readFile(routerPath);
        string memory flywheelJson = vm.readFile(flywheelPath);

        address feeSplitter = vm.parseJsonAddress(flywheelJson, ".FeeSplitter");
        address loyaltyOracle = vm.parseJsonAddress(flywheelJson, ".LoyaltyOracle");
        address uru = vm.envAddress("URU_TOKEN_ADDRESS");
        address uruSink = vm.parseJsonAddress(routerJson, ".UruDepositSink");
        address admin = vm.envOr("ADMIN", msg.sender);
        address attestationSigner = vm.envAddress("ATTESTATION_SIGNER");
        if (attestationSigner == address(0)) revert DeployNftStack__ZeroSigner();
        uint256 minUruFee = vm.envOr("MIN_URU_LAUNCH_FEE", uint256(0));

        out.feeSplitter = feeSplitter;
        out.uru = uru;
        out.uruSink = uruSink;
        out.loyaltyOracle = loyaltyOracle;
        out.attestationSigner = attestationSigner;
        out.minUruFee = minUruFee;

        vm.startBroadcast();

        // -- 1..3: impls
        out.erc721Impl = address(new ERC721ATemplate());
        out.mintModuleImpl = address(new NftMintModule());
        out.wlModuleImpl = address(new NftWhitelistModule());

        // -- 4: factory (owner = ADMIN)
        NftLaunchFactory factory = new NftLaunchFactory(admin);
        out.factory = address(factory);

        // -- 5: pin expected code hashes.
        //     Reading from the just-deployed addresses' .code so the
        //     hashes exactly match what the factory will bind.
        factory.setExpectedCodeHashes(
            keccak256(out.erc721Impl.code), keccak256(out.mintModuleImpl.code), keccak256(out.wlModuleImpl.code)
        );

        // -- 6: register the impls
        factory.setImpls(out.erc721Impl, out.mintModuleImpl, out.wlModuleImpl);

        // -- 7: URU config (fee + loyalty)
        factory.setUruConfig(IERC20(uru), uruSink, minUruFee, ILoyaltyOracleLike(loyaltyOracle));

        // -- 8: FeeSplitter + attestation signer
        factory.setFeeSplitter(feeSplitter);
        factory.setAttestationSigner(attestationSigner);

        vm.stopBroadcast();

        // -- 9: address book
        _writeDeploymentBook(chainId, out);

        console2.log("=== NFT Stack Deployed ===");
        console2.log("erc721Impl       ", out.erc721Impl);
        console2.log("mintModuleImpl   ", out.mintModuleImpl);
        console2.log("wlModuleImpl     ", out.wlModuleImpl);
        console2.log("factory          ", out.factory);
        console2.log("---");
        console2.log("feeSplitter      ", feeSplitter);
        console2.log("uru              ", uru);
        console2.log("uruSink          ", uruSink);
        console2.log("loyaltyOracle    ", loyaltyOracle);
        console2.log("attestationSigner", attestationSigner);
        console2.log("minUruLaunchFee  ", minUruFee);
    }

    function _writeDeploymentBook(
        string memory chainId,
        Deployed memory d
    ) internal {
        string memory obj = "nftDeploy";
        vm.serializeAddress(obj, "ERC721Impl", d.erc721Impl);
        vm.serializeAddress(obj, "NftMintModuleImpl", d.mintModuleImpl);
        vm.serializeAddress(obj, "NftWhitelistModuleImpl", d.wlModuleImpl);
        vm.serializeAddress(obj, "NftLaunchFactory", d.factory);
        vm.serializeAddress(obj, "FeeSplitter", d.feeSplitter);
        vm.serializeAddress(obj, "URU", d.uru);
        vm.serializeAddress(obj, "UruDepositSink", d.uruSink);
        vm.serializeAddress(obj, "LoyaltyOracle", d.loyaltyOracle);
        vm.serializeAddress(obj, "AttestationSigner", d.attestationSigner);
        string memory finalJson = vm.serializeUint(obj, "MinUruLaunchFee", d.minUruFee);

        string memory path = string.concat("deployment-nft.", chainId, ".json");
        vm.writeFile(path, finalJson);
        console2.log("wrote", path);
    }
}
