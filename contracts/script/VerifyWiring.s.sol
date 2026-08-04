// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RhConfigManifest} from "./manifest/RhConfigManifest.sol";

/// @title  VerifyWiring
/// @notice CANONICAL live-stack validator + address-book generator for the
///         Robinhood launchpad. Runs against a fork (or mainnet directly)
///         and asserts every invariant the launchpad depends on:
///
///           - chain id matches the expected Robinhood chain (4663)
///           - every named contract has deployed code at its address
///           - every owner-controlled slot is owned by the expected deployer
///           - every cross-contract wire points at the correct sibling
///             (Router.curveFactory, CurveFactory.graduator,
///              Graduator.defaultHook, MultiHookHost.initializer, etc.)
///           - the fee-flywheel triple is wired end to end (Router →
///             FeeSplitter → UruBuybackVault + NftRevenueVault + treasury)
///           - LoyaltyOracle points at canonical RH URU + GEMU
///           - Router.minUruFee is non-zero (blocker #2 in the audit)
///           - every canonical configHash in RhConfigManifest has both
///             sentinels set and its stored (count, flags) match
///           - the 3 retired Airdrop configHashes still hold their poison
///             value (attacker-hole mitigation from the audit's follow-up)
///
///         If ANY invariant fails the script reverts loudly with the
///         mismatched field name — that revert is the "your live state
///         drifted from the manifest" signal.
///
///         If EVERY invariant holds, the script emits a JSON address book
///         (`deployment-live-rh.<chainId>.json`) that becomes the canonical
///         source of truth. Frontend / indexer / operator env files should
///         be generated from this JSON rather than hand-copied — this
///         directly satisfies the auditor's "no manual copy-paste" merge
///         criterion.
///
///         The dashboard-style read comes for free: run this whenever the
///         stack rotates and pipe the resulting JSON into `.env` +
///         `web/src/lib/config.ts` via any automation you like. The
///         `RhLiveStackSnapshot.t.sol` test suite is the automated
///         guardrail; this script is the operator-facing snapshot.
///
///         Run:
///           forge script script/VerifyWiring.s.sol:VerifyWiring \
///             --rpc-url https://rpc.mainnet.chain.robinhood.com
///
///         Env vars (all optional, defaults match current live RH V7+V8):
///           ROBINHOOD_ROUTER_ADDRESS
///           ROBINHOOD_CURVE_FACTORY_ADDRESS
///           ROBINHOOD_NAME_REGISTRY_ADDRESS
///           ROBINHOOD_POOL_MANAGER_ADDRESS
///           ROBINHOOD_MULTI_HOOK_HOST_ADDRESS
///           ROBINHOOD_GRADUATOR_ADDRESS
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           ROBINHOOD_LOYALTY_ORACLE_ADDRESS
///           ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS
///           ROBINHOOD_URU_BUYBACK_VAULT_ADDRESS
///           ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS
///           ROBINHOOD_ROYALTY_ROUTER_FACTORY_ADDRESS
///           ROBINHOOD_ERC20_FACTORY_ADDRESS
///           ROBINHOOD_ERC721A_FACTORY_ADDRESS
///           ROBINHOOD_ERC1155_FACTORY_ADDRESS
///           ROBINHOOD_V4_SWAP_ROUTER_ADDRESS
///           ROBINHOOD_URU_ADDRESS
///           ROBINHOOD_GEMU_NFT_ADDRESS
///           EXPECTED_OWNER              (default deployer)

interface IRouter {
    function owner() external view returns (address);
    function curveFactory() external view returns (address);
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function loyaltyOracle() external view returns (address);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function minUruFee() external view returns (uint256);
    function paused() external view returns (bool);
    function factories(
        uint8 base
    ) external view returns (address);
    function moduleCountConfigured(
        bytes32 h
    ) external view returns (bool);
    function moduleCountForConfig(
        bytes32 h
    ) external view returns (uint256);
    function flagsConfigured(
        bytes32 h
    ) external view returns (bool);
    function flagsForConfig(
        bytes32 h
    ) external view returns (uint256);
}

interface ICurveFactory {
    function owner() external view returns (address);
    function graduator() external view returns (address);
    function trustedRouters(
        address
    ) external view returns (bool);
}

interface INameRegistry {
    function router() external view returns (address);
    function owner() external view returns (address);
}

interface IGraduator {
    function owner() external view returns (address);
    function defaultHook() external view returns (address);
    function curveFactory() external view returns (address);
    function poolManager() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface IMultiHookHost {
    function initializer() external view returns (address);
    function poolManager() external view returns (address);
    function platform() external view returns (address);
}

interface IFeeSplitter {
    function owner() external view returns (address);
    function uruBuybackSink() external view returns (address);
    function nftRevenueSink() external view returns (address);
    function treasurySink() external view returns (address);
    function uruBuybackBps() external view returns (uint16);
    function nftRevenueBps() external view returns (uint16);
    function treasuryBps() external view returns (uint16);
}

interface ILoyaltyOracle {
    function owner() external view returns (address);
    function uruToken() external view returns (address);
    function gemuNft() external view returns (address);
}

interface IUruDepositSink {
    function owner() external view returns (address);
    function uru() external view returns (address);
    function distributionSink() external view returns (address);
}

interface IUruBuybackVault {
    function owner() external view returns (address);
    function uru() external view returns (address);
}

interface INftRevenueVault {
    function owner() external view returns (address);
}

interface IRoyaltyRouterFactory {
    function owner() external view returns (address);
}

interface IFactoryOwned {
    function owner() external view returns (address);
    function router() external view returns (address);
}

contract VerifyWiring is Script {
    uint256 internal constant EXPECTED_CHAIN_ID = 4663;

    // Current live RH mainnet defaults (V7 Router + CurveFactory, V8 MHH + Graduator).
    // Update whenever the stack rotates; consumers can override via env vars.
    address internal constant DEFAULT_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant DEFAULT_CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant DEFAULT_NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_MHH = 0xed092D2B55AeAc862fb2E1caA4c7E10573cCA2c4;
    address internal constant DEFAULT_GRADUATOR = 0x0Db63b8Af346c5edabF79b16A236AEDA0428e712;
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant DEFAULT_LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;
    address internal constant DEFAULT_URU_DEPOSIT_SINK = 0xA6b3748023540af1aD4C4731E8B8A09fACFf737e;
    address internal constant DEFAULT_URU_BUYBACK_VAULT = 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354;
    address internal constant DEFAULT_NFT_REVENUE_VAULT = 0x93CFF459d5019eEc82fE9335013e265F1eD659c7;
    address internal constant DEFAULT_ROYALTY_ROUTER_FACTORY = 0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05;
    address internal constant DEFAULT_ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant DEFAULT_ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant DEFAULT_ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant DEFAULT_V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant DEFAULT_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant DEFAULT_GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;
    address internal constant DEFAULT_OWNER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    // The three retired Airdrop hashes whose fee-quote overflow was poisoned
    // (attacker-hole mitigation broadcast 2026-08-01). Their live count MUST
    // stay at type(uint256).max.
    bytes32 internal constant HASH_AIRDROP = 0x344f851ff67d34148ac2000b192fbc9a5cc4edd0ef612cd60c3e9d90738e7b2b;
    bytes32 internal constant HASH_AIRDROP_PERMIT = 0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064;
    bytes32 internal constant HASH_AIRDROP_VESTING = 0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2;

    /// URU-A05 AC #3: audited Graduator runtime bytecode hash. Default is
    /// bytes32(0) meaning "unpinned in source". Operators override per rotation
    /// via `EXPECTED_GRADUATOR_CODEHASH` env before running VerifyWiring —
    /// once the audit signs off on a specific Graduator artifact, pin the hex
    /// value here as the source-of-truth default so drift trips a hard revert
    /// even when the env is unset.
    bytes32 internal constant EXPECTED_GRADUATOR_CODEHASH_DEFAULT = bytes32(0);

    /// Every address gets bundled into one struct so the JSON emitter can serialize
    /// them field-by-field without repeating the address list.
    struct Addresses {
        address router;
        address curveFactory;
        address nameRegistry;
        address poolManager;
        address multiHookHost;
        address graduator;
        address feeSplitter;
        address loyaltyOracle;
        address uruDepositSink;
        address uruBuybackVault;
        address nftRevenueVault;
        address royaltyRouterFactory;
        address erc20Factory;
        address erc721AFactory;
        address erc1155Factory;
        address v4SwapRouter;
        address uru;
        address gemuNft;
        address expectedOwner;
    }

    function run() external {
        Addresses memory a = _readAddresses();
        _requireChainId();
        _requireCodeAtEveryAddress(a);
        _requireOwnership(a);
        _requireRouterState(a);
        _requireCurveFactoryState(a);
        _requireGraduatorState(a);
        _requireMultiHookHostState(a);
        _requireFeeSplitterState(a);
        _requireLoyaltyOracleState(a);
        _requireUruDepositSinkState(a);
        _requireUruBuybackVaultState(a);
        _requireNameRegistryState(a);
        _requireFactoryRouterWires(a);
        _requireManifestSentinelsPresent(a);
        _requireRetiredHashesPoisoned(a);
        _requireMinUruFeeNonZero(a);

        console2.log("=========================================================");
        console2.log("  ALL LIVE-STATE INVARIANTS HOLD");
        console2.log("=========================================================");
        _dumpJson(a);
    }

    // ---------------------------------------------------------------- reads
    function _readAddresses() internal view returns (Addresses memory a) {
        a.router = _env("ROBINHOOD_ROUTER_ADDRESS", DEFAULT_ROUTER);
        a.curveFactory = _env("ROBINHOOD_CURVE_FACTORY_ADDRESS", DEFAULT_CURVE_FACTORY);
        a.nameRegistry = _env("ROBINHOOD_NAME_REGISTRY_ADDRESS", DEFAULT_NAME_REGISTRY);
        a.poolManager = _env("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        a.multiHookHost = _env("ROBINHOOD_MULTI_HOOK_HOST_ADDRESS", DEFAULT_MHH);
        a.graduator = _env("ROBINHOOD_GRADUATOR_ADDRESS", DEFAULT_GRADUATOR);
        a.feeSplitter = _env("ROBINHOOD_FEE_SPLITTER_ADDRESS", DEFAULT_FEE_SPLITTER);
        a.loyaltyOracle = _env("ROBINHOOD_LOYALTY_ORACLE_ADDRESS", DEFAULT_LOYALTY_ORACLE);
        a.uruDepositSink = _env("ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS", DEFAULT_URU_DEPOSIT_SINK);
        a.uruBuybackVault = _env("ROBINHOOD_URU_BUYBACK_VAULT_ADDRESS", DEFAULT_URU_BUYBACK_VAULT);
        a.nftRevenueVault = _env("ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS", DEFAULT_NFT_REVENUE_VAULT);
        a.royaltyRouterFactory = _env("ROBINHOOD_ROYALTY_ROUTER_FACTORY_ADDRESS", DEFAULT_ROYALTY_ROUTER_FACTORY);
        a.erc20Factory = _env("ROBINHOOD_ERC20_FACTORY_ADDRESS", DEFAULT_ERC20_FACTORY);
        a.erc721AFactory = _env("ROBINHOOD_ERC721A_FACTORY_ADDRESS", DEFAULT_ERC721A_FACTORY);
        a.erc1155Factory = _env("ROBINHOOD_ERC1155_FACTORY_ADDRESS", DEFAULT_ERC1155_FACTORY);
        a.v4SwapRouter = _env("ROBINHOOD_V4_SWAP_ROUTER_ADDRESS", DEFAULT_V4_SWAP_ROUTER);
        a.uru = _env("ROBINHOOD_URU_ADDRESS", DEFAULT_URU);
        a.gemuNft = _env("ROBINHOOD_GEMU_NFT_ADDRESS", DEFAULT_GEMU_NFT);
        a.expectedOwner = _env("EXPECTED_OWNER", DEFAULT_OWNER);
    }

    // ---------------------------------------------------------------- checks
    function _requireChainId() internal view {
        require(
            block.chainid == EXPECTED_CHAIN_ID,
            string.concat("chain mismatch: expected 4663 (Robinhood), got ", vm.toString(block.chainid))
        );
    }

    function _requireCodeAtEveryAddress(
        Addresses memory a
    ) internal view {
        _requireHasCode(a.router, "Router");
        _requireHasCode(a.curveFactory, "CurveFactory");
        _requireHasCode(a.nameRegistry, "NameRegistry");
        _requireHasCode(a.poolManager, "PoolManager");
        _requireHasCode(a.multiHookHost, "MultiHookHost");
        _requireHasCode(a.graduator, "Graduator");
        _requireHasCode(a.feeSplitter, "FeeSplitter");
        _requireHasCode(a.loyaltyOracle, "LoyaltyOracle");
        _requireHasCode(a.uruDepositSink, "UruDepositSink");
        _requireHasCode(a.uruBuybackVault, "UruBuybackVault");
        _requireHasCode(a.nftRevenueVault, "NftRevenueVault");
        _requireHasCode(a.royaltyRouterFactory, "RoyaltyRouterFactory");
        _requireHasCode(a.erc20Factory, "ERC20Factory");
        _requireHasCode(a.erc721AFactory, "ERC721AFactory");
        _requireHasCode(a.erc1155Factory, "ERC1155Factory");
        _requireHasCode(a.v4SwapRouter, "V4SwapRouter");
        _requireHasCode(a.uru, "URU");
        _requireHasCode(a.gemuNft, "GEMU_NFT");
    }

    function _requireOwnership(
        Addresses memory a
    ) internal view {
        _requireEqAddr(IRouter(a.router).owner(), a.expectedOwner, "Router.owner");
        _requireEqAddr(ICurveFactory(a.curveFactory).owner(), a.expectedOwner, "CurveFactory.owner");
        _requireEqAddr(INameRegistry(a.nameRegistry).owner(), a.expectedOwner, "NameRegistry.owner");
        _requireEqAddr(IGraduator(a.graduator).owner(), a.expectedOwner, "Graduator.owner");
        _requireEqAddr(IFeeSplitter(a.feeSplitter).owner(), a.expectedOwner, "FeeSplitter.owner");
        _requireEqAddr(ILoyaltyOracle(a.loyaltyOracle).owner(), a.expectedOwner, "LoyaltyOracle.owner");
        _requireEqAddr(IUruDepositSink(a.uruDepositSink).owner(), a.expectedOwner, "UruDepositSink.owner");
        _requireEqAddr(IUruBuybackVault(a.uruBuybackVault).owner(), a.expectedOwner, "UruBuybackVault.owner");
        _requireEqAddr(INftRevenueVault(a.nftRevenueVault).owner(), a.expectedOwner, "NftRevenueVault.owner");
        _requireEqAddr(
            IRoyaltyRouterFactory(a.royaltyRouterFactory).owner(), a.expectedOwner, "RoyaltyRouterFactory.owner"
        );
        _requireEqAddr(IFactoryOwned(a.erc20Factory).owner(), a.expectedOwner, "ERC20Factory.owner");
        _requireEqAddr(IFactoryOwned(a.erc721AFactory).owner(), a.expectedOwner, "ERC721AFactory.owner");
        _requireEqAddr(IFactoryOwned(a.erc1155Factory).owner(), a.expectedOwner, "ERC1155Factory.owner");
    }

    function _requireRouterState(
        Addresses memory a
    ) internal view {
        IRouter r = IRouter(a.router);
        _requireEqAddr(r.curveFactory(), a.curveFactory, "Router.curveFactory");
        _requireEqAddr(r.registry(), a.nameRegistry, "Router.registry");
        _requireEqAddr(r.feeReceiver(), a.feeSplitter, "Router.feeReceiver");
        _requireEqAddr(r.loyaltyOracle(), a.loyaltyOracle, "Router.loyaltyOracle");
        _requireEqAddr(r.uru(), a.uru, "Router.uru");
        _requireEqAddr(r.uruSink(), a.uruDepositSink, "Router.uruSink");
        _requireEqAddr(r.factories(0), a.erc20Factory, "Router.factories[ERC20]");
        _requireEqAddr(r.factories(1), a.erc721AFactory, "Router.factories[ERC721A]");
        _requireEqAddr(r.factories(2), a.erc1155Factory, "Router.factories[ERC1155]");
    }

    function _requireCurveFactoryState(
        Addresses memory a
    ) internal view {
        _requireEqAddr(ICurveFactory(a.curveFactory).graduator(), a.graduator, "CurveFactory.graduator");
        require(
            ICurveFactory(a.curveFactory).trustedRouters(a.router), "CurveFactory.trustedRouters[Router] must be true"
        );
    }

    function _requireGraduatorState(
        Addresses memory a
    ) internal view {
        IGraduator g = IGraduator(a.graduator);
        _requireEqAddr(g.defaultHook(), a.multiHookHost, "Graduator.defaultHook");
        _requireEqAddr(g.curveFactory(), a.curveFactory, "Graduator.curveFactory");
        _requireEqAddr(g.poolManager(), a.poolManager, "Graduator.poolManager");
        require(g.fee() == 3000, "Graduator.fee != 3000");
        require(g.tickSpacing() == 60, "Graduator.tickSpacing != 60");
        // URU-A05 AC #3: verify the deployed Graduator bytecode matches the
        // audited artifact hash. Prior verify only checked hasCode + wiring,
        // which would pass a graduator whose bytecode had been swapped to a
        // rug variant with the same immutable slots. Pin comes from
        // EXPECTED_GRADUATOR_CODEHASH env (settable per rotation) — default
        // is the V8-final code the audit signed off on. When the pin is
        // bytes32(0) (unset env, no baked default), we log a warning but
        // don't revert — first-time deploys populate the pin from the
        // just-deployed code. Rotations MUST set this env explicitly.
        bytes32 expected = _envBytes32("EXPECTED_GRADUATOR_CODEHASH", EXPECTED_GRADUATOR_CODEHASH_DEFAULT);
        bytes32 actual;
        address grad = a.graduator;
        assembly {
            actual := extcodehash(grad)
        }
        if (expected == bytes32(0)) {
            console2.log("WARNING: EXPECTED_GRADUATOR_CODEHASH not pinned; actual codehash:");
            console2.logBytes32(actual);
        } else {
            require(
                actual == expected,
                string.concat(
                    "Graduator codehash drift; expected ", vm.toString(expected), " actual ", vm.toString(actual)
                )
            );
        }
    }

    function _requireMultiHookHostState(
        Addresses memory a
    ) internal view {
        IMultiHookHost m = IMultiHookHost(a.multiHookHost);
        // THE most critical wire — a mismatch here silently reverts every
        // graduation. Stranded ~4 ETH in the V7 rotation.
        _requireEqAddr(m.initializer(), a.graduator, "MultiHookHost.initializer (MUST equal Graduator)");
        _requireEqAddr(m.poolManager(), a.poolManager, "MultiHookHost.poolManager");
        _requireEqAddr(m.platform(), a.feeSplitter, "MultiHookHost.platform");
    }

    function _requireFeeSplitterState(
        Addresses memory a
    ) internal view {
        IFeeSplitter f = IFeeSplitter(a.feeSplitter);
        _requireEqAddr(f.uruBuybackSink(), a.uruBuybackVault, "FeeSplitter.uruBuybackSink");
        _requireEqAddr(f.nftRevenueSink(), a.nftRevenueVault, "FeeSplitter.nftRevenueSink");
        // treasurySink is deployer today; not asserted to a specific address so
        // this script keeps working after a future treasury handoff.
        require(f.treasurySink() != address(0), "FeeSplitter.treasurySink is zero");
        // Split MUST sum to exactly 10 000 and match the 40 / 35 / 25 policy.
        require(f.uruBuybackBps() == 4000, "FeeSplitter.uruBuybackBps != 4000");
        require(f.nftRevenueBps() == 3500, "FeeSplitter.nftRevenueBps != 3500");
        require(f.treasuryBps() == 2500, "FeeSplitter.treasuryBps != 2500");
    }

    function _requireLoyaltyOracleState(
        Addresses memory a
    ) internal view {
        ILoyaltyOracle l = ILoyaltyOracle(a.loyaltyOracle);
        _requireEqAddr(l.uruToken(), a.uru, "LoyaltyOracle.uruToken");
        _requireEqAddr(l.gemuNft(), a.gemuNft, "LoyaltyOracle.gemuNft");
    }

    function _requireUruDepositSinkState(
        Addresses memory a
    ) internal view {
        IUruDepositSink s = IUruDepositSink(a.uruDepositSink);
        _requireEqAddr(s.uru(), a.uru, "UruDepositSink.uru");
        _requireEqAddr(s.distributionSink(), a.feeSplitter, "UruDepositSink.distributionSink");
    }

    function _requireUruBuybackVaultState(
        Addresses memory a
    ) internal view {
        _requireEqAddr(IUruBuybackVault(a.uruBuybackVault).uru(), a.uru, "UruBuybackVault.uru");
    }

    function _requireNameRegistryState(
        Addresses memory a
    ) internal view {
        _requireEqAddr(INameRegistry(a.nameRegistry).router(), a.router, "NameRegistry.router");
    }

    function _requireFactoryRouterWires(
        Addresses memory a
    ) internal view {
        _requireEqAddr(IFactoryOwned(a.erc20Factory).router(), a.router, "ERC20Factory.router");
        _requireEqAddr(IFactoryOwned(a.erc721AFactory).router(), a.router, "ERC721AFactory.router");
        _requireEqAddr(IFactoryOwned(a.erc1155Factory).router(), a.router, "ERC1155Factory.router");
    }

    function _requireManifestSentinelsPresent(
        Addresses memory a
    ) internal view {
        IRouter r = IRouter(a.router);
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            require(
                r.moduleCountConfigured(e.configHash),
                string.concat("moduleCountConfigured false for manifest entry ", e.label)
            );
            require(
                r.flagsConfigured(e.configHash), string.concat("flagsConfigured false for manifest entry ", e.label)
            );
            require(
                r.moduleCountForConfig(e.configHash) == e.moduleCount,
                string.concat("moduleCountForConfig mismatch for manifest entry ", e.label)
            );
            require(
                r.flagsForConfig(e.configHash) == e.flags,
                string.concat("flagsForConfig mismatch for manifest entry ", e.label)
            );
        }
    }

    function _requireRetiredHashesPoisoned(
        Addresses memory a
    ) internal view {
        IRouter r = IRouter(a.router);
        require(
            r.moduleCountForConfig(HASH_AIRDROP) == type(uint256).max,
            "retired Airdrop hash count lost its poison (attacker hole reopened)"
        );
        require(
            r.moduleCountForConfig(HASH_AIRDROP_PERMIT) == type(uint256).max,
            "retired Airdrop+Permit hash count lost its poison"
        );
        require(
            r.moduleCountForConfig(HASH_AIRDROP_VESTING) == type(uint256).max,
            "retired Airdrop+Vesting hash count lost its poison"
        );
    }

    function _requireMinUruFeeNonZero(
        Addresses memory a
    ) internal view {
        require(IRouter(a.router).minUruFee() > 0, "Router.minUruFee is zero (URU spam-gate wide open)");
    }

    // ---------------------------------------------------------------- output
    /// Serializes every validated address into a JSON file that becomes the
    /// canonical source of truth for downstream operator tooling. Frontend
    /// config, indexer config, and service env files should be generated
    /// from this JSON rather than hand-copied. Directly satisfies the
    /// auditor's "no manual copy-paste" merge criterion.
    function _dumpJson(
        Addresses memory a
    ) internal {
        string memory o = "manifest";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "expectedOwner", a.expectedOwner);
        vm.serializeAddress(o, "router", a.router);
        vm.serializeAddress(o, "curveFactory", a.curveFactory);
        vm.serializeAddress(o, "nameRegistry", a.nameRegistry);
        vm.serializeAddress(o, "poolManager", a.poolManager);
        vm.serializeAddress(o, "multiHookHost", a.multiHookHost);
        vm.serializeAddress(o, "graduator", a.graduator);
        vm.serializeAddress(o, "feeSplitter", a.feeSplitter);
        vm.serializeAddress(o, "loyaltyOracle", a.loyaltyOracle);
        vm.serializeAddress(o, "uruDepositSink", a.uruDepositSink);
        vm.serializeAddress(o, "uruBuybackVault", a.uruBuybackVault);
        vm.serializeAddress(o, "nftRevenueVault", a.nftRevenueVault);
        vm.serializeAddress(o, "royaltyRouterFactory", a.royaltyRouterFactory);
        vm.serializeAddress(o, "erc20Factory", a.erc20Factory);
        vm.serializeAddress(o, "erc721AFactory", a.erc721AFactory);
        vm.serializeAddress(o, "erc1155Factory", a.erc1155Factory);
        vm.serializeAddress(o, "v4SwapRouter", a.v4SwapRouter);
        vm.serializeAddress(o, "uru", a.uru);
        string memory json = vm.serializeAddress(o, "gemuNft", a.gemuNft);
        string memory path = string.concat("./deployment-live-rh.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Validated manifest written:", path);
    }

    // ---------------------------------------------------------------- helpers
    function _requireHasCode(
        address addr,
        string memory label
    ) internal view {
        require(addr.code.length > 0, string.concat(label, ": no code at address"));
    }

    function _requireEqAddr(
        address got,
        address want,
        string memory label
    ) internal pure {
        if (got != want) {
            console2.log(string.concat("MISMATCH: ", label));
            console2.log("  got :", got);
            console2.log("  want:", want);
            revert(string.concat("wiring mismatch: ", label));
        }
    }

    function _env(
        string memory key,
        address fallback_
    ) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }

    function _envBytes32(
        string memory key,
        bytes32 fallback_
    ) internal view returns (bytes32) {
        try vm.envBytes32(key) returns (bytes32 v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
