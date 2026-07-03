// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";
import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {ERC20WithPausableGen} from "src/templates/composed/ERC20WithPausableGen.sol";
import {ERC20WithPermitGen} from "src/templates/composed/ERC20WithPermitGen.sol";
import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {ERC20WithGovernorBundleGen} from "src/templates/composed/ERC20WithGovernorBundleGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithFoTPermitGen} from "src/templates/composed/ERC20WithFoTPermitGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";
import {ERC20WithAirdropVestingGen} from "src/templates/composed/ERC20WithAirdropVestingGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
import {ERC20WithAirdropPermitGen} from "src/templates/composed/ERC20WithAirdropPermitGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";
import {ERC20WithAirdropVotesGen} from "src/templates/composed/ERC20WithAirdropVotesGen.sol";
import {ERC20WithPausablePermitGen} from "src/templates/composed/ERC20WithPausablePermitGen.sol";
import {ERC721AWithRoyaltyRefundableGen} from "src/templates/composed/ERC721AWithRoyaltyRefundableGen.sol";
import {ERC721AWithDelayedRevealRefundableGen} from "src/templates/composed/ERC721AWithDelayedRevealRefundableGen.sol";
import {ERC721AWithSvgSoulboundGen} from "src/templates/composed/ERC721AWithSvgSoulboundGen.sol";
import {ERC721AWithRoyaltySoulboundGen} from "src/templates/composed/ERC721AWithRoyaltySoulboundGen.sol";
import {ERC1155WithSupplyGen} from "src/templates/composed/ERC1155WithSupplyGen.sol";
import {ERC1155WithPayableGen} from "src/templates/composed/ERC1155WithPayableGen.sol";
import {ERC1155WithSplitPayableGen} from "src/templates/composed/ERC1155WithSplitPayableGen.sol";
import {ERC1155WithRoyaltyGen} from "src/templates/composed/ERC1155WithRoyaltyGen.sol";
import {ERC1155WithSupplyPayableGen} from "src/templates/composed/ERC1155WithSupplyPayableGen.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {ERC721AWithOnChainSVGGen} from "src/templates/composed/ERC721AWithOnChainSVGGen.sol";
import {ERC721AWithRoyaltyGen} from "src/templates/composed/ERC721AWithRoyaltyGen.sol";
import {ERC721AWithSvgAndRoyaltyGen} from "src/templates/composed/ERC721AWithSvgAndRoyaltyGen.sol";
import {ERC721AWithSoulboundGen} from "src/templates/composed/ERC721AWithSoulboundGen.sol";
import {ERC721AWithDelayedRevealGen} from "src/templates/composed/ERC721AWithDelayedRevealGen.sol";
import {ERC721AWithRefundableGen} from "src/templates/composed/ERC721AWithRefundableGen.sol";
import {BaseType} from "src/types/VMTypes.sol";

/// @notice Deploys the entire Phase 1 stack in one broadcast and wires it end-to-end:
///
///     NameRegistry → FeeReceiver → Router → ERC20Factory → ERC20Template (impl)
///
///     - router.setFactory(ERC20, factory)
///     - registry.setRouter(router)
///     - factory.registerImpl(BARE_CONFIG, impl)
///
/// After this script runs, the frontend can launch a bare ERC-20 with configHash=BARE_CONFIG.
///
/// Env vars (all optional; default to the broadcast sender):
///   ADMIN            — initial owner of all deployed contracts. Post-deploy, transfer to
///                       a multisig. Defaults to msg.sender.
///   TREASURY         — treasury address for NameRegistry (unused v1, wired for future sweeps).
///   REGISTRAR        — address permitted to call factory.registerImpl. Compile-service key.
///                       Defaults to msg.sender for solo dev; rotate to HSM in production.
///   ERC20_FEE_WEI    — launch fee in wei. Defaults to 0.05 ETH (mainnet target).
///   MODULE_ADDON_WEI — per-extra-module fee. Defaults to 0.01 ETH.
///   HOOK_ADDON_WEI   — v4-hook install fee. Defaults to 0.10 ETH.
///   GOV_ADDON_WEI    — governance-bundle install fee. Defaults to 0.10 ETH.
///
/// Local rehearsal (no broadcast, runs in-memory against Sepolia fork):
///   forge script script/DeployPhase1.s.sol:DeployPhase1 --fork-url $SEPOLIA_RPC_URL -vvvv
///
/// Sepolia broadcast:
///   forge script script/DeployPhase1.s.sol:DeployPhase1 \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --verify -vvvv \
///     --private-key $DEV_PRIVATE_KEY
contract DeployPhase1 is Script {
    struct Deployment {
        address registry;
        address feeReceiver;
        address router;
        address erc20Factory;
        address erc20TemplateImpl;
        address erc20WithAntiBotImpl;
        address erc20WithFoTImpl;
        address erc721aFactory;
        address erc721aTemplateImpl;
        address erc721aWithSvgImpl;
        address erc721aWithRoyaltyImpl;
        address erc721aWithSvgAndRoyaltyImpl;
        address erc1155Factory;
        address erc1155TemplateImpl;
    }

    /// @dev Config hashes the frontend passes as `params.configHash`. Formula:
    ///      `keccak256(abi.encode(base, sortedModulesJoinedByComma))`. Bare launches use "" for
    ///      the module list; composed launches join sorted module IDs with commas.
    bytes32 public constant BARE_ERC20_CONFIG = keccak256(abi.encode("ERC20", ""));
    bytes32 public constant ERC20_ANTIBOT_CONFIG = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 public constant ERC20_ANTIWHALE_CONFIG = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 public constant ERC20_FOT_CONFIG = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 public constant ERC20_PAUSABLE_CONFIG = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 public constant ERC20_PERMIT_CONFIG = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 public constant ERC20_AIRDROP_CONFIG = keccak256(abi.encode("ERC20", "Airdrop"));
    bytes32 public constant ERC20_VESTING_CONFIG = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 public constant ERC20_STAKING_CONFIG = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 public constant ERC20_VOTES_CONFIG = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 public constant ERC20_GOVERNOR_CONFIG = keccak256(abi.encode("ERC20", "GovernorBundle,Votes"));

    // ---- 14 curated multi-module bundles ----
    bytes32 public constant ERC20_ANTIBOT_ANTIWHALE_CONFIG = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale"));
    bytes32 public constant ERC20_ANTIBOT_PERMIT_CONFIG = keccak256(abi.encode("ERC20", "AntiBot,Permit"));
    bytes32 public constant ERC20_FOT_PERMIT_CONFIG = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));
    bytes32 public constant ERC20_ANTIBOT_ANTIWHALE_PERMIT_CONFIG =
        keccak256(abi.encode("ERC20", "AntiBot,AntiWhale,Permit"));
    bytes32 public constant ERC20_AIRDROP_VESTING_CONFIG = keccak256(abi.encode("ERC20", "Airdrop,Vesting"));
    bytes32 public constant ERC20_PERMIT_VESTING_CONFIG = keccak256(abi.encode("ERC20", "Permit,Vesting"));
    bytes32 public constant ERC20_AIRDROP_PERMIT_CONFIG = keccak256(abi.encode("ERC20", "Airdrop,Permit"));
    bytes32 public constant ERC20_PERMIT_STAKING_CONFIG = keccak256(abi.encode("ERC20", "Permit,Staking"));
    bytes32 public constant ERC20_AIRDROP_VOTES_CONFIG = keccak256(abi.encode("ERC20", "Airdrop,Votes"));
    bytes32 public constant ERC20_PAUSABLE_PERMIT_CONFIG = keccak256(abi.encode("ERC20", "Pausable,Permit"));
    bytes32 public constant ERC721A_ROYALTY_REFUNDABLE_CONFIG =
        keccak256(abi.encode("ERC721A", "ERC2981Royalty,Refundable"));
    bytes32 public constant ERC721A_DELAYEDREVEAL_REFUNDABLE_CONFIG =
        keccak256(abi.encode("ERC721A", "DelayedReveal,Refundable"));
    bytes32 public constant ERC721A_SVG_SOULBOUND_CONFIG = keccak256(abi.encode("ERC721A", "OnChainSVG,Soulbound"));
    bytes32 public constant ERC721A_ROYALTY_SOULBOUND_CONFIG =
        keccak256(abi.encode("ERC721A", "ERC2981Royalty,Soulbound"));
    bytes32 public constant BARE_ERC721A_CONFIG = keccak256(abi.encode("ERC721A", ""));
    bytes32 public constant ERC721A_DELAYEDREVEAL_CONFIG = keccak256(abi.encode("ERC721A", "DelayedReveal"));
    bytes32 public constant ERC721A_ROYALTY_CONFIG = keccak256(abi.encode("ERC721A", "ERC2981Royalty"));
    bytes32 public constant ERC721A_SVG_CONFIG = keccak256(abi.encode("ERC721A", "OnChainSVG"));
    bytes32 public constant ERC721A_SVG_ROYALTY_CONFIG = keccak256(abi.encode("ERC721A", "ERC2981Royalty,OnChainSVG"));
    bytes32 public constant ERC721A_SOULBOUND_CONFIG = keccak256(abi.encode("ERC721A", "Soulbound"));
    bytes32 public constant ERC721A_REFUNDABLE_CONFIG = keccak256(abi.encode("ERC721A", "Refundable"));
    bytes32 public constant BARE_ERC1155_CONFIG = keccak256(abi.encode("ERC1155", ""));
    bytes32 public constant ERC1155_SUPPLY_CONFIG = keccak256(abi.encode("ERC1155", "SupplyPerToken1155"));
    bytes32 public constant ERC1155_PAYABLE_CONFIG = keccak256(abi.encode("ERC1155", "PayableMint1155"));
    bytes32 public constant ERC1155_ROYALTY_CONFIG = keccak256(abi.encode("ERC1155", "ERC2981Royalty1155"));
    bytes32 public constant ERC1155_SUPPLY_PAYABLE_CONFIG =
        keccak256(abi.encode("ERC1155", "PayableMint1155,SupplyPerToken1155"));
    bytes32 public constant ERC1155_SPLIT_PAYABLE_CONFIG =
        keccak256(abi.encode("ERC1155", "PayableMint1155Split"));

    function run() external returns (Deployment memory d) {
        address deployer = msg.sender;
        address admin = vm.envOr("ADMIN", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        address registrar = vm.envOr("REGISTRAR", deployer);
        uint256 erc20Fee = vm.envOr("ERC20_FEE_WEI", uint256(0.05 ether));
        uint256 moduleAddOn = vm.envOr("MODULE_ADDON_WEI", uint256(0.01 ether));
        uint256 hookAddOn = vm.envOr("HOOK_ADDON_WEI", uint256(0.1 ether));
        uint256 govAddOn = vm.envOr("GOV_ADDON_WEI", uint256(0.1 ether));

        string[] memory reserved = _initialReservedTickers();

        vm.startBroadcast();

        NameRegistry registry = new NameRegistry(admin, treasury, reserved);
        FeeReceiver feeReceiver = new FeeReceiver(admin);
        Router router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            erc20Fee,
            erc20Fee, // ERC721A fee (mirror ERC20 for v1)
            erc20Fee, // ERC1155 fee (mirror ERC20 for v1)
            moduleAddOn,
            hookAddOn,
            govAddOn
        );
        ERC20Factory factory20 = new ERC20Factory(admin, address(router), registrar);
        ERC20Template impl20 = new ERC20Template();
        ERC20WithAntiBotGen impl20AntiBot = new ERC20WithAntiBotGen();
        ERC20WithAntiWhaleGen impl20AntiWhale = new ERC20WithAntiWhaleGen();
        ERC20WithFeeOnTransferGen impl20FoT = new ERC20WithFeeOnTransferGen();
        ERC20WithPausableGen impl20Pausable = new ERC20WithPausableGen();
        ERC20WithPermitGen impl20Permit = new ERC20WithPermitGen();
        ERC20WithAirdropGen impl20Airdrop = new ERC20WithAirdropGen();
        ERC20WithVestingGen impl20Vesting = new ERC20WithVestingGen();
        ERC20WithStakingGen impl20Staking = new ERC20WithStakingGen();
        ERC20WithVotesGen impl20Votes = new ERC20WithVotesGen();
        ERC20WithGovernorBundleGen impl20Governor = new ERC20WithGovernorBundleGen();
        // 14 curated bundles
        ERC20WithAntiBotAntiWhaleGen impl20AbAw = new ERC20WithAntiBotAntiWhaleGen();
        ERC20WithAntiBotPermitGen impl20AbP = new ERC20WithAntiBotPermitGen();
        ERC20WithFoTPermitGen impl20FotP = new ERC20WithFoTPermitGen();
        ERC20WithAntiBotAntiWhalePermitGen impl20AbAwP = new ERC20WithAntiBotAntiWhalePermitGen();
        ERC20WithAirdropVestingGen impl20DropVest = new ERC20WithAirdropVestingGen();
        ERC20WithPermitVestingGen impl20PVest = new ERC20WithPermitVestingGen();
        ERC20WithAirdropPermitGen impl20DropP = new ERC20WithAirdropPermitGen();
        ERC20WithPermitStakingGen impl20PStk = new ERC20WithPermitStakingGen();
        ERC20WithAirdropVotesGen impl20DropV = new ERC20WithAirdropVotesGen();
        ERC20WithPausablePermitGen impl20PauseP = new ERC20WithPausablePermitGen();

        ERC721AFactory factory721 = new ERC721AFactory(admin, address(router), registrar);
        ERC721ATemplate impl721 = new ERC721ATemplate();
        ERC721AWithDelayedRevealGen impl721DelayedReveal = new ERC721AWithDelayedRevealGen();
        ERC721AWithOnChainSVGGen impl721Svg = new ERC721AWithOnChainSVGGen();
        ERC721AWithRoyaltyGen impl721Royalty = new ERC721AWithRoyaltyGen();
        ERC721AWithSvgAndRoyaltyGen impl721SvgRoyalty = new ERC721AWithSvgAndRoyaltyGen();
        ERC721AWithSoulboundGen impl721Soulbound = new ERC721AWithSoulboundGen();
        ERC721AWithRefundableGen impl721Refundable = new ERC721AWithRefundableGen();
        ERC721AWithRoyaltyRefundableGen impl721RoyRef = new ERC721AWithRoyaltyRefundableGen();
        ERC721AWithDelayedRevealRefundableGen impl721DrRef = new ERC721AWithDelayedRevealRefundableGen();
        ERC721AWithSvgSoulboundGen impl721SvgSoul = new ERC721AWithSvgSoulboundGen();
        ERC721AWithRoyaltySoulboundGen impl721RoySoul = new ERC721AWithRoyaltySoulboundGen();

        ERC1155Factory factory1155 = new ERC1155Factory(admin, address(router), registrar);
        ERC1155Template impl1155 = new ERC1155Template();
        ERC1155WithSupplyGen impl1155Supply = new ERC1155WithSupplyGen();
        ERC1155WithPayableGen impl1155Payable = new ERC1155WithPayableGen();
        ERC1155WithSplitPayableGen impl1155SplitPayable = new ERC1155WithSplitPayableGen();
        ERC1155WithRoyaltyGen impl1155Royalty = new ERC1155WithRoyaltyGen();
        ERC1155WithSupplyPayableGen impl1155SupplyPayable = new ERC1155WithSupplyPayableGen();

        // Phase 2 bonding-curve stack.
        BondingCurve curveImpl = new BondingCurve();
        CurveFactory curveFactory = new CurveFactory(admin, address(feeReceiver), address(curveImpl));

        // Wire.
        router.setFactory(BaseType.ERC20, address(factory20));
        router.setFactory(BaseType.ERC721A, address(factory721));
        router.setFactory(BaseType.ERC1155, address(factory1155));
        router.setCurveFactory(address(curveFactory));
        registry.setRouter(address(router));

        // Register the curated impl menu — 14 launchable configurations at go-live.
        factory20.registerImpl(BARE_ERC20_CONFIG, address(impl20));
        factory20.registerImpl(ERC20_ANTIBOT_CONFIG, address(impl20AntiBot));
        factory20.registerImpl(ERC20_ANTIWHALE_CONFIG, address(impl20AntiWhale));
        factory20.registerImpl(ERC20_FOT_CONFIG, address(impl20FoT));
        factory20.registerImpl(ERC20_PAUSABLE_CONFIG, address(impl20Pausable));
        factory20.registerImpl(ERC20_PERMIT_CONFIG, address(impl20Permit));
        factory20.registerImpl(ERC20_AIRDROP_CONFIG, address(impl20Airdrop));
        factory20.registerImpl(ERC20_VESTING_CONFIG, address(impl20Vesting));
        factory20.registerImpl(ERC20_STAKING_CONFIG, address(impl20Staking));
        factory20.registerImpl(ERC20_VOTES_CONFIG, address(impl20Votes));
        factory20.registerImpl(ERC20_GOVERNOR_CONFIG, address(impl20Governor));
        factory20.registerImpl(ERC20_ANTIBOT_ANTIWHALE_CONFIG, address(impl20AbAw));
        factory20.registerImpl(ERC20_ANTIBOT_PERMIT_CONFIG, address(impl20AbP));
        factory20.registerImpl(ERC20_FOT_PERMIT_CONFIG, address(impl20FotP));
        factory20.registerImpl(ERC20_ANTIBOT_ANTIWHALE_PERMIT_CONFIG, address(impl20AbAwP));
        factory20.registerImpl(ERC20_AIRDROP_VESTING_CONFIG, address(impl20DropVest));
        factory20.registerImpl(ERC20_PERMIT_VESTING_CONFIG, address(impl20PVest));
        factory20.registerImpl(ERC20_AIRDROP_PERMIT_CONFIG, address(impl20DropP));
        factory20.registerImpl(ERC20_PERMIT_STAKING_CONFIG, address(impl20PStk));
        factory20.registerImpl(ERC20_AIRDROP_VOTES_CONFIG, address(impl20DropV));
        factory20.registerImpl(ERC20_PAUSABLE_PERMIT_CONFIG, address(impl20PauseP));
        factory721.registerImpl(BARE_ERC721A_CONFIG, address(impl721));
        factory721.registerImpl(ERC721A_DELAYEDREVEAL_CONFIG, address(impl721DelayedReveal));
        factory721.registerImpl(ERC721A_SVG_CONFIG, address(impl721Svg));
        factory721.registerImpl(ERC721A_ROYALTY_CONFIG, address(impl721Royalty));
        factory721.registerImpl(ERC721A_SVG_ROYALTY_CONFIG, address(impl721SvgRoyalty));
        factory721.registerImpl(ERC721A_SOULBOUND_CONFIG, address(impl721Soulbound));
        factory721.registerImpl(ERC721A_REFUNDABLE_CONFIG, address(impl721Refundable));
        factory721.registerImpl(ERC721A_ROYALTY_REFUNDABLE_CONFIG, address(impl721RoyRef));
        factory721.registerImpl(ERC721A_DELAYEDREVEAL_REFUNDABLE_CONFIG, address(impl721DrRef));
        factory721.registerImpl(ERC721A_SVG_SOULBOUND_CONFIG, address(impl721SvgSoul));
        factory721.registerImpl(ERC721A_ROYALTY_SOULBOUND_CONFIG, address(impl721RoySoul));
        factory1155.registerImpl(BARE_ERC1155_CONFIG, address(impl1155));
        factory1155.registerImpl(ERC1155_SUPPLY_CONFIG, address(impl1155Supply));
        factory1155.registerImpl(ERC1155_PAYABLE_CONFIG, address(impl1155Payable));
        factory1155.registerImpl(ERC1155_SPLIT_PAYABLE_CONFIG, address(impl1155SplitPayable));
        factory1155.registerImpl(ERC1155_ROYALTY_CONFIG, address(impl1155Royalty));
        factory1155.registerImpl(ERC1155_SUPPLY_PAYABLE_CONFIG, address(impl1155SupplyPayable));

        vm.stopBroadcast();

        d = Deployment({
            registry: address(registry),
            feeReceiver: address(feeReceiver),
            router: address(router),
            erc20Factory: address(factory20),
            erc20TemplateImpl: address(impl20),
            erc20WithAntiBotImpl: address(impl20AntiBot),
            erc20WithFoTImpl: address(impl20FoT),
            erc721aFactory: address(factory721),
            erc721aTemplateImpl: address(impl721),
            erc721aWithSvgImpl: address(impl721Svg),
            erc721aWithRoyaltyImpl: address(impl721Royalty),
            erc721aWithSvgAndRoyaltyImpl: address(impl721SvgRoyalty),
            erc1155Factory: address(factory1155),
            erc1155TemplateImpl: address(impl1155)
        });

        console2.log("=========================================================");
        console2.log("Phase 1 deployed");
        console2.log("=========================================================");
        console2.log("  NameRegistry:      ", d.registry);
        console2.log("  FeeReceiver:       ", d.feeReceiver);
        console2.log("  Router:            ", d.router);
        console2.log("  ERC20Factory:      ", d.erc20Factory);
        console2.log("  ERC20Template:     ", d.erc20TemplateImpl);
        console2.log("  ERC20+AntiBot:     ", d.erc20WithAntiBotImpl);
        console2.log("  ERC20+FoT:         ", d.erc20WithFoTImpl);
        console2.log("  ERC721AFactory:    ", d.erc721aFactory);
        console2.log("  ERC721ATemplate:   ", d.erc721aTemplateImpl);
        console2.log("  ERC721A+SVG:       ", d.erc721aWithSvgImpl);
        console2.log("  ERC721A+Royalty:   ", d.erc721aWithRoyaltyImpl);
        console2.log("  ERC721A+SVG+Roy:   ", d.erc721aWithSvgAndRoyaltyImpl);
        console2.log("  ERC1155Factory:    ", d.erc1155Factory);
        console2.log("  ERC1155Template:   ", d.erc1155TemplateImpl);
        console2.log("---------------------------------------------------------");
        console2.log("Config hashes:");
        console2.logBytes32(BARE_ERC20_CONFIG);
        console2.logBytes32(ERC20_ANTIBOT_CONFIG);
        console2.logBytes32(ERC20_FOT_CONFIG);
        console2.logBytes32(BARE_ERC721A_CONFIG);
        console2.logBytes32(ERC721A_SVG_CONFIG);
        console2.logBytes32(ERC721A_ROYALTY_CONFIG);
        console2.logBytes32(ERC721A_SVG_ROYALTY_CONFIG);
        console2.logBytes32(BARE_ERC1155_CONFIG);
        console2.log("---------------------------------------------------------");
        console2.log("Next steps (post-broadcast):");
        console2.log("  1. transferOwnership on all four contracts to a multisig (HandoffOwnership.s.sol).");
        console2.log("  2. Verify each on Etherscan: bash verify-phase1.sh <chain>");
        console2.log("  3. Sync addresses to web/indexer: node tools/sync-addresses.mjs <chain>");
        console2.log("  4. Smoke test: forge script script/PostDeploySmoke.s.sol --rpc-url ... --broadcast");

        _writeDeploymentJson(
            address(registry),
            address(feeReceiver),
            address(router),
            address(factory20),
            address(factory721),
            address(factory1155),
            address(curveFactory),
            address(curveImpl)
        );
    }

    /// @dev Persists the go-live address book to `deployment.<chainid>.json` next to the
    ///      script. `tools/sync-addresses.mjs` reads this and writes into web/src/lib/config.ts
    ///      + indexer .env — no manual copy-paste after broadcast.
    function _writeDeploymentJson(
        address registry_,
        address feeReceiver_,
        address router_,
        address erc20Factory_,
        address erc721aFactory_,
        address erc1155Factory_,
        address curveFactory_,
        address bondingCurveImpl_
    ) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        vm.serializeAddress(obj, "NameRegistry", registry_);
        vm.serializeAddress(obj, "FeeReceiver", feeReceiver_);
        vm.serializeAddress(obj, "Router", router_);
        vm.serializeAddress(obj, "ERC20Factory", erc20Factory_);
        vm.serializeAddress(obj, "ERC721AFactory", erc721aFactory_);
        vm.serializeAddress(obj, "ERC1155Factory", erc1155Factory_);
        vm.serializeAddress(obj, "CurveFactory", curveFactory_);
        string memory json = vm.serializeAddress(obj, "BondingCurveImpl", bondingCurveImpl_);
        string memory path = string.concat("deployment.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("---------------------------------------------------------");
        console2.log("Address book written:", path);
    }

    function _initialReservedTickers() internal pure returns (string[] memory) {
        string[] memory list = new string[](26);
        list[0] = "ETH";
        list[1] = "WETH";
        list[2] = "USDC";
        list[3] = "USDT";
        list[4] = "DAI";
        list[5] = "WBTC";
        list[6] = "MATIC";
        list[7] = "LINK";
        list[8] = "UNI";
        list[9] = "AAVE";
        list[10] = "COMP";
        list[11] = "MKR";
        list[12] = "SUSHI";
        list[13] = "CRV";
        list[14] = "LDO";
        list[15] = "PEPE";
        list[16] = "SHIB";
        list[17] = "DOGE";
        list[18] = "BASE";
        list[19] = "OP";
        list[20] = "ARB";
        list[21] = "SOL";
        list[22] = "BNB";
        list[23] = "AVAX";
        list[24] = "NEAR";
        list[25] = "ATOM";
        return list;
    }
}
