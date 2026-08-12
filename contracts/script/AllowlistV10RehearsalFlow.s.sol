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
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @title  AllowlistV10RehearsalFlow
/// @notice One-shot broadcast that produces a live V10 MHH pool for the Uniswap
///         v4 hook allowlist form. Flow:
///           1. snapshot current CF defaults (they will be restored at the end)
///           2. set grad target to 0.001 ETH (all other defaults preserved)
///           3. Router.launchAndBuy(bare ERC20, 0.0015 ETH initial buy)
///              → curve funded past 0.001 ETH → graduation → v4 pool minted
///                on the V10 MHH hook via the V10 Graduator
///           4. V4SwapRouter.swapExactETHForToken(0.0001 ETH)
///              → proves beforeSwap + afterSwap hooks fire on the real pool
///           5. restore snapshotted CF defaults
///         Prints token, curve, poolId, and PoolKey pieces so the allowlist
///         form (and this session's memory) has everything.
contract AllowlistV10RehearsalFlow is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // V10 live stack (2026-08-12 rotation + same-day Router re-wire).
    address constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address constant MULTI_HOOK_HOST = 0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V4_SWAP_ROUTER = 0xDb3D1C43225faEe04551b663E5aA0969937beEa4;

    bytes32 constant BARE_HASH = keccak256(abi.encode("ERC20", ""));
    uint256 constant TEST_GRAD_TARGET = 0.001 ether;
    uint256 constant INITIAL_BUY = 0.0015 ether;
    uint256 constant SWAP_SIZE = 0.0001 ether;

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);

        CurveFactory cf = CurveFactory(CURVE_FACTORY);

        // ---- (1) snapshot ----
        uint256 origSupply = cf.defaultCurveSupply();
        uint256 origVTok = cf.defaultVirtualTokenReserve();
        uint256 origVEth = cf.defaultVirtualEthReserve();
        uint256 origGrad = cf.defaultGraduationTargetEth();
        uint16 origFee = cf.defaultTradeFeeBps();

        console2.log("=========================================================");
        console2.log("V10 MHH Allowlist Rehearsal Flow");
        console2.log("=========================================================");
        console2.log("Signer:            ", me);
        console2.log("Snapshotted grad:  ", origGrad);
        console2.log("Test grad target:  ", TEST_GRAD_TARGET);
        console2.log("Initial buy:       ", INITIAL_BUY);
        console2.log("Swap size:         ", SWAP_SIZE);
        console2.log("=========================================================");

        vm.startBroadcast(pk);

        // ---- (2) lower grad target (everything else preserved) ----
        cf.setDefaults(origSupply, origVTok, origVEth, TEST_GRAD_TARGET, origFee);

        // ---- (3) Router.launchAndBuy → graduation ----
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V10 Allowlist Rehearsal";
        p.ticker = "V10AL";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(uint256(800_000_000e18), ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = Router(payable(ROUTER)).quote(p);
        address token =
            Router(payable(ROUTER)).launchAndBuy{value: launchFee + INITIAL_BUY}(p, INITIAL_BUY, 1, me);
        address curve = cf.curveFor(token);
        require(curve != address(0), "curve missing");
        require(BondingCurve(payable(curve)).graduated(), "did not graduate");

        // ---- (4) swap on the resulting v4 pool ----
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(MULTI_HOOK_HOST)
        });
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: SWAP_SIZE}(
            key, 1, me, block.timestamp + 300
        );

        // ---- (5) restore original CF defaults ----
        cf.setDefaults(origSupply, origVTok, origVEth, origGrad, origFee);

        vm.stopBroadcast();

        // ---- summary for the allowlist form ----
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        uint128 liq = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        uint256 poolTokBal = IERC20V(token).balanceOf(POOL_MANAGER);
        uint256 buyerTokBal = IERC20V(token).balanceOf(me);

        console2.log("=========================================================");
        console2.log("REHEARSAL COMPLETE - Uniswap allowlist form data below");
        console2.log("=========================================================");
        console2.log("Token address:     ", token);
        console2.log("Curve address:     ", curve);
        console2.log("MHH hook address:  ", MULTI_HOOK_HOST);
        console2.log("PoolManager:       ", POOL_MANAGER);
        console2.log("PoolKey.fee:       ", uint256(3000));
        console2.log("PoolKey.tickSpace: ", uint256(60));
        console2.log("Pool sqrtPriceX96: ", sqrtP);
        console2.log("Pool liquidity:    ", liq);
        console2.log("PoolManager holds: ", poolTokBal, "tokens");
        console2.log("Buyer holds:       ", buyerTokBal, "tokens");
        console2.log("Restored grad:     ", cf.defaultGraduationTargetEth());
        require(cf.defaultGraduationTargetEth() == origGrad, "CF defaults NOT restored");
        console2.log("=========================================================");
        console2.log("PoolID (bytes32):");
        console2.logBytes32(PoolId.unwrap(poolId));
        console2.log("=========================================================");
    }
}
