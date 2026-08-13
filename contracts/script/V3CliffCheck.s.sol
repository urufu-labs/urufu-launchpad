// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {GraduatorV3} from "src/curve/GraduatorV3.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title  V3CliffCheck
/// @notice Real on-chain graduation test at 0.001 ETH scale on the LIVE V3
///         stack (no redeploy - CF is already wired to V3). Purpose: prove
///         that the curve-marginal price a buyer sees at end-of-curve is the
///         same price the v4 pool opens with. That's the cliff LUV had.
///         If pool spot < curve marginal by > 5%, the cliff is back - the
///         script reverts and NOTHING makes it to launch.
///
///         Also reports market cap (spot * totalSupply) both sides so the
///         user can see "$X MC on curve -> $X MC on Uniswap" match up
///         (or not) in absolute dollar terms, not just ratios.
///
///         Env required: DEV_PRIVATE_KEY (funds the launch fee + buy).
contract V3CliffCheck is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Live V10-family wiring (unchanged). Only Graduator + MHH rotated to V3/V11.
    address constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V3 = 0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23;
    address constant V11_MHH = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;

    uint256 constant TEST_GRAD_TARGET = 0.001 ether;
    // 1% trade fee eats the buy on the way in, so buying exactly
    // gradTarget only puts (gradTarget * 0.99) into curve.ethReserve.
    // Grossed-up amount: gradTarget * 10000 / (10000 - feeBps).
    // At 100 bps: 0.001 / 0.99 = 0.001010101... ETH. Round up to 0.0011
    // for a tiny cushion (curve accepts any overshoot, V3 handles residual).
    uint256 constant TEST_BUY = 0.0011 ether;

    bytes32 constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);

        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        require(cf.graduator() == V3, "CF is NOT on V3 - abort");

        // Snapshot defaults so we can restore after test.
        uint256 origSupply = cf.defaultCurveSupply();
        uint256 origVTok = cf.defaultVirtualTokenReserve();
        uint256 origVEth = cf.defaultVirtualEthReserve();
        uint256 origGrad = cf.defaultGraduationTargetEth();
        uint16 origFee = cf.defaultTradeFeeBps();

        console2.log("========================================================");
        console2.log("V3 CLIFF-CHECK - real graduation at 0.001 ETH scale");
        console2.log("========================================================");
        console2.log("Signer:                    ", me);
        console2.log("Grad target (test):        ", TEST_GRAD_TARGET);
        console2.log("Buy (test, matches target):", TEST_BUY);

        vm.startBroadcast(pk);

        // Lower grad target for the test.
        cf.setDefaults(origSupply, origVTok, origVEth, TEST_GRAD_TARGET, origFee);

        // Launch + capped buy that lands exactly at gradTarget.
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Cliff Check 2";
        p.ticker = "CLF2";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(origSupply, ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = Router(payable(ROUTER)).quote(p);
        address token = Router(payable(ROUTER)).launchAndBuy{value: launchFee + TEST_BUY}(p, TEST_BUY, 1, me);

        address curve = cf.curveFor(token);
        require(BondingCurve(payable(curve)).graduated(), "did not graduate");

        vm.stopBroadcast();

        // ---- Read state for comparison ----
        uint256 totalSupply = IERC20V(token).totalSupply();

        // POST-graduation state (only the pool exists; curve reserves are 0).
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(V11_MHH)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        require(sqrtP > 0, "pool not initialized");

        // Pool spot in wei-of-ETH per WHOLE token (both currencies 18-dec):
        //   v4 stores sqrtPriceX96 where price = sqrtP^2 / 2^192, price is
        //   token_wei per eth_wei. To get eth_wei per WHOLE token (which
        //   matches curveMarginal's units), invert AND scale by 1e18:
        //     poolSpotWeiPerToken = (1e18 * 2^192) / sqrtP^2
        //   Same formula the trade page uses. My previous attempt missed
        //   the 1e18 factor and integer-divided to 0 at low prices.
        uint256 poolSpotWeiPerToken = (uint256(1e18) << 192) / (uint256(sqrtP) * uint256(sqrtP));

        // Expected curve marginal at the moment of graduation:
        //   marginal = (virtEth + gradTarget) / (virtTok + tokensLeftAtGrad)
        // where tokensLeftAtGrad = tokens the graduator received = pool tokens + burned tokens.
        uint256 poolTokens = IERC20V(token).balanceOf(POOL_MANAGER);
        uint256 burned = IERC20V(token).balanceOf(0x000000000000000000000000000000000000dEaD);
        uint256 tokensAtGrad = poolTokens + burned;
        uint256 expectedMarginalWeiPerToken = ((origVEth + TEST_GRAD_TARGET) * 1e18) / (origVTok + tokensAtGrad);

        console2.log("========================================================");
        console2.log("PRICE COMPARISON - curve marginal vs pool spot");
        console2.log("========================================================");
        console2.log("Curve marginal (last curve buy price, wei/tok):");
        console2.log("  ", expectedMarginalWeiPerToken);
        console2.log("Uniswap v4 pool spot (opening price, wei/tok):");
        console2.log("  ", poolSpotWeiPerToken);

        // Diff in bps - negative means pool is BELOW curve (=cliff).
        int256 diffBps;
        if (poolSpotWeiPerToken >= expectedMarginalWeiPerToken) {
            diffBps =
                int256(((poolSpotWeiPerToken - expectedMarginalWeiPerToken) * 10_000) / expectedMarginalWeiPerToken);
        } else {
            diffBps =
                -int256(((expectedMarginalWeiPerToken - poolSpotWeiPerToken) * 10_000) / expectedMarginalWeiPerToken);
        }
        console2.log("Diff (bps, positive = pool higher, negative = CLIFF):");
        console2.logInt(diffBps);

        // Reject anything below -500 bps (5% cliff). LUV was ~-5000 bps (50%).
        require(diffBps >= -500, "CLIFF DETECTED - pool > 5% below curve marginal - ABORT LAUNCH");

        console2.log("========================================================");
        console2.log("MARKET CAP COMPARISON (spot * totalSupply)");
        console2.log("========================================================");
        // MC in wei-of-ETH. totalSupply is already 18-decimals; poolSpotWeiPerToken
        // is wei-per-whole-token, so mc = spot * (totalSupply / 1e18).
        uint256 curveMcWei = (expectedMarginalWeiPerToken * totalSupply) / 1e18;
        uint256 poolMcWei = (poolSpotWeiPerToken * totalSupply) / 1e18;
        console2.log("Curve-side MC just before grad (ETH x1e18):   ", curveMcWei);
        console2.log("Pool-side MC right after grad  (ETH x1e18):   ", poolMcWei);

        // ---- Post-check state ----
        uint256 v3Bal = address(V3).balance;
        uint256 v3Claim = GraduatorV3(payable(V3)).totalClaimable();
        console2.log("========================================================");
        console2.log("GRADUATOR STATE");
        console2.log("========================================================");
        console2.log("V3.balance                  :", v3Bal);
        console2.log("V3.totalClaimable           :", v3Claim);
        console2.log("Strand (bal - claim)        :", v3Bal - v3Claim);
        console2.log("Pool tokens (in LP)         :", poolTokens);
        console2.log("Burned tokens               :", burned);
        console2.log("Token totalSupply           :", totalSupply);

        // Restore defaults
        vm.startBroadcast(pk);
        cf.setDefaults(origSupply, origVTok, origVEth, origGrad, origFee);
        vm.stopBroadcast();

        console2.log("========================================================");
        console2.log("PASSED. Pool spot >= curve marginal - 5%. NO CLIFF.");
        console2.log("Defaults restored (grad target back to", origGrad, ")");
        console2.log("========================================================");
        console2.log("Test token address:", token);
    }
}
