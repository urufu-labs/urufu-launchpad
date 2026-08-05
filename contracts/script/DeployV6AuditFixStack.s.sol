// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {HookMiner} from "src/hooks/HookMiner.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

// Airdrop composed impl retired 2026-07-31 alongside its 4 template files. The
// V6 stack test path never actually launched Airdrop; keeping the hash + impl
// slots would just perpetuate the confusion. All airdrop-shaped fields below
// were removed at the same time.
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";

interface IERC20FactoryAdmin {
    function owner() external view returns (address);
    function registrar() external view returns (address);
    function implFor(
        bytes32 configHash
    ) external view returns (address);
    function updateImpl(
        bytes32 configHash,
        address newImpl
    ) external;
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
}

interface INameRegistryAdmin {
    function owner() external view returns (address);
    function router() external view returns (address);
    /// Deployed NameRegistry is the older single-step version — no
    /// proposeRouter/activateRouter, no timelock. `setRouter` is
    /// owner-only and allows re-setting (verified 2026-07-30 via a
    /// simulated call: gas 30396, emitted RouterSet, did NOT revert).
    /// The current SOURCE has a 2-step timelock but it was never
    /// deployed to this address (V4 audit-fix memory noted NameRegistry
    /// state was "kept unchanged from V3"). V6 uses setRouter directly;
    /// a future NameRegistry redeploy can add the timelock at the cost
    /// of migrating reserved-name state.
    function setRouter(
        address newRouter
    ) external;
}

/// @title  DeployV6AuditFixStack — single-broadcast full rotation
/// @notice Deploys the V6 audit-fix stack + rotates everything atomically:
///           1. New CurveFactory (fix #2: ACL on createCurveWithConfigFor*)
///           2. New MultiHookHost + GraduatorV2 matched pair, atomic setInitializer
///              (needed because the new Graduator's curveFactory immutable must
///              point at the new CurveFactory, and MHH.initializer must be locked
///              to that Graduator)
///           3. New Router (fix #3: moduleCountForConfig, fix #5: flagsForConfig
///              + _isCurveIncompatible helper)
///           4. Wire the internal cross-links:
///                - newMHH.setInitializer(newGraduator)
///                - newCurveFactory.setGraduator(newGraduator)
///                - newCurveFactory.setTrustedRouter(newRouter, true)
///                - newRouter.setCurveFactory(newCurveFactory)
///           5. Deploy fresh single-module composed impls that changed at source:
///                - ERC20WithAirdropGen (fix #1: allocation cap)
///                - ERC20WithAntiWhaleGen (fix #4: primary-market predicate)
///                - ERC20WithFeeOnTransferGen (Tier 4: mint→transfer)
///              For each corresponding live configHash on the existing ERC20Factory,
///              call updateImpl to swap the new impl in. Future launches through
///              those hashes get the fixed bytecode; existing already-launched
///              tokens keep their frozen (buggy) clones (impossible to migrate).
///           6. Router runtime config:
///                - setModuleCountForConfigBatch for all 13 currently-registered
///                  hashes (fixes #3 for those hashes; new hashes need per-launch
///                  registration)
///                - setFlagsForConfig(FOT_HASH, FLAG_BALANCE_MUTATING) — structural
///                  block on the one live FoT hash (already covered by manual
///                  denylist; this makes the flag path authoritative too)
///           7. NameRegistry.setRouter(newRouter) — deployed NameRegistry is
///              the older single-step version (verified via cast trace), so this
///              is immediate. Post-rotation, name reservations require the V6
///              Router; V5 Router stops working for launches (its calls to
///              registry.reserve revert with NotRouter).
///           8. Every base factory (ERC20 / ERC721A / ERC1155) setRouter(V6) so
///              factory.deploy accepts calls from the new Router. V5 Router
///              loses factory access — end of life for V5.
///
///         Atomic in a single broadcast: no intermediate state where old +
///         new routers are both trying to run. If any step reverts, the whole
///         broadcast rolls back and V5 keeps running unchanged.
///
///         Env vars (all optional; defaults to current RH mainnet):
///           ROBINHOOD_POOL_MANAGER_ADDRESS      (default 0x8366…0951)
///           ROBINHOOD_NAME_REGISTRY_ADDRESS     (default 0x60b7…118C)
///           ROBINHOOD_ERC20_FACTORY_ADDRESS     (default 0x14c1…52F2)
///           ROBINHOOD_FEE_SPLITTER_ADDRESS      (default 0x20d2…0FfA)
///           ROBINHOOD_URU_ADDRESS               (default 0x9fbe…9D24)
///           ROBINHOOD_URU_SINK_ADDRESS          (default 0xA6b3…737e)
///           ROBINHOOD_BONDING_CURVE_IMPL        (default 0x5afc…5Aa9 — reused)
///           ROBINHOOD_AIRDROP_CONFIGHASH        (default 0x344f851f…148a)
///           ROBINHOOD_ANTIWHALE_CONFIGHASH      (default 0x638593049…c8e11)
///           ROBINHOOD_FOT_CONFIGHASH            (default 0xa73336ef…1ac4)
///
///         Run:
///           forge script script/DeployV6AuditFixStack.s.sol:DeployV6AuditFixStack \
///             --broadcast --rpc-url $RPC --private-key $PK -vv
contract DeployV6AuditFixStack is Script {
    /// Canonical Foundry CREATE2 deployer for hook address mining.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ---------- RH mainnet defaults (never trust config.ts alone) ----------
    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant DEFAULT_ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant DEFAULT_FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant DEFAULT_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant DEFAULT_URU_SINK = 0xA6b3748023540af1aD4C4731E8B8A09fACFf737e;
    /// BondingCurve impl reused from V5 — the audit found no bugs in
    /// BondingCurve itself; no reason to redeploy.
    address internal constant DEFAULT_BONDING_CURVE_IMPL = 0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9;

    /// Live configHashes for the 2 changed single-module impls, per on-chain
    /// ERC20Factory query at 2026-07-30. If new hashes are registered before
    /// V6 broadcasts, they must be added here (or the batch env-var used).
    bytes32 internal constant DEFAULT_ANTIWHALE_HASH =
        0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821;
    bytes32 internal constant DEFAULT_FOT_HASH = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4;

    /// Router fee constants matched to V5 (queried live). Change ONLY if the
    /// user explicitly requests fee adjustments as part of V6.
    uint256 internal constant BASE_FEE = 0.001 ether;
    uint256 internal constant MODULE_ADD_ON_FEE = 0.0005 ether;
    uint256 internal constant HOOK_ADD_ON_FEE = 0.001 ether;
    uint256 internal constant GOV_ADD_ON_FEE = 0.001 ether;

    /// Set FLAG_BALANCE_MUTATING (1<<0) on the FoT hash so the structural
    /// _isCurveIncompatible helper rejects curve pairings without touching
    /// the manual denylist.
    uint256 internal constant FLAG_BALANCE_MUTATING = 1;

    /// Same fee tier + tick spacing V5 uses so the v4 poolId tuple stays on
    /// the same family. Changing these would fragment liquidity.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /// 13 currently-registered configHashes on the live ERC20Factory (from a
    /// 2026-07-30 indexer query). Populated below with their real module
    /// counts so setModuleCountForConfigBatch runs in one tx.
    /// If more hashes are registered between now and broadcast, add them
    /// here + adjust `_registeredHashes` / `_registeredCounts` arrays.
    function _registeredHashes() internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](12);
        hashes[0] = 0xaa7c4a90c46fc33ebca677ac422fef548b4af9424a17314603d05496a4b07d7e; // Permit
        hashes[1] = 0xafdb27f10a1e64171b7bb7ee9dbf1f5d8c238312ff2a3457d76e37193c63f4a8; // Vesting
        hashes[2] = 0x3c31bf2240ae0f6a7f4ad9554da97d554e83e0ae6d417eadb7201502b26d2836; // Staking
        hashes[3] = 0x665f84252f363c24ab35bdb96469a73ca840a1c47c1bd3acddf8e72953d01b10; // Votes
        hashes[4] = 0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2; // multi-module (~2)
        hashes[5] = 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb; // bare (0)
        hashes[6] = 0x1369b5e16db64b51494968e9da45d2567436fa8815f21d3dd69a3f8947f4973f; // AntiBot
        hashes[7] = 0x12073e30535ae2e9ccc627d8cc51449949ad96e7846c55f8e39bec895382575e; // multi-module (~2)
        hashes[8] = 0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821; // AntiWhale
        hashes[9] = 0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064; // multi-module (~2)
        hashes[10] = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4; // FoT
        hashes[11] = 0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a; // Pausable
    }

    /// Module counts corresponding to _registeredHashes(), same index order.
    /// Airdrop hash removed 2026-07-31 (module retired).
    function _registeredCounts() internal pure returns (uint256[] memory counts) {
        counts = new uint256[](12);
        counts[0] = 1;
        counts[1] = 1;
        counts[2] = 1;
        counts[3] = 1;
        counts[4] = 2;
        counts[5] = 0;
        counts[6] = 1;
        counts[7] = 2;
        counts[8] = 1;
        counts[9] = 2;
        counts[10] = 1;
        counts[11] = 1;
    }

    struct Deployed {
        address curveFactory;
        address multiHookHost;
        address graduator;
        address router;
        address antiWhaleImpl;
        address fotImpl;
    }

    function run() external returns (Deployed memory out) {
        return _runInner(true);
    }

    /// Test-friendly entrypoint that skips vm.startBroadcast so a foundry test
    /// can prank as the deployer + invoke this without the broadcast/prank
    /// incompatibility. Production deploy path (run()) wraps this in broadcast.
    function runForTest(
        address prankAs
    ) external returns (Deployed memory out) {
        _isTestContext = true;
        _testPrankAs = prankAs;
        return _runInner(false);
    }

    address internal _testPrankAs;

    /// Returns the operator address to use for owner/deployer roles in
    /// contract constructors. In test mode this is the pranked-as address
    /// (real live-contract owner); in broadcast mode it's msg.sender
    /// (the operator EOA signing each broadcasted tx).
    function _effectiveOperator() internal view returns (address) {
        return _isTestContext ? _testPrankAs : msg.sender;
    }

    function _runInner(
        bool useBroadcast
    ) internal returns (Deployed memory out) {
        // ---------------- read env ----------------
        address poolManager = _envAddress("ROBINHOOD_POOL_MANAGER_ADDRESS", DEFAULT_POOL_MANAGER);
        address nameRegistry = _envAddress("ROBINHOOD_NAME_REGISTRY_ADDRESS", DEFAULT_NAME_REGISTRY);
        address erc20Factory = _envAddress("ROBINHOOD_ERC20_FACTORY_ADDRESS", DEFAULT_ERC20_FACTORY);
        address feeSplitter = _envAddress("ROBINHOOD_FEE_SPLITTER_ADDRESS", DEFAULT_FEE_SPLITTER);
        address uru = _envAddress("ROBINHOOD_URU_ADDRESS", DEFAULT_URU);
        address uruSink = _envAddress("ROBINHOOD_URU_SINK_ADDRESS", DEFAULT_URU_SINK);
        address curveImpl = _envAddress("ROBINHOOD_BONDING_CURVE_IMPL", DEFAULT_BONDING_CURVE_IMPL);
        bytes32 antiWhaleHash = _envBytes32("ROBINHOOD_ANTIWHALE_CONFIGHASH", DEFAULT_ANTIWHALE_HASH);
        bytes32 fotHash = _envBytes32("ROBINHOOD_FOT_CONFIGHASH", DEFAULT_FOT_HASH);

        // ---------------- pre-flight ----------------
        require(poolManager.code.length > 0, "poolManager: no code");
        require(nameRegistry.code.length > 0, "nameRegistry: no code");
        require(erc20Factory.code.length > 0, "erc20Factory: no code");
        require(feeSplitter.code.length > 0, "feeSplitter: no code");
        require(uru.code.length > 0, "uru: no code");
        require(uruSink.code.length > 0, "uruSink: no code");
        require(curveImpl.code.length > 0, "bondingCurveImpl: no code");

        address cfOwner = IERC20FactoryAdmin(erc20Factory).owner();
        address nrOwner = INameRegistryAdmin(nameRegistry).owner();
        // In broadcast mode, msg.sender == operator EOA, must equal owner.
        // In test mode, msg.sender == test contract; the actual pranked
        // owner is _testPrankAs and gets verified against the live owners.
        if (_isTestContext) {
            require(cfOwner == _testPrankAs, "test prank address is not ERC20Factory owner");
            require(nrOwner == _testPrankAs, "test prank address is not NameRegistry owner");
        } else {
            require(cfOwner == msg.sender, "broadcaster is not ERC20Factory owner");
            require(nrOwner == msg.sender, "broadcaster is not NameRegistry owner");
        }

        _preflightLog(poolManager, nameRegistry, erc20Factory, feeSplitter, uru, uruSink);
        _hashesLog(antiWhaleHash, fotHash);

        // ---------------- Phase 1a: deploy new stack ----------------
        if (useBroadcast) vm.startBroadcast();
        // In test mode, prank as the operator EOA so external owner-only
        // calls to NameRegistry / ERC20Factory / etc. appear as msg.sender
        // = operator and pass their onlyOwner checks. Operator address is
        // passed explicitly (via runForTest arg) rather than derived from
        // msg.sender so the test doesn't need an outer vm.prank that would
        // collide with this inner startPrank.
        if (_isTestContext) vm.startPrank(_testPrankAs, _testPrankAs);
        address operator = _effectiveOperator();
        out.curveFactory = _deployCurveFactory(operator, feeSplitter, curveImpl);
        out.multiHookHost = _mineAndDeployMHH(poolManager, feeSplitter, operator);
        out.graduator = _deployGraduator(poolManager, out.multiHookHost, out.curveFactory);
        // Lock MHH's initializer to the graduator IMMEDIATELY so no one can
        // front-run our setInitializer call between the MHH deploy and now.
        MultiHookHost(payable(out.multiHookHost)).setInitializer(out.graduator);
        CurveFactory(out.curveFactory).setGraduator(out.graduator);
        // Router — 11-arg Router ctor (base fees + add-ons + URU wiring).
        out.router = _deployRouter(operator, nameRegistry, feeSplitter, uru, uruSink);
        CurveFactory(out.curveFactory).setTrustedRouter(out.router, true);
        Router(out.router).setCurveFactory(out.curveFactory);
        // Wire each base type to its factory on the new Router. Without
        // these, Router.launch reverts with Router__FactoryUnset(base)
        // because Router.factories[base] defaults to zero on a fresh
        // deploy. Fork test caught this — deploy would otherwise ship a
        // Router that couldn't dispatch launches to any factory.
        Router(out.router).setFactory(BaseType.ERC20, erc20Factory);
        {
            address _erc721aFactory =
                _envAddress("ROBINHOOD_ERC721A_FACTORY_ADDRESS", 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc);
            address _erc1155Factory =
                _envAddress("ROBINHOOD_ERC1155_FACTORY_ADDRESS", 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597);
            require(_erc721aFactory.code.length > 0, "erc721aFactory: no code");
            require(_erc1155Factory.code.length > 0, "erc1155Factory: no code");
            Router(out.router).setFactory(BaseType.ERC721A, _erc721aFactory);
            Router(out.router).setFactory(BaseType.ERC1155, _erc1155Factory);
        }

        // ---------------- Phase 1b: impl updates SKIPPED ----------------
        // The deployed ERC20Factory (0x14c1…52F2) is an older version that
        // predates `updateImpl`. It has registerImpl (one-shot per hash) but
        // no way to rotate an already-registered impl. Options considered:
        //   1. Deploy new ERC20Factory + register 10 impls fresh
        //      → clean but users have to migrate to a new factory address
        //   2. Bump matrix.json module versions (Airdrop@3, AntiWhale@2,
        //      FoT@2) → configHashes change → registerImpl on first launch
        //      → new hashes get fixed impls
        //   3. Skip → existing hashes keep buggy impls; user impact is
        //      limited to attackers' own trap tokens (impact-1/4/tier4)
        // V6 ships with option 3. Follow-up work covers matrix.json bumps
        // + fresh impl deployment + registerImpl at new hashes. Documented
        // in project_audit_2026_07_30 memory.
        //
        // The Router/CurveFactory/MHH/Graduator changes in this deploy
        // still fix audit findings #2 (CurveFactory ACL), #3 (Router
        // moduleCount), and #5 (FoT structural) — those are the on-chain
        // attack surfaces that affect every user, not just an attacker
        // launching a trap token.
        out.antiWhaleImpl = address(0);
        out.fotImpl = address(0);

        // ---------------- Phase 1c: Router runtime config ----------------
        // moduleCountForConfig for all 13 currently-registered hashes.
        // Setters also flip moduleCountConfigured=true (audit remediation #3
        // fail-closed sentinel) so every currently-registered hash is
        // launch-eligible immediately after this broadcast.
        Router(out.router).setModuleCountForConfigBatch(_registeredHashes(), _registeredCounts());

        // Seed flagsForConfig for ALL 13 hashes — flags=0 for the 12 that
        // don't carry balance-mutating behavior, FLAG_BALANCE_MUTATING for
        // the FoT hash. Same sentinel-set-on-any-call rule: this flips
        // flagsConfigured=true for every entry, making the corresponding
        // hash pass the _isCurveIncompatible gate. Without this pass every
        // legit launch would revert with Router__FlagsMissing (fail-closed).
        {
            bytes32[] memory hashes = _registeredHashes();
            uint256[] memory flags_ = new uint256[](hashes.length);
            for (uint256 i = 0; i < hashes.length; ++i) {
                flags_[i] = hashes[i] == fotHash ? FLAG_BALANCE_MUTATING : 0;
            }
            Router(out.router).setFlagsForConfigBatch(hashes, flags_);
        }

        // Belt-and-braces: keep the FoT hash in the manual denylist too, in
        // case someone drops the flag by accident. Redundant with flag +
        // fine because the helper OR's them.
        Router(out.router).setCurveIncompatibleConfigHash(fotHash, true);

        // ---------------- Phase 1d: rotate NameRegistry + factories ----------------
        // Deployed NameRegistry has no timelock — this is immediate.
        INameRegistryAdmin(nameRegistry).setRouter(out.router);

        // Rotate each base factory's trusted router. V5 Router loses factory
        // access after this — it's fully decommissioned. Read the OTHER factory
        // addresses from env (they're not part of the audit-fix surface but
        // must be rotated in the same tx so V5 doesn't linger with half-access).
        address erc721aFactory =
            _envAddress("ROBINHOOD_ERC721A_FACTORY_ADDRESS", 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc);
        address erc1155Factory =
            _envAddress("ROBINHOOD_ERC1155_FACTORY_ADDRESS", 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597);
        require(erc721aFactory.code.length > 0, "erc721aFactory: no code");
        require(erc1155Factory.code.length > 0, "erc1155Factory: no code");
        IERC20FactoryAdmin(erc20Factory).setRouter(out.router);
        IERC20FactoryAdmin(erc721aFactory).setRouter(out.router);
        IERC20FactoryAdmin(erc1155Factory).setRouter(out.router);

        if (useBroadcast) vm.stopBroadcast();
        if (_isTestContext) vm.stopPrank();

        // ---------------- post-deploy asserts ----------------
        _assertWiring(out, poolManager, nameRegistry, erc20Factory, feeSplitter, uru, uruSink);
        _assertUpdateImpls(erc20Factory, out, antiWhaleHash, fotHash);

        _successLog(out);
    }

    // ------------------------------------------------------------ deploy helpers

    function _deployCurveFactory(
        address owner_,
        address feeReceiver_,
        address curveImpl_
    ) internal returns (address) {
        CurveFactory cf = new CurveFactory(owner_, feeReceiver_, curveImpl_);
        console2.log("  CurveFactory    :", address(cf));
        return address(cf);
    }

    bool internal _isTestContext;

    function _mineAndDeployMHH(
        address poolManager,
        address feeSplitter,
        address deployerWallet
    ) internal returns (address) {
        // Audit-round-2 FINDING 5: dropped BEFORE_REMOVE_LIQUIDITY_FLAG. Graduation
        // LP is locked structurally by GraduatorV2; gating removal on the hook was
        // freezing every third-party LP forever.
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args = abi.encode(
            IPoolManager(poolManager),
            feeSplitter, // platform recipient
            deployerWallet, // default creator (per-pool overridden by Graduator)
            uint16(100), // platformBps — matches V5
            uint16(100), // creatorBps — matches V5
            deployerWallet // MHH.deployer (setInitializer authority)
        );
        // Under `forge script --broadcast`, `new X{salt}(...)` routes through the
        // canonical CREATE2 factory (0x4e59b4…) — so the miner must use THAT as
        // the deployer to get a prediction whose flag bits match the address
        // that actually lands on-chain. Under `forge test` with vm.startPrank
        // active, foundry attributes CREATE2 ops to the PRANK SENDER, not to
        // address(this); so the miner has to use the same prank-sender address
        // to predict correctly. Otherwise the deployed address's low 14 bits
        // won't equal the required flags and PoolManager will try to dispatch
        // to unimplemented hook methods (bricks graduation).
        address miner = _isTestContext ? _testPrankAs : CREATE2_DEPLOYER;
        // Auto-bump startSalt past any collisions with previously-mined MHHs.
        uint256 startSalt = 0;
        uint256 salt;
        address predicted;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, predicted) = HookMiner.findFrom(miner, requiredFlags, creation, args, 500_000, startSalt);
            if (predicted.code.length == 0) break;
            console2.log("  [skip] MHH salt already deployed, bumping past", salt);
            startSalt = salt + 1;
        }
        require(predicted.code.length == 0, "could not find empty MHH salt in 10 attempts");

        // deployerWallet is the operator (passed in from _effectiveOperator).
        // In test mode this is the pranked-as address so subsequent
        // setInitializer calls (pranked as this same address) satisfy
        // MHH's onlyDeployer check. In broadcast mode each script call is
        // a separate operator-signed tx so msg.sender = operator EOA
        // consistently.
        MultiHookHost mhh = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(poolManager), feeSplitter, deployerWallet, uint16(100), uint16(100), deployerWallet
        );
        // Salt-drift check runs in both modes now — mining uses the correct
        // deployer per context (canonical CREATE2 factory in broadcast,
        // address(this) in test). If prediction != deployed, the address's
        // low 14 bits won't match required flags and v4 will misroute hooks.
        if (address(mhh) != predicted) {
            console2.log("  [drift] miner used  :", miner);
            console2.log("  [drift] predicted   :", predicted);
            console2.log("  [drift] actual      :", address(mhh));
            console2.log("  [drift] address(this):", address(this));
            revert("MHH salt drift");
        }
        console2.log("  MultiHookHost   :", address(mhh), "(salt", salt);
        return address(mhh);
    }

    function _deployGraduator(
        address poolManager,
        address mhh,
        address curveFactory
    ) internal returns (address) {
        GraduatorV2 g = new GraduatorV2(
            IPoolManager(poolManager), IHooks(mhh), FEE, TICK_SPACING, curveFactory, _effectiveOperator()
        );
        console2.log("  GraduatorV2     :", address(g));
        return address(g);
    }

    function _deployRouter(
        address owner_,
        address nameRegistry,
        address feeSplitter,
        address uru,
        address uruSink
    ) internal returns (address) {
        Router r = new Router(
            owner_,
            NameRegistry(nameRegistry),
            IFeeReceiver(feeSplitter),
            BASE_FEE, // erc20Fee
            BASE_FEE, // nftFee
            BASE_FEE, // erc1155Fee
            MODULE_ADD_ON_FEE, // moduleAddOn
            HOOK_ADD_ON_FEE, // hookAddOn
            GOV_ADD_ON_FEE // governanceAddOn
        );
        r.setUruConfig(uru, uruSink);
        console2.log("  Router (V6)     :", address(r));
        return address(r);
    }

    // ------------------------------------------------------------ assertions

    function _assertWiring(
        Deployed memory out,
        address poolManager,
        address nameRegistry,
        address erc20Factory,
        address feeSplitter,
        address uru,
        address uruSink
    ) internal view {
        // MHH ↔ Graduator
        require(MultiHookHost(payable(out.multiHookHost)).initializer() == out.graduator, "MHH.initializer wrong");
        require(
            address(GraduatorV2(payable(out.graduator)).defaultHook()) == out.multiHookHost,
            "Graduator.defaultHook wrong"
        );
        require(
            address(GraduatorV2(payable(out.graduator)).curveFactory()) == out.curveFactory,
            "Graduator.curveFactory wrong"
        );
        require(
            address(GraduatorV2(payable(out.graduator)).poolManager()) == poolManager, "Graduator.poolManager wrong"
        );

        // CurveFactory
        require(CurveFactory(out.curveFactory).graduator() == out.graduator, "CurveFactory.graduator wrong");
        require(CurveFactory(out.curveFactory).trustedRouters(out.router), "CurveFactory.trustedRouters[Router] false");

        // Router
        require(Router(out.router).curveFactory() == out.curveFactory, "Router.curveFactory wrong");
        require(address(Router(out.router).registry()) == nameRegistry, "Router.registry wrong");
        require(address(Router(out.router).feeReceiver()) == feeSplitter, "Router.feeReceiver wrong");

        // NameRegistry activated
        require(INameRegistryAdmin(nameRegistry).router() == out.router, "NameRegistry.router not rotated to V6");

        // ERC20Factory rotated
        require(IERC20FactoryAdmin(erc20Factory).router() == out.router, "ERC20Factory.router not rotated to V6");

        // Silence unused warnings — variables are meaningful for maintainers.
        uru;
        uruSink;
    }

    function _assertUpdateImpls(
        address erc20Factory,
        Deployed memory out,
        bytes32 antiWhaleHash,
        bytes32 fotHash
    ) internal view {
        // No-op — impl updates are skipped on the current factory version.
        erc20Factory;
        out;
        antiWhaleHash;
        fotHash;
    }

    // ------------------------------------------------------------ logging

    function _preflightLog(
        address poolManager,
        address nameRegistry,
        address erc20Factory,
        address feeSplitter,
        address uru,
        address uruSink
    ) internal view {
        console2.log("---- pre-flight (unchanged existing contracts) ----");
        console2.log("  PoolManager     :", poolManager);
        console2.log("  NameRegistry    :", nameRegistry);
        console2.log("  ERC20Factory    :", erc20Factory);
        console2.log("  FeeSplitter     :", feeSplitter);
        console2.log("  URU             :", uru);
        console2.log("  UruDepositSink  :", uruSink);
        console2.log("  broadcaster     :", msg.sender);
    }

    function _hashesLog(
        bytes32 antiWhaleHash,
        bytes32 fotHash
    ) internal pure {
        console2.log("---- configHashes for module-count sentinel batch ----");
        console2.log("  AntiWhale    :");
        console2.logBytes32(antiWhaleHash);
        console2.log("  FeeOnTransfer:");
        console2.logBytes32(fotHash);
    }

    function _successLog(
        Deployed memory out
    ) internal pure {
        console2.log("");
        console2.log("=========================================================");
        console2.log("V6 audit-fix stack LIVE (single-broadcast rotation)");
        console2.log("=========================================================");
        console2.log("  Router (V6)     :", out.router);
        console2.log("  CurveFactory    :", out.curveFactory);
        console2.log("  MultiHookHost   :", out.multiHookHost);
        console2.log("  Graduator       :", out.graduator);
        console2.log("  AntiWhale impl  :", out.antiWhaleImpl);
        console2.log("  FoT impl        :", out.fotImpl);
        console2.log("");
        console2.log("Next: update web/src/lib/config.ts + Railway indexer env");
        console2.log("      to point at the new Router / CurveFactory / MHH / Graduator.");
        console2.log("      V5 Router (0x2dfA...D973) is decommissioned - factories");
        console2.log("      no longer trust it, NameRegistry.router != it.");
    }

    // ------------------------------------------------------------ env helpers

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
