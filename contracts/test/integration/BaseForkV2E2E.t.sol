// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Router} from "src/router/Router.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithAirdropVestingGen} from "src/templates/composed/ERC20WithAirdropVestingGen.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @title  BaseForkV2E2E — end-to-end validation of the V3 hook + V2 templates stack
///         against production Base contracts, no gas cost.
///
/// @notice This test forks Base mainnet at a recent block and exercises the whole
///         production flow that a real launcher would trigger from the create page:
///
///           1. Launch an ERC20 with V2 Airdrop through the current production
///              Router (V3 hook + V2 CurveFactory) — with a bonding curve, the
///              path that most people will pick.
///           2. Assert reserve carve-out on init (curve gets supply-alloc, token
///              holds the reserve, total supply == initial mint).
///           3. Assert on-chain wiring: Router uses V2 CF; CF uses V3 Graduator;
///              curve.launcher matches Router.launch caller.
///           4. Buy through the curve, verify supply invariant preserved.
///           5. Claim an airdrop from the reserve, verify supply invariant.
///           6. Assert the V3 hook rejects a malicious pool init (the H2 attack
///              class we shipped V3 for).
///           7. Direct-launch path with KeepEOA — verify launcher becomes owner
///              so profile-page owner-controls work.
///
///         Zero mainnet gas. Zero risk. Provides pre-broadcast confidence that
///         everything the create page will do actually works against the real
///         production contract state.
///
/// Fork:
///   forge test --match-contract BaseForkV2E2ETest --fork-url $BASE_RPC_URL -vv
///
///   (skipped without a fork so `forge test` in local dev doesn't require an RPC)
contract BaseForkV2E2ETest is Test {
    // Production Base mainnet addresses (verified in web/src/lib/config.ts + on
    // the block explorer). Sourced from the latest V3 hook + V2 templates deploy.
    Router internal constant ROUTER = Router(payable(0x38461D94d6f84204399132AEc891E3B90563939a));
    ERC20Factory internal constant ERC20_FACTORY = ERC20Factory(0x347c9567bf379a5a046f925498FD805a9A34457A);
    CurveFactory internal constant CURVE_FACTORY_V2 = CurveFactory(0x3Ac6737141c77498d645836e5652Cc5b091B9b02);
    MultiHookHost internal constant HOOK_V3 = MultiHookHost(payable(0xb6b8e00450Ca203b96498E2577CCEEf92029e2c4));
    Graduator internal constant GRADUATOR_V3 = Graduator(payable(0xfB55944f70c5ba2bc8962eBB75934e9D8ab40715));
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    // V2 impl addresses (registered on ERC20_FACTORY under @2 configHashes).
    address internal constant AIRDROP_V2_IMPL = 0x22C9D5640b30afC5cD935b30F59d0C5eA9FA32af;
    address internal constant VESTING_V2_IMPL = 0x0aEe4238A3a7a8e13cE591ffA5E07CfA22674bC4;
    address internal constant AIRDROP_VESTING_V2_IMPL = 0xA8F5E4ab757b05665A5F9a39d16e6b6DA9895F8d;

    // Bare ERC20 impl for the direct-launch path — registered under legacy hash.
    address internal constant BARE_ERC20_IMPL = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;

    // ConfigHashes matching web/src/lib/modules.ts:configHashFor logic. V2 modules
    // get @version tags; v1-only tuples keep the legacy formula.
    bytes32 internal AIRDROP_V2_HASH = keccak256(abi.encode("ERC20", "Airdrop@2"));
    bytes32 internal VESTING_V2_HASH = keccak256(abi.encode("ERC20", "Vesting@2"));
    bytes32 internal AIRDROP_VESTING_V2_HASH = keccak256(abi.encode("ERC20", "Airdrop@2,Vesting@2"));
    bytes32 internal BARE_HASH = keccak256(abi.encode("ERC20", ""));

    address internal launcher = makeAddr("v2e2e_launcher");
    address internal buyer = makeAddr("v2e2e_buyer");
    address internal claimer;
    address internal beneficiary = makeAddr("v2e2e_vest_beneficiary");

    /// The airdrop merkle contains ONE leaf so the "proof" is empty (single-leaf tree
    /// where the root == the leaf hash). Amount is 25M tokens — the launcher will
    /// reserve exactly 25M so the reserve matches the merkle sum.
    uint256 internal constant AIRDROP_AMOUNT = 25_000_000e18;
    uint256 internal constant AIRDROP_ALLOCATION = 25_000_000e18;
    uint256 internal constant VESTING_ALLOCATION = 100_000_000e18;
    uint256 internal constant CURVE_DEFAULT_SUPPLY = 800_000_000e18;

    function setUp() public {
        // Skip if not forking — this is a Base-mainnet-only e2e. Local `forge test`
        // without --fork-url will silently no-op the whole suite.
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true);
        }
        // If we did fork, sanity-check the contracts actually exist at those
        // addresses on this fork. If not, skip — happens on Base Sepolia fork or
        // any other chain that doesn't have our production V2 stack.
        if (address(ROUTER).code.length == 0) vm.skip(true);
        if (address(CURVE_FACTORY_V2).code.length == 0) vm.skip(true);
        if (address(HOOK_V3).code.length == 0) vm.skip(true);
        if (address(GRADUATOR_V3).code.length == 0) vm.skip(true);

        // claimer address depends on the merkle we build, so derive it from a fixed key
        claimer = makeAddr("v2e2e_airdrop_claimer");
        vm.deal(launcher, 5 ether);
        vm.deal(buyer, 100 ether);
    }

    // ============================================================================
    // Assertion 1: production wiring is correct
    // ============================================================================

    function test_ProductionWiring_RouterCurveFactoryGraduatorHook() public view {
        // Router routes NEW launches through V2 CurveFactory.
        assertEq(ROUTER.curveFactory(), address(CURVE_FACTORY_V2), "Router->CurveFactoryV2");
        // V2 CurveFactory routes graduations through V3 Graduator.
        assertEq(CURVE_FACTORY_V2.graduator(), address(GRADUATOR_V3), "CurveFactoryV2->GraduatorV3");
        // V3 Graduator uses V3 hook as its defaultHook (from constructor).
        assertEq(address(GRADUATOR_V3.defaultHook()), address(HOOK_V3), "GraduatorV3.defaultHook==HookV3");
        // V3 hook's initializer gate points at V3 Graduator — any other sender can't
        // initialize a pool through this hook. Blocks the pool-init griefing DoS.
        assertEq(HOOK_V3.initializer(), address(GRADUATOR_V3), "HookV3.initializer==GraduatorV3");
        // V2 Airdrop impl is registered on the ERC20Factory under the versioned hash.
        assertEq(ERC20_FACTORY.implFor(AIRDROP_V2_HASH), AIRDROP_V2_IMPL, "Airdrop@2 impl registered");
    }

    // ============================================================================
    // Assertion 2: V2 Airdrop + curve launch flows end-to-end
    // ============================================================================

    /// Full launch flow — the money test. Launcher picks V2 Airdrop with 25M
    /// allocation + bonding curve. All the invariants a real launcher expects:
    ///
    ///   - Total supply mint = exactly defaultCurveSupply (800M).
    ///   - Curve receives (800M - 25M) = 775M.
    ///   - Token contract holds the 25M airdrop reserve on `address(this)`.
    ///   - Launcher holds 0 tokens (curve mode → all supply routed).
    ///   - Ownership renounced (curve auto-renounces).
    ///   - Launcher wallet recorded on the BondingCurve so the graduator can
    ///     stamp them as per-pool creator at graduation time.
    function test_Launch_V2AirdropCurve_InvariantsHold() public {
        // Build the merkle: single-leaf tree where root == leaf hash.
        bytes32 leaf = keccak256(abi.encodePacked(claimer, AIRDROP_AMOUNT));
        bytes32 merkleRoot = leaf;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(merkleRoot, AIRDROP_ALLOCATION);
        LaunchParams memory p = _params("V2E2E Airdrop", "V2EAD", AIRDROP_V2_HASH, moduleData, true);

        uint256 fee = ROUTER.quote(p);
        // Prank both msg.sender AND tx.origin. On real chains they're the same
        // (an EOA), but Foundry's default tx.origin is `DEFAULT_SENDER` unless
        // set explicitly. Matters here because V2 CurveFactory's
        // createCurveWithConfig falls back to tx.origin when Router (a contract)
        // is msg.sender.
        vm.prank(launcher, launcher);
        address token = ROUTER.launch{value: fee}(p);
        assertTrue(token != address(0), "launch returned zero");

        // Curve was created on V2 CurveFactory (not the old one).
        address curve = CURVE_FACTORY_V2.curveFor(token);
        assertTrue(curve != address(0), "curve not on V2 CurveFactory");

        // Total supply == exactly 800M. NEVER inflated post-launch.
        IERC20 t = IERC20(token);
        assertEq(t.totalSupply(), CURVE_DEFAULT_SUPPLY, "total supply must equal initial mint");

        // Curve holds (800M - 25M) = 775M — the V2 CF pulled Router's ACTUAL
        // post-reserve balance, not the hardcoded 800M.
        assertEq(t.balanceOf(curve), CURVE_DEFAULT_SUPPLY - AIRDROP_ALLOCATION, "curve holds supply - reserve");
        // Token contract holds the 25M airdrop reserve.
        assertEq(t.balanceOf(token), AIRDROP_ALLOCATION, "token holds airdrop reserve");
        // Launcher holds 0 — everything routed through Router to the curve or reserve.
        assertEq(t.balanceOf(launcher), 0, "launcher holds no tokens on curve launch");

        // BondingCurve reflects the ACTUAL supply it holds (not the default).
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.curveSupply(), CURVE_DEFAULT_SUPPLY - AIRDROP_ALLOCATION, "curveSupply matches balance");
        // Curve records launcher for the Graduator to stamp on the V3 hook at grad.
        assertEq(bc.launcher(), launcher, "launcher recorded on curve");

        // Ownership renounced by Router when installBondingCurve=true.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok, "owner() should be callable");
        address owner = abi.decode(ret, (address));
        assertEq(owner, address(0), "curve launches must auto-renounce ownership");
    }

    // ============================================================================
    // Assertion 3: curve buys don't touch the reserve or change supply
    // ============================================================================

    function test_Buy_DoesNotTouchReserveOrChangeSupply() public {
        (address token, address curve) = _launchAirdropCurve();
        IERC20 t = IERC20(token);
        uint256 supplyBefore = t.totalSupply();
        uint256 curveBefore = t.balanceOf(curve);
        uint256 reserveBefore = t.balanceOf(token);

        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: 1 ether}(0);

        assertEq(t.totalSupply(), supplyBefore, "supply unchanged on buy");
        assertLt(t.balanceOf(curve), curveBefore, "curve lost tokens on buy");
        assertEq(t.balanceOf(token), reserveBefore, "reserve untouched by curve buy");
        assertGt(t.balanceOf(buyer), 0, "buyer received tokens");
    }

    // ============================================================================
    // Assertion 4: airdrop claim transfers from reserve, not mint
    // ============================================================================

    function test_Claim_TransfersFromReserveWithoutInflation() public {
        (address token,) = _launchAirdropCurve();
        IERC20 t = IERC20(token);
        ERC20WithAirdropGen a = ERC20WithAirdropGen(token);

        uint256 supplyBefore = t.totalSupply();
        uint256 reserveBefore = t.balanceOf(token);
        uint256 claimerBefore = t.balanceOf(claimer);

        // Single-leaf merkle so proof is empty.
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(claimer);
        a.airdropClaim(AIRDROP_AMOUNT, proof);

        assertEq(t.totalSupply(), supplyBefore, "supply unchanged on claim");
        assertEq(t.balanceOf(claimer), claimerBefore + AIRDROP_AMOUNT, "claimer got their share");
        assertEq(t.balanceOf(token), reserveBefore - AIRDROP_AMOUNT, "reserve drained by claim amount");
        assertTrue(a.airdropHasClaimed(claimer), "claim tracked");
        assertEq(a.airdropClaimedTotal(), AIRDROP_AMOUNT, "claimed total tracked");
    }

    // ============================================================================
    // Assertion 5: V3 hook rejects pool-init griefing (the H2 attack fix)
    // ============================================================================

    /// An attacker cannot bootstrap a pool with our V3 hook attached unless they
    /// are the wired Graduator. This is the fix for H2 (pool-init griefing DoS) —
    /// pre-V3, anyone could front-run PoolManager.initialize on a graduating pool
    /// key and permanently block that token's graduation.
    function test_V3Hook_RejectsUnauthorizedInitializer() public {
        // Anyone calling PoolManager.initialize with our hook in the pool key
        // would trigger hook.beforeInitialize(sender=caller). V3 checks that
        // sender == initializer (= our Graduator) and reverts otherwise.
        //
        // Simulate the attack path: prank as PoolManager (only PoolManager can call
        // the hook callback directly), pass an attacker as sender.
        address attacker = makeAddr("v2e2e_pool_griefer");
        vm.prank(POOL_MANAGER);
        vm.expectRevert(abi.encodeWithSelector(MultiHookHost.MultiHookHost__UnauthorizedInitializer.selector, attacker));
        // Any pool key with our hook — content doesn't matter, the sender check
        // fires before anything else.
        HOOK_V3.beforeInitialize(
            attacker,
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(0x1)),
                fee: 3000,
                tickSpacing: 60,
                hooks: IHooks(address(HOOK_V3))
            }),
            0 // sqrtPriceX96 — ignored on the revert path
        );
    }

    // ============================================================================
    // Assertion 6: direct-launch path preserves ownership
    // ============================================================================

    /// Direct launch (installBondingCurve=false, ownership=KeepEOA) — the path
    /// where a launcher wants to keep admin controls (Pausable/AntiBot/etc.).
    /// Verifies:
    ///   - Launcher becomes owner (not renounced, not Router).
    ///   - Total supply matches what the launcher requested.
    ///   - No curve created — direct-launch skips CurveFactory entirely.
    function test_DirectLaunch_KeepEOA_LauncherOwnsToken() public {
        bytes[] memory moduleData = new bytes[](0);
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "V2E2E Direct",
            ticker: "V2ED",
            configHash: BARE_HASH,
            initData: abi.encode(1_000_000e18, launcher, moduleData),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        uint256 fee = ROUTER.quote(p);
        // Prank both msg.sender AND tx.origin. On real chains they're the same
        // (an EOA), but Foundry's default tx.origin is `DEFAULT_SENDER` unless
        // set explicitly. Matters here because V2 CurveFactory's
        // createCurveWithConfig falls back to tx.origin when Router (a contract)
        // is msg.sender.
        vm.prank(launcher, launcher);
        address token = ROUTER.launch{value: fee}(p);

        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok, "owner() readable");
        assertEq(abi.decode(ret, (address)), launcher, "direct-launch launcher must be owner");
        assertEq(IERC20(token).balanceOf(launcher), 1_000_000e18, "launcher holds full supply");
        assertEq(CURVE_FACTORY_V2.curveFor(token), address(0), "no curve for direct launch");
    }

    // ============================================================================
    // Assertion 7: composed multi-module template (Airdrop + Vesting on curve)
    // ============================================================================

    /// The trickiest launch scenario: TWO reserve modules stacked on a curve. Both
    /// carve their share, sequentially, out of the 800M. The remaining ends up on
    /// the curve. Any over-allocation reverts loudly via solady _transfer.
    function test_Launch_MultiModule_AirdropPlusVesting_OnCurve() public {
        // Skip if the multi-module impl isn't registered on this fork (mostly a
        // dev-machine hedge — production always has it).
        if (ERC20_FACTORY.implFor(AIRDROP_VESTING_V2_HASH) == address(0)) {
            console2.log("[skip] AIRDROP_VESTING_V2 impl not registered on this fork");
            return;
        }
        bytes32 merkleRoot = keccak256(abi.encodePacked(claimer, AIRDROP_AMOUNT));

        // Fragments run alphabetically: Airdrop first, Vesting second.
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(merkleRoot, AIRDROP_ALLOCATION);
        moduleData[1] = abi.encode(
            beneficiary, VESTING_ALLOCATION, uint64(block.timestamp + 1 days), uint64(block.timestamp + 365 days)
        );
        LaunchParams memory p = _params("V2E2E Combo", "V2EC", AIRDROP_VESTING_V2_HASH, moduleData, true);

        uint256 fee = ROUTER.quote(p);
        // Prank both msg.sender AND tx.origin. On real chains they're the same
        // (an EOA), but Foundry's default tx.origin is `DEFAULT_SENDER` unless
        // set explicitly. Matters here because V2 CurveFactory's
        // createCurveWithConfig falls back to tx.origin when Router (a contract)
        // is msg.sender.
        vm.prank(launcher, launcher);
        address token = ROUTER.launch{value: fee}(p);
        address curve = CURVE_FACTORY_V2.curveFor(token);

        IERC20 t = IERC20(token);
        assertEq(t.totalSupply(), CURVE_DEFAULT_SUPPLY, "supply unchanged");
        // Reserves stack: 25M airdrop + 100M vesting = 125M held on token.
        assertEq(t.balanceOf(token), AIRDROP_ALLOCATION + VESTING_ALLOCATION, "combined reserve on token");
        // Curve gets the rest: 800M - 125M = 675M.
        assertEq(
            t.balanceOf(curve), CURVE_DEFAULT_SUPPLY - AIRDROP_ALLOCATION - VESTING_ALLOCATION, "curve gets remainder"
        );
    }

    // ============================================================================
    // Assertion 8: over-allocation reverts at init (safety by construction)
    // ============================================================================

    /// Launcher tries to allocate MORE than the curve supply (e.g. 1B when supply
    /// is 800M). The sequential _transfer in the fragment reverts inside solady
    /// when the mint target runs dry — no launch succeeds with dilution-hiding
    /// state.
    function test_Launch_OverAllocationReverts() public {
        bytes32 merkleRoot = keccak256(abi.encodePacked(claimer, uint256(1_000_000_000e18)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(merkleRoot, uint256(CURVE_DEFAULT_SUPPLY + 1));
        LaunchParams memory p = _params("V2E2E Bad", "V2EB", AIRDROP_V2_HASH, moduleData, true);
        uint256 fee = ROUTER.quote(p);
        vm.prank(launcher);
        vm.expectRevert(); // solady ERC20 underflow — bubbles up through Router.
        ROUTER.launch{value: fee}(p);
    }

    // ============================================================================
    // helpers
    // ============================================================================

    function _params(
        string memory name_,
        string memory ticker_,
        bytes32 configHash,
        bytes[] memory moduleData,
        bool curve
    ) internal view returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: name_,
            ticker: ticker_,
            configHash: configHash,
            initData: abi.encode(curve ? CURVE_DEFAULT_SUPPLY : uint256(1_000_000e18), address(ROUTER), moduleData),
            moduleCount: moduleData.length + 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: curve,
            ownership: curve ? OwnershipMode.Renounce : OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    function _launchAirdropCurve() internal returns (address token, address curve) {
        bytes32 merkleRoot = keccak256(abi.encodePacked(claimer, AIRDROP_AMOUNT));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(merkleRoot, AIRDROP_ALLOCATION);
        LaunchParams memory p = _params("V2E2E Fixture", "V2EF", AIRDROP_V2_HASH, moduleData, true);
        uint256 fee = ROUTER.quote(p);
        vm.prank(launcher);
        token = ROUTER.launch{value: fee}(p);
        curve = CURVE_FACTORY_V2.curveFor(token);
    }
}
