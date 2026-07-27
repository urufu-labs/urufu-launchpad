// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

interface ILiveRouterReads {
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function fees(
        BaseType b
    ) external view returns (uint256);
    function moduleAddOnFee() external view returns (uint256);
    function hookAddOnFee() external view returns (uint256);
    function governanceAddOnFee() external view returns (uint256);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function minUruFee() external view returns (uint256);
    function loyaltyOracle() external view returns (address);
    function curveFactory() external view returns (address);
    function factories(
        BaseType b
    ) external view returns (address);
    function paused() external view returns (bool);
    function owner() external view returns (address);
}

interface ILiveRouterAdmin {
    function setPaused(
        bool p
    ) external;
    function paused() external view returns (bool);
}

interface ICurveFactoryAdmin {
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function trustedRouters(
        address
    ) external view returns (bool);
}

interface IRoyaltyRouterFactoryAdmin {
    function setTrustedDeployer(
        address deployer_,
        bool trusted_
    ) external;
    function trustedDeployer(
        address
    ) external view returns (bool);
}

interface INameRegistryAdmin {
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
}

interface IBaseFactoryAdmin {
    function setRouter(
        address newRouter
    ) external;
    function router() external view returns (address);
    function owner() external view returns (address);
}

/// @title  RedeployRouterV6
/// @notice V6 Router single-phase redeploy. Verified against deployed bytecode,
///         not source: the LIVE NameRegistry (checked via cast keccak against
///         its deployed selectors) is the ORIGINAL unrestricted-setRouter
///         version, NOT the current-source propose/activate timelocked version.
///         Rotation is one call, no 48h wait.
///
///         Broadcast order matters:
///           1. Pre-flight asserts on live state.
///           2. Deploy V6 Router.
///           3. Mirror V5 state onto V6.
///           4. Pause V5 FIRST — closes the mempool window on V5 with the
///              clearest possible revert reason (Router__Paused) before any
///              rotation makes V5 launches revert with cryptic factory errors.
///           5. Rotate NameRegistry.setRouter(V6). Registry gates name reservation.
///           6. Rotate CurveFactory trust (V6=true, V5=false).
///           7. Rotate RoyaltyRouterFactory trust (V6=true, V5=false).
///           8. Rotate each base factory's router (V6).
///           9. Replay every FoT-inclusive configHash blacklist entry on V6.
///
///         Every rotation is HARD-ASSERTED (require, not try/catch+warn).
///         A single failed rotation aborts the whole broadcast so no silent
///         partial-migration ships.
///
/// Env vars (required):
///   V5_ROUTER_V2                current live RouterV2 (0x5EFA...)
///   CURVE_FACTORY               live CurveFactory
///   NAME_REGISTRY               live NameRegistry
///   ROYALTY_ROUTER_FACTORY      live RoyaltyRouterFactory
contract RedeployRouterV6 is Script {
    // Exhaustive on-chain sweep of ERC20Factory.implFor confirmed only these
    // three FoT-inclusive configHashes are registered on the live factory —
    // nothing else can be launched with a curve+FoT combination.
    bytes32 internal constant HASH_FOT_SOLO = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot,FeeOnTransfer"));
    bytes32 internal constant HASH_FOT_PERMIT = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));

    function run() external {
        address oldRouterAddr = vm.envAddress("V5_ROUTER_V2");
        address curveFactoryAddr = vm.envAddress("CURVE_FACTORY");
        address nameRegistryAddr = vm.envAddress("NAME_REGISTRY");
        address royaltyRouterFactoryAddr = vm.envAddress("ROYALTY_ROUTER_FACTORY");

        ILiveRouterReads oldReads = ILiveRouterReads(oldRouterAddr);

        // ============================================================
        // Pre-flight — every assumption we rely on, verified upfront.
        // ============================================================
        require(oldRouterAddr.code.length > 0, "V5 Router has no code");
        require(oldReads.owner() == msg.sender, "V5 Router not owned by broadcaster");
        require(!oldReads.paused(), "V5 already paused - is this a re-run?");
        require(
            INameRegistryAdmin(nameRegistryAddr).router() == oldRouterAddr,
            "NameRegistry.router != V5 - state drift, aborting"
        );
        console2.log("Pre-flight OK. Deploying V6...");

        // ============================================================
        // 1. Deploy V6 RouterV2.
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
        require(newRouter.code.length > 0, "V6 Router deploy produced empty code");
        console2.log("V6 Router deployed:", newRouter);

        // ============================================================
        // 2. Mirror V5's post-construction state onto V6.
        // ============================================================
        _mirrorState(newRouter, oldReads, curveFactoryAddr);

        // ============================================================
        // 3. Pause V5 FIRST. Any launch already in the mempool that
        //    targets V5 now reverts with Router__Paused (clearest
        //    possible error), before subsequent rotations would make
        //    V5 launches fail with cryptic factory onlyRouter errors.
        // ============================================================
        ILiveRouterAdmin v5Admin = ILiveRouterAdmin(oldRouterAddr);
        vm.startBroadcast();
        v5Admin.setPaused(true);
        vm.stopBroadcast();
        require(v5Admin.paused(), "assert failed: V5 paused");
        console2.log("  [ok+asserted] V5 Router paused");

        // ============================================================
        // 4. NameRegistry.setRouter(V6). Deployed contract does NOT have
        //    the source's one-shot RouterAlreadySet check (verified via
        //    bytecode selector grep: neither pendingRouter() nor
        //    RouterAlreadySet paths exist on-chain). Simple setter works.
        // ============================================================
        INameRegistryAdmin nr = INameRegistryAdmin(nameRegistryAddr);
        vm.startBroadcast();
        nr.setRouter(newRouter);
        vm.stopBroadcast();
        require(nr.router() == newRouter, "assert failed: NameRegistry.router != V6");
        console2.log("  [ok+asserted] NameRegistry.setRouter(V6)");

        // ============================================================
        // 5. Rotate CurveFactory trust: trust V6, untrust V5.
        // ============================================================
        ICurveFactoryAdmin cf = ICurveFactoryAdmin(curveFactoryAddr);
        vm.startBroadcast();
        cf.setTrustedRouter(newRouter, true);
        cf.setTrustedRouter(oldRouterAddr, false);
        vm.stopBroadcast();
        require(cf.trustedRouters(newRouter), "assert failed: CurveFactory.trustedRouters(V6) not true");
        require(!cf.trustedRouters(oldRouterAddr), "assert failed: CurveFactory.trustedRouters(V5) not false");
        console2.log("  [ok+asserted] CurveFactory trust rotated");

        // ============================================================
        // 6. Rotate RoyaltyRouterFactory trust: trust V6, untrust V5.
        // ============================================================
        IRoyaltyRouterFactoryAdmin rrf = IRoyaltyRouterFactoryAdmin(royaltyRouterFactoryAddr);
        vm.startBroadcast();
        rrf.setTrustedDeployer(newRouter, true);
        rrf.setTrustedDeployer(oldRouterAddr, false);
        vm.stopBroadcast();
        require(rrf.trustedDeployer(newRouter), "assert failed: RRF.trustedDeployer(V6) not true");
        require(!rrf.trustedDeployer(oldRouterAddr), "assert failed: RRF.trustedDeployer(V5) not false");
        console2.log("  [ok+asserted] RoyaltyRouterFactory trust rotated");

        // ============================================================
        // 7. Rotate the 3 base factories' router slot. onlyRouter check
        //    on factory.deploy() reads this — after rotation, V6 launches
        //    can call factory.deploy() but V5 can't.
        // ============================================================
        _rotateFactory(oldReads.factories(BaseType.ERC20), newRouter, "ERC20Factory");
        _rotateFactory(oldReads.factories(BaseType.ERC721A), newRouter, "ERC721AFactory");
        _rotateFactory(oldReads.factories(BaseType.ERC1155), newRouter, "ERC1155Factory");

        // ============================================================
        // 8. Blacklist replay on V6.
        // ============================================================
        _replayBlacklist(newRouter, HASH_FOT_SOLO, "FeeOnTransfer (solo)");
        _replayBlacklist(newRouter, HASH_FOT_ANTIBOT, "AntiBot,FeeOnTransfer");
        _replayBlacklist(newRouter, HASH_FOT_PERMIT, "FeeOnTransfer,Permit");

        // ============================================================
        // 9. Write the routerv6 address book so tools/sync-addresses.mjs
        //    can layer V6 over V4stack next run without manual edits.
        // ============================================================
        string memory obj = "routerv6";
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeAddress(obj, "RouterV2", newRouter);
        string memory bookPath = string.concat("deployment-routerv6.", vm.toString(block.chainid), ".json");
        vm.writeFile(bookPath, json);
        console2.log("  [ok] wrote address book:", bookPath);

        // ============================================================
        // Summary
        // ============================================================
        console2.log("=========================================================");
        console2.log("V6 mini-redeploy complete + fully asserted");
        console2.log("=========================================================");
        console2.log("  V6 Router (live):    ", newRouter);
        console2.log("  V5 Router (paused):  ", oldRouterAddr);
        console2.log("");
        console2.log("Immediate follow-up:");
        console2.log("  1. Verify V6 on Blockscout.");
        console2.log("  2. web/src/lib/config.ts robinhood.Router -> V6.");
        console2.log("  3. .env ROBINHOOD_ROUTER_ADDRESS -> V6.");
        console2.log("  4. Railway ROBINHOOD_ROUTER_ADDRESS -> V6, restart Ponder.");
        console2.log("  5. Rebuild + deploy frontend (Vercel).");
    }

    // ---------------------------------------------------------------- helpers

    function _mirrorState(
        address newRouter,
        ILiveRouterReads oldReads,
        address curveFactoryAddr
    ) internal {
        RouterV2 r = RouterV2(payable(newRouter));

        vm.startBroadcast();
        address f0 = oldReads.factories(BaseType.ERC20);
        require(f0 != address(0), "V5 ERC20Factory unset");
        r.setFactory(BaseType.ERC20, f0);

        address f1 = oldReads.factories(BaseType.ERC721A);
        require(f1 != address(0), "V5 ERC721AFactory unset");
        r.setFactory(BaseType.ERC721A, f1);

        address f2 = oldReads.factories(BaseType.ERC1155);
        require(f2 != address(0), "V5 ERC1155Factory unset");
        r.setFactory(BaseType.ERC1155, f2);

        r.setCurveFactory(curveFactoryAddr);

        address oracle = oldReads.loyaltyOracle();
        if (oracle != address(0)) r.setLoyaltyOracle(oracle);

        uint256 minFee = oldReads.minUruFee();
        if (minFee > 0) r.setMinUruFee(minFee);
        vm.stopBroadcast();

        require(r.factories(BaseType.ERC20) == f0, "assert failed: V6.factories(ERC20)");
        require(r.factories(BaseType.ERC721A) == f1, "assert failed: V6.factories(ERC721A)");
        require(r.factories(BaseType.ERC1155) == f2, "assert failed: V6.factories(ERC1155)");
        require(r.curveFactory() == curveFactoryAddr, "assert failed: V6.curveFactory");
        require(r.loyaltyOracle() == oracle, "assert failed: V6.loyaltyOracle");
        require(r.minUruFee() == minFee, "assert failed: V6.minUruFee");
        console2.log("  [ok+asserted] V6 state mirrored from V5");
    }

    function _rotateFactory(
        address factory,
        address newRouter,
        string memory name
    ) internal {
        require(factory != address(0), string.concat(name, ": address(0)"));
        IBaseFactoryAdmin f = IBaseFactoryAdmin(factory);
        require(f.owner() == msg.sender, string.concat(name, ": broadcaster is not owner"));
        vm.startBroadcast();
        f.setRouter(newRouter);
        vm.stopBroadcast();
        require(f.router() == newRouter, string.concat(name, ": assert failed router() != V6"));
        console2.log(string.concat("  [ok+asserted] ", name, ".setRouter(V6)"));
    }

    function _replayBlacklist(
        address router,
        bytes32 hash,
        string memory label
    ) internal {
        RouterV2 r = RouterV2(payable(router));
        vm.startBroadcast();
        r.setCurveIncompatibleConfigHash(hash, true);
        vm.stopBroadcast();
        require(r.curveIncompatibleConfigHash(hash), string.concat(label, ": assert failed blacklist not set"));
        console2.log(string.concat("  [ok+asserted] V6.blacklist(", label, ")"));
    }
}
