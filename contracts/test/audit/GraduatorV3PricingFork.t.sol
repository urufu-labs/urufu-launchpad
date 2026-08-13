// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {GraduatorV3} from "src/curve/GraduatorV3.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// @title  GraduatorV3PricingFork
/// @notice Fork test proving V3 fixes the graduation-cliff bug that shipped
///         with V2 (LUV / gemuse et al.). Two assertions matter:
///           1. Post-graduation pool sqrtPriceX96 ≈ curve marginal price
///              (NOT raw real ratio like V2)
///           2. Excess tokens (curve reserve at grad minus what LP absorbs
///              at marginal price) go to 0xdEaD, NOT into the LP
///
///         Test flow:
///           - fork RH mainnet (uses the live Router / CF / MHH)
///           - etch V3's code over the current live Graduator (preserves
///             the auth check: curveFactory.graduator() still returns
///             the same address, so Router → CF → Graduator chain works)
///           - launch a fresh V10AL-style token
///           - buy 4.5 ETH into it to trigger graduation
///           - assert:
///               * pool sqrtP is close to what the CURVE MARGINAL formula
///                 predicts (within some %, allowing for integer sqrt trunc)
///               * PoolManager balance of the token is FAR LESS than what
///                 curve reserves held at grad (excess got burned)
///               * BURN_ADDRESS holds the difference
///               * Graduator has 0 balance (nothing stranded)
contract GraduatorV3PricingForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address internal constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    // Live V3 + V11 addresses now that CurveFactory.graduator was rotated
    // to V3 on 2026-08-13 and MHH to V11 in the same broadcast. The earlier
    // vm.etch-over-V10 approach doesn't apply anymore because CF now dispatches
    // to the REAL V3 at V3_GRADUATOR, not the etched V10 slot.
    address internal constant V3_GRADUATOR = 0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23;
    address internal constant V11_MHH = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;
    // Kept for backward-compatible name references in this file's body.
    address internal constant V10_GRADUATOR = V3_GRADUATOR;
    address internal constant V10_MHH = V11_MHH;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    bytes32 internal constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    address internal launcher = makeAddr("v3-test-launcher");
    address internal buyer = makeAddr("v3-test-buyer");

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

        // V3 is now REAL on-chain at V3_GRADUATOR — no etch needed. The
        // constants V10_GRADUATOR / V10_MHH above alias to V3 / V11 so the
        // rest of this file's body compiles unchanged. The vm.etch call is
        // a no-op-equivalent (etches V3 code onto its own address).
        GraduatorV3 v3Impl =
            new GraduatorV3(IPoolManager(POOL_MANAGER), IHooks(V11_MHH), 3000, 60, CURVE_FACTORY, DEPLOYER);
        // Belt-and-suspenders: still etch in case a future rotation moves the
        // live V3. Harmless when live V3 == the code being etched.
        vm.etch(V3_GRADUATOR, address(v3Impl).code);

        vm.deal(launcher, 10 ether);
        vm.deal(buyer, 10 ether);
    }

    /// The critical test — V3's seed price should match the CURVE MARGINAL
    /// at graduation, NOT the raw real ratio. Also excess tokens burned.
    function test_V3_SeedsPoolAtCurveMarginal_AndBurnsExcessTokens() public {
        // Read defaults so we know the curve config the token will launch with.
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        uint256 virtEth = cf.defaultVirtualEthReserve();
        uint256 virtTok = cf.defaultVirtualTokenReserve();
        uint256 curveSupply = cf.defaultCurveSupply();
        uint256 gradTarget = cf.defaultGraduationTargetEth();
        console2.log("=== Curve defaults ===");
        console2.log("  virtEth:      ", virtEth);
        console2.log("  virtTok:      ", virtTok);
        console2.log("  curveSupply:  ", curveSupply);
        console2.log("  gradTarget:   ", gradTarget);

        // 1) Launch bare ERC20 via live Router.
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "GradV3 Test";
        p.ticker = "GV3T";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(curveSupply, ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = Router(payable(ROUTER)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(ROUTER)).launch{value: launchFee}(p);
        address curve = cf.curveFor(token);
        console2.log("  launched token:", token);
        console2.log("  curve:         ", curve);

        // 2) Buy exactly enough ETH to trigger graduation. gradTarget + tiny
        //    slippage buffer. The curve rejects the ~overflow so we simulate
        //    the "fill to the top" behavior by sending slightly more than
        //    gradTarget * (1 / (1 - fee)).
        uint256 buyAmount = gradTarget + 0.5 ether;
        vm.deal(buyer, buyAmount + 0.1 ether);
        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: buyAmount}(0);

        assertTrue(BondingCurve(payable(curve)).graduated(), "curve did not graduate");
        console2.log("=== Graduation state ===");
        console2.log("  curve.ethReserve after:  ", BondingCurve(payable(curve)).ethReserve());
        console2.log("  curve.tokenReserve after:", BondingCurve(payable(curve)).tokenReserve());

        // 3) Read pool state via poolManager (both currencies are 18-decimal,
        //    currency0 = ETH, currency1 = token).
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(V10_MHH)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtP, 0, "pool not initialized");

        // 4) Compute EXPECTED curve marginal price at graduation.
        //    marginal_wei = (virtEth + realEth_at_grad) / (virtTok + realTok_at_grad)
        //    ≈ (virtEth + gradTarget) / (virtTok + tokenReserveAtGrad)
        //    Both curve state values are queryable AFTER graduation as 0 (curve wiped),
        //    but we can reconstruct: tokenReserve at grad = (v_eth * curveSupply) / (v_eth + realEth) - v_tok /
        // (constant product) Simpler: use the poolManager balance of the token BEFORE any swaps to see how much LP got.

        // Post-graduation:
        //   PoolManager holds SOME of `tokenAmount` handed to Graduator.
        //   BURN_ADDRESS holds the rest.
        //   PM + BURN = total token supply the graduator received (which was
        //     the curve's post-grad tokenReserve, i.e., curveSupply - tokens_sold).
        uint256 pmHolds = IERC20V(token).balanceOf(POOL_MANAGER);
        uint256 burned = IERC20V(token).balanceOf(BURN_ADDRESS);
        uint256 buyerHolds = IERC20V(token).balanceOf(buyer);
        console2.log("=== Post-graduation token distribution ===");
        console2.log("  PoolManager (LP):  ", pmHolds);
        console2.log("  BURN_ADDRESS:       ", burned);
        console2.log("  Buyer wallet:       ", buyerHolds);
        console2.log("  Sum:                ", pmHolds + burned + buyerHolds);
        console2.log("  Total supply:       ", IERC20V(token).balanceOf(address(0)) == 0 ? curveSupply : 0);

        // ═══════════════════════════════════════════════════════════════════
        //   ASSERTION 1: BURN happened. Curve delivered lots of tokens →
        //   LP absorbed only the fraction that matched marginal price →
        //   rest burned. V2 would have LP absorbing ALL of them (burn == 0).
        // ═══════════════════════════════════════════════════════════════════
        assertGt(burned, 0, "V3 must burn excess tokens (V2 bug: burn was always 0)");
        console2.log("  [OK] BURN happened:", burned, "tokens sent to 0xdEaD");

        // ═══════════════════════════════════════════════════════════════════
        //   ASSERTION 2: Pool spot ≈ curve marginal. With V2 the pool spot
        //   would be roughly (real_ETH / real_tokens_in_LP) which is ~4x
        //   lower than marginal for our defaults. With V3, they should
        //   match closely (within ~1% for integer math).
        // ═══════════════════════════════════════════════════════════════════
        // Pool spot in ETH per token (18-dec) = 2^192 / sqrtP^2  (both currs 18dec, currency0=ETH)
        uint256 poolSpot18 = (uint256(1e18) << 192) / (uint256(sqrtP) * uint256(sqrtP));
        console2.log("  poolSpot (ETH per token, 18-dec):", poolSpot18);

        // Compute expected curve marginal from state Graduator SAW.
        // Graduator receives (ethAmount, tokenAmount) from curve.
        //   ethAmount = curve.ethReserve at grad = gradTarget (curve floor)
        //   tokenAmount = curve.tokenReserve at grad = k/(virtEth+ethAmount) - virtTok
        //   where k = virtEth * (curveSupply + virtTok)
        uint256 k = virtEth * (curveSupply + virtTok) / 1e18; // keep k in wei-scale
        // Simpler: read what actually was delivered by looking at PM + burn.
        uint256 tokenAmountDelivered = pmHolds + burned;
        uint256 ethAmountDelivered = uint256(pmHolds > 0 ? BondingCurve(payable(curve)).ethReserve() : 0);
        // ethReserve is 0 post-graduation. Use gradTarget as a proxy — near enough.
        uint256 realEthAtGrad = gradTarget;
        uint256 expectedMarginal18 = ((virtEth + realEthAtGrad) * 1e18) / (virtTok + tokenAmountDelivered);
        console2.log("  expected marginal (ETH per token, 18-dec):", expectedMarginal18);

        // Allow 5% deviation for integer sqrt truncation + slippage on the last buy tx.
        uint256 lo = expectedMarginal18 * 95 / 100;
        uint256 hi = expectedMarginal18 * 105 / 100;
        assertGe(poolSpot18, lo, "pool spot below curve marginal - 5%");
        assertLe(poolSpot18, hi, "pool spot above curve marginal + 5%");
        console2.log("  [OK] pool spot within 5% of curve marginal");

        // ═══════════════════════════════════════════════════════════════════
        //   ASSERTION 3: No ETH stranded on Graduator. All ethAmount either
        //   went into LP or credited to launcher's pull-refund ledger.
        // ═══════════════════════════════════════════════════════════════════
        uint256 gradBal = V10_GRADUATOR.balance;
        uint256 claimable = GraduatorV3(payable(V10_GRADUATOR)).totalClaimable();
        assertEq(gradBal, claimable, "Graduator balance must equal totalClaimable (no strand)");
        console2.log("  [OK] Graduator.balance == totalClaimable:", gradBal, "wei");

        // ═══════════════════════════════════════════════════════════════════
        //   HEADLINE: buyer #1 (only buyer here) was up how much?
        // ═══════════════════════════════════════════════════════════════════
        // Their spot value = tokens * poolSpot18 / 1e18
        uint256 spotValue = (buyerHolds * poolSpot18) / 1e18;
        console2.log("=== Buyer P&L (single-buyer test) ===");
        console2.log("  Buyer spent (approx):", buyAmount);
        console2.log("  Buyer tokens:        ", buyerHolds);
        console2.log("  Buyer spot value:    ", spotValue);
        console2.log("  Net vs spent:        ", int256(spotValue) - int256(buyAmount));
    }
}
