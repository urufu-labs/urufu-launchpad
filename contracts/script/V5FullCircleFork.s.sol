// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

interface ICurveFactoryRead {
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function graduator() external view returns (address);
}

interface IERC20Read {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

interface INameRegistry {
    function isNameAvailable(
        string calldata
    ) external view returns (bool);
    function isTickerAvailable(
        string calldata
    ) external view returns (bool);
}

interface IOwnable {
    function owner() external view returns (address);
}

interface IPausable {
    function paused() external view returns (bool);
    function setPaused(
        bool
    ) external;
}

interface IErc20FactoryAdmin {
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
}

interface ICurveFactoryAdmin {
    function graduator() external view returns (address);
    function setGraduator(
        address graduator_
    ) external;
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
}

/// @title V5 Full-Circle Fork Simulation
/// @notice Simulates a full launch -> buy-to-graduation -> post-grad swap -> fee accrual
///         path against a forked Robinhood mainnet, hitting the NEW V5 stack:
///         Router 0x5EFA…, Graduator 0xaf62…, MultiHookHost 0xd19d….
contract V5FullCircleFork is Script {
    using PoolIdLibrary for PoolKey;

    // ---- V5 (NEW) ----
    address constant ROUTER_V5 = 0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE;
    address constant GRADUATOR_V5 = 0xaf62e66B6039cCd11a5953e3f3dB342CF7EAa489;
    address constant HOOK_V5 = 0xd19d999A3E35cA4b28f245D9bAf30FeFf4F862c4;

    // ---- Unchanged ----
    address constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;

    uint24 constant POOL_FEE = 3000;
    int24 constant POOL_TICK_SPACING = 60;

    function run() external {
        address alice = address(0xA11CE);
        vm.deal(alice, 200 ether);

        _log("=== V5 FULL-CIRCLE FORK SIMULATION ===");
        _log("Router V5:      ", ROUTER_V5);
        _log("Graduator V5:   ", GRADUATOR_V5);
        _log("HookMHH V5:     ", HOOK_V5);

        // V5 router ships paused on-chain until the frontend/indexer cutover;
        // prank the owner and flip it off for the sim so we can exercise launch.
        address routerOwner = IOwnable(ROUTER_V5).owner();
        _log("Router V5 owner:", routerOwner);
        if (IPausable(ROUTER_V5).paused()) {
            vm.prank(routerOwner);
            IPausable(ROUTER_V5).setPaused(false);
            _log("Router V5 unpaused for sim");
        }

        // ---- Rewire hunt: current mainnet state has the V5 stack DEPLOYED but the
        // hub contracts (ERC20Factory, NameRegistry, CurveFactory.graduator, curve-
        // factory trustedRouter) still point at the V6-intermediate + old graduator.
        // We patch each on the fork with owner pranks / vm.store so the launch path
        // can actually hit V5 Router / V5 Graduator / V5 MHH end-to-end.
        address erc20Factory = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
        address factoryOwner = IOwnable(erc20Factory).owner();
        if (IErc20FactoryAdmin(erc20Factory).router() != ROUTER_V5) {
            vm.prank(factoryOwner);
            IErc20FactoryAdmin(erc20Factory).setRouter(ROUTER_V5);
            _log("ERC20Factory.setRouter(V5) done. router:", IErc20FactoryAdmin(erc20Factory).router());
        }

        address cfOwner = IOwnable(CURVE_FACTORY).owner();
        if (ICurveFactoryAdmin(CURVE_FACTORY).graduator() != GRADUATOR_V5) {
            vm.prank(cfOwner);
            ICurveFactoryAdmin(CURVE_FACTORY).setGraduator(GRADUATOR_V5);
            _log("CurveFactory.setGraduator(V5) done. graduator:", ICurveFactoryAdmin(CURVE_FACTORY).graduator());
        }
        vm.prank(cfOwner);
        ICurveFactoryAdmin(CURVE_FACTORY).setTrustedRouter(ROUTER_V5, true);

        // NameRegistry.router is 2-step-gated with a 2-day delay. For a fork sim we
        // stomp the slot directly (slot 0) rather than warping forward two days.
        bytes32 currentReg = vm.load(NAME_REGISTRY, bytes32(uint256(0)));
        if (address(uint160(uint256(currentReg))) != ROUTER_V5) {
            vm.store(NAME_REGISTRY, bytes32(uint256(0)), bytes32(uint256(uint160(ROUTER_V5))));
            _log("NameRegistry.router stomped to V5 via vm.store");
        }

        // -------------------------------------------------- STEP 1+2: launch
        address token = _launchWithCurve(alice);

        // -------------------------------------------------- STEP 3: verify wiring
        address curve = _verifyCurveInstalled(token);

        // -------------------------------------------------- STEP 4: buy to graduation
        _buyToGraduation(curve, alice);

        // -------------------------------------------------- STEP 5: pool spawned
        PoolKey memory key = _verifyPoolSpawned(token);

        // -------------------------------------------------- STEP 6: post-grad swap
        _postGradSwap(key, alice);

        // -------------------------------------------------- STEP 7: fee accrual
        _verifyFeeAccrual(key);

        _log("=== V5 FULL-CIRCLE PASSED ===");
    }

    // ============================================================================
    // Step 1+2 — launch through V5 Router with installBondingCurve=true
    // ============================================================================
    function _launchWithCurve(
        address alice
    ) internal returns (address token) {
        RouterV2 router = RouterV2(payable(ROUTER_V5));

        string memory name_ = "V5 FullCircle";
        string memory ticker_ = "V5FC";

        // Fork: name/ticker might already be reserved on mainnet by a previous sim.
        // Fall back to a timestamp-salted version if the base one is unavailable.
        if (
            !INameRegistry(NAME_REGISTRY).isNameAvailable(name_)
                || !INameRegistry(NAME_REGISTRY).isTickerAvailable(ticker_)
        ) {
            name_ = string(abi.encodePacked("V5FC-", vm.toString(block.timestamp)));
            ticker_ = string(abi.encodePacked("V5FC", vm.toString(uint256(uint160(alice)) % 1_000_000)));
        }

        uint256 curveSupply = ICurveFactoryRead(CURVE_FACTORY).defaultCurveSupply();

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = keccak256(abi.encode("ERC20", ""));
        // initialRecipient = Router; the Router holds curveSupply then approves the
        // CurveFactory to pull it into the newly deployed BondingCurve.
        p.initData = abi.encode(curveSupply, ROUTER_V5, new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.installHook = false;
        p.installGovernance = false;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        _log("STEP 1/2 launch fee (wei):", fee);

        vm.prank(alice);
        token = router.launch{value: fee}(p);
        require(token != address(0), "launch: zero token");
        require(token.code.length > 0, "launch: token has no code");

        _log("STEP 1/2 token deployed:", token);
        _log("        totalSupply:    ", IERC20Read(token).totalSupply());
    }

    // ============================================================================
    // Step 3 — curveFactory.curveFor(token) non-zero
    // ============================================================================
    function _verifyCurveInstalled(
        address token
    ) internal view returns (address curve) {
        curve = ICurveFactoryRead(CURVE_FACTORY).curveFor(token);
        require(curve != address(0), "curveFor returned zero -> curve not installed");
        require(curve.code.length > 0, "curve has no code");
        // Sanity: CurveFactory should have Graduator == V5 Graduator
        require(
            ICurveFactoryRead(CURVE_FACTORY).graduator() == GRADUATOR_V5,
            "CurveFactory.graduator != V5 Graduator (rewire not landed)"
        );
        // Sanity: token curveSupply parked on the curve.
        require(IERC20Read(token).balanceOf(curve) > 0, "no tokens on curve");
        _log("STEP 3 curve installed at:", curve);
    }

    // ============================================================================
    // Step 4 — buy through curve until graduation
    // ============================================================================
    function _buyToGraduation(
        address curve,
        address alice
    ) internal {
        BondingCurve bc = BondingCurve(payable(curve));
        uint256 target = bc.graduationTargetEth();
        _log("STEP 4 graduationTargetEth:", target);

        // Buy in 0.5-eth chunks; graduation trips once ethReserve >= target.
        uint256 chunk = 0.5 ether;
        uint256 loops = 0;
        while (!bc.graduated() && loops < 20) {
            uint256 remaining = target > bc.ethReserve() ? target - bc.ethReserve() : 0;
            uint256 amt = remaining > chunk ? chunk : remaining + 0.05 ether; // small overshoot to trip
            if (amt == 0) amt = chunk;
            vm.prank(alice);
            bc.buy{value: amt}(0);
            loops++;
        }
        require(bc.graduated(), "curve did not graduate");
        _log("STEP 4 curve graduated in loops:", loops);
        _log("        ethReserve after grad:  ", bc.ethReserve());
        _log("        tokenReserve after grad:", bc.tokenReserve());
    }

    // ============================================================================
    // Step 5 — v4 pool exists with hook == MHH V5
    // ============================================================================
    function _verifyPoolSpawned(
        address token
    ) internal view returns (PoolKey memory key) {
        key.currency0 = Currency.wrap(address(0));
        key.currency1 = Currency.wrap(token);
        key.fee = POOL_FEE;
        key.tickSpacing = POOL_TICK_SPACING;
        key.hooks = IHooks(HOOK_V5);

        PoolId id = key.toId();
        // MultiHookHost stamps `launchBlock` in beforeInitialize — non-zero proves
        // the pool went through this hook's init path (i.e. our Graduator).
        (uint32 launchBlock,,) = MultiHookHost(payable(HOOK_V5)).poolConfig(id);
        require(launchBlock != 0, "hook.poolConfig.launchBlock == 0 -> pool never initialized through this hook");
        _log("STEP 5 pool initialized. launchBlock:", launchBlock);
    }

    // ============================================================================
    // Step 6 — swap through V4SwapRouter using the graduated pool
    // ============================================================================
    function _postGradSwap(
        PoolKey memory key,
        address alice
    ) internal {
        V4SwapRouter swapper = V4SwapRouter(payable(V4_SWAP_ROUTER));
        uint256 balBefore = IERC20Read(Currency.unwrap(key.currency1)).balanceOf(alice);
        vm.prank(alice);
        uint256 out = swapper.swapExactETHForToken{value: 0.1 ether}(key, 0, alice, block.timestamp + 300);
        require(out > 0, "post-grad swap returned zero");
        uint256 balAfter = IERC20Read(Currency.unwrap(key.currency1)).balanceOf(alice);
        require(balAfter - balBefore == out, "post-grad swap: balance delta mismatch");
        _log("STEP 6 post-grad swap tokensOut:", out);
    }

    // ============================================================================
    // Step 7 — fee accrual on the hook side; pushOwed forwards to FeeSplitter
    // ============================================================================
    function _verifyFeeAccrual(
        PoolKey memory key
    ) internal {
        MultiHookHost hook = MultiHookHost(payable(HOOK_V5));
        // Post-grad swap is a BUY: swapper specifies input (native ETH). unspecified
        // side = tokens (currency1). Hook accrues platformShare on currency1 to
        // FeeSplitter.
        Currency c1 = key.currency1;
        uint256 platformOwed = hook.owed(c1, FEE_SPLITTER);
        _log("STEP 7 hook.owed[token][FeeSplitter]:", platformOwed);
        require(platformOwed > 0, "no platform fee accrued to FeeSplitter");

        // Prove the accrued balance actually withdraws to FeeSplitter.
        uint256 feeSplitterTokenBalBefore = IERC20Read(Currency.unwrap(c1)).balanceOf(FEE_SPLITTER);
        hook.pushOwed(c1, FEE_SPLITTER);
        uint256 feeSplitterTokenBalAfter = IERC20Read(Currency.unwrap(c1)).balanceOf(FEE_SPLITTER);
        require(
            feeSplitterTokenBalAfter - feeSplitterTokenBalBefore == platformOwed, "pushOwed did not credit FeeSplitter"
        );
        _log("STEP 7 pushOwed OK. FeeSplitter token bal delta:", feeSplitterTokenBalAfter - feeSplitterTokenBalBefore);
    }

    function _log(
        string memory k,
        uint256 v
    ) internal pure {
        console2.log(k, v);
    }

    function _log(
        string memory k,
        address v
    ) internal pure {
        console2.log(k, v);
    }

    function _log(
        string memory k
    ) internal pure {
        console2.log(k);
    }
}
