// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {DeployV9StackFix} from "script/DeployV9StackFix.s.sol";
import {Router} from "src/router/Router.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  V9FullPipelineFork
/// @notice End-to-end verification of the V9 stack (CurveFactory + MHH +
///         Graduator triple rotation with:
///           - modules-over-allocated cap (supply must be >= curveSupply / 2
///             at curve create) — still enforced even after Airdrop was pulled
///             because any future module that carves supply must not starve
///             the curve
///           - chunky-pool defaults (17 ETH virt + 10 ETH grad -> ~207M+10 ETH LP)
///
///         Walks the FULL pipeline on a live RH mainnet fork:
///           deploy V9 stack -> launch bare -> buy -> graduate -> v4 swap ->
///           fee accrual -> Graduator balance = 0.
///
///         Airdrop-focused tests were removed 2026-07-30: the module is
///         retired platform-wide because the deployed V1 composed impl has
///         an inflation rug (see memory: airdrop removal + graduator-v9).
///         Every test isolates via setUp() which runs the full deploy script's
///         runForTest entrypoint against a fresh fork.
contract V9FullPipelineForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    // Unchanged: v4 core + launcher's own swap router + flywheel
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

    // Composed impls we launch through (already registered on ERC20Factory)
    // Bare ERC20 hash — no modules
    bytes32 internal constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    DeployV9StackFix.Deployed internal v9;

    address internal launcher = makeAddr("v9-launcher");
    address internal buyer = makeAddr("v9-buyer");
    address internal swapper = makeAddr("v9-swapper");

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

        // Deploy V9 via the actual script.
        DeployV9StackFix script = new DeployV9StackFix();
        vm.deal(address(script), 1 ether);
        v9 = script.runForTest(DEPLOYER);
    }

    // ============================================================
    // 1. Deploy sanity + wiring invariants (also asserted inside the
    //    script itself but re-checked from outside as an integration
    //    boundary).
    // ============================================================

    function test_V9_Wiring_MHHInitializerIsGraduator() public view {
        assertEq(
            MultiHookHost(payable(v9.multiHookHost)).initializer(),
            v9.graduator,
            "MHH.initializer must equal V9 Graduator"
        );
    }

    function test_V9_Wiring_GraduatorPointsAtV9CFAndMHH() public view {
        assertEq(address(GraduatorV2(payable(v9.graduator)).defaultHook()), v9.multiHookHost, "grad.defaultHook");
        assertEq(address(GraduatorV2(payable(v9.graduator)).curveFactory()), v9.curveFactory, "grad.curveFactory");
    }

    function test_V9_Wiring_CurveFactoryPointsAtV9Graduator() public view {
        assertEq(CurveFactory(v9.curveFactory).graduator(), v9.graduator, "cf.graduator");
        assertTrue(CurveFactory(v9.curveFactory).trustedRouters(ROUTER_V7), "cf trusts Router");
    }

    function test_V9_Wiring_RouterPointsAtV9CurveFactory() public view {
        assertEq(Router(ROUTER_V7).curveFactory(), v9.curveFactory, "router.curveFactory rotated");
    }

    function test_V9_Defaults_Applied_17ETH_10ETH() public view {
        CurveFactory cf = CurveFactory(v9.curveFactory);
        assertEq(cf.defaultVirtualEthReserve(), 17 ether, "virtEth");
        assertEq(cf.defaultVirtualTokenReserve(), 800_000_000e18, "virtToken");
        assertEq(cf.defaultCurveSupply(), 800_000_000e18, "curveSupply");
        assertEq(cf.defaultGraduationTargetEth(), 10 ether, "gradTarget");
        assertEq(cf.defaultTradeFeeBps(), 100, "tradeFeeBps");
    }

    // ============================================================
    // 2. Modules-over-allocated cap — cannot be triggered from a live
    //    launch today because every registered composed impl either
    //    forwards the full supply to Router or carves a fixed sub-1%
    //    reserve. Airdrop was the only launcher-controlled carve path
    //    and it was removed 2026-07-30 (V1 impl has an inflation rug).
    //    The cap itself stays live in CurveFactory as a defense-in-depth
    //    guard for any future module that adds a launcher-sized carve.
    // ============================================================

    // ============================================================
    // 3. THE FULL PIPELINE test - what the user asked for.
    //    launch -> buy -> graduate -> v4 pool -> swap -> fee accrual
    //    Verifies at every step + hits the CRITICAL asserts:
    //      - Graduator balance == 0 after graduation (V8 regression)
    //      - LP amounts match expected chunky-config math
    //      - v4 pool live, hook active, swap fees flow to FeeSplitter
    // ============================================================

    function test_V9_FullPipeline_BareLaunch_Graduate_Swap_Fees() public {
        // -------- PHASE 1: launch bare ERC20 --------
        LaunchParams memory p = _bareLaunchParams("V9 Pipeline", "V9P");
        Router router = Router(payable(ROUTER_V7));
        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);
        vm.prank(launcher);
        address token = router.launch{value: fee}(p);
        assertTrue(token != address(0), "phase1: token addr zero");

        address curve = CurveFactory(v9.curveFactory).curveFor(token);
        assertTrue(curve != address(0), "phase1: curveFor zero");
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.tokenReserve(), 800_000_000e18, "phase1: bare launch curve got full 800M");
        assertFalse(bc.graduated(), "phase1: not yet graduated");

        // -------- PHASE 2: buy through graduation (10 ETH target) --------
        uint256 gradTarget = bc.graduationTargetEth();
        assertEq(gradTarget, 10 ether, "phase2: gradTarget must be 10 ETH");
        uint256 buyValue = gradTarget + 0.5 ether;
        vm.deal(buyer, buyValue + 1 ether);
        vm.prank(buyer);
        bc.buy{value: buyValue}(0);
        assertTrue(bc.graduated(), "phase2: curve should have graduated");
        assertEq(bc.ethReserve(), 0, "phase2: ETH reserve drained");
        assertEq(bc.tokenReserve(), 0, "phase2: token reserve drained");

        // -------- PHASE 2b: CRITICAL - graduator balance is zero --------
        // The V7 bug stranded 4 ETH here. If this fails, V9 has the same
        // problem and we STOP the rollout.
        assertEq(v9.graduator.balance, 0, "PHASE2b CRITICAL: graduator MUST hold zero ETH post-graduation");

        // -------- PHASE 3: v4 pool exists w/ V9 MHH as hook --------
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(v9.multiHookHost)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "phase3: pool not initialized");
        uint128 liquidity = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        assertGt(liquidity, 0, "phase3: pool zero liquidity");

        // -------- PHASE 3b: LP is CHUNKY - ~207M tokens + ~10 ETH --------
        // With 17 ETH virt + 10 ETH grad on 800M curveSupply, LP should
        // have ~207M tokens. Use loose tolerance (+/- 5%) because rounding
        // in the graduation-triggering buy pushes exact amounts around.
        uint256 tokensInPool = IERC20V(token).balanceOf(POOL_MANAGER);
        assertGt(tokensInPool, 190_000_000e18, "phase3b: LP has <190M tokens (chunky config broken)");
        assertLt(tokensInPool, 225_000_000e18, "phase3b: LP has >225M tokens (config math off)");
        console2.log("LP tokens (should be ~207M):", tokensInPool);

        // -------- PHASE 4: swap on v4 pool succeeds --------
        vm.deal(swapper, 2 ether);
        uint256 owedTokenBefore = MultiHookHost(payable(v9.multiHookHost)).owed(Currency.wrap(token), FEE_SPLITTER);
        uint256 owedEthBefore = MultiHookHost(payable(v9.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        uint256 swapperBefore = IERC20V(token).balanceOf(swapper);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: 0.1 ether}(
            key, 1, swapper, block.timestamp + 300
        );
        uint256 swapperAfter = IERC20V(token).balanceOf(swapper);
        assertGt(swapperAfter, swapperBefore, "phase4: swap didn't credit tokens");

        // -------- PHASE 5: fees accrued to FeeSplitter via MHH --------
        uint256 owedTokenAfter = MultiHookHost(payable(v9.multiHookHost)).owed(Currency.wrap(token), FEE_SPLITTER);
        assertGt(owedTokenAfter, owedTokenBefore, "phase5: FeeSplitter owed[token] didn't grow");

        // Sell to accrue ETH-side owed
        uint256 sellSize = IERC20V(token).balanceOf(swapper) / 4;
        vm.prank(swapper);
        IERC20V(token).approve(V4_SWAP_ROUTER, sellSize);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactTokenForETH(key, sellSize, 1, swapper, block.timestamp + 300);
        uint256 owedEthAfter = MultiHookHost(payable(v9.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        assertGt(owedEthAfter, owedEthBefore, "phase5b: FeeSplitter owed[eth] didn't grow");

        // -------- PHASE 6: FeeSplitter can pull the ETH --------
        vm.prank(FEE_SPLITTER);
        MultiHookHost(payable(v9.multiHookHost)).claim(Currency.wrap(address(0)));
        assertEq(
            MultiHookHost(payable(v9.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER),
            0,
            "phase6: owed[eth] not zeroed after claim"
        );
    }

    // ============================================================
    // helpers
    // ============================================================

    function _bareLaunchParams(
        string memory name_,
        string memory ticker_
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = BARE_HASH;
        // For curve mode, initialRecipient MUST be Router.
        p.initData = abi.encode(uint256(800_000_000e18), ROUTER_V7, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }
}
