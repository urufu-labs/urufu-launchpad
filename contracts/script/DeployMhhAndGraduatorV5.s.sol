// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";

interface ICurveFactoryAdmin {
    function graduator() external view returns (address);
    function setGraduator(
        address newGraduator
    ) external;
    function owner() external view returns (address);
}

/// @title  DeployMhhAndGraduatorV5
/// @notice Deploys a matched pair of MultiHookHost + GraduatorV2 and wires them
///         atomically in one broadcast:
///
///           1. mine + deploy new MultiHookHost (CREATE2, hook flags 0x22C4)
///           2. deploy new GraduatorV2 with the new MHH as its `defaultHook`
///           3. newMHH.setInitializer(newGraduator)  — one-shot lock, done same tx
///           4. CurveFactory.setGraduator(newGraduator)  — points new launches at it
///
///         Why this exists: the previous GraduatorV2 was deployed pointing at
///         the OLD (pre-V4-audit) MHH by mistake. That MHH's `setInitializer`
///         slot was one-shot-locked to a *different* graduator, so every new
///         curve's graduation reverted with UnauthorizedInitializer. We can't
///         re-authorize a one-shot slot, so the fix is a fresh MHH deploy that
///         is authorized on the NEW pair from birth.
///
///         Existing pre-V5 launches:
///           - Already-graduated tokens keep trading on their old MHH's pool
///             (v4 pool key includes the hook address, so their pool is
///             independent). No impact.
///           - Curves with old graduator burned in as immutable stay stuck.
///             Their tokens should be added to hiddenTokens.ts.
///
///         Env vars (fall back to RH mainnet V4 addresses):
///           ROBINHOOD_POOL_MANAGER_ADDRESS
///           ROBINHOOD_CURVE_FACTORY_ADDRESS
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           GRADUATOR_CREATOR_RECIPIENT   (fee-slot creator; defaults to broadcaster)
///           GRADUATOR_PLATFORM_BPS        (default 100)
///           GRADUATOR_CREATOR_BPS         (default 100)
///
///         Run:
///           forge script script/DeployMhhAndGraduatorV5.s.sol:DeployMhhAndGraduatorV5 \
///             --broadcast --rpc-url $RPC --private-key $PK
contract DeployMhhAndGraduatorV5 is Script {
    /// Canonical Foundry CREATE2 deployer; present on every EVM chain we target.
    /// `new X{salt}(...)` inside a `--broadcast` script routes through this
    /// address so the deploy tx is sent to the canonical deployer, producing
    /// the same address `HookMiner.find(CREATE2_DEPLOYER, ...)` predicted.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ---------- RH mainnet V4 defaults (per project_robinhood_v4_deploy memory) ----------
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    /// FeeSplitter V4 — receives the MHH platform-slot fees for the flywheel.
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

    /// Same fee tier + tick spacing as the existing (broken) graduator, so
    /// tooling that hard-coded these values (frontend v4 pool-id computation,
    /// indexer PoolManager filter) doesn't need updates.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    function run() external returns (address newMhh, address newGraduator) {
        address poolManager = _envAddress("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address curveFactory = _envAddress("ROBINHOOD_CURVE_FACTORY_ADDRESS", DEFAULT_CURVE_FACTORY);
        address feeSplitter = _envAddress("ROBINHOOD_FEE_SPLITTER_ADDRESS", DEFAULT_FEE_SPLITTER);
        address creatorRecipient = _envAddress("GRADUATOR_CREATOR_RECIPIENT", msg.sender);
        uint16 platformBps = uint16(_envUint("GRADUATOR_PLATFORM_BPS", 100));
        uint16 creatorBps = uint16(_envUint("GRADUATOR_CREATOR_BPS", 100));

        // ---------------- pre-flight sanity ----------------
        // Fail loud rather than half-deploying + leaving state torn. Everything
        // below assumes real, owner-controlled contracts at these addresses.
        require(poolManager.code.length > 0, "poolManager not a contract");
        require(curveFactory.code.length > 0, "curveFactory not a contract");
        require(feeSplitter.code.length > 0, "feeSplitter not a contract");

        address cfOwner = ICurveFactoryAdmin(curveFactory).owner();
        require(cfOwner == msg.sender, "broadcaster is not CurveFactory owner");

        address oldGraduator = ICurveFactoryAdmin(curveFactory).graduator();

        console2.log("---- pre-flight ----");
        console2.log("  PoolManager     :", poolManager);
        console2.log("  CurveFactory    :", curveFactory);
        console2.log("    owner         :", cfOwner);
        console2.log("    graduator (old):", oldGraduator);
        console2.log("  FeeSplitter     :", feeSplitter);
        console2.log("  creatorRecipient:", creatorRecipient);
        console2.log("  platformBps     :", platformBps);
        console2.log("  creatorBps      :", creatorBps);

        // ---------------- mine MHH address ----------------
        // Required flags = MHH's declared permissions. If we change MHH's
        // getHookPermissions() we MUST update this mask; a wrong mask would
        // deploy at an address v4 rejects on beforeInitialize / beforeSwap.
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

        // Constructor args must match the actual `new MultiHookHost(...)` call
        // below EXACTLY — HookMiner bakes them into the salt hash. Note the
        // trailing `msg.sender` is used for MHH's explicit `_deployer` slot
        // (the wallet allowed to call setInitializer once).
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), feeSplitter, creatorRecipient, platformBps, creatorBps, msg.sender);

        // Auto-bump past collisions. The V4 stack was mined with the same ctor
        // tuple (same PoolManager, FeeSplitter, deployer wallet, 100/100 bps)
        // so the FIRST satisfying salt lands on V4 MHH which is already
        // deployed. We just want the NEXT satisfying salt — same MHH
        // semantics, fresh unused hook address whose initializer slot we can
        // legitimately claim.
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
        require(predictedMhh.code.length == 0, "could not find empty MHH salt in 10 attempts");
        console2.log("---- mined ----");
        console2.log("  predicted MHH   :", predictedMhh);
        console2.log("  salt            :", salt);

        // ---------------- deploy + wire ----------------
        vm.startBroadcast();

        MultiHookHost mhh = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), feeSplitter, creatorRecipient, platformBps, creatorBps, msg.sender
        );
        require(address(mhh) == predictedMhh, "MHH salt drift");
        newMhh = address(mhh);
        console2.log("---- deployed ----");
        console2.log("  MHH             :", newMhh);

        GraduatorV2 g = new GraduatorV2(IPoolManager(poolManager), IHooks(newMhh), FEE, TICK_SPACING, curveFactory);
        newGraduator = address(g);
        console2.log("  GraduatorV2     :", newGraduator);

        // Lock the initializer slot NOW, in the same broadcast — closes the
        // front-run window where a griefer could otherwise call
        // setInitializer with their own address between our deploy and wire.
        mhh.setInitializer(newGraduator);
        console2.log("  setInitializer  : done ->", newGraduator);

        // Point the CurveFactory at the new graduator. Every new BondingCurve
        // clone that CurveFactory mints after this tx will burn `newGraduator`
        // into its immutable `graduator` field.
        ICurveFactoryAdmin(curveFactory).setGraduator(newGraduator);
        console2.log("  setGraduator    : done ->", newGraduator);

        vm.stopBroadcast();

        // ---------------- post-deploy verification ----------------
        // Belt-and-suspenders reads so a mis-wired deploy is loud, not silent.
        address readInit = MultiHookHost(payable(newMhh)).initializer();
        address readGrad = ICurveFactoryAdmin(curveFactory).graduator();
        address readHook = address(GraduatorV2(payable(newGraduator)).defaultHook());
        require(readInit == newGraduator, "MHH.initializer wrong");
        require(readGrad == newGraduator, "CurveFactory.graduator wrong");
        require(readHook == newMhh, "Graduator.defaultHook wrong");

        console2.log("");
        console2.log("=========================================================");
        console2.log("V5 MHH + Graduator wired");
        console2.log("=========================================================");
        console2.log("  MHH             :", newMhh);
        console2.log("  Graduator       :", newGraduator);
        console2.log("  Old graduator   :", oldGraduator, "(rollback target)");
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Update web/src/lib/config.ts MultiHookHost -> newMhh");
        console2.log("  2. Update Railway indexer env ROBINHOOD_MULTI_HOOK_HOST_ADDRESS -> newMhh");
        console2.log("  3. Bump ROBINHOOD_START_BLOCK_MHH so old-MHH backfill is not needed");
        console2.log("  4. Restart indexer + compile-service");
    }

    function _envAddress(
        string memory key,
        address fallback_
    ) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }

    function _envUint(
        string memory key,
        uint256 fallback_
    ) internal view returns (uint256) {
        try vm.envUint(key) returns (uint256 v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
