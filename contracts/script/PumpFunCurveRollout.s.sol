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
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title  PumpFunCurveRollout
/// @notice Combined setDefaults + cliff verification + production rollout.
///
///         Step 1: setDefaults to the NEW pump-fun-shaped config but with a
///                 tiny 0.001 ETH grad target (for cheap testing).
///         Step 2: Launch a real token via launchAndBuy that triggers
///                 graduation. Verify pool spot matches curve marginal (no
///                 cliff). Assert within 5% tolerance.
///         Step 3: On pass, setDefaults again with the PRODUCTION grad target
///                 (4.2 ETH). If step 2 reverts, defaults stay at test values
///                 for inspection.
///
///         Result: production curves launch with steeper 10x-ramp dynamics
///         and V3 continues to seed pools at curve marginal (no cliff).
contract PumpFunCurveRollout is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V11_MHH = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;

    // NEW pump-fun-shaped config. supply unchanged so existing tokens read
    // like existing tokens; new tokens have steeper ramp.
    uint256 constant NEW_SUPPLY = 800_000_000e18;
    uint256 constant NEW_VIRT_TOK = 200_000_000e18;
    uint256 constant NEW_VIRT_ETH = 2 ether;
    uint256 constant NEW_GRAD_TARGET = 4.2 ether;
    uint16 constant NEW_FEE_BPS = 100;

    // Cheap-test grad target used during the on-chain cliff verification.
    // 1% fee grosses the buy up to 0.00101 ETH. Total cost ~ 0.0015 ETH.
    uint256 constant TEST_GRAD_TARGET = 0.001 ether;
    uint256 constant TEST_BUY = 0.0011 ether;

    bytes32 constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);
        CurveFactory cf = CurveFactory(CURVE_FACTORY);
        require(cf.owner() == me, "not CF owner");

        uint256 origSupply = cf.defaultCurveSupply();
        uint256 origVTok = cf.defaultVirtualTokenReserve();
        uint256 origVEth = cf.defaultVirtualEthReserve();
        uint256 origGrad = cf.defaultGraduationTargetEth();
        uint16 origFee = cf.defaultTradeFeeBps();

        console2.log("========================================================");
        console2.log("PUMPFUN CURVE ROLLOUT");
        console2.log("========================================================");
        console2.log("Old defaults:");
        console2.log("  virtEth:", origVEth);
        console2.log("  virtTok:", origVTok);
        console2.log("  grad:   ", origGrad);
        console2.log("New defaults (target):");
        console2.log("  virtEth:", NEW_VIRT_ETH);
        console2.log("  virtTok:", NEW_VIRT_TOK);
        console2.log("  grad:   ", NEW_GRAD_TARGET);
        console2.log("  (ramp: ~10x from launch to graduation)");

        vm.startBroadcast(pk);

        // Step 1: setDefaults to NEW virtEth/virtTok with TEST grad target.
        cf.setDefaults(NEW_SUPPLY, NEW_VIRT_TOK, NEW_VIRT_ETH, TEST_GRAD_TARGET, NEW_FEE_BPS);

        // Step 2: Launch + immediately buy through target.
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "PumpFun Rollout Test";
        p.ticker = "PFT";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(NEW_SUPPLY, ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = Router(payable(ROUTER)).quote(p);
        address token = Router(payable(ROUTER)).launchAndBuy{value: launchFee + TEST_BUY}(p, TEST_BUY, 1, me);

        address curve = cf.curveFor(token);
        require(BondingCurve(payable(curve)).graduated(), "did not graduate");

        vm.stopBroadcast();

        // Read state for cliff comparison.
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

        uint256 poolSpot = (uint256(1e18) << 192) / (uint256(sqrtP) * uint256(sqrtP));
        uint256 poolTokens = IERC20V(token).balanceOf(POOL_MANAGER);
        uint256 burned = IERC20V(token).balanceOf(0x000000000000000000000000000000000000dEaD);
        uint256 tokensAtGrad = poolTokens + burned;
        uint256 expectedMarginal = ((NEW_VIRT_ETH + TEST_GRAD_TARGET) * 1e18) / (NEW_VIRT_TOK + tokensAtGrad);

        console2.log("");
        console2.log("========================================================");
        console2.log("CLIFF CHECK at new pump-fun-shaped config");
        console2.log("========================================================");
        console2.log("Curve marginal (wei/tok):", expectedMarginal);
        console2.log("Pool spot      (wei/tok):", poolSpot);

        int256 diffBps;
        if (poolSpot >= expectedMarginal) {
            diffBps = int256(((poolSpot - expectedMarginal) * 10_000) / expectedMarginal);
        } else {
            diffBps = -int256(((expectedMarginal - poolSpot) * 10_000) / expectedMarginal);
        }
        console2.log("Diff (bps, negative = CLIFF):");
        console2.logInt(diffBps);
        require(diffBps >= -500, "CLIFF DETECTED - defaults NOT changed to production");

        console2.log("");
        console2.log("NO CLIFF. Setting production defaults now.");

        // Step 3: setDefaults again with production grad target.
        vm.startBroadcast(pk);
        cf.setDefaults(NEW_SUPPLY, NEW_VIRT_TOK, NEW_VIRT_ETH, NEW_GRAD_TARGET, NEW_FEE_BPS);
        vm.stopBroadcast();

        // Sanity re-read.
        require(cf.defaultVirtualEthReserve() == NEW_VIRT_ETH, "virtEth restore mismatch");
        require(cf.defaultVirtualTokenReserve() == NEW_VIRT_TOK, "virtTok restore mismatch");
        require(cf.defaultGraduationTargetEth() == NEW_GRAD_TARGET, "grad restore mismatch");

        console2.log("========================================================");
        console2.log("PRODUCTION DEFAULTS SET.");
        console2.log("Every new launch from now uses pump-fun-shaped curve.");
        console2.log("Existing tokens unchanged (params baked at curve init).");
        console2.log("Test token (hide from feeds):", token);
        console2.log("========================================================");
    }
}
