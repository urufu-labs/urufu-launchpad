// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {DeployDn404Lane} from "script/DeployDn404Lane.s.sol";
import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404Graduator} from "src/dn404/Dn404Graduator.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Vm} from "forge-std/Vm.sol";
import {
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike
} from "src/dn404/Dn404LaunchFactory.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20Like {
    function balanceOf(
        address who
    ) external view returns (uint256);
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

/// Minimal mint-and-transfer ERC-20 used as the DN404 pair currency in
/// this test. USDG's real storage layout is opaque to `deal` so we can't
/// fund test wallets with the live token; a mock ERC-20 exercises the
/// exact same `Dn404BondingCurve.buy` code path (safeTransferFrom + pull
/// pair currency) without that constraint.
contract MockPairErc20 {
    string public constant name = "MockPair";
    string public constant symbol = "MPAIR";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title  Dn404GraduationForkTest
/// @notice The end-to-end walk the launchpad has never actually run:
///         launch a DN404 through Dn404LaunchFactory → buy through the
///         curve until the graduation target trips → verify the v4 pool
///         landed at the expected PoolId + our mined MHH captured the
///         beforeInitialize callback + tokens flowed as expected.
///
///         Uses the USDG pair-currency path so it exercises
///         Dn404LaunchFactory + Dn404CurveFactory + Dn404BondingCurve +
///         Dn404Graduator + mined MultiHookHost together, in one tx,
///         against real Robinhood mainnet state.
///
///         Skips cleanly without ROBINHOOD_RPC_URL. Skips further if URU
///         / USDG live addresses can't be resolved on the fork.
contract Dn404GraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live RH addresses. Same values Dn404PairCurrencyLiveFork uses so both
    // fork tests agree on the world they're testing against.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    /// Mock pair currency deployed in setUp — see MockPairErc20 above.
    MockPairErc20 internal pair;

    // v4 pool shape — matches the launchpad's canonical defaults.
    uint24 internal constant V4_FEE = 3000;
    int24 internal constant V4_TICK_SPACING = 60;

    DeployDn404Lane internal script;
    DeployDn404Lane.Deployed internal stack;

    address internal admin;
    address internal keeper;
    address internal treasury;
    address internal launcher;
    address internal buyer;

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
        if (RH_POOL_MANAGER.code.length == 0) vm.skip(true);

        // Shared labels with sibling DeployDn404LaneForkTest so parallel test
        // execution can't race on process-shared env vars — see that file.
        admin = makeAddr("dn404-fork-admin");
        keeper = makeAddr("dn404-fork-keeper");
        treasury = makeAddr("dn404-fork-treasury");
        launcher = makeAddr("dn404-grad-launcher");
        buyer = makeAddr("dn404-grad-buyer");

        vm.setEnv("ADMIN", vm.toString(admin));
        vm.setEnv("URU_TOKEN_ADDRESS", vm.toString(RH_URU));
        vm.setEnv("DN404_TAX_KEEPER", vm.toString(keeper));
        vm.setEnv("DN404_TAX_TREASURY", vm.toString(treasury));

        script = new DeployDn404Lane();
        stack = script.runForTest();

        // Deploy the mock pair currency + governance-seed it on the allowlist.
        // Using a mock (not USDG) because USDG's live storage layout is
        // opaque to `deal`, which we need to fund test wallets.
        pair = new MockPairErc20();
        vm.prank(admin);
        Dn404PairCurrencyAllowlist(stack.pairCurrencyAllowlist).setAllowed(address(pair), true, "MPAIR");

        // Zero the URU launch fee so this test doesn't need to fund URU.
        // The live NftLaunchFactory.minUruFee is 5,000 URU (=> 10,000 URU
        // seed here per the 2× rule) and `deal(URU, ...)` fails to write
        // through URU's non-standard balance layout. Testing the URU fee
        // path itself is out of scope for graduation — that lives in the
        // launch-factory unit tests.
        //
        // Read every view value into locals BEFORE the prank; vm.prank is
        // single-shot and inline view reads inside the setter call args
        // would silently consume it, making setUruConfig run un-pranked.
        Dn404LaunchFactory lf = Dn404LaunchFactory(stack.launchFactory);
        address uruSink = lf.uruSink();
        address loyaltyOracle = address(lf.loyaltyOracle());
        vm.prank(admin);
        lf.setUruConfig(FactoryIERC20(RH_URU), uruSink, 0, ILoyaltyOracleLike(loyaltyOracle));
    }

    // ================================================================
    // The graduation walk. Launch a USDG-paired DN404 with tax off, buy
    // through the curve past the graduation target, verify the v4 pool
    // exists at the expected id with our mined MHH as the hook.
    // ================================================================
    function test_FullWalk_LaunchBuyGraduateWithUsdgPair() public {
        // ---- 1. URU fee zeroed in setUp; nothing to fund on the launcher side.
        //         The graduation walk is what this test targets — the URU
        //         fee path is exercised by the unit test suite.

        // ---- 2. Launch. Total supply = 800M (matches DN404 CF's
        //         defaultCurveSupply so the CF's minimum-supply check
        //         passes and no supply is stranded).
        //         collectionSize = 800 × unit = 1_000_000 → 800M.
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = "Graduation Test";
        p.ticker = "GRAD";
        p.baseURI = "ipfs://grad/";
        p.contractURI = "ipfs://grad/collection.json";
        p.collectionSize = 800;
        p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.pairCurrency = address(pair);
        p.taxMode = 0;
        p.taxBps = 0;
        p.taxTarget = address(0);
        p.uruAmount = 0;

        vm.prank(launcher);
        (address base, address mirror, address curve) = Dn404LaunchFactory(stack.launchFactory).launch(p);

        assertGt(base.code.length, 0, "base clone not deployed");
        assertGt(mirror.code.length, 0, "mirror clone not deployed");
        assertGt(curve.code.length, 0, "curve not deployed");

        // ---- 3. Curve is fresh: no pair-currency accumulated, not graduated.
        Dn404BondingCurve c = Dn404BondingCurve(curve);
        assertEq(c.ethReserve(), 0, "fresh curve should hold no pair currency");
        assertFalse(c.graduated(), "curve should start ungraduated");
        assertEq(c.pairCurrency(), address(pair), "curve pairCurrency != USDG");

        // ---- 4. Fund buyer with USDG + push a big buy past graduation
        //         target. Curve charges 1% fee on input, so send extra
        //         slack so pairAfterFee comfortably crosses the target.
        uint256 target = c.graduationTargetEth();
        assertGt(target, 0, "graduation target unset");
        // 25% headroom — matches the pattern DeployPathRhFork uses to
        // guarantee the final buy crosses even after the fee slice.
        uint256 buyAmount = (target * 125) / 100;
        pair.mint(buyer, buyAmount);

        vm.startPrank(buyer);
        pair.approve(curve, buyAmount);
        uint256 tokensOut = c.buy(buyAmount, 0);
        vm.stopPrank();

        assertGt(tokensOut, 0, "buy returned zero tokens");
        assertTrue(c.graduated(), "curve failed to graduate after over-target buy");

        // ---- 5. Post-graduation curve invariants: reserves zeroed.
        assertEq(c.tokenReserve(), 0, "curve.tokenReserve not zeroed at graduation");
        assertEq(c.ethReserve(), 0, "curve.ethReserve not zeroed at graduation");

        // ---- 6. V4 pool exists at the expected PoolId. The graduator
        //         builds the key with (currency0, currency1) canonically
        //         sorted so we do the same math here.
        (address c0, address c1) = base < address(pair) ? (base, address(pair)) : (address(pair), base);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: V4_FEE,
            tickSpacing: V4_TICK_SPACING,
            hooks: IHooks(stack.multiHookHost)
        });
        PoolId poolId = key.toId();

        (uint160 sqrtPriceX96,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(poolId);
        uint128 liquidity = IPoolManager(RH_POOL_MANAGER).getLiquidity(poolId);
        assertGt(sqrtPriceX96, 0, "v4 pool not initialized post-graduation");
        assertGt(liquidity, 0, "v4 pool has no liquidity");

        // ---- 7. Our mined MHH captured the beforeInitialize callback.
        //         If the MHH gate rejected the sender, graduation would
        //         have reverted upstream — this is defense in depth.
        (uint32 launchBlock,,) = MultiHookHost(payable(stack.multiHookHost)).poolConfig(poolId);
        assertGt(launchBlock, 0, "MHH did not stamp launchBlock on the graduated pool");
        (,,,,, uint64 launchBlockPolicy, bool frozen) =
            MultiHookHost(payable(stack.multiHookHost)).poolPolicy(poolId);
        assertGt(launchBlockPolicy, 0, "MHH poolPolicy launchBlock unset");
        assertTrue(frozen, "MHH poolPolicy not immutableAfterLaunch");
    }

    // ================================================================
    // Graduation math sanity — ethReserve accumulates only pairAfterFee,
    // not the full input. A test at 99% target intentionally does NOT
    // graduate; the next test bumps past 100% and does.
    // ================================================================
    function test_BuyAt99PctOfTarget_DoesNotGraduate() public {
        Dn404LaunchFactory.LaunchParams memory p = _minimalLaunchParams(address(pair));
        vm.prank(launcher);
        (,, address curve) = Dn404LaunchFactory(stack.launchFactory).launch(p);
        Dn404BondingCurve c = Dn404BondingCurve(curve);

        // Send exactly 99% of the target (pre-fee). After the 1% fee this
        // deposits ~0.98 × target — well short of graduating.
        uint256 target = c.graduationTargetEth();
        uint256 sendAmount = (target * 99) / 100;
        pair.mint(buyer, sendAmount);

        vm.startPrank(buyer);
        pair.approve(curve, sendAmount);
        c.buy(sendAmount, 0);
        vm.stopPrank();

        assertFalse(c.graduated(), "should not have graduated on 99% buy");
        assertLt(c.ethReserve(), target, "ethReserve unexpectedly hit target");
    }

    // ================================================================
    // PRICE CONTINUITY AT GRADUATION — the "no cliff" proof.
    //
    // The ERC-20 lane once shipped a graduator that seeded the v4 pool
    // from the curve's raw real-reserve ratio instead of its marginal
    // (virtual + real) price, opening the pool ~50% away from the last
    // curve trade. Dn404Graduator is ported from the fixed GraduatorV3,
    // AND adds a branch V3 never had: with an ERC-20 pair, the token can
    // sort as currency0 or currency1, and the seed must be inverted in
    // one of those cases. A wrong inversion is a cliff.
    //
    // These tests do not trust the derivation. They graduate on the live
    // fork, read the pool's ACTUAL slot0 price, and assert it equals the
    // curve's marginal price at graduation within 1% — once per address
    // ordering, forced deterministically by pinning the mock pair token
    // at a low / high address with deployCodeTo. Each test also asserts
    // the ordering it claims, so the two can never silently test the
    // same branch.
    // ================================================================

    /// keccak256("Dn404Graduated(address,address,address,uint256,uint256,uint160,uint128)")
    bytes32 internal constant DN404_GRADUATED_TOPIC0 =
        keccak256("Dn404Graduated(address,address,address,uint256,uint256,uint160,uint128)");

    function test_NoCliff_PairIsCurrency0() public {
        // Low address => pair < base => pair is currency0 (non-inverted branch).
        address pairAddr = address(0x0000000000000000000000000000000000001001);
        _assertNoCliffForPairAt(pairAddr, true);
    }

    function test_NoCliff_TokenIsCurrency0() public {
        // High address => base < pair => token is currency0 (inverted branch).
        address pairAddr = address(0xFFfffFFfFFfffFfFffFFfFfFfFffFfffFFFFFf01);
        _assertNoCliffForPairAt(pairAddr, false);
    }

    /// Full launch → buy-to-graduate → pool-price-vs-curve-price check for a
    /// mock pair token pinned at `pairAddr`. `expectPairIsC0` is the ordering
    /// the caller intends to exercise; asserted, not assumed.
    function _assertNoCliffForPairAt(address pairAddr, bool expectPairIsC0) internal {
        // Pin the mock at the chosen address. MockPairErc20 has no constructor
        // state (constants + empty mappings), so runtime-only placement is
        // a complete deployment.
        deployCodeTo("Dn404GraduationFork.t.sol:MockPairErc20", pairAddr);
        MockPairErc20 p = MockPairErc20(pairAddr);

        vm.prank(admin);
        Dn404PairCurrencyAllowlist(stack.pairCurrencyAllowlist).setAllowed(pairAddr, true, "MPAIR-ORD");

        Dn404LaunchFactory.LaunchParams memory lp = _minimalLaunchParams(pairAddr);
        lp.name = expectPairIsC0 ? "NoCliff PairC0" : "NoCliff TokenC0";
        lp.ticker = expectPairIsC0 ? "NCP" : "NCT";
        vm.prank(launcher);
        (address base,, address curve) = Dn404LaunchFactory(stack.launchFactory).launch(lp);

        // The ordering this test exists to exercise MUST hold, or the test is
        // lying about which branch it covers.
        bool pairIsC0 = pairAddr < base;
        assertEq(pairIsC0, expectPairIsC0, "address ordering did not land on the intended branch");

        Dn404BondingCurve c = Dn404BondingCurve(curve);
        uint256 virtPair = c.virtualEthReserve();
        uint256 virtTok = c.virtualTokenReserve();
        uint256 target = c.graduationTargetEth();
        uint256 buyAmount = (target * 125) / 100;
        p.mint(buyer, buyAmount);

        vm.recordLogs();
        vm.startPrank(buyer);
        p.approve(curve, buyAmount);
        c.buy(buyAmount, 0);
        vm.stopPrank();
        assertTrue(c.graduated(), "did not graduate");

        // Pull the graduator's emitted (pairAmount, tokenAmount, sqrtPriceX96).
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 pairAmount; uint256 tokenAmount; uint160 emittedSqrt;
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == stack.graduator && logs[i].topics[0] == DN404_GRADUATED_TOPIC0) {
                (pairAmount, tokenAmount, emittedSqrt,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint160, uint128));
                found = true;
                break;
            }
        }
        assertTrue(found, "Dn404Graduated not emitted by the graduator");

        // Curve marginal price at graduation, pair-per-token, 1e18 fixed point.
        // pairAmount/tokenAmount are the REAL reserves the curve handed over
        // (see Dn404BondingCurve._graduate), so this is the true spot price.
        uint256 curvePriceX18 = ((virtPair + pairAmount) * 1e18) / (virtTok + tokenAmount);

        // What the POOL actually opened at — read slot0, don't trust the event.
        (address c0, address c1) = pairIsC0 ? (pairAddr, base) : (base, pairAddr);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: V4_FEE,
            tickSpacing: V4_TICK_SPACING,
            hooks: IHooks(stack.multiHookHost)
        });
        (uint160 slotSqrt,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(key.toId());
        assertGt(slotSqrt, 0, "pool not initialized");
        assertEq(slotSqrt, emittedSqrt, "graduator emitted a different sqrtPrice than it initialized with");

        // v4: sqrtPriceX96 = sqrt(currency1 per currency0) * 2^96.
        // poolPriceX18 = (sqrt^2 / 2^192) * 1e18, computed as two mulDivs.
        uint256 sq = uint256(slotSqrt);
        uint256 poolPriceX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(sq, sq, 1 << 96), 1e18, 1 << 96
        );

        // If pair is currency0 the pool encodes token-per-pair = 1/curvePrice.
        // If token is currency0 the pool encodes pair-per-token = curvePrice.
        uint256 expectedX18 = pairIsC0 ? (1e36 / curvePriceX18) : curvePriceX18;

        uint256 diff = poolPriceX18 > expectedX18 ? poolPriceX18 - expectedX18 : expectedX18 - poolPriceX18;
        // 1% tolerance: covers the 1e9 sqrt truncation in the seed. A real
        // cliff (wrong branch / raw ratio) is off by ~50% or by orders of
        // magnitude, nowhere near this band.
        assertLe(diff * 100, expectedX18, "CLIFF: pool opening price != curve marginal price");

        emit log_named_uint("curve price (pair/token, x1e18)", curvePriceX18);
        emit log_named_uint("pool price   (c1/c0,       x1e18)", poolPriceX18);
        emit log_named_uint("expected     (c1/c0,       x1e18)", expectedX18);
        emit log_named_uint("deviation bps", (diff * 10_000) / expectedX18);
    }

    function _minimalLaunchParams(
        address pairCurrency
    ) internal pure returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "MinLaunch";
        p.ticker = "MIN";
        p.baseURI = "ipfs://min/";
        p.contractURI = "ipfs://min/collection.json";
        p.collectionSize = 800;
        p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.pairCurrency = pairCurrency;
        p.taxMode = 0;
        p.taxBps = 0;
        p.taxTarget = address(0);
        p.uruAmount = 0;
    }
}
