// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairGraduator} from "src/fair/FairGraduator.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

/// Read-only views on the live token-lane stack. Interfaces only, so this script never
/// links against the frozen V10 contracts.
interface ILiveCurveFactory {
    function graduator() external view returns (address);
    function feeReceiver() external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function defaultVirtualTokenReserve() external view returns (uint256);
    function defaultVirtualEthReserve() external view returns (uint256);
    function defaultGraduationTargetEth() external view returns (uint256);
    function defaultTradeFeeBps() external view returns (uint16);
}

interface ILiveGraduator {
    function defaultHook() external view returns (address);
    function poolManager() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface ILiveMhh {
    function platform() external view returns (address);
    function platformBps() external view returns (uint16);
    function creatorBps() external view returns (uint16);
    function initializer() external view returns (address);
}

/// @title  DeployFairLane
/// @notice Stands up the Fair launch lane (docs/SPEC-fair-launch.md) next to the live
///         token lane. NOT BROADCAST as of 2026-10-19: audit + Uniswap hook allowlist come
///         first.
///
///         Pre-flight (stale-env guard, from the 2026-07-30 V8 incident and the
///         2026-09-16 stale-book incident): nothing is read from a local address book.
///         Every live input is read from chain and cross-checked:
///           * chain id is Robinhood (4663) unless FAIR_ALLOW_ANY_CHAIN=true
///           * live CurveFactory -> graduator -> defaultHook == live MHH
///           * live graduator.poolManager == the PoolManager we pass the hook
///           * live MHH.initializer == live graduator (the pair is wired)
///           * MHH.platform == CurveFactory.feeReceiver (both fee streams hit the
///             FeeSplitter, so the 40/35/25 flywheel sees Fair-lane fees, spec D5)
///           * optional env pins (FAIR_EXPECT_POOL_MANAGER / FAIR_EXPECT_FEE_SPLITTER)
///             must match what chain says, or the script reverts
///         Curve defaults, fee bps, pool fee and tick spacing are copied from the live
///         stack so the two lanes cannot drift.
///
///         Deploy order: ERC20Template impl, FairBondingCurve impl, OpeningBatch impl,
///         FairHookHost (HookMiner + canonical CREATE2 deployer, flags 0x20C4),
///         FairGraduator, FairLaunchFactory. Wiring: hook.setInitializer(graduator),
///         graduator.setFactory(factory), factory.setDefaults(live values). New launches
///         stay CLOSED (`launchesOpen = false`) until the owner opens them.
///
///         Manual follow-ups after a broadcast: verify on Blockscout
///         (runs=10000, via_ir), submit the hook to the Uniswap allowlist, add the
///         FairHookHost to the keeper's pushOwed sweep and a burnBank job, then
///         index the new addresses.
///
///         Dry run:
///           forge script script/DeployFairLane.s.sol --rpc-url $ROBINHOOD_RPC_URL
contract DeployFairLane is Script {
    error DeployFairLane__WrongChain(uint256 chainId);
    error DeployFairLane__NoCode(string what, address at);
    error DeployFairLane__Stale(string what, address expected, address actual);
    error DeployFairLane__SaltDrift(address predicted);

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // Live token lane on Robinhood as of 2026-10-19 (V10 CF + V11 graduator / MHH pair).
    address internal constant LIVE_CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address internal constant LIVE_MHH = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;

    // Spec defaults D3 / D4.
    uint16 internal constant TAX_START_BPS = 2000;
    uint32 internal constant TAX_DECAY_SECS = 300;
    uint16 internal constant FORFEIT_DROP_BPS = 1000;

    struct Inputs {
        address admin;
        address poolManager;
        address platform;
        address feeReceiver;
        uint16 platformBps;
        uint16 creatorBps;
        uint24 poolFee;
        int24 tickSpacing;
        uint256 curveSupply;
        uint256 virtualTokenReserve;
        uint256 virtualEthReserve;
        uint256 graduationTargetEth;
        uint16 tradeFeeBps;
    }

    struct Deployed {
        address tokenImpl;
        address curveImpl;
        address batchImpl;
        address hook;
        uint256 hookSalt;
        address graduator;
        address factory;
    }

    bool internal _isTestContext;
    address internal _admin;

    function run() external returns (Deployed memory) {
        return _run();
    }

    /// Fork-test entrypoint: pranks the admin instead of broadcasting, skips the book.
    function runForTest(
        address admin
    ) external returns (Deployed memory) {
        _isTestContext = true;
        _admin = admin;
        return _run();
    }

    function _run() internal returns (Deployed memory d) {
        Inputs memory i = preflight();
        console2.log("pre-flight ok: PoolManager", i.poolManager);
        console2.log("               FeeSplitter", i.platform);

        // The hook's one-shot setInitializer and the owner-only wiring below run as the
        // broadcaster, so ADMIN must be the broadcasting wallet.
        if (!_isTestContext) require(i.admin == msg.sender, "ADMIN must be the broadcaster");

        if (_isTestContext) vm.startPrank(i.admin);
        else vm.startBroadcast();

        d.tokenImpl = address(new ERC20Template());
        d.curveImpl = address(new FairBondingCurve());
        d.batchImpl = address(new OpeningBatch());
        (d.hook, d.hookSalt) = _mineAndDeployHook(i);
        d.graduator = address(
            new FairGraduator(IPoolManager(i.poolManager), IHooks(d.hook), i.poolFee, i.tickSpacing, 0, i.admin)
        );
        d.factory =
            address(new FairLaunchFactory(i.admin, d.tokenImpl, d.curveImpl, d.batchImpl, d.graduator, i.feeReceiver));

        FairHookHost(payable(d.hook)).setInitializer(d.graduator);
        FairGraduator(payable(d.graduator)).setFactory(d.factory);
        FairLaunchFactory(d.factory)
            .setDefaults(
                i.curveSupply,
                i.virtualTokenReserve,
                i.virtualEthReserve,
                i.graduationTargetEth,
                i.tradeFeeBps,
                60, // D1
                2500, // D2
                0
            );

        if (_isTestContext) vm.stopPrank();
        else vm.stopBroadcast();

        _assertWiring(d, i);
        _log(d);
        if (!_isTestContext) _writeBook(d, i);
    }

    /// Reads every live input from chain and cross-checks it. Public so a dry run (or a
    /// test) can call it on its own.
    function preflight() public view returns (Inputs memory i) {
        if (block.chainid != 4663 && !vm.envOr("FAIR_ALLOW_ANY_CHAIN", false)) {
            revert DeployFairLane__WrongChain(block.chainid);
        }
        i.admin = _isTestContext ? _admin : vm.envOr("ADMIN", msg.sender);

        address cf = vm.envOr("FAIR_LIVE_CURVE_FACTORY", LIVE_CURVE_FACTORY);
        address mhh = vm.envOr("FAIR_LIVE_MHH", LIVE_MHH);
        _requireCode("live CurveFactory", cf);
        _requireCode("live MHH", mhh);

        address grad = ILiveCurveFactory(cf).graduator();
        _requireCode("live graduator", grad);
        address gradHook = ILiveGraduator(grad).defaultHook();
        if (gradHook != mhh) revert DeployFairLane__Stale("CF.graduator.defaultHook != MHH", mhh, gradHook);
        address mhhInit = ILiveMhh(mhh).initializer();
        if (mhhInit != grad) revert DeployFairLane__Stale("MHH.initializer != CF.graduator", grad, mhhInit);

        i.poolManager = ILiveGraduator(grad).poolManager();
        _requireCode("PoolManager", i.poolManager);
        address pinnedPm = vm.envOr("FAIR_EXPECT_POOL_MANAGER", i.poolManager);
        if (pinnedPm != i.poolManager) revert DeployFairLane__Stale("PoolManager env pin", pinnedPm, i.poolManager);

        i.platform = ILiveMhh(mhh).platform();
        i.feeReceiver = ILiveCurveFactory(cf).feeReceiver();
        if (i.platform != i.feeReceiver) {
            revert DeployFairLane__Stale("MHH.platform != CF.feeReceiver", i.feeReceiver, i.platform);
        }
        _requireCode("FeeSplitter", i.platform);
        address pinnedSplitter = vm.envOr("FAIR_EXPECT_FEE_SPLITTER", i.platform);
        if (pinnedSplitter != i.platform) {
            revert DeployFairLane__Stale("FeeSplitter env pin", pinnedSplitter, i.platform);
        }

        i.platformBps = ILiveMhh(mhh).platformBps();
        i.creatorBps = ILiveMhh(mhh).creatorBps();
        i.poolFee = ILiveGraduator(grad).fee();
        i.tickSpacing = ILiveGraduator(grad).tickSpacing();
        i.curveSupply = ILiveCurveFactory(cf).defaultCurveSupply();
        i.virtualTokenReserve = ILiveCurveFactory(cf).defaultVirtualTokenReserve();
        i.virtualEthReserve = ILiveCurveFactory(cf).defaultVirtualEthReserve();
        i.graduationTargetEth = ILiveCurveFactory(cf).defaultGraduationTargetEth();
        i.tradeFeeBps = ILiveCurveFactory(cf).defaultTradeFeeBps();
    }

    function _mineAndDeployHook(
        Inputs memory i
    ) internal returns (address hook, uint256 salt) {
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(FairHookHost).creationCode;
        bytes memory args = abi.encode(
            IPoolManager(i.poolManager),
            i.platform,
            i.platformBps,
            i.creatorBps,
            TAX_START_BPS,
            TAX_DECAY_SECS,
            FORFEIT_DROP_BPS,
            i.admin
        );
        uint256 start;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, hook) = HookMiner.findFrom(CREATE2_DEPLOYER, flags, creation, args, 500_000, start);
            if (hook.code.length == 0) break;
            start = salt + 1;
        }
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(bytes32(salt), creation, args));
        require(ok, "CREATE2 FairHookHost deploy failed");
        if (hook.code.length == 0) revert DeployFairLane__SaltDrift(hook);
    }

    function _assertWiring(
        Deployed memory d,
        Inputs memory i
    ) internal view {
        FairHookHost h = FairHookHost(payable(d.hook));
        FairGraduator g = FairGraduator(payable(d.graduator));
        FairLaunchFactory f = FairLaunchFactory(d.factory);
        require(uint160(d.hook) & 0x3FFF == 0x20C4, "hook flags");
        require(h.initializer() == d.graduator, "hook.initializer != graduator");
        require(address(h.poolManager()) == i.poolManager, "hook.poolManager");
        require(h.platform() == i.platform, "hook.platform != FeeSplitter");
        require(h.platformBps() == i.platformBps && h.creatorBps() == i.creatorBps, "hook fee bps drift");
        require(h.taxStartBps() == TAX_START_BPS && h.taxDecaySecs() == TAX_DECAY_SECS, "tax params");
        require(h.forfeitDropBps() == FORFEIT_DROP_BPS, "forfeit param");
        require(address(g.hook()) == d.hook && address(g.factory()) == d.factory, "graduator wiring");
        require(address(g.poolManager()) == i.poolManager, "graduator.poolManager");
        require(g.fee() == i.poolFee && g.tickSpacing() == i.tickSpacing, "pool key drift");
        require(f.graduator() == d.graduator && f.feeReceiver() == i.feeReceiver, "factory wiring");
        require(f.defaultCurveSupply() == i.curveSupply, "curve supply drift");
        require(f.defaultVirtualEthReserve() == i.virtualEthReserve, "virtual ETH drift");
        require(f.defaultGraduationTargetEth() == i.graduationTargetEth, "target drift");
        require(!f.launchesOpen(), "launches must start closed");
        require(f.owner() == i.admin && g.owner() == i.admin, "owner");
    }

    function _log(
        Deployed memory d
    ) internal pure {
        console2.log("=== Fair lane ===");
        console2.log("ERC20Template impl ", d.tokenImpl);
        console2.log("FairBondingCurve   ", d.curveImpl);
        console2.log("OpeningBatch       ", d.batchImpl);
        console2.log("FairHookHost       ", d.hook);
        console2.log("  salt             ", d.hookSalt);
        console2.log("FairGraduator      ", d.graduator);
        console2.log("FairLaunchFactory  ", d.factory);
    }

    function _writeBook(
        Deployed memory d,
        Inputs memory i
    ) internal {
        string memory o = "fairDeploy";
        vm.serializeAddress(o, "ERC20TemplateImpl", d.tokenImpl);
        vm.serializeAddress(o, "FairBondingCurveImpl", d.curveImpl);
        vm.serializeAddress(o, "OpeningBatchImpl", d.batchImpl);
        vm.serializeAddress(o, "FairHookHost", d.hook);
        vm.serializeUint(o, "FairHookHostSalt", d.hookSalt);
        vm.serializeAddress(o, "FairGraduator", d.graduator);
        vm.serializeAddress(o, "PoolManager", i.poolManager);
        vm.serializeAddress(o, "FeeSplitter", i.platform);
        string memory json = vm.serializeAddress(o, "FairLaunchFactory", d.factory);
        string memory path = string.concat("deployment-fair.", vm.toString(block.chainid), ".json");
        vm.writeFile(path, json);
        console2.log("wrote", path);
    }

    function _requireCode(
        string memory what,
        address at
    ) internal view {
        if (at.code.length == 0) revert DeployFairLane__NoCode(what, at);
    }
}
