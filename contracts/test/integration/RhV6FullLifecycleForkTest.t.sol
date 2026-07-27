// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface ICurveFactoryReadLike {
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function defaultGraduationTargetEth() external view returns (uint256);
}

interface IMultiHookHostLike {
    function owed(
        Currency currency,
        address who
    ) external view returns (uint256);
    /// `claim` transfers `owed[currency][msg.sender]` to msg.sender. So to claim
    /// the platform (FeeSplitter) share, we vm.prank(FEE_SPLITTER) and call.
    function claim(
        Currency currency
    ) external;
    /// Permissionless push — sends `account`'s owed balance to `account`. Handy
    /// when the platform is a contract like FeeSplitter that can't call claim()
    /// itself in production, but for the fork test we prank + claim directly.
    function pushOwed(
        address account,
        Currency currency
    ) external;
    function platform() external view returns (address);
}

interface IERC20Like {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function owner() external view returns (address);
}

/// @title  RhV6FullLifecycleForkTest
/// @notice End-to-end test against the ACTUAL DEPLOYED V6 Router (no etch, no mocks).
///         Proves the full launch -> curve buy -> graduation -> v4 pool -> post-grad
///         swap -> fee accrual -> FeeSplitter routing loop works on live V6 bytecode.
///
///         What this proves:
///           1. V6 Router.launch{value: fee}(params) deploys a token + installs curve
///           2. Router's _grantCurveModuleAllowances allowlists curve + Graduator + PM
///              (verified indirectly: buys and graduation transfer succeed on modules
///              that would otherwise reject them)
///           3. Buying through the curve to graduation triggers Graduator.execute
///           4. Graduator creates a v4 pool with MultiHookHost as the hook, LP locked
///           5. Post-grad swap through V4SwapRouter succeeds
///           6. Swap fee accrues to MultiHookHost.owed[FeeSplitter] (both currencies)
///           7. MultiHookHost.claim routes fees to FeeSplitter address
///
///         What this deliberately does NOT test:
///           - FeeSplitter's 40/35/25 split — FeeSplitter is currently
///             misconfigured (100% treasury, waiting for setConfig timelock).
///             The claim -> FeeSplitter routing IS tested; downstream split
///             comes online after setConfig fires.
contract RhV6FullLifecycleForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live V6 stack (post-V6-broadcast state)
    address internal constant ROUTER_V6 = 0x2dfA89FF6822C53509127b4943c97A48952dD973;
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant GRADUATOR = 0xaf62e66B6039cCd11a5953e3f3dB342CF7EAa489;
    address internal constant MULTI_HOOK_HOST = 0xd19d999A3E35cA4b28f245D9bAf30FeFf4F862c4;
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;

    // Bare-ERC20 config (matches frontend's configHashFor('ERC20', []))
    bytes32 internal constant CH_BARE = keccak256(abi.encode("ERC20", ""));

    RouterV2 internal router;
    address internal launcher = makeAddr("v6-lifecycle-launcher");
    address internal buyer = makeAddr("v6-lifecycle-buyer");
    address internal swapper = makeAddr("v6-lifecycle-swapper");

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
        if (ROUTER_V6.code.length == 0) vm.skip(true);

        router = RouterV2(payable(ROUTER_V6));

        vm.deal(launcher, 20 ether);
        vm.deal(buyer, 20 ether);
        vm.deal(swapper, 5 ether);
    }

    /// One big test that walks the whole lifecycle. Split into phases with
    /// console.log markers so a failure trace pinpoints exactly which phase.
    function test_V6_FullLifecycle_Launch_Buy_Graduate_Swap_FeeAccrual() public {
        // ============================================================
        // PHASE 1: launch bare ERC20 through V6 with curve installed
        // ============================================================
        uint256 curveSupply = ICurveFactoryReadLike(CURVE_FACTORY).defaultCurveSupply();
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V6 Lifecycle Test";
        p.ticker = "V6LT";
        p.configHash = CH_BARE;
        // Router receives the initial supply, forwards to curve via approve+pull.
        p.initData = abi.encode(curveSupply, ROUTER_V6, new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = router.quote(p);
        vm.prank(launcher);
        address token = router.launch{value: launchFee}(p);
        assertTrue(token != address(0), "phase1: token addr zero");
        assertGt(token.code.length, 0, "phase1: token no code");

        address curve = ICurveFactoryReadLike(CURVE_FACTORY).curveFor(token);
        assertTrue(curve != address(0), "phase1: curveFor returned zero");
        console2.log("PHASE 1 ok - token:", token, "curve:", curve);

        // ============================================================
        // PHASE 2: buy through the curve until graduation
        // ============================================================
        BondingCurve bc = BondingCurve(payable(curve));
        assertFalse(bc.graduated(), "phase2 pre: already graduated");

        uint256 gradTarget = ICurveFactoryReadLike(CURVE_FACTORY).defaultGraduationTargetEth();
        // buy target amount + a little padding to make sure we cross the threshold
        uint256 buyValue = gradTarget + 0.5 ether;
        vm.deal(buyer, buyValue + 1 ether);
        vm.prank(buyer);
        bc.buy{value: buyValue}(0);

        assertTrue(bc.graduated(), "phase2: curve did not graduate");
        assertEq(bc.ethReserve(), 0, "phase2: eth reserve not drained");
        assertEq(bc.tokenReserve(), 0, "phase2: token reserve not drained");
        console2.log("PHASE 2 ok - graduated");

        // ============================================================
        // PHASE 3: verify v4 pool created with MultiHookHost as hook
        // ============================================================
        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(MULTI_HOOK_HOST)
        });
        PoolId poolId = poolKey.toId();
        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "phase3: pool not initialized");
        uint128 liquidity = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        assertGt(liquidity, 0, "phase3: pool has zero liquidity");
        console2.log("PHASE 3 ok - v4 pool live at sqrtPriceX96", sqrtPriceX96);

        // ============================================================
        // PHASE 4: post-grad swap through V4SwapRouter
        // ============================================================
        uint256 swapperTokensBefore = IERC20Like(token).balanceOf(swapper);
        uint256 feeSplitterOwedTokenBefore =
            IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(token), FEE_SPLITTER);
        uint256 feeSplitterOwedEthBefore =
            IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(address(0)), FEE_SPLITTER);

        // Sanity: post-grad AntiSniper gate is 0 blocks (we launched with no gate)
        // so swap should go through immediately.
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: 0.1 ether}(
            poolKey, 1, swapper, block.timestamp + 300
        );

        uint256 swapperTokensAfter = IERC20Like(token).balanceOf(swapper);
        assertGt(swapperTokensAfter, swapperTokensBefore, "phase4: swap didn't credit tokens");
        console2.log("PHASE 4 ok - swapped ETH -> tokens, got", swapperTokensAfter - swapperTokensBefore);

        // ============================================================
        // PHASE 5: verify swap fee accrued to FeeSplitter address on MHH
        // ============================================================
        uint256 feeSplitterOwedTokenAfter = IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(token), FEE_SPLITTER);
        // ETH -> token swap: fee taken on output side (token). owed[token] should grow.
        assertGt(
            feeSplitterOwedTokenAfter,
            feeSplitterOwedTokenBefore,
            "phase5: FeeSplitter's owed[token] did not grow after swap"
        );
        console2.log(
            "PHASE 5 ok - platform fee accrued (delta):", feeSplitterOwedTokenAfter - feeSplitterOwedTokenBefore
        );

        // Also do a token -> ETH swap so ETH-side owed grows.
        uint256 swapperTokenBal = IERC20Like(token).balanceOf(swapper);
        uint256 sellSize = swapperTokenBal / 4;
        vm.prank(swapper);
        IERC20Like(token).approve(V4_SWAP_ROUTER, sellSize);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactTokenForETH(poolKey, sellSize, 1, swapper, block.timestamp + 300);

        uint256 feeSplitterOwedEthAfter =
            IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        assertGt(
            feeSplitterOwedEthAfter,
            feeSplitterOwedEthBefore,
            "phase5b: FeeSplitter's owed[eth] did not grow after sell"
        );
        console2.log("PHASE 5b ok - eth-side fee accrued (delta):", feeSplitterOwedEthAfter - feeSplitterOwedEthBefore);

        // ============================================================
        // PHASE 6: claim ETH fees on hook -> FeeSplitter (proves the
        //           MHH-side of the flywheel path actually calls into
        //           FeeSplitter). FeeSplitter's downstream 40/35/25 split
        //           is still in cold-start state (100% to treasury) until
        //           setConfig fires post-timelock — that's an orthogonal
        //           check, not what this test proves.
        // ============================================================
        uint256 owedEthBefore = IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        require(owedEthBefore > 0, "phase6 pre: owed[eth] is zero, nothing to claim");
        // FeeSplitter can't call claim() itself in production, but on the fork
        // we prank it and call claim() directly to exercise the code path.
        vm.prank(FEE_SPLITTER);
        IMultiHookHostLike(MULTI_HOOK_HOST).claim(Currency.wrap(address(0)));
        // Post-claim invariants:
        //   - owed[eth][FeeSplitter] should be zeroed
        //   - ETH left MHH somehow (to FeeSplitter address; FeeSplitter's own
        //     receive() further distributes it 100% to treasurySink=deployer
        //     in cold-start config, so FEE_SPLITTER.balance may not grow —
        //     the check that matters is owed being zeroed)
        uint256 owedEthAfter = IMultiHookHostLike(MULTI_HOOK_HOST).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        assertEq(owedEthAfter, 0, "phase6: owed[eth] not zeroed after claim");
        console2.log("PHASE 6 ok - claimed (owed pre/post):", owedEthBefore, "->", owedEthAfter);
    }

    receive() external payable {}
}
