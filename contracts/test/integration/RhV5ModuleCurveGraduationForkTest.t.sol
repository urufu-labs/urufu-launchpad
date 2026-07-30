// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// Reads used to clone RouterV2 ctor args off the live deployment when the
/// test needs the CURRENT source bytecode (with fresh fixes) at the live
/// address for fork exercises.
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
    function loyaltyOracle() external view returns (address);
    function curveFactory() external view returns (address);
    function factories(
        BaseType b
    ) external view returns (address);
    function minUruFee() external view returns (uint256);
}

interface IFactoryOwnedLike {
    function owner() external view returns (address);
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function implFor(
        bytes32
    ) external view returns (address);
}

interface IERC20Like {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
    function owner() external view returns (address);
}

interface ICurveFactoryReadLike {
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function defaultGraduationTargetEth() external view returns (uint256);
    function defaultTradeFeeBps() external view returns (uint16);
}

interface IMultiHookHostLike {
    function owed(
        Currency currency,
        address who
    ) external view returns (uint256);
    function platform() external view returns (address);
}

/// @title  RhV5ModuleCurveGraduationForkTest
/// @notice End-to-end matrix: launch each shipped ERC20 module through the LIVE V5
///         Router WITH `installBondingCurve = true`, drive the curve to graduation,
///         swap on the resulting v4 pool, and assert fees actually accrue.
///
///         The point of this file is to find real integration bugs where a module's
///         transfer-gating (AntiBot, AntiWhale, Pausable) fights the bonding curve's
///         curve→buyer transfer. Router does NOT allowlist/exclude the curve at
///         launch time — so any module that gates transfers by default rejects the
///         curve on the first buy. When that happens, the test FAILS loudly: the
///         failure trace pinpoints the bug (curve address that needed pre-approval).
///
///         Modules covered:
///           - Bare ERC20   (baseline; must pass so deltas are attributable)
///           - AntiBot      (transfer gate, block-based)
///           - AntiWhale    (per-tx / per-wallet caps, block-based)
///           - Pausable     (owner can pause; unpaused by default)
///           - Permit       (transparent)
///           - Airdrop      (Merkle claim, reserves a slice of supply — transparent)
///           - Vesting      (reserves a slice — transparent)
///           - Staking      (reserves a slice — transparent)
///           - Votes        (transparent)
///
///         FeeOnTransfer is skipped by design (blacklisted from curves); a sanity
///         assertion verifies the blacklist row is still on-chain.
///
///         Runs against a live RH mainnet fork. Only mutation is factory.setRouter
///         (needed because the on-chain factories on some rewire paths still point
///         at older router bytecode — same fork-only workaround the FoT test uses).
contract RhV5ModuleCurveGraduationForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // ---- LIVE V5 stack ----
    address internal constant ROUTER_V2 = 0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE;
    address internal constant GRADUATOR = 0x0d63E9D1b8EA9b3620ba75F1D6DA69eFf4adbd02;
    address internal constant MULTI_HOOK_HOST = 0x1Bb4666b905D81aE0b70aC63Df76Eea096efA2C4;
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    // ---- Module impl addresses (LibClone targets). Tests etch fresh source
    //      bytecode over these on the fork so the AntiBot allowlisted-from
    //      bypass + AntiWhale exclusion flow are exercised BEFORE the impls
    //      get redeployed on-chain. Same pattern as etching Router above.
    address internal constant ERC20_WITH_ANTIBOT_IMPL = 0x14b8132547d9e724Ce557F69897E66b9e699e64a;
    address internal constant ERC20_WITH_ANTIWHALE_IMPL = 0xdD7c50BEb82b53F8FFa746dd85cc3BcDa43BabcD;

    // ---- ConfigHashes matching the on-chain factory registrations. Same shape
    //      the frontend uses: keccak256(abi.encode("ERC20", <ModuleName>)).
    bytes32 internal constant BARE_ERC20 = keccak256(abi.encode("ERC20", ""));
    bytes32 internal constant ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal constant ANTIWHALE = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 internal constant PAUSABLE = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 internal constant PERMIT = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 internal constant AIRDROP = keccak256(abi.encode("ERC20", "Airdrop"));
    bytes32 internal constant VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal constant STAKING = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 internal constant VOTES = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 internal constant FOT = keccak256(abi.encode("ERC20", "FeeOnTransfer"));

    RouterV2 internal router;

    address internal launcher = makeAddr("launcher");
    address internal alice = makeAddr("alice");

    function setUp() public {
        // Skipped 2026-07-30: post-V8 rotation the live stack (Router, MHH,
        // Graduator) is no longer V5. These tests hardcode V5-era addresses in
        // their assertions and etches. Historical only — kept for reference.
        // TODO: refactor to dynamic reads from NameRegistry.router() +
        // CurveFactory.graduator() if the coverage is still valuable, then
        // remove this skip. See GraduatorV2Test.t.sol for the dynamic pattern.
        vm.skip(true);
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (ROUTER_V2.code.length == 0) vm.skip(true);

        // Etch the CURRENT source bytecode over the live V5 Router + the AntiBot /
        // AntiWhale impl targets. Live storage on Router is preserved (etch only
        // swaps the runtime code) and the impls have no immutables so no
        // ctor-mirror is needed. Same fork-only workaround pattern as the FoT
        // blacklist test — lets the fix be verified BEFORE any on-chain redeploy.
        _etchFreshRouterBytecodeOverLive();
        vm.etch(ERC20_WITH_ANTIBOT_IMPL, address(new ERC20WithAntiBotGen()).code);
        vm.etch(ERC20_WITH_ANTIWHALE_IMPL, address(new ERC20WithAntiWhaleGen()).code);

        router = RouterV2(payable(ROUTER_V2));

        _ensureFactoryPointsAtLiveRouter(ERC20_FACTORY);
        _ensureFactoryPointsAtLiveRouter(ERC721A_FACTORY);
        _ensureFactoryPointsAtLiveRouter(ERC1155_FACTORY);
        _restoreV5LiveWiringOnFork();

        vm.deal(launcher, 100 ether);
        vm.deal(alice, 100 ether);
    }

    /// Post-V6-broadcast, the LIVE V5 Router is paused and CurveFactory no longer
    /// trusts it. These tests etch fresh V5-bytecode over V5 address to exercise
    /// module × curve behavior without waiting on the V6 rewire; etch preserves
    /// storage, so paused=true and trustedRouters[V5]=false persist. Fork-only
    /// undo of both so tests still run cleanly against the etched Router.
    function _restoreV5LiveWiringOnFork() internal {
        (bool ok, bytes memory ret) = ROUTER_V2.staticcall(abi.encodeWithSignature("paused()"));
        if (ok && ret.length == 32 && abi.decode(ret, (bool))) {
            vm.prank(DEPLOYER);
            (bool okSet,) = ROUTER_V2.call(abi.encodeWithSignature("setPaused(bool)", false));
            require(okSet, "fork-unpause of V5 Router failed");
        }
        (bool okT, bytes memory retT) =
            CURVE_FACTORY.staticcall(abi.encodeWithSignature("trustedRouters(address)", ROUTER_V2));
        if (okT && retT.length == 32 && !abi.decode(retT, (bool))) {
            vm.prank(DEPLOYER);
            (bool okSetT,) =
                CURVE_FACTORY.call(abi.encodeWithSignature("setTrustedRouter(address,bool)", ROUTER_V2, true));
            require(okSetT, "fork-retrust of V5 Router on CurveFactory failed");
        }
        // NameRegistry.router was rotated to V6 by broadcast. Registry gates
        // name reservation on msg.sender==router, so V5 launches revert
        // NotRouter without this restore. Deployed NameRegistry has the
        // pre-timelock unrestricted setRouter (verified via bytecode grep),
        // so a plain setRouter call succeeds even though router != 0.
        (bool okN, bytes memory retN) =
            address(0x60b797f18292d941E72B2b59916C0afC1A81118C).staticcall(abi.encodeWithSignature("router()"));
        if (okN && retN.length == 32 && abi.decode(retN, (address)) != ROUTER_V2) {
            (bool okOwn, bytes memory retOwn) =
                address(0x60b797f18292d941E72B2b59916C0afC1A81118C).staticcall(abi.encodeWithSignature("owner()"));
            require(okOwn && retOwn.length == 32, "NameRegistry owner read failed");
            address own = abi.decode(retOwn, (address));
            vm.prank(own);
            (bool okSet,) = address(0x60b797f18292d941E72B2b59916C0afC1A81118C)
                .call(abi.encodeWithSignature("setRouter(address)", ROUTER_V2));
            require(okSet, "fork-restore NameRegistry.router to V5 failed");
        }
    }

    function _ensureFactoryPointsAtLiveRouter(
        address factory
    ) internal {
        if (IFactoryOwnedLike(factory).router() == ROUTER_V2) return;
        address own = IFactoryOwnedLike(factory).owner();
        vm.prank(own);
        IFactoryOwnedLike(factory).setRouter(ROUTER_V2);
    }

    /// Deploy a fresh RouterV2 with the CURRENT source (post-fix) and etch its
    /// runtime bytecode onto the live V5 Router address. Live storage remains
    /// intact — factories map, curveFactory pointer, ownership, minUruFee — so
    /// no re-wire is needed. The fresh Router's ctor args mirror the live ones
    /// so its baked-in immutables (uru, uruSink, registry, feeReceiver, fees)
    /// resolve to identical values, preventing bytecode/storage drift.
    function _etchFreshRouterBytecodeOverLive() internal {
        ILiveRouterReads live = ILiveRouterReads(ROUTER_V2);
        RouterV2 fresh = new RouterV2(
            address(this),
            NameRegistry(live.registry()),
            IFeeReceiver(live.feeReceiver()),
            live.fees(BaseType.ERC20),
            live.fees(BaseType.ERC721A),
            live.fees(BaseType.ERC1155),
            live.moduleAddOnFee(),
            live.hookAddOnFee(),
            live.governanceAddOnFee(),
            live.uru(),
            UruDepositSink(payable(live.uruSink()))
        );
        vm.etch(ROUTER_V2, address(fresh).code);
        // Audit remediation #3: fail-closed sentinels — etched bytecode
        // reads moduleCountConfigured + flagsConfigured mappings that are
        // in NEW slots; the pre-existing storage on the live Router has
        // the OLD mappings populated but nothing in the sentinel slots.
        // Seed sentinels for every hash any test in this suite launches.
        RouterV2 asFresh = RouterV2(payable(ROUTER_V2));
        address routerOwner = asFresh.owner();
        bytes32[] memory h = new bytes32[](10);
        uint256[] memory c = new uint256[](10);
        uint256[] memory f = new uint256[](10);
        h[0] = BARE_ERC20;
        c[0] = 0;
        h[1] = ANTIBOT;
        c[1] = 1;
        h[2] = ANTIWHALE;
        c[2] = 1;
        h[3] = PAUSABLE;
        c[3] = 1;
        h[4] = PERMIT;
        c[4] = 1;
        h[5] = AIRDROP;
        c[5] = 1;
        h[6] = VESTING;
        c[6] = 1;
        h[7] = STAKING;
        c[7] = 1;
        h[8] = VOTES;
        c[8] = 1;
        h[9] = FOT; // FLAG_BALANCE_MUTATING
        c[9] = 1;
        f[9] = 1;
        vm.prank(routerOwner);
        asFresh.setModuleCountForConfigBatch(h, c);
        vm.prank(routerOwner);
        asFresh.setFlagsForConfigBatch(h, f);
    }

    // ============================================================
    // Sanity — the assumptions this test suite relies on
    // ============================================================

    /// FoT is intentionally SKIPPED from the module matrix — it's blacklisted from
    /// curves because its transfer tax drifts the curve's arithmetic reserve on
    /// every trade. Assert the blacklist row is still present so a silent rotation
    /// doesn't make future launches through the curve path bricked or drifted.
    function test_Sanity_FoTBlacklistStillActive() public view {
        assertTrue(
            router.curveIncompatibleConfigHash(FOT),
            "FoT configHash MUST remain blacklisted from curve installs (transfer tax drifts curve reserve)"
        );
        assertTrue(
            IFactoryOwnedLike(ERC20_FACTORY).implFor(FOT) != address(0),
            "FoT impl must still be registered - blacklist covers curve path, not launch itself"
        );
    }

    // ============================================================
    // Baseline — Bare ERC20 must pass so any module delta is
    // attributable to the module, not the harness or curve.
    // ============================================================

    function test_Bare_LaunchAndGraduate() public {
        (address token, address curve) = _launchWithCurve(BARE_ERC20, "Bare Curve One", "BARE1", "", 1);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "bare: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // AntiBot — the module blocks any non-owner transfer while
    // block.number < gateEnd unless the recipient is on the
    // per-token allowlist. After ownership dispatch, owner() is
    // the launcher (KeepEOA) or 0 (Renounce) — the curve is
    // neither, and Router does NOT call setAntiBotAllowed(curve)
    // during launch. Result: the first buy against the curve tries
    // `_beforeTokenTransfer(curve → buyer)` which reverts with
    // AntiBot__Gated. This test asserts graduation succeeds — if
    // it fails, the failure trace names the bug ("curve not on
    // AntiBot allowlist"). Zero-gate path (blockGate=0) is the
    // trivial pass-through.
    // ============================================================

    /// Zero-gate AntiBot — module is present but gate window is empty, so no
    /// transfer is ever gated. Curve should graduate the same as bare.
    function test_AntiBot_ZeroGate_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(uint16(0));
        (address token, address curve) = _launchWithCurve(ANTIBOT, "AntiBot Zero", "ABZ", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "antibot(gate=0): curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    /// Realistic AntiBot — 5-block gate. Because Router does not allowlist the
    /// curve, the first `curve.buy` (same block as launch, well inside the gate)
    /// must fail with AntiBot__Gated. That IS the bug this test exists to catch:
    /// the Router→CurveFactory happy path leaves the curve unable to sell to
    /// buyers during the gate window, silently bricking the launch until the
    /// gate expires. The assertGraduated call reveals the failure loudly.
    function test_AntiBot_ActiveGate_RevealsCurveNotAllowlistedBug() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(uint16(5));
        (address token, address curve) = _launchWithCurve(ANTIBOT, "AntiBot Live", "ABL", abi.encode(mods), 2);

        // Sanity — the module is actually gated right now (else the test proves nothing).
        (bool okG, bytes memory retG) = token.staticcall(abi.encodeWithSignature("antiBotIsGated()"));
        assertTrue(okG, "antiBotIsGated view missing");
        assertTrue(abi.decode(retG, (bool)), "gate should be active immediately after launch");

        // The bug: Router never called setAntiBotAllowed(curve, true), so the very
        // first curve→buyer transfer during a buy will revert. If the assertion
        // below fails, the failure trace pins the exact allowlist miss.
        _buyUntilGraduated(curve);
        assertTrue(
            BondingCurve(payable(curve)).graduated(),
            "antibot(active): curve did not graduate - curve missing from allowlist"
        );

        // The AntiBot gate is designed to restrict trading for `gateBlocks`. Post-grad
        // trades through the v4 pool are still "trades" and should stay blocked while
        // the gate is active — the launcher chose that trade-off. Fast-forward past
        // the 5-block window to verify normal post-grad trading resumes cleanly.
        vm.roll(block.number + 10);
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // AntiWhale — per-tx / per-wallet caps that skip when either
    // side of the transfer is on the excluded set. Router (init
    // owner) is auto-excluded during init, so the Router→curve
    // transfer during curve install is safe. But once ownership
    // is dispatched away, the curve is NEITHER owner NOR excluded,
    // and the curve→buyer transfer during buy() will fail if the
    // amount exceeds maxTx OR the buyer's post-balance exceeds
    // maxWallet. Router does NOT call setAntiWhaleExcluded(curve),
    // so any realistic caps produce a broken launch.
    // ============================================================

    /// Loose caps — maxTx and maxWallet set high enough that curve buys never
    /// come close. Confirms the module itself is transparent when configured
    /// permissively.
    function test_AntiWhale_LooseCaps_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        // maxWallet = 1B tokens, maxTx = 1B tokens, expire in 0 blocks (immediate off).
        mods[0] = abi.encode(uint128(1_000_000_000e18), uint128(1_000_000_000e18), uint32(0));
        (address token, address curve) = _launchWithCurve(ANTIWHALE, "AntiWhale Loose", "AWL", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "antiwhale(loose): curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    /// Realistic caps — maxTx = 50M tokens, maxWallet = 100M tokens, gate active
    /// for 1000 blocks. A single buy that accumulates enough tokens to graduate
    /// will overshoot maxWallet on the buyer. Curve is not on the exclusion
    /// list, so curve→buyer trips the cap and buy() reverts. If the assertion
    /// fails the trace names the bug.
    function test_AntiWhale_RealisticCaps_RevealsCurveNotExcludedBug() public {
        // Skipped post-V6: the AntiWhale predicate fix (audit fix #4) is live
        // at source but the deployed composed impl for the AntiWhale config
        // hash still has the pre-fix bytecode. ERC20Factory has no updateImpl
        // (it's an older version), so the impl can't be rotated without a
        // full factory redeploy. This test documents the on-chain limitation
        // and will pass once matrix.json version bumps push new configHashes
        // through registerImpl (queued follow-up in project_robinhood_v6_deploy).
        vm.skip(true);

        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(uint128(100_000_000e18), uint128(50_000_000e18), uint32(1000));
        (address token, address curve) = _launchWithCurve(ANTIWHALE, "AntiWhale Real", "AWR", abi.encode(mods), 2);

        _buyUntilGraduated(curve);
        assertTrue(
            BondingCurve(payable(curve)).graduated(),
            "antiwhale(realistic): curve did not graduate - curve missing from exclusion set"
        );

        // Same rationale as AntiBot: whale caps expire in 1000 blocks; post-grad
        // trades count. Roll past to verify normal trading resumes.
        vm.roll(block.number + 1005);
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Pausable — owner can pause. Unpaused by default, so a
    // baseline launch-and-graduate must pass. (Once the launcher's
    // ownership is renounced during launch, pausing is impossible
    // by anyone — safe by construction for curve buyers.)
    // ============================================================

    function test_Pausable_Unpaused_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = "";
        (address token, address curve) = _launchWithCurve(PAUSABLE, "Pausable Curve", "PAUC", abi.encode(mods), 2);

        // Sanity — default state is unpaused.
        (bool okP, bytes memory retP) = token.staticcall(abi.encodeWithSignature("pausablePaused()"));
        assertTrue(okP && !abi.decode(retP, (bool)), "pausable: should start unpaused");

        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "pausable(unpaused): curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Permit — pure ERC20Permit surface, no transfer gating.
    // Transparent to bonding-curve buys.
    // ============================================================

    function test_Permit_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = "";
        (address token, address curve) = _launchWithCurve(PERMIT, "Permit Curve", "PMTC", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "permit: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Airdrop — reserves a slice of supply for post-launch Merkle
    // claims. Transparent to transfers. The reserve carve means
    // CurveFactory pulls (initialSupply - allocation) instead of
    // the full defaultCurveSupply — the curve is initialized with
    // the smaller pool, but graduationTargetEth is still hit at
    // the same ETH threshold (virtual reserves unchanged).
    // ============================================================

    function test_Airdrop_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        // 100e18 = 100 tokens reserved. Trivial vs 800M curve supply.
        mods[0] = abi.encode(bytes32(uint256(0xdeadbeef)), uint256(100e18));
        (address token, address curve) = _launchWithCurve(AIRDROP, "Airdrop Curve", "ADRC", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "airdrop: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Vesting — reserves a slice for linear vesting to a beneficiary.
    // Transparent to transfers.
    // ============================================================

    function test_Vesting_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(
            makeAddr("vestBeneficiary"),
            uint256(500e18),
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 400 days)
        );
        (address token, address curve) = _launchWithCurve(VESTING, "Vesting Curve", "VSTC", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "vesting: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Staking — reserves a rewards pool. Transparent to transfers.
    // ============================================================

    function test_Staking_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(uint256(1000e18), uint32(30 days));
        (address token, address curve) = _launchWithCurve(STAKING, "Staking Curve", "STKC", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "staking: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Votes — ERC20Votes checkpointing. Transparent to transfers.
    // ============================================================

    function test_Votes_LaunchAndGraduate() public {
        bytes[] memory mods = new bytes[](1);
        mods[0] = "";
        (address token, address curve) = _launchWithCurve(VOTES, "Votes Curve", "VTSC", abi.encode(mods), 2);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "votes: curve did not graduate");
        _postGradSwapAndAssertFeesAccrued(token);
    }

    // ============================================================
    // Helpers
    // ============================================================

    /// Launch through the LIVE V5 Router with `installBondingCurve = true`.
    ///  - initialSupply = defaultCurveSupply so the curve pulls the full pool
    ///    (reserve-backed modules carve their allocation before the CurveFactory
    ///    balanceOf-based pull, so the actual curveSupply is smaller by the
    ///    allocation — the virtual reserves are still the defaults, so
    ///    graduationTargetEth is unaffected).
    ///  - initialRecipient = ROUTER so Router holds the mint and can approve
    ///    the CurveFactory.
    ///  - OwnershipMode.Renounce so post-launch there is no admin to allowlist
    ///    the curve — mirrors most safe launches and forces the "does Router
    ///    do the right thing at launch time?" question.
    function _launchWithCurve(
        bytes32 configHash,
        string memory nm,
        string memory tk,
        bytes memory moduleDataAbi,
        uint256 moduleCount
    ) internal returns (address token, address curve) {
        uint256 supply = ICurveFactoryReadLike(CURVE_FACTORY).defaultCurveSupply();

        bytes memory initData;
        if (moduleDataAbi.length == 0) {
            initData = abi.encode(supply, ROUTER_V2, new bytes[](0));
        } else {
            bytes[] memory decoded = abi.decode(moduleDataAbi, (bytes[]));
            initData = abi.encode(supply, ROUTER_V2, decoded);
        }

        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: nm,
            ticker: tk,
            configHash: configHash,
            initData: initData,
            moduleCount: moduleCount,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });

        uint256 fee = router.quoteFor(p, launcher);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
        assertTrue(token != address(0), "router.launch returned zero");
        curve = ICurveFactoryReadLike(CURVE_FACTORY).curveFor(token);
        assertTrue(curve != address(0), "curveFactory has no curve for token");
    }

    /// Drive `alice` buying from the curve until it graduates. The mainnet
    /// default graduationTargetEth is 4 ETH with a 1% trade fee — we send
    /// 5 ETH which comfortably overshoots after fees. If ANY module gate
    /// interferes with the curve→buyer transfer, this call reverts and the
    /// per-module test's `assertTrue(graduated)` never runs — but the outer
    /// revert trace names the exact module error (AntiBot__Gated,
    /// AntiWhale__MaxTxExceeded, Pausable__Paused, etc.), so failures are
    /// self-diagnosing.
    function _buyUntilGraduated(
        address curve
    ) internal {
        BondingCurve c = BondingCurve(payable(curve));
        uint256 target = c.graduationTargetEth();
        assertGt(target, 0, "curve missing graduation target");
        // 5% headroom over target to cover the 1% buy fee and rounding.
        uint256 gross = (target * 110) / 100 + 1;
        vm.deal(alice, gross + 1 ether);
        vm.prank(alice);
        c.buy{value: gross}(0);
    }

    /// Post-graduation smoke test — do a small ETH→token swap through the LIVE
    /// V4SwapRouter and confirm the hook's ETH-side fee slot doesn't go
    /// backwards (buy path accrues fees on the unspecified side which is the
    /// token currency, so hook.owed[token][FeeSplitter] is what grows). We
    /// assert the token-side owed slot increased, proving both (a) the pool
    /// spawned and (b) the fee-accrual path is wired through the launched
    /// token's transfer surface — the whole point of the flywheel.
    function _postGradSwapAndAssertFeesAccrued(
        address token
    ) internal {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(MULTI_HOOK_HOST)
        });

        IMultiHookHostLike hook = IMultiHookHostLike(MULTI_HOOK_HOST);
        Currency tokenCurrency = Currency.wrap(token);
        address platform = hook.platform();
        assertEq(platform, FEE_SPLITTER, "hook.platform must be FeeSplitter - flywheel wire broken");
        uint256 tokenOwedBefore = hook.owed(tokenCurrency, platform);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        uint256 out = V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: 0.05 ether}(
            key, 0, alice, block.timestamp + 1
        );
        assertGt(out, 0, "post-grad buy produced zero tokens");

        uint256 tokenOwedAfter = hook.owed(tokenCurrency, platform);
        assertGt(
            tokenOwedAfter, tokenOwedBefore, "no token-side platform fee accrued to FeeSplitter after post-grad swap"
        );
    }
}
