// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";
import {Router} from "src/router/Router.sol";

/// @notice Deploys the flywheel stack (FeeSplitter + LoyaltyOracle + NftRevenueVault +
///         UruBuybackVault) and wires them into a live Phase 1 deployment.
///
///         Prereqs:
///           1. `DeployPhase1` broadcast (address book at `deployment.<chainid>.json`)
///           2. `URU_TOKEN_ADDRESS` + `GEMU_NFT_ADDRESS` env vars set — see
///              `docs/references/ecosystem-contracts.md`
///
///         Post-broadcast wiring:
///           - Router.setLoyaltyOracle(oracle)
///           - FeeSplitter.setConfig(...)  (owner-controlled; done separately via multisig
///             after the 2-day config delay)
///
/// Usage:
///   forge script script/DeployFlywheel.s.sol:DeployFlywheel \
///     --rpc-url $BASE_RPC_URL --broadcast --private-key $DEV_PRIVATE_KEY -vvvv
contract DeployFlywheel is Script {
    error DeployFlywheel__NoAddressBook();

    struct Deployed {
        address feeSplitter;
        address oracle;
        address nftVault;
        address buybackVault;
        address royaltyImpl;
        address royaltyFactory;
    }

    function run() external returns (Deployed memory out) {
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) revert DeployFlywheel__NoAddressBook();
        string memory book = vm.readFile(path);
        address router = vm.parseJsonAddress(book, ".Router");

        address admin = vm.envOr("ADMIN", msg.sender);
        address treasury = vm.envOr("TREASURY", msg.sender);
        address uruToken = vm.envAddress("URU_TOKEN_ADDRESS");
        address gemuNft = vm.envAddress("GEMU_NFT_ADDRESS");
        uint256 uruThreshold = vm.envOr("URU_THRESHOLD", uint256(100_000e18));
        uint256 configDelay = vm.envOr("SPLITTER_CONFIG_DELAY", uint256(2 days));
        // Platform's share of secondary-royalty ETH from ERC-2981 flows. Default 500 (5%).
        // Launchers keep the remaining 9500 (95%). Frozen at factory construction.
        uint16 royaltyPlatformBps = uint16(vm.envOr("ROYALTY_PLATFORM_BPS", uint256(500)));

        vm.startBroadcast();

        FeeSplitter splitter = new FeeSplitter(admin, treasury, configDelay);
        LoyaltyOracle oracle_ = new LoyaltyOracle(admin, uruToken, gemuNft, uruThreshold);
        NftRevenueVault nftVault_ = new NftRevenueVault(admin);
        UruBuybackVault buybackVault_ = new UruBuybackVault(admin, uruToken, address(nftVault_));

        // NFT secondary-royalty split scaffolding. Wired to FeeSplitter so 2981 flows land
        // in the same 40/35/25 loop as launch + curve + swap fees. Not registered in any
        // launch flow yet — activated when NFT bases turn on in the UI.
        RoyaltyRouterImpl royaltyImpl = new RoyaltyRouterImpl();
        RoyaltyRouterFactory royaltyFactory =
            new RoyaltyRouterFactory(admin, address(royaltyImpl), address(splitter), royaltyPlatformBps);

        Router(payable(router)).setLoyaltyOracle(address(oracle_));

        vm.stopBroadcast();

        out = Deployed({
            feeSplitter: address(splitter),
            oracle: address(oracle_),
            nftVault: address(nftVault_),
            buybackVault: address(buybackVault_),
            royaltyImpl: address(royaltyImpl),
            royaltyFactory: address(royaltyFactory)
        });

        console2.log("=========================================================");
        console2.log("Flywheel deployed");
        console2.log("=========================================================");
        console2.log("  FeeSplitter:           ", out.feeSplitter);
        console2.log("  LoyaltyOracle:         ", out.oracle);
        console2.log("  NftRevenueVault:       ", out.nftVault);
        console2.log("  UruBuybackVault:       ", out.buybackVault);
        console2.log("  RoyaltyRouterImpl:     ", out.royaltyImpl);
        console2.log("  RoyaltyRouterFactory:  ", out.royaltyFactory);
        console2.log("---------------------------------------------------------");
        console2.log("Next steps:");
        console2.log("  1. Run ConfigureFlywheel.s.sol to allowlist keeper + swap target");
        console2.log("  2. Configure FeeSplitter splits post-config-delay");
        console2.log("  3. NFT flows (RoyaltyRouter + PayableMint1155Split) activate when");
        console2.log("     NFT bases unlock in the UI");

        _writeFlywheelJson(out);
    }

    function _writeFlywheelJson(
        Deployed memory out
    ) internal {
        string memory obj = "flywheel";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "FeeSplitter", out.feeSplitter);
        vm.serializeAddress(obj, "LoyaltyOracle", out.oracle);
        vm.serializeAddress(obj, "NftRevenueVault", out.nftVault);
        vm.serializeAddress(obj, "UruBuybackVault", out.buybackVault);
        vm.serializeAddress(obj, "RoyaltyRouterImpl", out.royaltyImpl);
        string memory json = vm.serializeAddress(obj, "RoyaltyRouterFactory", out.royaltyFactory);
        string memory outPath = string.concat("deployment-flywheel.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, outPath);
        console2.log("Address book written:", outPath);
    }
}
