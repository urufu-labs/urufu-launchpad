// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";

contract MigMockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "MigTest";
    }

    function symbol() public pure override returns (string memory) {
        return "MIGT";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Fork test that proves the MigrateToV2Hook flow actually re-plumbs post-graduation
///         swap fees into the flywheel on Robinhood. Mirrors the on-chain sequence:
///           1. Deploy Flywheel (FeeSplitter) on the fork
///           2. CREATE2-mine + deploy a fresh MultiHookHost with `platform = FeeSplitter`
///           3. Deploy a fresh Graduator wired to the new hook
///           4. Set initializer gate so the graduator can call beforeInitialize
///           5. Create + initialize a bonding curve pointing at the NEW Graduator
///           6. Buy the curve to graduation → v4 pool spawns with the NEW hook + platform
///           7. Swap on the graduated pool via the deployed V4SwapRouter
///           8. Assert the ETH-denominated platform fee accrued to the hook's `owed` map
///              under FeeSplitter's address (proving the platform-repoint took effect)
///           9. Claim the fee → FeeSplitter.receive() distributes 40/35/25 into buyback +
///              NFT + treasury — proving the full loop closes
contract RhHookMigrationForkTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // RH v4 core (from config.ts HOOKS.robinhood + V4_ROUTERS.robinhood).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant V4_SWAP_ROUTER = 0x96E040a16A8B8B17a7896BDbDf02978895368bf6;

    // Ecosystem addresses (used for LoyaltyOracle in the real Flywheel deploy — this test
    // skips LoyaltyOracle since it's not on the fee-accrual path).
    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

    // Real hook config we ship.
    uint16 internal constant PLATFORM_BPS = 100; // 1%
    uint16 internal constant CREATOR_BPS = 100; // 1%

    // Curve params — tuned low so 3 ETH graduates the curve inside the test.
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal feeReceiverBurn = makeAddr("feeReceiverBurn"); // curve buy-fee sink; unused by graduation

    IPoolManager internal manager;
    MultiHookHost internal hook;
    Graduator internal graduator;
    V4SwapRouter internal swapRouter;
    /// Test-only helper that fires exactOutput swaps through PoolManager
    /// directly. V4SwapRouter is exactInput-only; F-2 regression coverage
    /// needs the other direction.
    ExactOutSwapper internal exactOutSwapper;

    FeeSplitter internal splitter;
    NftRevenueVault internal nftVault;
    UruBuybackVault internal buybackVault;

    function setUp() public {
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
        if (POOL_MANAGER.code.length == 0 || V4_SWAP_ROUTER.code.length == 0) vm.skip(true);

        manager = IPoolManager(POOL_MANAGER);
        // Deploy a FRESH V4SwapRouter for the tests instead of the on-chain V3
        // one. The V4 stack ships a new router with `deadline` + slippage-hoist
        // fixes; using the fresh bytecode here lets us exercise the same
        // sig/behavior that will be live post-deploy. Constructor-only immutable
        // is `poolManager`; no admin surface to wire.
        swapRouter = new V4SwapRouter(manager);
        exactOutSwapper = new ExactOutSwapper(manager);

        _deployFlywheel();
        _deployNewHookAndGraduator();
    }

    /// Slim flywheel deploy — FeeSplitter + vaults, configured for the 40/35/25 split.
    /// Skips LoyaltyOracle + RoyaltyRouter (not on the swap-fee accrual path this test cares about).
    function _deployFlywheel() internal {
        vm.startPrank(admin);
        splitter = new FeeSplitter(admin, treasury, 2 days);
        nftVault = new NftRevenueVault(admin);
        buybackVault = new UruBuybackVault(admin, URU_TOKEN, address(nftVault), 2 days);
        vm.warp(block.timestamp + splitter.minConfigDelay() + 1);
        splitter.setConfig(address(buybackVault), address(nftVault), treasury, 4000, 3500, 2500);
        vm.stopPrank();
    }

    /// Mirrors MigrateToV2Hook.s.sol — CREATE2-mine + deploy MultiHookHost with the
    /// flywheel's FeeSplitter as `platform`, then deploy a fresh Graduator wired to it.
    function _deployNewHookAndGraduator() internal {
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        // Constructor args: (IPoolManager, platform, creator, platformBps, creatorBps, deployer).
        // platform = FeeSplitter is the whole point of this migration.
        bytes memory args = abi.encode(manager, address(splitter), creator, PLATFORM_BPS, CREATOR_BPS, address(this));
        (uint256 salt,) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);

        // Deploy via the canonical CREATE2 deployer so the mined salt maps to the right addr.
        vm.prank(CREATE2_DEPLOYER);
        address hookAddr;
        assembly {
            let ptr := mload(0x40)
            let cLen := mload(creation)
            let aLen := mload(args)
            for { let i := 0 } lt(i, cLen) { i := add(i, 0x20) } {
                mstore(add(ptr, i), mload(add(add(creation, 0x20), i)))
            }
            for { let i := 0 } lt(i, aLen) { i := add(i, 0x20) } {
                mstore(add(add(ptr, cLen), i), mload(add(add(args, 0x20), i)))
            }
            hookAddr := create2(0, ptr, add(cLen, aLen), salt)
        }
        require(hookAddr != address(0), "hook CREATE2 failed");
        hook = MultiHookHost(payable(hookAddr));

        graduator = new Graduator(manager, IHooks(address(hook)), 3000, 60);

        // Wire the beforeInitialize gate so the fresh graduator can initialize pools.
        // Deployer stamped in the constructor (this contract) is the only address that can
        // call setInitializer — matches MigrateToV2Hook's post-deploy wiring.
        hook.setInitializer(address(graduator));
    }

    // =========================================================
    // Fee routes to FeeSplitter, not the old platform
    // =========================================================

    function test_PostGraduation_SwapFeeAccruesToFeeSplitter() public {
        // 1. Create + graduate a curve pointing at the new Graduator.
        (MigMockToken token, BondingCurve curve) = _launchAndGraduate();

        // 2. Swap on the graduated pool. First buy some token so alice has inventory,
        //    then sell to accrue ETH-denominated platform fees on the token→ETH leg.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        Currency eth = Currency.wrap(address(0));
        uint256 splitterOwedBefore = hook.owed(eth, address(splitter));

        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        // Buy — ETH in, tokens out. Fee accrues on the OUTPUT (unspecified) side which is
        // tokens here, so the ETH slot doesn't grow yet.
        swapRouter.swapExactETHForToken{value: 1 ether}(key, 0, alice, block.timestamp + 1);
        // Sell — approve + swap. Now the unspecified side is ETH → fee accrues in `eth` slot.
        uint256 tokenBal = token.balanceOf(alice);
        token.approve(address(swapRouter), tokenBal);
        swapRouter.swapExactTokenForETH(key, tokenBal, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        uint256 splitterOwedAfter = hook.owed(eth, address(splitter));

        // 3. Fees accrued to FeeSplitter's owed slot — the platform-repoint took effect.
        //    (Old MultiHookHost platform was the deploy wallet; new one is FeeSplitter.)
        assertGt(splitterOwedAfter - splitterOwedBefore, 0, "no ETH fee accrued to FeeSplitter");
    }

    // =========================================================
    // Claim → FeeSplitter distributes per 40/35/25
    // =========================================================

    function test_ClaimFromHook_DistributesToFlywheel() public {
        // Reuse the graduate + swap flow.
        (MigMockToken token,) = _launchAndGraduate();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        Currency eth = Currency.wrap(address(0));

        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        swapRouter.swapExactETHForToken{value: 1 ether}(key, 0, alice, block.timestamp + 1);
        uint256 tokenBal = token.balanceOf(alice);
        token.approve(address(swapRouter), tokenBal);
        swapRouter.swapExactTokenForETH(key, tokenBal, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        uint256 owed = hook.owed(eth, address(splitter));
        require(owed > 0, "precondition: no ETH owed to splitter");

        uint256 buybackBefore = address(buybackVault).balance;
        uint256 nftBefore = address(nftVault).balance;
        uint256 treasuryBefore = treasury.balance;

        // hook.claim(currency) pushes owed[currency][msg.sender] to msg.sender. Prank as
        // FeeSplitter so the ETH flows to it and triggers its receive() → distribution.
        vm.prank(address(splitter));
        hook.claim(eth);

        uint256 buybackDelta = address(buybackVault).balance - buybackBefore;
        uint256 nftDelta = address(nftVault).balance - nftBefore;
        uint256 treasuryDelta = treasury.balance - treasuryBefore;
        uint256 total = buybackDelta + nftDelta + treasuryDelta;

        assertEq(total, owed - address(splitter).balance, "distributed total != claimed ETH minus residue");
        assertApproxEqAbs(buybackDelta * 10_000 / total, 4000, 5, "buyback share off");
        assertApproxEqAbs(nftDelta * 10_000 / total, 3500, 5, "nft share off");
        assertApproxEqAbs(treasuryDelta * 10_000 / total, 2500, 5, "treasury share off");
    }

    // =========================================================
    // Helpers
    // =========================================================

    /// Deploy a fresh mock ERC20 + BondingCurve clone, initialize the curve against the
    /// new Graduator, and buy through to graduation. Returns the pair for further checks.
    function _launchAndGraduate() internal returns (MigMockToken, BondingCurve) {
        return _launchAndGraduateWithConfig(0, 0);
    }

    function _launchAndGraduateWithConfig(
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) internal returns (MigMockToken, BondingCurve) {
        MigMockToken token = new MigMockToken();
        BondingCurve impl = new BondingCurve();
        BondingCurve curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token.mint(address(curve), CURVE_SUPPLY);

        curve.initialize(
            address(token),
            feeReceiverBurn,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            antiSniperBlocks,
            buybackBurnBps,
            address(0)
        );

        // 3 ETH sent → 2.97 ETH after 1% curve buy fee → past 2 ETH target → _graduate() fires.
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);

        require(curve.graduated(), "curve failed to graduate");
        return (token, curve);
    }

    // =========================================================
    // Anti-sniper: swap in the gate window reverts; roll past it, swap succeeds
    // =========================================================

    function test_AntiSniper_GateRevertsThenOpens() public {
        uint32 gateBlocks = 20;
        (MigMockToken token,) = _launchAndGraduateWithConfig(gateBlocks, 0);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // Config was written by Graduator + frozen by beforeInitialize.
        (uint32 launchBlock, uint32 gate,) = hook.poolConfig(key.toId());
        assertEq(gate, gateBlocks, "antiSniperBlocks not stored");
        assertGt(uint256(launchBlock), 0, "launchBlock not stamped");

        // Inside the window — swap must revert. Use vm.expectRevert on the outer call
        // since MultiHookHost__AntiSniperGate bubbles up from beforeSwap.
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        vm.expectRevert();
        swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, alice, block.timestamp + 1);

        // Roll past the window (block.number += gateBlocks + 1) and the same swap works.
        vm.roll(block.number + uint256(gateBlocks) + 1);
        vm.prank(alice);
        uint256 out = swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, alice, block.timestamp + 1);
        assertGt(out, 0, "swap after gate produced 0 tokens");
    }

    // =========================================================
    // Buyback-burn: a slice of every BUY output lands at 0xdead
    // =========================================================

    function test_BuybackBurn_SendsSliceToBurn() public {
        uint16 burnBps = 500; // 5%
        (MigMockToken token,) = _launchAndGraduateWithConfig(0, burnBps);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // Verify hook stored the buyback-burn config.
        (,, uint16 storedBurn) = hook.poolConfig(key.toId());
        assertEq(storedBurn, burnBps, "buybackBurnBps not stored");

        address BURN = 0x000000000000000000000000000000000000dEaD;
        uint256 burnBefore = token.balanceOf(BURN);

        // Buy on the graduated pool — unspecified side is the token (currency1) which
        // triggers the buyback-burn slice.
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        uint256 aliceOut = swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, alice, block.timestamp + 1);
        assertGt(aliceOut, 0, "swap produced 0 tokens");

        uint256 burnDelta = token.balanceOf(BURN) - burnBefore;
        assertGt(burnDelta, 0, "burn address did not receive any tokens");
        // Alice's received amount is post-hook-take, so gross output = aliceOut + burn +
        // fee slice (platform + creator). Just verify burnDelta is roughly proportional
        // to burnBps of the total swap output. Not exact due to platform+creator slices
        // also coming out — a loose check with margin is enough for regression coverage.
        //
        // Total output = aliceOut + burnDelta + platform+creator slice (2% total).
        // burnDelta / totalOutput should be ~= burnBps/10000 = 5%. We check burnDelta > 0
        // which proves the buyback-burn code path fired at all — precise arithmetic is
        // covered in the unit tests against MultiHookHost.
    }

    // =========================================================
    // LP-lock: any attempt to modifyLiquidity on the graduated pool reverts
    // =========================================================

    // =========================================================
    // V3 fix regression tests — each of these was added alongside a specific
    // audit finding (see fix commits). Together they lock in the invariants
    // and prevent silent reintroduction of the bugs.
    // =========================================================

    /// Fix 1 — `pushOwed` lets anyone route the platform slot to FeeSplitter.
    /// Without it, `owed[currency][FeeSplitter]` accumulates forever (FeeSplitter
    /// has no `claim()` caller).
    function test_Fix1_PushOwed_RoutesPlatformSlotToFeeSplitter() public {
        (MigMockToken token,) = _launchAndGraduate();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        Currency eth = Currency.wrap(address(0));

        // Accrue ETH-side platform fees via a buy + sell round-trip.
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        swapRouter.swapExactETHForToken{value: 1 ether}(key, 0, alice, block.timestamp + 1);
        uint256 tokenBal = token.balanceOf(alice);
        token.approve(address(swapRouter), tokenBal);
        swapRouter.swapExactTokenForETH(key, tokenBal, 0, alice, block.timestamp + 1);
        vm.stopPrank();

        uint256 owed = hook.owed(eth, address(splitter));
        require(owed > 0, "precondition: no fees accrued to splitter slot");

        uint256 buybackBefore = address(buybackVault).balance;
        uint256 nftBefore = address(nftVault).balance;
        uint256 treasuryBefore = treasury.balance;

        // Random caller — NOT FeeSplitter, NOT owner — invokes pushOwed. Must
        // succeed and route funds into FeeSplitter's receive() → distribution.
        address randomPusher = makeAddr("randomPusher");
        vm.prank(randomPusher);
        hook.pushOwed(eth, address(splitter));

        assertEq(hook.owed(eth, address(splitter)), 0, "owed not zeroed after push");
        uint256 distributed = (address(buybackVault).balance - buybackBefore) + (address(nftVault).balance - nftBefore)
            + (treasury.balance - treasuryBefore);
        assertGt(distributed, 0, "no funds reached flywheel sinks");
    }

    function test_Fix1_PushOwed_RevertsWhenNothingOwed() public {
        Currency eth = Currency.wrap(address(0));
        vm.expectRevert(MultiHookHost.MultiHookHost__NothingToClaim.selector);
        hook.pushOwed(eth, address(splitter));
    }

    /// Fix 2 — Graduator MUST always call setPoolConfig, even when both values
    /// are zero. Otherwise an attacker who predicts the poolId can plant a
    /// malicious config on the deterministic address before graduation and
    /// have it frozen in when the graduator skips the overwrite.
    function test_Fix2_Graduator_OverwritesPreplantedPoolConfig() public {
        // Predict the poolId of the graduation this test will trigger. The test
        // must control token address BEFORE the curve exists so it can be planted.
        MigMockToken token = new MigMockToken();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();

        // Attacker plants a hostile config — huge anti-sniper window + max burn.
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        hook.setPoolConfig(poolId, type(uint32).max, hook.MAX_BUYBACK_BPS());

        // Now graduate the curve with launcher config (0, 0). If Graduator honored
        // the old `if (antiSniperBlocks > 0 || buybackBurnBps > 0)` skip, the
        // attacker's config would freeze in. Fix: unconditional overwrite → zeros land.
        _graduateThisToken(token, 0, 0);

        (, uint32 storedAntiSniper, uint16 storedBurn) = hook.poolConfig(poolId);
        assertEq(storedAntiSniper, 0, "graduator did not overwrite attacker antiSniper");
        assertEq(storedBurn, 0, "graduator did not overwrite attacker burn");
    }

    /// Fix 2 — same story for setCreator. When launcher is 0, Graduator must
    /// still set the creator explicitly (to the hook's immutable fallback) so
    /// an attacker can't plant themselves as the pool's creator.
    function test_Fix2_Graduator_OverwritesPreplantedCreator_WhenLauncherZero() public {
        MigMockToken token = new MigMockToken();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();

        // Attacker plants themselves as the pool creator.
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        hook.setCreator(poolId, attacker);

        // Graduate with launcher = 0 (legacy path). Fix reads hook.creator()
        // and sets that explicitly, overwriting the attacker.
        _graduateThisToken(token, 0, 0);

        assertEq(hook.creators(poolId), hook.creator(), "attacker's planted creator survived graduation");
        assertTrue(hook.creators(poolId) != attacker, "attacker still installed as creator");
    }

    /// Fix 3 — WL init with `fallbackTs <= block.timestamp` must revert. Prior
    /// behavior silently accepted and shipped a launch with a dead WL. Two
    /// variants: `fallbackTs == block.timestamp` (also invalid per `<=` check)
    /// and `fallbackTs == 0` (uninitialized default).
    function test_Fix3_WlInit_FallbackInPast_Reverts() public {
        MigMockToken token = new MigMockToken(); // hoisted — must precede expectRevert
        BondingCurve curve = _cloneCurve();
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: bytes32(uint256(1)),
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: uint64(block.timestamp),
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 1
        });
        vm.expectRevert(BondingCurve.BondingCurve__WlFallbackInPast.selector);
        curve.initializeWithWhitelist(
            address(token),
            feeReceiverBurn,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            0,
            0,
            address(0),
            wl
        );
    }

    function test_Fix3_WlInit_FallbackZero_Reverts() public {
        MigMockToken token = new MigMockToken();
        BondingCurve curve = _cloneCurve();
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: bytes32(uint256(1)),
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: 0,
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 1
        });
        vm.expectRevert(BondingCurve.BondingCurve__WlFallbackInPast.selector);
        curve.initializeWithWhitelist(
            address(token),
            feeReceiverBurn,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            0,
            0,
            address(0),
            wl
        );
    }

    /// Fixes 4 + 5 combined — a WL curve where reservedTokens == curveSupply
    /// lets one WL buyer drain the entire token reserve via `buyWithProof`'s
    /// clamp. This reproduces the exact bug scenario:
    ///   * gradTarget deliberately HUGE so ethReserve never crosses it before
    ///     the token side exhausts,
    ///   * one buyWithProof drains tokenReserve to 0 via the clamp,
    ///   * OLD code would set `graduated = true` (tokenReserve==0 trigger) then
    ///     `_graduate`'s `tokenOut > 0` guard would skip the Graduator call,
    ///     stranding ETH forever,
    ///   * NEW code (Fix 5) removes `tokenReserve == 0` from the trigger — curve
    ///     stays graduated=false and the ETH is recoverable via sell,
    ///   * subsequent buyWithProof calls clamp tokensOut to 0 which now reverts
    ///     with ZeroAmount (Fix 4) instead of silently letting the buyer pay
    ///     ETH for nothing.
    /// V4SwapRouter H-3 - swap tx with expired deadline reverts (was a MEV
    /// stale-tx vector - signed txs could sit in mempool and execute at bad prices).
    function test_FixV4Router_DeadlineExpired_Reverts() public {
        (MigMockToken token,) = _launchAndGraduate();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(V4SwapRouter.V4SwapRouter__DeadlinePassed.selector, block.timestamp - 1));
        swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, alice, block.timestamp - 1);
    }

    /// V4SwapRouter M-4 - zero-recipient reverts loudly instead of burning ETH.
    function test_FixV4Router_ZeroRecipient_Reverts() public {
        (MigMockToken token,) = _launchAndGraduate();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(V4SwapRouter.V4SwapRouter__ZeroRecipient.selector);
        swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, address(0), block.timestamp + 1);
    }

    /// V4 fix F-2 - exact-output swaps now pay the platform + creator fees.
    /// Prior MultiHookHost.afterSwap early-returned when `unspecDelta <= 0`,
    /// which zeroed platform+creator+burn fees on every exact-output swap
    /// (a trivial v4-periphery code path). This test proves the fee accrues.
    function test_FixF2_ExactOutputSwap_PaysFees() public {
        (MigMockToken token,) = _launchAndGraduate();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        Currency eth = Currency.wrap(address(0));

        // Baseline: platform slot owed 0 ETH before any swap.
        assertEq(hook.owed(eth, address(splitter)), 0);

        // Fire an exact-OUTPUT sell (spec = positive ETH out) via a mini in-test
        // helper. Unspecified side = token input; delta < 0. The V3 hook
        // silently returned 0 here; V4 hook charges fee on |delta| in both
        // directions.
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        swapRouter.swapExactETHForToken{value: 1 ether}(key, 0, alice, block.timestamp + 1);
        uint256 tokenBal = token.balanceOf(alice);
        token.approve(address(exactOutSwapper), tokenBal);
        // Ask for 0.05 ETH out; the swapper pulls token input from alice.
        exactOutSwapper.exactOutputEth(key, 0.05 ether, tokenBal, alice);
        vm.stopPrank();

        // Platform fee slot MUST have accrued on the input side (token
        // currency). The pre-fix hook would leave this at 0 for exact-output.
        assertGt(
            hook.owed(key.currency1, address(splitter)),
            0,
            "F-2 broken: token-side platform fee not charged on exactOutput"
        );
    }

    function test_Fix4And5_WlDrainThenSubsequentBuys() public {
        MigMockToken token = new MigMockToken();
        BondingCurve curve = _cloneCurve();
        token.mint(address(curve), CURVE_SUPPLY);
        // Single-leaf merkle: root == leaf, proof is empty.
        bytes32 aliceLeaf = keccak256(abi.encodePacked(alice));
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: aliceLeaf,
            reservedTokens: CURVE_SUPPLY, // 100% reserved so alice can drain all
            maxWlPerAddress: CURVE_SUPPLY,
            fallbackTs: uint64(block.timestamp + 1 days),
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 1
        });
        // Use a tiny virtualEth override so natural token exhaustion happens at
        // ~0.1 ETH — a single 5 ETH buy massively overshoots, triggering the
        // `tokensOut > tokenReserve` clamp in buyWithProof (the exact code path
        // that flags Fix 5's bug scenario).
        curve.initializeWithWhitelist(
            address(token),
            feeReceiverBurn,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            0.1 ether, // smaller virtualEth → exhaustion at 0.1 ETH
            100 ether, // gradTarget WAY above natural exhaustion
            100,
            address(graduator),
            0,
            0,
            address(0),
            wl
        );

        bytes32[] memory emptyProof = new bytes32[](0);
        vm.deal(alice, 10 ether);

        // Buy massive amount — the internal math would have wanted way more
        // tokens than tokenReserve has; clamp reduces tokensOut to tokenReserve.
        // The buy succeeds, tokenReserve = 0 afterwards, ethReserve well below gradTarget.
        vm.prank(alice);
        curve.buyWithProof{value: 5 ether}(emptyProof, 0);

        assertEq(curve.tokenReserve(), 0, "tokenReserve not fully exhausted");
        assertLt(curve.ethReserve(), 100 ether, "ethReserve somehow crossed gradTarget");
        // Fix 5 — the critical invariant: no graduation despite tokenReserve==0.
        assertFalse(curve.graduated(), "curve graduated on tokenReserve exhaustion (Fix 5 broken)");

        // Fix 4 — a follow-up buy clamps tokensOut to 0 (tokenReserve is 0), which
        // must revert with ZeroAmount rather than silently succeed.
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        vm.prank(alice);
        curve.buyWithProof{value: 0.1 ether}(emptyProof, 0);
    }

    /// Clone the BondingCurve impl the test already deployed via LibClone. Kept
    /// separate from `_launchAndGraduate` so WL-fix tests can drive their own
    /// initializeWithWhitelist call without triggering a graduation.
    function _cloneCurve() internal returns (BondingCurve) {
        BondingCurve impl = new BondingCurve();
        return BondingCurve(payable(LibClone.clone(address(impl))));
    }

    /// Graduate a pre-existing token by cloning a fresh curve, funding it, and
    /// letting alice buy through the threshold. Used by the Fix 2 tests that
    /// need to plant attacker state at a predictable poolId (which means the
    /// token address must be chosen BEFORE the curve exists).
    function _graduateThisToken(
        MigMockToken token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) internal {
        BondingCurve curve = _cloneCurve();
        token.mint(address(curve), CURVE_SUPPLY);
        curve.initialize(
            address(token),
            feeReceiverBurn,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            antiSniperBlocks,
            buybackBurnBps,
            address(0)
        );
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        require(curve.graduated(), "curve failed to graduate in helper");
    }

    function test_LpLocked_RemoveLiquidityReverts() public {
        (MigMockToken token,) = _launchAndGraduate();

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // Route the modify through a bare unlock-callback contract so we actually hit
        // PoolManager.modifyLiquidity → hook.beforeRemoveLiquidity — the path that reverts.
        MigUnlocker unlocker = new MigUnlocker(manager);
        vm.expectRevert(); // MultiHookHost__LiquidityLocked bubbles out of the callback
        unlocker.tryRemoveLiquidity(key);
    }
}

/// Minimal unlock-callback contract for the LP-lock test — packages a
/// PoolManager.modifyLiquidity call inside an unlock so the beforeRemoveLiquidity hook
/// fires against a real caller. Delta = -1 (any negative amount triggers the hook).
contract MigUnlocker {
    IPoolManager public immutable manager;

    constructor(
        IPoolManager _manager
    ) {
        manager = _manager;
    }

    function tryRemoveLiquidity(
        PoolKey memory key
    ) external {
        manager.unlock(abi.encode(key));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        PoolKey memory key = abi.decode(data, (PoolKey));
        manager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -1, salt: 0}), ""
        );
        return "";
    }
}

/// Minimal exact-OUTPUT swapper - pulls tokens from `user`, sells exactly
/// `amountOutEth` of ETH out. Used for F-2 regression coverage since
/// V4SwapRouter only does exact-input. Currency0 must be native ETH.
contract ExactOutSwapper {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    constructor(
        IPoolManager _manager
    ) {
        manager = _manager;
    }

    struct Ctx {
        PoolKey key;
        uint256 amountOutEth;
        uint256 maxTokenIn;
        address user;
    }

    function exactOutputEth(
        PoolKey calldata key,
        uint256 amountOutEth,
        uint256 maxTokenIn,
        address user
    ) external {
        // Pull tokens up-front so the callback has them available to settle.
        SafeTransferLib.safeTransferFrom(Currency.unwrap(key.currency1), user, address(this), maxTokenIn);
        manager.unlock(abi.encode(Ctx(key, amountOutEth, maxTokenIn, user)));
        // Refund any unused token input back to user.
        uint256 leftover = IERC20Refund(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (leftover > 0) SafeTransferLib.safeTransfer(Currency.unwrap(key.currency1), user, leftover);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(manager), "not pm");
        Ctx memory c = abi.decode(data, (Ctx));

        // zeroForOne = false (selling token1 -> want currency0 ETH out).
        // amountSpecified > 0 = exactOutput (we want +amountOutEth of currency0).
        manager.swap(
            c.key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(c.amountOutEth),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int256 d0 = TransientStateLibrary.currencyDelta(manager, address(this), c.key.currency0);
        int256 d1 = TransientStateLibrary.currencyDelta(manager, address(this), c.key.currency1);

        // Owe tokens (d1 < 0).
        if (d1 < 0) {
            manager.sync(c.key.currency1);
            SafeTransferLib.safeTransfer(Currency.unwrap(c.key.currency1), address(manager), uint256(-d1));
            manager.settle();
        }
        // Receive ETH (d0 > 0).
        if (d0 > 0) {
            manager.take(c.key.currency0, c.user, uint256(d0));
        }
        return "";
    }

    receive() external payable {}
}

interface IERC20Refund {
    function balanceOf(
        address
    ) external view returns (uint256);
}
