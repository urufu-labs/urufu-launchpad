// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {Router} from "src/router/Router.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {ERC20WithPausableGen} from "src/templates/composed/ERC20WithPausableGen.sol";
import {ERC20WithPermitGen} from "src/templates/composed/ERC20WithPermitGen.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IERC20Min {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  ModuleLaunchGraduationTest
/// @notice Every prior graduation test in this repo (and in the local V4 suite)
///         launches a BARE ERC-20. This one launches tokens that actually carry
///         feature modules — the drag-drop cart output real users produce — and
///         drives each through curve trading, graduation into a real Uniswap v4
///         pool, and a post-graduation swap.
///
///         Module transfer hooks are the risk here: AntiBot gates transfers for
///         N blocks, AntiWhale caps per-tx and per-wallet size, Pausable can
///         halt transfers outright, and the reserve-backed modules (Vesting,
///         Staking, Airdrop) carve a slice out of the initial supply BEFORE the
///         tokens reach the curve. Each interacts with the curve moving hundreds
///         of millions of tokens and with the Graduator moving the whole float
///         into the pool.
contract ModuleLaunchGraduationTest is LocalV4Stack {
    using StateLibrary for IPoolManager;

    address internal launcher = makeAddr("mod-launcher");
    address internal buyer = makeAddr("mod-buyer");
    address internal trader = makeAddr("mod-trader");

    uint256 internal nonce;

    function setUp() public {
        _deployStack();
        vm.deal(buyer, 500 ether);
        vm.deal(trader, 500 ether);
    }

    // =====================================================================
    // helpers
    // =====================================================================

    /// Register a composed impl under its canonical config hash and open it for
    /// launching. `moduleCount` drives the add-on fee; `flags` = 0 means the
    /// config is not balance-mutating and stays curve-eligible.
    function _register(
        string memory modules,
        address impl,
        uint256 moduleCount
    ) internal returns (bytes32 ch) {
        ch = keccak256(abi.encode("ERC20", modules));
        vm.startPrank(admin);
        // URU-A08 (round 3): pin the audited codehash before registerImpl.
        erc20Factory.setExpectedCodeHash(ch, keccak256(impl.code));
        erc20Factory.registerImpl(ch, impl);
        router.setModuleCountForConfig(ch, moduleCount);
        router.setFlagsForConfig(ch, 0);
        vm.stopPrank();
    }

    function _launch(
        bytes32 ch,
        string memory name_,
        string memory sym_,
        bytes[] memory moduleData
    ) internal returns (address token, BondingCurve curve) {
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = ch;
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), moduleData);
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.deal(launcher, launcher.balance + fee);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
        curve = BondingCurve(payable(curveFactory.curveFor(token)));
        require(address(curve) != address(0), "no curve installed");
    }

    /// Walk the curve to graduation in steps. A single grossed-up buy works on a
    /// full 800M curve but reverts with `ExceedsSupply` once a reserve-backed
    /// module has carved supply out — `buy()` reverts rather than partially
    /// filling, unlike `quoteBuy()` which clamps.
    function _driveToGraduation(
        BondingCurve curve
    ) internal {
        uint256 step = 0.5 ether;
        for (uint256 i = 0; i < 80 && !curve.graduated(); ++i) {
            uint256 need = curve.graduationTargetEth() - curve.ethReserve();
            uint256 amt = need + (need / 50) + 1; // ~2% over, covers the 1% trade fee
            if (amt > step) amt = step;
            vm.prank(buyer);
            try curve.buy{value: amt}(0) {}
            catch {
                step /= 2;
                if (step == 0) break;
            }
        }
        assertTrue(curve.graduated(), "curve did not graduate");
    }

    /// Buy to graduation, confirm the pool opened, then round-trip a swap.
    function _graduateAndSwap(
        address token,
        BondingCurve curve
    ) internal {
        _driveToGraduation(curve);

        assertEq(address(graduator).balance, 0, "graduator stranded ETH");
        assertEq(IERC20Min(token).balanceOf(address(graduator)), 0, "graduator stranded tokens");

        PoolId id = _poolIdFor(token);
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "v4 pool not initialized");
        assertGt(ipm.getLiquidity(id), 0, "v4 pool has no liquidity");

        PoolKey memory key = _poolKeyFor(token);
        vm.prank(trader);
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.2 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(bought, 0, "post-graduation v4 buy returned nothing");
    }

    function _next() internal returns (string memory) {
        nonce++;
        return vm.toString(nonce);
    }

    // =====================================================================
    // single-module launches
    // =====================================================================

    function test_AntiBot_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiBot", address(new ERC20WithAntiBotGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(3)); // 3-block gate
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Mod", "ABM", md);
        // Clear the anti-bot window. A real curve takes far more than 3 blocks
        // to accumulate 4 ETH, so this is the realistic ordering.
        vm.roll(block.number + 10);
        _graduateAndSwap(token, curve);
    }

    function test_AntiWhale_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiWhale", address(new ERC20WithAntiWhaleGen()), 2);
        bytes[] memory md = new bytes[](1);
        // Caps must be wide enough for the Graduator to move the whole float
        // into the pool in one transfer — docs tell launchers to size sensibly.
        md[0] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        (address token, BondingCurve curve) = _launch(ch, "AntiWhale Mod", "AWM", md);
        _graduateAndSwap(token, curve);
    }

    function test_Pausable_GraduatesAndSwaps() public {
        bytes32 ch = _register("Pausable", address(new ERC20WithPausableGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        (address token, BondingCurve curve) = _launch(ch, "Pausable Mod", "PSM", md);
        _graduateAndSwap(token, curve);
    }

    function test_Permit_GraduatesAndSwaps() public {
        bytes32 ch = _register("Permit", address(new ERC20WithPermitGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        (address token, BondingCurve curve) = _launch(ch, "Permit Mod", "PMM", md);
        _graduateAndSwap(token, curve);
    }

    function test_Votes_GraduatesAndSwaps() public {
        bytes32 ch = _register("Votes", address(new ERC20WithVotesGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        (address token, BondingCurve curve) = _launch(ch, "Votes Mod", "VTM", md);
        _graduateAndSwap(token, curve);
    }

    // =====================================================================
    // reserve-backed modules — these carve supply out before the curve
    // =====================================================================

    function test_Vesting_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Vesting", address(new ERC20WithVestingGen()), 2);
        bytes[] memory md = new bytes[](1);
        uint256 vested = 100_000_000e18;
        md[0] = abi.encode(makeAddr("beneficiary"), vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "Vesting Mod", "VSM", md);

        // The curve receives supply MINUS the vested allocation, and prices
        // itself against the smaller float.
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        _graduateAndSwap(token, curve);
    }

    function test_Staking_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Staking", address(new ERC20WithStakingGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        (address token, BondingCurve curve) = _launch(ch, "Staking Mod", "STM", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        _graduateAndSwap(token, curve);
    }

    // Airdrop test removed 2026-07-31: Airdrop module retired platform-wide (V1
    // composed impl has an inflation rug). Vesting + Staking above cover the
    // reserve-backed carve invariant identically.

    /// The over-allocation guard: reserve-backed modules may not consume more
    /// than half the intended curve supply, or the curve starves.
    function test_OverAllocatedModule_IsRejected() public {
        bytes32 ch = _register("Vesting", address(new ERC20WithVestingGen()), 2);
        bytes[] memory md = new bytes[](1);
        // 600M of an 800M supply — past the 50% ceiling.
        md[0] =
            abi.encode(makeAddr("greedy"), uint256(600_000_000e18), block.timestamp + 1 days, block.timestamp + 2 days);

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Greedy Vest";
        p.ticker = "GVST";
        p.configHash = ch;
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), md);
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.deal(launcher, launcher.balance + fee);
        vm.prank(launcher);
        vm.expectRevert();
        router.launch{value: fee}(p);
    }

    // =====================================================================
    // multi-module + the FoT blocklist
    // =====================================================================

    function test_AntiBotAntiWhale_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiBot,AntiWhale", address(new ERC20WithAntiBotAntiWhaleGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint16(2));
        md[1] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        (address token, BondingCurve curve) = _launch(ch, "Bot Whale", "BWM", md);
        vm.roll(block.number + 10);
        _graduateAndSwap(token, curve);
    }

    /// Fee-on-transfer mints a token whose real balance never matches the
    /// curve's arithmetic reserve. Router must refuse to pair it with a curve.
    function test_FeeOnTransfer_IsBlockedFromCurve() public {
        bytes32 ch = _register("FeeOnTransfer", address(new ERC20WithFeeOnTransferGen()), 2);
        vm.prank(admin);
        router.setCurveIncompatibleConfigHash(ch, true);

        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(500), uint16(4000), uint16(6000), makeAddr("fot-treasury"));

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "FoT Curve";
        p.ticker = "FOTC";
        p.configHash = ch;
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), md);
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.deal(launcher, launcher.balance + fee);
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, ch));
        router.launch{value: fee}(p);
    }

    /// Same FoT config WITHOUT a curve is a legitimate launch and must succeed.
    function test_FeeOnTransfer_LaunchesFineWithoutCurve() public {
        bytes32 ch = _register("FeeOnTransfer", address(new ERC20WithFeeOnTransferGen()), 2);
        vm.prank(admin);
        router.setCurveIncompatibleConfigHash(ch, true);

        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(500), uint16(4000), uint16(6000), makeAddr("fot-treasury"));

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "FoT Plain";
        p.ticker = "FOTP";
        p.configHash = ch;
        p.initData = abi.encode(uint256(1_000_000e18), launcher, md);
        p.moduleCount = 1;
        p.installBondingCurve = false;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.deal(launcher, launcher.balance + fee);
        vm.prank(launcher);
        address token = router.launch{value: fee}(p);
        assertEq(IERC20Min(token).balanceOf(launcher), 1_000_000e18, "FoT token did not mint to launcher");
    }

    // =====================================================================
    // AntiBot vs. the project's own V4 swap router
    // =====================================================================

    /// FINDING (documented, not asserted as desired behaviour): `Router` grants
    /// AntiBot/AntiWhale bypass to the curve, the Graduator, and the v4
    /// PoolManager — but never to `V4SwapRouter`. A v4 buy settles
    /// PoolManager → V4SwapRouter → user, and that last hop has neither party
    /// allowlisted, so it reverts `AntiBot__Gated` while the window is open.
    ///
    /// Unreachable on a normally-configured launch, since a curve needs far more
    /// than a few blocks of real volume to reach the 4 ETH target. Reachable if a
    /// launcher picks a large `blockGate` and the token graduates inside it —
    /// swaps through the launchpad's own router then fail until the gate expires.
    function test_AntiBotGate_BlocksSwapsThroughV4SwapRouter() public {
        // Gate wide enough to still be open after graduation.
        bytes32 ch = _register("AntiBot", address(new ERC20WithAntiBotGen()), 2);
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(60_000)); // blockGate is uint16 — 65_535 is the ceiling
        (address token, BondingCurve curve) = _launch(ch, "Long Gate", "LGT", md);

        _driveToGraduation(curve);

        // Graduation itself is fine — Graduator and PoolManager are allowlisted.
        PoolId id = _poolIdFor(token);
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "pool should still open under an open gate");
        assertGt(ipm.getLiquidity(id), 0, "pool should still be seeded");

        // The user-facing swap is what breaks.
        PoolKey memory key = _poolKeyFor(token);
        uint256 deadline = block.timestamp + 600;
        vm.prank(trader);
        vm.expectRevert();
        swapRouter.swapExactETHForToken{value: 0.2 ether}(key, 0, trader, deadline);

        // Once the gate expires the same swap succeeds untouched.
        vm.roll(block.number + 60_001);
        vm.prank(trader);
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.2 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(bought, 0, "swap should work once the anti-bot gate expires");
    }
}
