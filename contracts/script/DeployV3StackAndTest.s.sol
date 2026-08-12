// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
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

/// @title  DeployV3StackAndTest
/// @notice One-shot broadcast:
///           1. Deploy V11 MultiHookHost (CREATE2-mined for 0x20C4 flags)
///           2. Deploy GraduatorV3 pointing at V11 MHH
///           3. MHH.setInitializer(V3)
///           4. CurveFactory.setGraduator(V3)
///           5. Snapshot defaults + set LOW grad target (0.001 ETH) for test
///           6. Router.launchAndBuy — trigger a real graduation on-chain
///           7. Verify pool spot ≈ curve marginal + excess burned + no strand
///           8. Restore original defaults
///
///         If step 7 fails, the script reverts BEFORE restoring defaults,
///         so state is left with the broken curve setup for inspection. If
///         step 7 passes, defaults + wiring end in a clean, launch-ready
///         state with V3 as the CurveFactory's graduator.
///
///         DOES NOT flip LAUNCHPAD_LIVE. User does that separately after
///         confirming this broadcast succeeded.
contract DeployV3StackAndTest is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Live V10 wiring (unchanged addresses we plug into).
    address constant ROUTER = 0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269;
    address constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 constant TEST_GRAD_TARGET = 0.001 ether;
    uint256 constant TEST_INITIAL_BUY = 0.0015 ether;

    bytes32 constant BARE_HASH = keccak256(abi.encode("ERC20", ""));

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");
        address me = vm.addr(pk);

        CurveFactory cf = CurveFactory(CURVE_FACTORY);

        uint256 origSupply = cf.defaultCurveSupply();
        uint256 origVTok = cf.defaultVirtualTokenReserve();
        uint256 origVEth = cf.defaultVirtualEthReserve();
        uint256 origGrad = cf.defaultGraduationTargetEth();
        uint16 origFee = cf.defaultTradeFeeBps();

        console2.log("========================================================");
        console2.log("V3 GRADUATOR STACK DEPLOY + REAL-CHAIN TEST");
        console2.log("========================================================");
        console2.log("Signer:            ", me);
        console2.log("Snapshotted grad:  ", origGrad);
        console2.log("Test grad target:  ", TEST_GRAD_TARGET);
        console2.log("Test initial buy:  ", TEST_INITIAL_BUY);
        console2.log("========================================================");

        vm.startBroadcast(pk);

        // ---- 1. Mine + deploy V11 MHH ----
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory mhhCreation = type(MultiHookHost).creationCode;
        // MHH ctor: (IPoolManager, feeSplitter, operator, platformBps, creatorBps, deployer)
        bytes memory mhhArgs = abi.encode(
            IPoolManager(POOL_MANAGER), FEE_SPLITTER, me, uint16(100), uint16(100), me
        );
        // Foundry's `new X{salt}` routes through the canonical CREATE2 deployer
        // (0x4e59...4956C), not the signing wallet. Mine with that address.
        // Bump past any salt whose predicted address already has code — V10
        // MHH used the same ctor args, so salt=0 collides. Same pattern as
        // DeployV10WlImmediateStack.
        uint256 startSalt = 0;
        uint256 salt;
        address predicted;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, predicted) =
                HookMiner.findFrom(CREATE2_DEPLOYER, requiredFlags, mhhCreation, mhhArgs, 500_000, startSalt);
            if (predicted.code.length == 0) break;
            console2.log("  [skip] MHH salt already deployed, bumping past", salt);
            startSalt = salt + 1;
        }
        require(predicted.code.length == 0, "no empty MHH salt found in 10 attempts");
        MultiHookHost mhh = new MultiHookHost{salt: bytes32(salt)}(
            IPoolManager(POOL_MANAGER), FEE_SPLITTER, me, uint16(100), uint16(100), me
        );
        require(address(mhh) == predicted, "MHH salt drift");
        console2.log("V11 MHH deployed:  ", address(mhh));

        // ---- 2. Deploy V3 Graduator ----
        GraduatorV3 v3 = new GraduatorV3(
            IPoolManager(POOL_MANAGER),
            IHooks(address(mhh)),
            3000,
            60,
            CURVE_FACTORY,
            me
        );
        console2.log("V3 Graduator:      ", address(v3));

        // ---- 3. Wire ----
        mhh.setInitializer(address(v3));
        require(mhh.initializer() == address(v3), "MHH initializer wiring failed");
        console2.log("MHH.initializer -> V3 OK");

        // ---- 4. Rotate CF ----
        cf.setGraduator(address(v3));
        require(cf.graduator() == address(v3), "CF.setGraduator failed");
        console2.log("CF.graduator     -> V3 OK");

        // ---- 5. Lower grad target for test ----
        cf.setDefaults(origSupply, origVTok, origVEth, TEST_GRAD_TARGET, origFee);
        require(cf.defaultGraduationTargetEth() == TEST_GRAD_TARGET, "setDefaults down failed");
        console2.log("Defaults grad lowered to", TEST_GRAD_TARGET);

        // ---- 6. Launch + trigger graduation ----
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V3 Test Coin";
        p.ticker = "V3TC";
        p.configHash = BARE_HASH;
        p.initData = abi.encode(uint256(800_000_000e18), ROUTER, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 launchFee = Router(payable(ROUTER)).quote(p);
        address token = Router(payable(ROUTER))
            .launchAndBuy{value: launchFee + TEST_INITIAL_BUY}(p, TEST_INITIAL_BUY, 1, me);
        address curve = cf.curveFor(token);
        require(curve != address(0), "curve missing");
        require(BondingCurve(payable(curve)).graduated(), "did not graduate");
        console2.log("Launched + graduated. Token:", token);

        // ---- 7. Verify pool state ----
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(mhh))
        });
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        require(sqrtP > 0, "pool not initialized");

        uint256 pmHolds = IERC20V(token).balanceOf(POOL_MANAGER);
        uint256 burned = IERC20V(token).balanceOf(BURN_ADDRESS);
        uint256 meHolds = IERC20V(token).balanceOf(me);

        console2.log("---- Post-graduation ----");
        console2.log("  poolManager (LP):  ", pmHolds);
        console2.log("  BURN_ADDRESS:       ", burned);
        console2.log("  buyer wallet:       ", meHolds);
        require(burned > 0, "V3 must burn excess tokens (regression: burn=0)");

        // Pool spot = 2^192 / sqrtP^2 (18-dec, both currencies 18-dec, currency0=ETH)
        uint256 poolSpot18 = (uint256(1e18) << 192) / (uint256(sqrtP) * uint256(sqrtP));

        // Expected curve marginal (18-dec ETH per token):
        //   marginal = (virtEth + gradTarget) / (virtTok + tokenReserveAtGrad)
        //   tokenReserveAtGrad = pmHolds + burned (what Graduator received)
        uint256 tokenAtGrad = pmHolds + burned;
        uint256 expectedMarginal = ((origVEth + TEST_GRAD_TARGET) * 1e18) / (origVTok + tokenAtGrad);
        console2.log("  poolSpot   (ETH/tok 18dec):", poolSpot18);
        console2.log("  expected   (ETH/tok 18dec):", expectedMarginal);
        require(poolSpot18 * 100 >= expectedMarginal * 90, "pool spot below marginal - 10%");
        require(poolSpot18 * 100 <= expectedMarginal * 110, "pool spot above marginal + 10%");

        uint256 gradBal = address(v3).balance;
        uint256 claimable = v3.totalClaimable();
        require(gradBal == claimable, "Graduator ETH strand");

        // ---- 8. Restore defaults ----
        cf.setDefaults(origSupply, origVTok, origVEth, origGrad, origFee);
        require(cf.defaultGraduationTargetEth() == origGrad, "restore failed");
        console2.log("Defaults restored to grad=", origGrad);

        vm.stopBroadcast();

        console2.log("========================================================");
        console2.log("SUCCESS. V3 wired + tested on-chain. New addresses:");
        console2.log("  V11 MHH:      ", address(mhh));
        console2.log("  V3 Graduator: ", address(v3));
        console2.log("========================================================");
    }
}
