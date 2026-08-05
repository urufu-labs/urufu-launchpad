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
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
// Round-6 audit coverage: the 10 pair combos the compile-service can splice
// from {AntiBot, AntiWhale, Permit, Votes, Staking, Vesting}. Staking+Vesting
// omitted per matrix.json (Staking.incompatibleWith includes "Vesting").
import {ERC20WithAntiBotStakingGen} from "src/templates/composed/ERC20WithAntiBotStakingGen.sol";
import {ERC20WithAntiBotVestingGen} from "src/templates/composed/ERC20WithAntiBotVestingGen.sol";
import {ERC20WithAntiBotVotesGen} from "src/templates/composed/ERC20WithAntiBotVotesGen.sol";
import {ERC20WithAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiWhalePermitGen.sol";
import {ERC20WithAntiWhaleStakingGen} from "src/templates/composed/ERC20WithAntiWhaleStakingGen.sol";
import {ERC20WithAntiWhaleVestingGen} from "src/templates/composed/ERC20WithAntiWhaleVestingGen.sol";
import {ERC20WithAntiWhaleVotesGen} from "src/templates/composed/ERC20WithAntiWhaleVotesGen.sol";
import {ERC20WithPermitVotesGen} from "src/templates/composed/ERC20WithPermitVotesGen.sol";
import {ERC20WithStakingVotesGen} from "src/templates/composed/ERC20WithStakingVotesGen.sol";
import {ERC20WithVestingVotesGen} from "src/templates/composed/ERC20WithVestingVotesGen.sol";

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

        // FINDING 6 round 2: residual dust is now credited to the launcher's
        // pull-based refund ledger, not pushed. Invariant is that NO
        // un-credited ETH sits on the graduator and no tokens do.
        assertEq(address(graduator).balance, graduator.totalClaimable(), "graduator holds un-credited ETH");
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

    /// Permit + Staking pair. moduleData order per composed template
    /// ERC20WithPermitStakingGen.initialize: [0] = Permit (no params), [1] =
    /// Staking (rewardsTotal, duration). Staking carves its reward pool out of
    /// the mintTarget's balance before the curve is funded, so the curve prices
    /// itself against a smaller float — same invariant as the solo Staking
    /// test above, verified alongside a live Permit module.
    function test_PermitAndStaking_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Permit,Staking", address(new ERC20WithPermitStakingGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = ""; // Permit takes no init params
        md[1] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        (address token, BondingCurve curve) = _launch(ch, "Permit Staking", "PSK", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        // Permit sanity: solady's EIP-2612 domain separator returns non-zero
        // once name() is set, which happens in initialize() for every launch.
        assertTrue(ERC20WithPermitStakingGen(token).DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
        _graduateAndSwap(token, curve);
    }

    /// Permit + Vesting pair. moduleData order per composed template
    /// ERC20WithPermitVestingGen.initialize: [0] = Permit (no params), [1] =
    /// Vesting (beneficiary, total, cliff, end). Same reserve-carve invariant
    /// as the solo Vesting test — proves the pair composes cleanly through the
    /// full curve → graduate → v4 swap pipeline.
    function test_PermitAndVesting_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Permit,Vesting", address(new ERC20WithPermitVestingGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        md[0] = ""; // Permit takes no init params
        md[1] = abi.encode(makeAddr("pv-beneficiary"), vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "Permit Vesting", "PVS", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        assertTrue(ERC20WithPermitVestingGen(token).DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
        _graduateAndSwap(token, curve);
    }

    // Airdrop test removed 2026-07-31: Airdrop module retired platform-wide (V1
    // composed impl has an inflation rug). Vesting + Staking above cover the
    // reserve-backed carve invariant identically.

    // =====================================================================
    // Round-6 pair combos: the remaining 10 valid 2-module compositions the
    // compile-service can splice from {AntiBot, AntiWhale, Permit, Votes,
    // Staking, Vesting}. Each test walks the launch -> curve -> graduate ->
    // v4 swap pipeline through the composed impl so a regression in any
    // fragment interaction surfaces before a user hits it. Staking+Vesting
    // is intentionally absent (matrix.json declares them incompatible).
    //
    // Pair-specific hazards each test exercises:
    //   - AntiBot pairs: fragment's before-transfer hook must NOT fire on
    //     the mintTarget=Router carve transfers (owner bypass) and must NOT
    //     fire on curve trades after the gate expires. Every AntiBot test
    //     rolls past the gate before driving to graduation.
    //   - AntiWhale pairs: initialOwner=Router is auto-excluded so the
    //     reserve carve passes. Caps must be wide enough for the Graduator
    //     to move the whole float into the pool in one transfer.
    //   - Reserve-backed pairs (Staking, Vesting): both modules run
    //     `_transfer(mintTarget, address(this), reserve)` at init — assert
    //     the curve receives a REDUCED float (curveSupply < default).
    //   - Votes pairs: composed impl inherits ERC20Votes so
    //     `_afterTokenTransfer` runs checkpointing on every transfer. We
    //     don't assert a specific past-vote value (buyers are ephemeral EOAs)
    //     but the graduation swap succeeding proves checkpointing didn't
    //     revert on any transfer along the pipeline.
    // =====================================================================

    /// AntiBot + Staking. moduleData order: [0]=AntiBot(uint16 blockGate),
    /// [1]=Staking(uint256 rewardsTotal, uint32 duration). Staking carves its
    /// reward pool from mintTarget before the curve is funded; AntiBot's
    /// before-transfer hook fires on every transfer during the gate window.
    function test_AntiBotAndStaking_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiBot,Staking", address(new ERC20WithAntiBotStakingGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint16(3));
        md[1] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Staking", "ABS", md);
        assertTrue(ERC20WithAntiBotStakingGen(token).antiBotIsGated(), "AntiBot gate not active at launch");
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        vm.roll(block.number + 10);
        assertFalse(ERC20WithAntiBotStakingGen(token).antiBotIsGated(), "AntiBot gate should have expired");
        _graduateAndSwap(token, curve);
    }

    /// AntiBot + Vesting. moduleData order: [0]=AntiBot(uint16), [1]=Vesting
    /// (address beneficiary, uint256 total, uint64 cliff, uint64 end). Same
    /// invariants as AntiBot+Staking with the beneficiary-based reserve
    /// carve instead of the reward-pool carve.
    function test_AntiBotAndVesting_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiBot,Vesting", address(new ERC20WithAntiBotVestingGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        md[0] = abi.encode(uint16(3));
        md[1] = abi.encode(makeAddr("abv-beneficiary"), vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Vesting", "ABV", md);
        assertTrue(ERC20WithAntiBotVestingGen(token).antiBotIsGated(), "AntiBot gate not active at launch");
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        vm.roll(block.number + 10);
        _graduateAndSwap(token, curve);
    }

    /// AntiBot + Votes. moduleData order: [0]=AntiBot(uint16), [1]=Votes ("").
    /// Composed impl inherits ERC20Votes via the templateOverride path —
    /// checkpointing runs on every _afterTokenTransfer including the curve
    /// buys and the Graduator handoff.
    function test_AntiBotAndVotes_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiBot,Votes", address(new ERC20WithAntiBotVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint16(3));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Votes", "ABT", md);
        assertTrue(ERC20WithAntiBotVotesGen(token).antiBotIsGated(), "AntiBot gate not active at launch");
        vm.roll(block.number + 10);
        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Permit. moduleData order: [0]=AntiWhale(uint128 maxWallet,
    /// uint128 maxTx, uint32 expireAfter), [1]=Permit (""). AntiWhale caps
    /// sized wide enough for the graduation-side one-shot transfer.
    function test_AntiWhaleAndPermit_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiWhale,Permit", address(new ERC20WithAntiWhalePermitGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Whale Permit", "AWP", md);
        assertTrue(ERC20WithAntiWhalePermitGen(token).DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Staking. moduleData order: [0]=AntiWhale, [1]=Staking.
    /// Router (initialOwner) is auto-excluded in AntiWhale's init, so the
    /// reserve carve `_transfer(router, address(this), reward)` passes the
    /// maxTx check even with tight caps.
    function test_AntiWhaleAndStaking_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiWhale,Staking", address(new ERC20WithAntiWhaleStakingGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        md[1] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        (address token, BondingCurve curve) = _launch(ch, "Whale Stake", "AWS", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Vesting. moduleData order: [0]=AntiWhale, [1]=Vesting.
    /// Same exclusion-driven reserve carve as AntiWhale+Staking with the
    /// vesting beneficiary as the tracked payout address.
    function test_AntiWhaleAndVesting_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiWhale,Vesting", address(new ERC20WithAntiWhaleVestingGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        md[0] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        md[1] = abi.encode(makeAddr("awv-beneficiary"), vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "Whale Vest", "AWV", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Votes. moduleData order: [0]=AntiWhale, [1]=Votes ("").
    /// Composed impl inherits ERC20Votes; every transfer (init carves + curve
    /// buys + graduation) must pass AntiWhale caps AND accrue checkpoints.
    function test_AntiWhaleAndVotes_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiWhale,Votes", address(new ERC20WithAntiWhaleVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(800_000_000e18), uint256(0));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Whale Votes", "AWT", md);
        _graduateAndSwap(token, curve);
    }

    /// Permit + Votes. moduleData order: [0]=Permit (""), [1]=Votes ("").
    /// Both are no-param marker modules. Composed impl inherits ERC20Votes
    /// (via templateOverride) AND solady's built-in permit (via ERC20Votes
    /// -> ERC20). Verifies both paths agree on the underlying token name.
    function test_PermitAndVotes_GraduatesAndSwaps() public {
        bytes32 ch = _register("Permit,Votes", address(new ERC20WithPermitVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = "";
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Permit Votes", "PMV", md);
        assertTrue(ERC20WithPermitVotesGen(token).DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
        _graduateAndSwap(token, curve);
    }

    /// Staking + Votes. moduleData order: [0]=Staking, [1]=Votes ("").
    /// Staking carves its reward pool before the curve is funded; ERC20Votes
    /// checkpoints the carve transfer, every curve buy, and the graduation
    /// handoff. Regression coverage for a subtle bug class where a fragment's
    /// after-transfer body could omit `super._afterTokenTransfer` and silently
    /// drop checkpoints.
    function test_StakingAndVotes_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Staking,Votes", address(new ERC20WithStakingVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Stake Votes", "SVT", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        _graduateAndSwap(token, curve);
    }

    /// Vesting + Votes. moduleData order: [0]=Vesting, [1]=Votes ("").
    /// Same super._afterTokenTransfer invariant as Staking+Votes, with the
    /// vesting beneficiary-address carve instead of the reward-pool carve.
    function test_VestingAndVotes_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Vesting,Votes", address(new ERC20WithVestingVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        md[0] = abi.encode(makeAddr("vv-beneficiary"), vested, block.timestamp + 30 days, block.timestamp + 365 days);
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Vest Votes", "VVT", md);
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        _graduateAndSwap(token, curve);
    }

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

    /// AntiBot + Permit pair. moduleData order per composed template
    /// ERC20WithAntiBotPermitGen.initialize: [0] = AntiBot (uint16 blockGate),
    /// [1] = Permit (no params). AntiBot's before-transfer hook fires on every
    /// curve buy inside its window — Router allowlists the curve at launch so
    /// the install transfer succeeds, and we roll past the gate before driving
    /// to graduation so all subsequent transfers are unrestricted.
    function test_AntiBotAndPermit_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiBot,Permit", address(new ERC20WithAntiBotPermitGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint16(3)); // 3-block AntiBot gate
        md[1] = ""; // Permit takes no init params
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Permit", "ABP", md);
        // AntiBot should be active immediately after launch (proves the gate
        // wired even in the composed impl, not just the solo one).
        assertTrue(ERC20WithAntiBotPermitGen(token).antiBotIsGated(), "AntiBot gate not active at launch");
        // Roll past the anti-bot window so curve buys settle to non-allowlisted
        // buyers without needing per-buyer whitelisting.
        vm.roll(block.number + 10);
        assertFalse(ERC20WithAntiBotPermitGen(token).antiBotIsGated(), "AntiBot gate should have expired");
        // Permit sanity: solady's EIP-2612 domain separator returns non-zero
        // once name() is set — proves the Permit slice ran in initialize().
        assertTrue(ERC20WithAntiBotPermitGen(token).DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
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
