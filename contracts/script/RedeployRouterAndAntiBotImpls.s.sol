// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";
import {ERC20WithAntiBotAndFeeOnTransferGen} from "src/templates/composed/ERC20WithAntiBotAndFeeOnTransferGen.sol";

interface ILiveRouterReads {
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function fees(BaseType b) external view returns (uint256);
    function moduleAddOnFee() external view returns (uint256);
    function hookAddOnFee() external view returns (uint256);
    function governanceAddOnFee() external view returns (uint256);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function minUruFee() external view returns (uint256);
    function loyaltyOracle() external view returns (address);
    function curveFactory() external view returns (address);
    function factories(BaseType b) external view returns (address);
    function curveIncompatibleConfigHash(bytes32) external view returns (bool);
}

interface ILiveRouterAdmin {
    function setPaused(bool p) external;
    function owner() external view returns (address);
}

interface ICurveFactoryAdmin {
    function setGraduator(address) external;
    function setTrustedRouter(address router_, bool trusted_) external;
    function graduator() external view returns (address);
}

interface IRoyaltyRouterFactoryAdmin {
    function setTrustedDeployer(address deployer_, bool trusted_) external;
}

interface INameRegistryAdmin {
    function setRouter(address newRouter) external;
}

interface IBaseFactoryAdmin {
    /// Every base factory's `deploy()` has `onlyRouter` — post-Router-redeploy
    /// this needs updating or launches through the new Router revert.
    function setRouter(address newRouter) external;
    function router() external view returns (address);
    function updateImpl(bytes32 configHash, address newImpl) external;
    function implFor(bytes32 configHash) external view returns (address);
}

/// @title  RedeployRouterAndAntiBotImpls
/// @notice V6 mini-redeploy fixing two on-chain HIGH bugs surfaced post-V5:
///           (1) RouterV2.launch never allowlisted the bonding curve on the
///               launched token's AntiBot/AntiWhale modules, so ANY launch with
///               `AntiBot + curve` or `AntiWhale + realistic-caps + curve`
///               reverted on the first buy. The frontend blocks these combos
///               today via a `requiresOwner`/`taxesTransfers` UI gate, but a
///               direct-tx caller could still hit them.
///           (2) The AntiBot gate check only bypassed on `_abAllowed[to]`.
///               Even with the curve pre-allowlisted, buys still failed because
///               the buyer wasn't. Fix: bypass when EITHER endpoint is allowlisted.
///
///         Ships:
///           - New RouterV2 with `_grantCurveModuleAllowances(token, curve)` called
///             from every launch entrypoint (parent Router.launch + launchWithURU
///             + launchWithWhitelist + launchWithURUAndWhitelist). Allowlists the
///             curve, the Graduator (from-side of the graduation transferFrom), and
///             the PoolManager (to-side of the graduation liquidity transfer).
///           - Five fresh composed AntiBot impls whose `_beforeTokenTransfer`
///             hook bypasses the gate on `_abAllowed[from] || _abAllowed[to]`
///             (was to-only).
///
///         Rotates:
///           - `curveFactory.setGraduator` — unchanged (V5 Graduator stays live).
///           - `curveFactory.setTrustedRouter(newV6, true)` + `(oldV5, false)`.
///           - `NameRegistry.setRouter(newV6)`.
///           - `RoyaltyRouterFactory.setTrustedDeployer(newV6, true)` + `(oldV5, false)`.
///           - `newV6.setFactory(ERC20/721A/1155)` + `setCurveFactory` + `setLoyaltyOracle` + `setMinUruFee` (mirrored from V5).
///           - `newV6.setCurveIncompatibleConfigHash` for every hash the V5 Router
///             already blacklisted (kept in the script as constants — solo FoT
///             + composed AntiBot,FoT + composed FoT,Permit).
///           - `ERC20Factory.setRouter(newV6)` + `ERC721A/1155.setRouter(newV6)`.
///           - `ERC20Factory.updateImpl(hash, newImpl)` for each of the 5 fresh AntiBot impls.
///           - `oldV5Router.setPaused(true)`.
///
///         NOT redeployed (unchanged, unaffected):
///           - MultiHookHost, Graduator, CurveFactory, BondingCurveImpl,
///             FeeSplitter, UruDepositSink, UruBuybackVault, NftRevenueVault,
///             V4SwapRouter, RoyaltyRouterFactory, RoyaltyRouterImpl,
///             LoyaltyOracle, PoolManager, NameRegistry, ERC20Template,
///             ERC721A / ERC1155 factories + impls, all non-AntiBot module
///             impls (AntiWhale, Pausable, Permit, Airdrop, Vesting, Staking,
///             Votes, FoT solo, and composed impls without AntiBot).
///
/// Env vars (required):
///   V5_ROUTER_V2                current live RouterV2 (0x5EFA...)
///   CURVE_FACTORY               live CurveFactory
///   NAME_REGISTRY               live NameRegistry
///   ROYALTY_ROUTER_FACTORY      live RoyaltyRouterFactory
///
/// Post-deploy MANUAL steps:
///   1. Verify V6 Router + 5 fresh impl contracts on Blockscout.
///   2. Bump ROBINHOOD_ROUTER_ADDRESS in .env + Railway to V6.
///   3. Rebuild frontend with V6 Router in web/src/lib/config.ts.
///   4. Restart Ponder indexer (picks up new Router address from env).
contract RedeployRouterAndAntiBotImpls is Script {
    // Hashes the V5 Router already blacklists. Kept as constants so the redeploy
    // can replay them on the fresh V6 Router without loading logs from chain.
    bytes32 internal constant HASH_FOT_SOLO = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot,FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_PERMIT = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));

    // ConfigHashes for the 5 AntiBot impls that need bytecode rotation.
    bytes32 internal constant HASH_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal constant HASH_ANTIBOT_ANTIWHALE = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale"));
    bytes32 internal constant HASH_ANTIBOT_PERMIT = keccak256(abi.encode("ERC20", "AntiBot,Permit"));
    bytes32 internal constant HASH_ANTIBOT_ANTIWHALE_PERMIT =
        keccak256(abi.encode("ERC20", "AntiBot,AntiWhale,Permit"));
    bytes32 internal constant HASH_ANTIBOT_FOT_COMPOSED = keccak256(abi.encode("ERC20", "AntiBot,FeeOnTransfer"));

    function run() external {
        address oldRouterAddr = vm.envAddress("V5_ROUTER_V2");
        address curveFactory = vm.envAddress("CURVE_FACTORY");
        address nameRegistry = vm.envAddress("NAME_REGISTRY");
        address royaltyRouterFactory = vm.envAddress("ROYALTY_ROUTER_FACTORY");

        ILiveRouterReads oldReads = ILiveRouterReads(oldRouterAddr);

        // ============================================================
        // 1. Deploy the 5 fresh AntiBot impls (fix: bypass on either endpoint).
        // ============================================================
        vm.startBroadcast();
        address implAntiBot = address(new ERC20WithAntiBotGen());
        address implAntiBotAntiWhale = address(new ERC20WithAntiBotAntiWhaleGen());
        address implAntiBotPermit = address(new ERC20WithAntiBotPermitGen());
        address implAntiBotAntiWhalePermit = address(new ERC20WithAntiBotAntiWhalePermitGen());
        address implAntiBotFoT = address(new ERC20WithAntiBotAndFeeOnTransferGen());
        vm.stopBroadcast();
        console2.log("Fresh AntiBot impls deployed:");
        console2.log("  AntiBot                    :", implAntiBot);
        console2.log("  AntiBot,AntiWhale          :", implAntiBotAntiWhale);
        console2.log("  AntiBot,Permit             :", implAntiBotPermit);
        console2.log("  AntiBot,AntiWhale,Permit   :", implAntiBotAntiWhalePermit);
        console2.log("  AntiBot,FeeOnTransfer      :", implAntiBotFoT);

        // ============================================================
        // 2. Deploy V6 RouterV2 mirroring V5's ctor args.
        // ============================================================
        vm.startBroadcast();
        address newRouter = address(
            new RouterV2(
                msg.sender,
                NameRegistry(oldReads.registry()),
                IFeeReceiver(oldReads.feeReceiver()),
                oldReads.fees(BaseType.ERC20),
                oldReads.fees(BaseType.ERC721A),
                oldReads.fees(BaseType.ERC1155),
                oldReads.moduleAddOnFee(),
                oldReads.hookAddOnFee(),
                oldReads.governanceAddOnFee(),
                oldReads.uru(),
                UruDepositSink(payable(oldReads.uruSink()))
            )
        );
        vm.stopBroadcast();
        console2.log("V6 RouterV2 deployed:     ", newRouter);

        // ============================================================
        // 3. Wire the fresh Router's post-construction state from V5 live state.
        // ============================================================
        _wireNewRouter(newRouter, oldReads, curveFactory);

        // ============================================================
        // 4. Rotate external references onto the V6 Router.
        // ============================================================
        vm.startBroadcast();
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(newRouter, true);
        ICurveFactoryAdmin(curveFactory).setTrustedRouter(oldRouterAddr, false);
        vm.stopBroadcast();
        console2.log("  [ok] CurveFactory.setTrustedRouter(V6=true, V5=false)");

        _tryNameRegistrySetRouter(nameRegistry, newRouter);
        _tryRoyaltyRouterFactoryRotate(royaltyRouterFactory, newRouter, oldRouterAddr);

        // ============================================================
        // 5. Rotate the 3 base factories' `router` slot to V6.
        // ============================================================
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC20), newRouter, "ERC20Factory");
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC721A), newRouter, "ERC721AFactory");
        _tryFactorySetRouter(oldReads.factories(BaseType.ERC1155), newRouter, "ERC1155Factory");

        // ============================================================
        // 6. Rotate the 5 AntiBot impls on the ERC20Factory. New tokens using
        //    these configHashes clone the fresh impl (with the from/to bypass);
        //    already-deployed tokens keep their old impl bytecode (per-token
        //    clones don't re-read the factory's implFor after init) — safe by
        //    design since existing tokens have curve state that no rotation
        //    should touch.
        // ============================================================
        address erc20Factory = oldReads.factories(BaseType.ERC20);
        _tryUpdateImpl(erc20Factory, HASH_ANTIBOT, implAntiBot, "AntiBot");
        _tryUpdateImpl(erc20Factory, HASH_ANTIBOT_ANTIWHALE, implAntiBotAntiWhale, "AntiBot,AntiWhale");
        _tryUpdateImpl(erc20Factory, HASH_ANTIBOT_PERMIT, implAntiBotPermit, "AntiBot,Permit");
        _tryUpdateImpl(
            erc20Factory, HASH_ANTIBOT_ANTIWHALE_PERMIT, implAntiBotAntiWhalePermit, "AntiBot,AntiWhale,Permit"
        );
        _tryUpdateImpl(erc20Factory, HASH_ANTIBOT_FOT_COMPOSED, implAntiBotFoT, "AntiBot,FeeOnTransfer");

        // ============================================================
        // 7. Replay every FoT-inclusive blacklist hash on the fresh V6 Router.
        // ============================================================
        _replayBlacklist(newRouter, HASH_FOT_SOLO, "FeeOnTransfer (solo)");
        _replayBlacklist(newRouter, HASH_FOT_ANTIBOT, "AntiBot,FeeOnTransfer");
        _replayBlacklist(newRouter, HASH_FOT_PERMIT, "FeeOnTransfer,Permit");

        // ============================================================
        // 8. Pause V5 Router so no launches land there while the frontend swap propagates.
        // ============================================================
        _pauseOldRouter(oldRouterAddr);

        _logSummary(newRouter, oldRouterAddr, implAntiBot, implAntiBotAntiWhale, implAntiBotPermit);
    }

    // ---------------------------------------------------------------- New Router wiring
    function _wireNewRouter(address newRouter, ILiveRouterReads oldReads, address curveFactory) internal {
        RouterV2 r = RouterV2(payable(newRouter));

        vm.startBroadcast();
        address f0 = oldReads.factories(BaseType.ERC20);
        if (f0 != address(0)) r.setFactory(BaseType.ERC20, f0);
        address f1 = oldReads.factories(BaseType.ERC721A);
        if (f1 != address(0)) r.setFactory(BaseType.ERC721A, f1);
        address f2 = oldReads.factories(BaseType.ERC1155);
        if (f2 != address(0)) r.setFactory(BaseType.ERC1155, f2);

        r.setCurveFactory(curveFactory);

        address oracle = oldReads.loyaltyOracle();
        if (oracle != address(0)) r.setLoyaltyOracle(oracle);

        uint256 minFee = oldReads.minUruFee();
        if (minFee > 0) r.setMinUruFee(minFee);
        vm.stopBroadcast();
        console2.log("  [ok] V6.setFactory x3 + setCurveFactory + setLoyaltyOracle + setMinUruFee");
    }

    function _tryNameRegistrySetRouter(address nameRegistry, address newRouter) internal {
        vm.startBroadcast();
        try INameRegistryAdmin(nameRegistry).setRouter(newRouter) {
            console2.log("  [ok] NameRegistry.setRouter(V6)");
        } catch {
            console2.log("  [warn] NameRegistry.setRouter FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _tryRoyaltyRouterFactoryRotate(address rrf, address newRouter, address oldRouter) internal {
        vm.startBroadcast();
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(newRouter, true) {
            console2.log("  [ok] RRF.setTrustedDeployer(V6, true)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(V6) FAILED (needs multisig)");
        }
        try IRoyaltyRouterFactoryAdmin(rrf).setTrustedDeployer(oldRouter, false) {
            console2.log("  [ok] RRF.setTrustedDeployer(V5, false)");
        } catch {
            console2.log("  [warn] RRF.setTrustedDeployer(V5, false) FAILED (needs multisig)");
        }
        vm.stopBroadcast();
    }

    function _tryFactorySetRouter(address factory, address newRouter, string memory name) internal {
        if (factory == address(0)) return;
        vm.startBroadcast();
        try IBaseFactoryAdmin(factory).setRouter(newRouter) {
            console2.log(string.concat("  [ok] ", name, ".setRouter(V6)"));
        } catch {
            console2.log(string.concat("  [warn] ", name, ".setRouter FAILED (needs owner)"));
        }
        vm.stopBroadcast();
    }

    function _tryUpdateImpl(address factory, bytes32 hash, address newImpl, string memory name) internal {
        vm.startBroadcast();
        try IBaseFactoryAdmin(factory).updateImpl(hash, newImpl) {
            console2.log(string.concat("  [ok] Factory.updateImpl(", name, ")"));
        } catch {
            console2.log(string.concat("  [warn] Factory.updateImpl(", name, ") FAILED (needs owner)"));
        }
        vm.stopBroadcast();
    }

    function _replayBlacklist(address router, bytes32 hash, string memory label) internal {
        vm.startBroadcast();
        try RouterV2(payable(router)).setCurveIncompatibleConfigHash(hash, true) {
            console2.log(string.concat("  [ok] V6.blacklist(", label, ")"));
        } catch {
            console2.log(string.concat("  [warn] V6.blacklist(", label, ") FAILED"));
        }
        vm.stopBroadcast();
    }

    function _pauseOldRouter(address oldRouterAddr) internal {
        vm.startBroadcast();
        try ILiveRouterAdmin(oldRouterAddr).setPaused(true) {
            console2.log("  [ok] V5 Router setPaused(true)");
        } catch {
            console2.log("  [warn] V5 Router setPaused FAILED - operator must call from owner");
        }
        vm.stopBroadcast();
    }

    function _logSummary(
        address newRouter,
        address oldRouter,
        address implAntiBot,
        address implAntiBotAntiWhale,
        address implAntiBotPermit
    ) internal view {
        console2.log("=========================================================");
        console2.log("V6 mini-redeploy complete");
        console2.log("=========================================================");
        console2.log("  chainid:                     ", block.chainid);
        console2.log("  --- NEW ---");
        console2.log("  RouterV2 (V6):               ", newRouter);
        console2.log("  ERC20WithAntiBotImpl:        ", implAntiBot);
        console2.log("  ERC20WithAntiBotAntiWhale:   ", implAntiBotAntiWhale);
        console2.log("  ERC20WithAntiBotPermit:      ", implAntiBotPermit);
        console2.log("  (see broadcast log for remaining 2 impls)");
        console2.log("  --- OLD (paused / superseded) ---");
        console2.log("  RouterV2 (V5):               ", oldRouter);
    }
}
