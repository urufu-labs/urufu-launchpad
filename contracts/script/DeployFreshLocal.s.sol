// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {BaseType} from "src/types/VMTypes.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @title  DeployFreshLocal
/// @notice Deploys the ENTIRE launchpad stack from scratch to fresh addresses,
///         wired end-to-end against a real Uniswap v4 PoolManager. Intended for
///         a local anvil fork of a chain that already has v4 deployed (Ethereum
///         mainnet, Base, Robinhood).
///
///         Unlike `the historical stack deploy` (an upgrade script that assumes a live
///         NameRegistry / factories / LoyaltyOracle already exist), this script
///         assumes NOTHING pre-exists except the v4 PoolManager itself.
///
///         Deploy order + wiring:
///           1.  NameRegistry(owner, treasury, [])
///           2.  FeeReceiver(owner)
///           3.  Router(owner, registry, feeReceiver, fees…)
///           4.  registry.setRouter(router)                 — one-shot
///           5.  ERC20Template impl
///           6.  ERC20Factory(owner, router, registrar)
///           7.  factory.registerImpl(CH_BARE, impl)
///           8.  router.setFactory(ERC20, factory)
///           9.  BondingCurve impl
///           10. CurveFactory(owner, feeReceiver, curveImpl)
///           11. curveFactory.setTrustedRouter(router, true)
///           12. router.setCurveFactory(curveFactory)
///           13. mine + CREATE2-deploy MultiHookHost at a flag-valid address
///           14. GraduatorV2(poolManager, mhh, FEE, TICK_SPACING, curveFactory, owner)
///           15. mhh.setInitializer(graduator)               — one-shot
///           16. curveFactory.setGraduator(graduator)
///           17. V4SwapRouter(poolManager)
///
///         Writes `deployment-fresh.<chainid>.json` at the contracts/ root.
///
///         Run against a local anvil fork:
///           anvil --fork-url $MAINNET_RPC_URL --chain-id 1
///           forge script script/DeployFreshLocal.s.sol:DeployFreshLocal \
///             --broadcast --rpc-url http://127.0.0.1:8545 --private-key $DEV_PRIVATE_KEY
///
///         Env:
///           V4_POOL_MANAGER  (required) v4 PoolManager for the forked chain
///           PLATFORM_BPS     (default 100)  MHH platform slice
///           CREATOR_BPS      (default 100)  MHH creator fallback slice
contract DeployFreshLocal is Script {
    /// Canonical Foundry CREATE2 deployer — present on every chain we target.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Same pool params the rest of the stack hardcodes (indexer poolId
    /// derivation, frontend v4 reads). Do not change without updating those.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /// Matches the frontend's `configHashFor('ERC20', [])`.
    bytes32 internal constant CH_BARE = keccak256(abi.encode("ERC20", ""));

    struct Stack {
        address nameRegistry;
        address feeReceiver;
        address router;
        address erc20Impl;
        address erc20Factory;
        address bondingCurveImpl;
        address curveFactory;
        address multiHookHost;
        address graduator;
        address v4SwapRouter;
        address poolManager;
    }

    function run() external returns (Stack memory s) {
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));

        require(poolManager.code.length > 0, "V4_POOL_MANAGER has no code on this chain");

        // The broadcaster owns + registers everything on a local fork.
        address admin = msg.sender;
        s.poolManager = poolManager;

        console2.log("==== DeployFreshLocal ====");
        console2.log("  chainid     :", block.chainid);
        console2.log("  deployer    :", admin);
        console2.log("  PoolManager :", poolManager);

        // ---------------------------------------------------------------
        // Mine the MultiHookHost address BEFORE broadcasting. v4 encodes a
        // hook's permissions in the low bits of its address, so MHH can only
        // live at an address whose bits match getHookPermissions(). The ctor
        // args here must match the `new MultiHookHost{salt}` call below
        // EXACTLY — HookMiner bakes them into the salt preimage.
        // ---------------------------------------------------------------
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

        // Platform slice goes to the FeeReceiver we are about to deploy, so we
        // must know its address before mining. FeeReceiver is deployed by
        // `admin` via plain CREATE, so its address is a pure function of
        // (admin, nonce). Rather than predict a nonce — brittle — we deploy the
        // non-hook contracts FIRST, then mine with the real FeeReceiver address.

        vm.startBroadcast();

        // ---- 1. NameRegistry -------------------------------------------
        string[] memory noReserved = new string[](0);
        NameRegistry registry = new NameRegistry(admin, admin, noReserved);
        s.nameRegistry = address(registry);

        // ---- 2. FeeReceiver --------------------------------------------
        FeeReceiver feeReceiver = new FeeReceiver(admin);
        s.feeReceiver = address(feeReceiver);

        // ---- 3. Router --------------------------------------------------
        // Fees mirror the mainnet-target defaults in Router deploy.
        Router router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            0.05 ether, // ERC20 launch fee
            0.05 ether, // ERC721A launch fee
            0.05 ether, // ERC1155 launch fee
            0.01 ether, // module add-on
            0.01 ether, // hook add-on
            0.01 ether // governance add-on
        );
        s.router = address(router);

        // ---- 4. registry -> router (one-shot) ---------------------------
        registry.setRouter(address(router));

        // ---- 5/6/7/8. ERC20 template + factory --------------------------
        ERC20Template erc20Impl = new ERC20Template();
        s.erc20Impl = address(erc20Impl);

        ERC20Factory erc20Factory = new ERC20Factory(admin, address(router), admin);
        s.erc20Factory = address(erc20Factory);

        erc20Factory.registerImpl(CH_BARE, address(erc20Impl));
        router.setFactory(BaseType.ERC20, address(erc20Factory));

        // Router fails CLOSED on any configHash without a registered module
        // count and flag bitset — registerImpl (registrar role) and these two
        // (owner role) are separate privileges, so a hash live in the factory
        // but unknown to the Router must not be launchable. Bare ERC20 is a
        // 1-"module" config (the base itself) with no balance-mutating
        // modules, so flags = 0 keeps it bonding-curve eligible.
        router.setModuleCountForConfig(CH_BARE, 1);
        router.setFlagsForConfig(CH_BARE, 0);

        // ---- 9/10/11/12. Bonding curve + factory ------------------------
        BondingCurve curveImpl = new BondingCurve();
        s.bondingCurveImpl = address(curveImpl);

        CurveFactory curveFactory = new CurveFactory(admin, address(feeReceiver), address(curveImpl));
        s.curveFactory = address(curveFactory);

        curveFactory.setTrustedRouter(address(router), true);
        router.setCurveFactory(address(curveFactory));

        vm.stopBroadcast();

        // ---------------------------------------------------------------
        // 13. Mine + deploy MultiHookHost. Done outside the broadcast block
        //     for the mining itself (pure off-chain compute), then a fresh
        //     broadcast for the CREATE2 deploy.
        // ---------------------------------------------------------------
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), address(feeReceiver), admin, platformBps, creatorBps, admin);

        uint256 startSalt = 0;
        uint256 salt;
        address predictedMhh;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, predictedMhh) =
                HookMiner.findFrom(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000, startSalt);
            if (predictedMhh.code.length == 0) break;
            console2.log("  [skip] mined address already deployed, bumping past salt", salt);
            startSalt = salt + 1;
        }
        require(predictedMhh.code.length == 0, "could not find an empty MHH salt in 10 attempts");
        console2.log("  mined MHH   :", predictedMhh);
        console2.log("  salt        :", salt);

        vm.startBroadcast();

        MultiHookHost mhh = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), address(feeReceiver), admin, platformBps, creatorBps, admin
        );
        require(address(mhh) == predictedMhh, "MHH salt drift");
        s.multiHookHost = address(mhh);

        // ---- 14/15/16. Graduator, matched to this MHH -------------------
        GraduatorV2 graduator = new GraduatorV2(
            IPoolManager(poolManager), IHooks(address(mhh)), FEE, TICK_SPACING, address(curveFactory), admin
        );
        s.graduator = address(graduator);

        // One-shot lock, same broadcast — closes the front-run window.
        mhh.setInitializer(address(graduator));
        curveFactory.setGraduator(address(graduator));

        // ---- 17. V4SwapRouter -------------------------------------------
        V4SwapRouter swapRouter = new V4SwapRouter(IPoolManager(poolManager));
        s.v4SwapRouter = address(swapRouter);

        vm.stopBroadcast();

        _report(s);
        _write(s);
    }

    function _report(
        Stack memory s
    ) internal pure {
        console2.log("---- deployed (fresh addresses) ----");
        console2.log("  NameRegistry    :", s.nameRegistry);
        console2.log("  FeeReceiver     :", s.feeReceiver);
        console2.log("  Router          :", s.router);
        console2.log("  ERC20Template   :", s.erc20Impl);
        console2.log("  ERC20Factory    :", s.erc20Factory);
        console2.log("  BondingCurveImpl:", s.bondingCurveImpl);
        console2.log("  CurveFactory    :", s.curveFactory);
        console2.log("  MultiHookHost   :", s.multiHookHost);
        console2.log("  GraduatorV2     :", s.graduator);
        console2.log("  V4SwapRouter    :", s.v4SwapRouter);
        console2.log("  PoolManager     :", s.poolManager);
    }

    function _write(
        Stack memory s
    ) internal {
        string memory o = "fresh";
        vm.serializeAddress(o, "nameRegistry", s.nameRegistry);
        vm.serializeAddress(o, "feeReceiver", s.feeReceiver);
        vm.serializeAddress(o, "router", s.router);
        vm.serializeAddress(o, "erc20Impl", s.erc20Impl);
        vm.serializeAddress(o, "erc20Factory", s.erc20Factory);
        vm.serializeAddress(o, "bondingCurveImpl", s.bondingCurveImpl);
        vm.serializeAddress(o, "curveFactory", s.curveFactory);
        vm.serializeAddress(o, "multiHookHost", s.multiHookHost);
        vm.serializeAddress(o, "graduator", s.graduator);
        vm.serializeAddress(o, "v4SwapRouter", s.v4SwapRouter);
        string memory json = vm.serializeAddress(o, "poolManager", s.poolManager);
        vm.writeJson(json, string.concat("./deployment-fresh.", vm.toString(block.chainid), ".json"));
    }
}
