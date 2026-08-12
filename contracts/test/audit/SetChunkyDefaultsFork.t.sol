// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {SetChunkyDefaults} from "script/SetChunkyDefaults.s.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  SetChunkyDefaultsFork
/// @notice Fork the live RH mainnet, run the SetChunkyDefaults script against
///         the live V8 CurveFactory, then launch → graduate a bare ERC20 and
///         assert the resulting v4 pool matches the chunky-config math.
///
///         The point of this test: **the mutation is applied via the actual
///         broadcast script we plan to run** (`SetChunkyDefaults.runFor`),
///         not a manual `cf.setDefaults(...)` in the test body. If the
///         script drifts from mainnet behavior, this test catches it.
contract SetChunkyDefaultsForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live V8 stack pulled from `.env` on 2026-07-30.
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address internal constant MULTI_HOOK_HOST = 0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4;
    address internal constant GRADUATOR = 0xA29Ee1DB0a7C53e4733092C46C00d09feb1dFFC1;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;

    bytes32 internal constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    address internal launcher = makeAddr("chunky-launcher");
    address internal buyer = makeAddr("chunky-buyer");
    address internal swapper = makeAddr("chunky-swapper");

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
    }

    function test_LiveStack_WiringIntact_AllAddressesMatch() public view {
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        Router router = Router(payable(ROUTER_V7));
        GraduatorV2 grad = GraduatorV2(payable(GRADUATOR));
        MultiHookHost mhh = MultiHookHost(payable(MULTI_HOOK_HOST));

        assertEq(cf.graduator(), GRADUATOR, "cf.graduator drift");
        assertEq(cf.owner(), DEPLOYER, "cf.owner drift");
        assertTrue(cf.trustedRouters(ROUTER_V7), "cf trustedRouters[Router] false");
        assertEq(router.curveFactory(), CURVE_FACTORY, "router.curveFactory drift");
        assertEq(address(grad.curveFactory()), CURVE_FACTORY, "grad.curveFactory drift");
        assertEq(address(grad.defaultHook()), MULTI_HOOK_HOST, "grad.defaultHook drift");
        assertEq(mhh.initializer(), GRADUATOR, "mhh.initializer drift");
    }

    /// Snapshot the pre-state, run the script through its test entrypoint,
    /// verify only virt/grad moved.
    function test_Script_Applies_ChunkyDefaults_And_Preserves_Rest() public {
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        uint256 supplyBefore = cf.defaultCurveSupply();
        uint256 vTokBefore = cf.defaultVirtualTokenReserve();
        uint16 feeBefore = cf.defaultTradeFeeBps();

        SetChunkyDefaults script = new SetChunkyDefaults();
        script.runFor(CURVE_FACTORY, DEPLOYER);

        assertEq(cf.defaultVirtualEthReserve(), 17 ether, "virt not 17");
        assertEq(cf.defaultGraduationTargetEth(), 10 ether, "grad not 10");
        assertEq(cf.defaultCurveSupply(), supplyBefore, "supply drift");
        assertEq(cf.defaultVirtualTokenReserve(), vTokBefore, "vTok drift");
        assertEq(cf.defaultTradeFeeBps(), feeBefore, "fee drift");
    }

    /// Full end-to-end pipeline against EVERY live contract on RH mainnet:
    ///   Router → NameRegistry → ERC20Factory → CurveFactory → BondingCurve →
    ///   Graduator → MultiHookHost → PoolManager → V4SwapRouter → FeeSplitter.
    /// Applies chunky defaults via the actual broadcast script, then walks a
    /// launch through every hop. If ANYTHING breaks under 17/10, DO NOT
    /// broadcast — the diff between fork and live is essentially zero at this
    /// point (we're using every live address).
    function test_ChunkyDefaults_LiveStack_LaunchGraduateSwapFees_FullE2E() public {
        // ------------------------------------------------------ apply defaults
        SetChunkyDefaults script = new SetChunkyDefaults();
        script.runFor(CURVE_FACTORY, DEPLOYER);

        // ------------------------------------------------------ launch (live Router / Registry / Factory)
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "E2E Chunky";
        p.ticker = "E2EC";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(uint256(800_000_000e18), ROUTER_V7, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        Router router = Router(payable(ROUTER_V7));
        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);
        vm.prank(launcher);
        address token = router.launch{value: fee}(p);
        assertTrue(token != address(0), "phase1: launch returned zero");

        address curve = CurveFactory(CURVE_FACTORY).curveFor(token);
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.graduationTargetEth(), 10 ether, "phase1: curve did not adopt chunky grad");
        assertEq(bc.tokenReserve(), 800_000_000e18, "phase1: curve missing supply");

        // ------------------------------------------------------ graduate through live Graduator
        vm.deal(buyer, 12 ether);
        vm.prank(buyer);
        bc.buy{value: 10.5 ether}(0);
        assertTrue(bc.graduated(), "phase2: did not graduate");
        assertEq(bc.ethReserve(), 0, "phase2: curve ETH not drained");
        assertEq(bc.tokenReserve(), 0, "phase2: curve tokens not drained");

        // CRITICAL — the V7 stranding regression check on the LIVE graduator.
        // V7 could strand full graduation-ETH amounts (multi-ether). V8+ LP-math
        // fix leaves μETH-scale rounding dust that owner.sweep() recovers. If
        // this ever exceeds 0.001 ETH per graduation, real stranding is back.
        assertLe(GRADUATOR.balance, 0.001 ether, "phase2: LIVE graduator dust exceeded 0.001 ETH (real stranding regression?)");

        // ------------------------------------------------------ chunky LP shape
        uint256 lpTokens = IERC20V(token).balanceOf(POOL_MANAGER);
        assertGt(lpTokens, 190_000_000e18, "phase3: LP tokens too thin");
        assertLt(lpTokens, 225_000_000e18, "phase3: LP tokens too fat");
        console2.log("LP tokens (target ~207M):", lpTokens);

        // ------------------------------------------------------ pool live via live MHH hook
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(MULTI_HOOK_HOST)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtP, 0, "phase3: pool not initialized");
        uint128 liq = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        assertGt(liq, 0, "phase3: pool has zero liquidity");

        // ------------------------------------------------------ swap via live V4SwapRouter
        vm.deal(swapper, 2 ether);
        MultiHookHost mhh = MultiHookHost(payable(MULTI_HOOK_HOST));
        uint256 owedTokBefore = mhh.owed(Currency.wrap(token), FEE_SPLITTER);
        uint256 owedEthBefore = mhh.owed(Currency.wrap(address(0)), FEE_SPLITTER);
        uint256 swapperTokenBefore = IERC20V(token).balanceOf(swapper);

        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: 0.1 ether}(
            key, 1, swapper, block.timestamp + 300
        );
        uint256 swapperTokenAfter = IERC20V(token).balanceOf(swapper);
        assertGt(swapperTokenAfter, swapperTokenBefore, "phase4: buy swap did not credit tokens");

        // ------------------------------------------------------ fees accrue to FeeSplitter via live MHH
        uint256 owedTokAfter = mhh.owed(Currency.wrap(token), FEE_SPLITTER);
        assertGt(owedTokAfter, owedTokBefore, "phase5: MHH.owed[token] did not grow after buy");

        // ETH-side fees: sell some of what we just bought back to ETH.
        uint256 sellSize = swapperTokenAfter / 4;
        vm.prank(swapper);
        IERC20V(token).approve(V4_SWAP_ROUTER, sellSize);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactTokenForETH(key, sellSize, 1, swapper, block.timestamp + 300);
        uint256 owedEthAfter = mhh.owed(Currency.wrap(address(0)), FEE_SPLITTER);
        assertGt(owedEthAfter, owedEthBefore, "phase5: MHH.owed[eth] did not grow after sell");

        // ------------------------------------------------------ FeeSplitter can pull
        vm.prank(FEE_SPLITTER);
        mhh.claim(Currency.wrap(address(0)));
        assertEq(mhh.owed(Currency.wrap(address(0)), FEE_SPLITTER), 0, "phase6: owed[eth] not zeroed post-claim");

        console2.log("PASS: chunky defaults + live stack + full pipeline + fees intact");
    }
}
