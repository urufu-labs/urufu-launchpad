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

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

interface IERC20Min {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
    function allowance(
        address,
        address
    ) external view returns (uint256);
}

/// Solady's ERC-2612 surface is uniform across every composed template that
/// splices the Permit fragment. Kept module-agnostic so `_signPermit` works
/// for any pair-composed impl without a per-type interface.
interface IERC20PermitMin {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(
        address
    ) external view returns (uint256);
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
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
    ///
    /// GH-9 (AC #10): every test that reaches graduation via this helper
    /// automatically inherits the HookPolicySet + `poolPolicy` assertions.
    /// The canonical policy MUST be frozen with the exact fee bps the hook
    /// was constructed with, the exact per-pool antiSniperBlocks /
    /// buybackBurnBps written pre-init, launchBlock == the graduation-tx
    /// block, `immutableAfterLaunch = true`, and a non-zero creatorRecipient
    /// (either the per-pool launcher or the constructor fallback).
    function _graduateAndSwap(
        address token,
        BondingCurve curve
    ) internal {
        // Capture the graduation block up front. `_driveToGraduation` does
        // NOT vm.roll between iterations, so every buy — including the one
        // that flips `graduated` — lands at THIS block. That's the block
        // beforeInitialize will stamp into `poolPolicy.launchBlock`.
        uint256 expectedLaunchBlock = block.number;
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

        // GH-9: assert the canonical PoolPolicy was written + frozen with
        // the exact values a downstream indexer would need. Reads the same
        // fields the HookPolicySet event carried (see `test/audit/
        // HookPolicyOnGraduation.t.sol` for the event-topic pin — kept
        // separate so this helper stays cheap for the 20+ graduation tests
        // that invoke it).
        (
            uint16 antiSniperBlocks,
            uint16 buybackBurnBps,
            uint16 platformFeeBps,
            uint16 creatorFeeBps,
            address creatorRecipient,
            uint64 launchBlock,
            bool immutableAfterLaunch
        ) = mhh.poolPolicy(id);
        assertTrue(immutableAfterLaunch, "GH-9: poolPolicy not frozen post-graduation");
        assertEq(uint256(launchBlock), expectedLaunchBlock, "GH-9: launchBlock != graduation block");
        assertEq(platformFeeBps, mhh.platformBps(), "GH-9: platformFeeBps drifted from hook constant");
        assertEq(creatorFeeBps, mhh.creatorBps(), "GH-9: creatorFeeBps drifted from hook constant");
        assertTrue(creatorRecipient != address(0), "GH-9: creatorRecipient must resolve to a real address");
        // The per-pool anti-sniper + burn values in the emitted policy must
        // agree with the legacy PoolConfig — both are written from the same
        // Graduator flow, and drift between them would be a real bug.
        (uint32 legacyLaunchBlock, uint32 legacyAnti, uint16 legacyBurn) = mhh.poolConfig(id);
        assertEq(uint256(antiSniperBlocks), uint256(legacyAnti), "GH-9: antiSniperBlocks divergence");
        assertEq(uint256(buybackBurnBps), uint256(legacyBurn), "GH-9: buybackBurnBps divergence");
        // GH-9 audit LOW #2: assert launchBlock parity across the two shapes so
        // any future refactor that stamps them at different times fails loud.
        assertEq(
            uint256(legacyLaunchBlock),
            uint256(launchBlock),
            "GH-9: launchBlock divergence between poolConfig and poolPolicy"
        );

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
    // module-semantic assertion helpers
    // =====================================================================

    /// EIP-2612 permit signer for solady's ERC20 (the base every Permit-composed
    /// template inherits). The typehash + domain-separator layout is fixed
    /// across every template so a single helper drives every Permit pair test.
    function _signPermit(
        address token,
        uint256 signerPk,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        address signer = vm.addr(signerPk);
        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        uint256 nonce_ = IERC20PermitMin(token).nonces(signer);
        bytes32 domain = IERC20PermitMin(token).DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(abi.encode(permitTypehash, signer, spender, value, nonce_, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (v, r, s) = vm.sign(signerPk, digest);
    }

    /// Warm-up buy so `buyer` holds enough float to drive P2P-cap and
    /// stake / delegate assertions. Curve is on both the AntiBot allowlist
    /// and the AntiWhale exclusion list (Router grants both at launch), so a
    /// warm-up buy clears both gates even while the windows are active.
    function _warmBuy(
        BondingCurve curve,
        uint256 ethIn
    ) internal returns (uint256 tokensReceived) {
        address token = curve.token();
        uint256 balBefore = IERC20Min(token).balanceOf(buyer);
        vm.prank(buyer);
        curve.buy{value: ethIn}(0);
        tokensReceived = IERC20Min(token).balanceOf(buyer) - balBefore;
        assertGt(tokensReceived, 0, "warm buy delivered no tokens");
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
        ERC20WithAntiBotStakingGen tk = ERC20WithAntiBotStakingGen(token);

        assertTrue(tk.antiBotIsGated(), "AntiBot gate not active at launch");
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");

        // AntiBot semantics: warm-up buy clears the gate via the curve's
        // allowlist entry (Router grants it at launch), then a P2P hop
        // between two non-allowlisted addresses must revert AntiBot__Gated.
        _warmBuy(curve, 0.5 ether);
        address abVictim = makeAddr("ab-victim");
        vm.prank(buyer);
        vm.expectRevert(); // AntiBot__Gated(buyer, abVictim, blocksLeft)
        IERC20Min(token).transfer(abVictim, 1);

        vm.roll(block.number + 10);
        assertFalse(tk.antiBotIsGated(), "AntiBot gate should have expired");
        // Post-gate: the same P2P now settles — proves the gate closed, not
        // that the token permanently refuses non-allowlisted transfers.
        vm.prank(buyer);
        IERC20Min(token).transfer(abVictim, 1);
        assertEq(IERC20Min(token).balanceOf(abVictim), 1, "post-gate P2P failed to settle");

        // Staking semantics: stake, accrue over the reward window, claim,
        // and check the payout landed. Reserve pool was carved at init so
        // this exercises the full deposit -> earn -> claim loop without
        // touching totalSupply.
        uint256 stakeAmt = 1000e18;
        require(IERC20Min(token).balanceOf(buyer) > stakeAmt, "buyer needs float to stake");
        vm.prank(buyer);
        tk.stake(stakeAmt);
        assertEq(tk.stakingBalanceOf(buyer), stakeAmt, "stake ledger did not update");
        vm.warp(block.timestamp + 30 days);
        uint256 earned = tk.stakingEarned(buyer);
        assertGt(earned, 0, "stakingEarned should accrue after time advance");
        uint256 preClaim = IERC20Min(token).balanceOf(buyer);
        vm.prank(buyer);
        tk.stakingClaim();
        assertGt(IERC20Min(token).balanceOf(buyer), preClaim, "stakingClaim did not pay out");

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
        address bene = makeAddr("abv-beneficiary");
        md[0] = abi.encode(uint16(3));
        md[1] = abi.encode(bene, vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "AntiBot Vesting", "ABV", md);
        ERC20WithAntiBotVestingGen tk = ERC20WithAntiBotVestingGen(token);

        assertTrue(tk.antiBotIsGated(), "AntiBot gate not active at launch");
        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        assertEq(tk.vestingBeneficiary(), bene, "vesting beneficiary mis-stored");
        assertEq(tk.vestingTotal(), vested, "vesting total mis-stored");

        // AntiBot semantics: warm-up buy so buyer holds float, then a P2P
        // hop between two non-allowlisted addresses must revert.
        _warmBuy(curve, 0.5 ether);
        address abVictim = makeAddr("abv-victim");
        vm.prank(buyer);
        vm.expectRevert();
        IERC20Min(token).transfer(abVictim, 1);

        vm.roll(block.number + 10);
        assertFalse(tk.antiBotIsGated(), "AntiBot gate should have expired");

        // Vesting semantics: warp past end, prove the full reserve is
        // releasable, then release and prove the beneficiary was paid from
        // the pre-carved reserve (not via a fresh mint).
        vm.warp(uint256(tk.vestingEndTimestamp()) + 1 days);
        assertEq(tk.vestingReleasable(), vested, "full vested should be releasable after end");
        uint256 supplyBefore = IERC20Min(token).totalSupply();
        uint256 preRelease = IERC20Min(token).balanceOf(bene);
        tk.vestingRelease();
        assertEq(IERC20Min(token).balanceOf(bene) - preRelease, vested, "beneficiary did not receive full vested");
        assertEq(IERC20Min(token).totalSupply(), supplyBefore, "release must not mint");

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
        ERC20WithAntiBotVotesGen tk = ERC20WithAntiBotVotesGen(token);

        assertTrue(tk.antiBotIsGated(), "AntiBot gate not active at launch");

        // AntiBot semantics: warm-up buy clears the gate (curve allowlisted),
        // then a P2P hop between two non-allowlisted addresses must revert.
        _warmBuy(curve, 0.5 ether);
        address abVictim = makeAddr("abvt-victim");
        vm.prank(buyer);
        vm.expectRevert();
        IERC20Min(token).transfer(abVictim, 1);

        vm.roll(block.number + 10);
        assertFalse(tk.antiBotIsGated(), "AntiBot gate should have expired");

        // Votes semantics: buyer holds warm-buy float. Before self-delegate,
        // votes are zero even though balance is non-zero (ERC20Votes rule).
        // After delegate(self), the current balance becomes voting weight
        // — checkpointing did not silently drop it under the AntiBot fragment.
        uint256 buyerBal = IERC20Min(token).balanceOf(buyer);
        assertGt(buyerBal, 0, "warm buy should have funded buyer");
        assertEq(tk.getVotes(buyer), 0, "votes should be zero before delegation");
        vm.prank(buyer);
        tk.delegate(buyer);
        assertEq(tk.delegates(buyer), buyer, "self-delegation did not stick");
        assertEq(tk.getVotes(buyer), buyerBal, "getVotes should equal balance after self-delegate");

        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Permit. moduleData order: [0]=AntiWhale(uint128 maxWallet,
    /// uint128 maxTx, uint32 expireAfter), [1]=Permit (""). maxWallet stays
    /// wide (PoolManager receives the whole graduation float in one leg and
    /// PoolManager is NOT AntiWhale-excluded by Router). maxTx is narrowed
    /// so the P2P cap is testable with a modest warm-up buy; the tight cap
    /// is safe during graduation because Router excludes the curve and the
    /// Graduator, so every graduation-leg transfer bypasses maxTx via the
    /// sender-side exclusion. We roll past the AntiWhale window before
    /// `_graduateAndSwap` so the post-grad PoolManager -> trader swap (from
    /// PoolManager, which is NOT excluded) isn't caught by the tight cap.
    function test_AntiWhaleAndPermit_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiWhale,Permit", address(new ERC20WithAntiWhalePermitGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(100_000e18), uint256(60_000));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Whale Permit", "AWP", md);
        ERC20WithAntiWhalePermitGen tk = ERC20WithAntiWhalePermitGen(token);

        assertTrue(tk.DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");
        assertTrue(tk.antiWhaleIsActive(), "AntiWhale gate not active at launch");

        // AntiWhale semantics: warm-up buy delivers >maxTx tokens to buyer
        // (curve is excluded so maxTx is bypassed on that leg), then a P2P
        // hop above maxTx between two non-excluded EOAs must revert. Under-
        // cap transfer succeeds — proves the check is size-gated, not blanket.
        _warmBuy(curve, 0.5 ether);
        address awVictim = makeAddr("awp-victim");
        uint256 cap = 100_000e18;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithAntiWhalePermitGen.AntiWhale__MaxTxExceeded.selector, cap + 1, cap)
        );
        IERC20Min(token).transfer(awVictim, cap + 1);
        vm.prank(buyer);
        IERC20Min(token).transfer(awVictim, cap);
        assertEq(IERC20Min(token).balanceOf(awVictim), cap, "under-cap transfer should succeed");

        // Roll past AntiWhale so the post-grad V4 swap (PoolManager -> trader
        // moves millions of tokens; PoolManager is NOT excluded from AntiWhale)
        // doesn't trip the tight maxTx.
        vm.roll(block.number + 60_001);
        assertFalse(tk.antiWhaleIsActive(), "AntiWhale should have expired");

        // Permit semantics: an off-chain signature must produce an on-chain
        // allowance — proves EIP-2612 wiring survived composition with the
        // AntiWhale before-transfer hook.
        uint256 alicePk = 0xA11CE;
        address alice = vm.addr(alicePk);
        address permitSpender = makeAddr("awp-spender");
        uint256 value = 1000e18;
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonceBefore = IERC20PermitMin(token).nonces(alice);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(token, alicePk, permitSpender, value, deadline);
        IERC20PermitMin(token).permit(alice, permitSpender, value, deadline, v, r, s);
        assertEq(IERC20Min(token).allowance(alice, permitSpender), value, "permit did not set allowance");
        assertEq(IERC20PermitMin(token).nonces(alice), nonceBefore + 1, "permit did not consume nonce");

        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Staking. moduleData order: [0]=AntiWhale, [1]=Staking.
    /// Router (initialOwner) is auto-excluded in AntiWhale's init, so the
    /// reserve carve `_transfer(router, address(this), reward)` passes the
    /// maxTx check even with tight caps. Cap sizing follows AntiWhale+Permit
    /// (see that test for the rationale on the P2P-testable maxTx + wide
    /// maxWallet + roll-past-window ordering).
    function test_AntiWhaleAndStaking_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiWhale,Staking", address(new ERC20WithAntiWhaleStakingGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(100_000e18), uint256(60_000));
        md[1] = abi.encode(uint256(50_000_000e18), uint256(90 days));
        (address token, BondingCurve curve) = _launch(ch, "Whale Stake", "AWS", md);
        ERC20WithAntiWhaleStakingGen tk = ERC20WithAntiWhaleStakingGen(token);

        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");
        assertTrue(tk.antiWhaleIsActive(), "AntiWhale gate not active at launch");

        // AntiWhale semantics: warm-up buy funds buyer with >maxTx; the P2P
        // hop above maxTx reverts, the under-cap hop settles.
        _warmBuy(curve, 0.5 ether);
        address awVictim = makeAddr("aws-victim");
        uint256 cap = 100_000e18;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithAntiWhaleStakingGen.AntiWhale__MaxTxExceeded.selector, cap + 1, cap)
        );
        IERC20Min(token).transfer(awVictim, cap + 1);

        // Roll past AntiWhale before staking — `stake()` moves tokens
        // buyer -> address(this) via _transfer, neither is excluded, so a
        // stake above maxTx during the window would revert too.
        vm.roll(block.number + 60_001);
        assertFalse(tk.antiWhaleIsActive(), "AntiWhale should have expired");

        // Staking semantics: stake, accrue over the reward window, claim,
        // and confirm payout came from the pre-carved reserve.
        uint256 stakeAmt = 1000e18;
        vm.prank(buyer);
        tk.stake(stakeAmt);
        assertEq(tk.stakingBalanceOf(buyer), stakeAmt, "stake ledger did not update");
        vm.warp(block.timestamp + 30 days);
        uint256 earned = tk.stakingEarned(buyer);
        assertGt(earned, 0, "stakingEarned should accrue after time advance");
        uint256 preClaim = IERC20Min(token).balanceOf(buyer);
        vm.prank(buyer);
        tk.stakingClaim();
        assertGt(IERC20Min(token).balanceOf(buyer), preClaim, "stakingClaim did not pay out");

        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Vesting. moduleData order: [0]=AntiWhale, [1]=Vesting.
    /// Same exclusion-driven reserve carve as AntiWhale+Staking with the
    /// vesting beneficiary as the tracked payout address.
    function test_AntiWhaleAndVesting_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("AntiWhale,Vesting", address(new ERC20WithAntiWhaleVestingGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        address bene = makeAddr("awv-beneficiary");
        md[0] = abi.encode(uint256(800_000_000e18), uint256(100_000e18), uint256(60_000));
        md[1] = abi.encode(bene, vested, block.timestamp + 30 days, block.timestamp + 365 days);
        (address token, BondingCurve curve) = _launch(ch, "Whale Vest", "AWV", md);
        ERC20WithAntiWhaleVestingGen tk = ERC20WithAntiWhaleVestingGen(token);

        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        assertTrue(tk.antiWhaleIsActive(), "AntiWhale gate not active at launch");
        assertEq(tk.vestingBeneficiary(), bene, "vesting beneficiary mis-stored");

        // AntiWhale semantics: warm-up buy funds buyer, P2P above maxTx reverts.
        _warmBuy(curve, 0.5 ether);
        address awVictim = makeAddr("awv-victim");
        uint256 cap = 100_000e18;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithAntiWhaleVestingGen.AntiWhale__MaxTxExceeded.selector, cap + 1, cap)
        );
        IERC20Min(token).transfer(awVictim, cap + 1);

        // Roll past AntiWhale before releasing: release moves `vested` (100M)
        // from address(this) -> beneficiary, neither excluded, so a release
        // during the window would trip maxTx (100M >> 100k).
        vm.roll(block.number + 60_001);
        assertFalse(tk.antiWhaleIsActive(), "AntiWhale should have expired");

        // Vesting semantics: warp past end, release, and confirm the
        // beneficiary received the full pre-carved reserve.
        vm.warp(uint256(tk.vestingEndTimestamp()) + 1 days);
        assertEq(tk.vestingReleasable(), vested, "full vested should be releasable after end");
        uint256 supplyBefore = IERC20Min(token).totalSupply();
        uint256 preRelease = IERC20Min(token).balanceOf(bene);
        tk.vestingRelease();
        assertEq(IERC20Min(token).balanceOf(bene) - preRelease, vested, "beneficiary did not receive full vested");
        assertEq(IERC20Min(token).totalSupply(), supplyBefore, "release must not mint");

        _graduateAndSwap(token, curve);
    }

    /// AntiWhale + Votes. moduleData order: [0]=AntiWhale, [1]=Votes ("").
    /// Composed impl inherits ERC20Votes; every transfer (init carves + curve
    /// buys + graduation) must pass AntiWhale caps AND accrue checkpoints.
    function test_AntiWhaleAndVotes_GraduatesAndSwaps() public {
        bytes32 ch = _register("AntiWhale,Votes", address(new ERC20WithAntiWhaleVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        md[0] = abi.encode(uint256(800_000_000e18), uint256(100_000e18), uint256(60_000));
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Whale Votes", "AWT", md);
        ERC20WithAntiWhaleVotesGen tk = ERC20WithAntiWhaleVotesGen(token);

        assertTrue(tk.antiWhaleIsActive(), "AntiWhale gate not active at launch");

        // AntiWhale semantics: warm-up buy funds buyer, P2P above maxTx reverts.
        _warmBuy(curve, 0.5 ether);
        address awVictim = makeAddr("awt-victim");
        uint256 cap = 100_000e18;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ERC20WithAntiWhaleVotesGen.AntiWhale__MaxTxExceeded.selector, cap + 1, cap)
        );
        IERC20Min(token).transfer(awVictim, cap + 1);

        // Roll past AntiWhale before the graduation swap (PoolManager -> trader
        // moves millions; PoolManager is NOT AntiWhale-excluded).
        vm.roll(block.number + 60_001);
        assertFalse(tk.antiWhaleIsActive(), "AntiWhale should have expired");

        // Votes semantics: buyer holds warm-buy float. Pre-delegate votes are
        // zero (ERC20Votes rule); post self-delegate votes equal current
        // balance — proves the after-transfer checkpoint chain survived
        // composition with the AntiWhale before-transfer hook.
        uint256 buyerBal = IERC20Min(token).balanceOf(buyer);
        assertEq(tk.getVotes(buyer), 0, "votes should be zero before delegation");
        vm.prank(buyer);
        tk.delegate(buyer);
        assertEq(tk.delegates(buyer), buyer, "self-delegation did not stick");
        assertEq(tk.getVotes(buyer), buyerBal, "getVotes should equal balance after self-delegate");

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
        ERC20WithPermitVotesGen tk = ERC20WithPermitVotesGen(token);

        assertTrue(tk.DOMAIN_SEPARATOR() != bytes32(0), "Permit not initialized");

        // Fund buyer with float — used by the Votes leg below.
        _warmBuy(curve, 0.5 ether);

        // Permit semantics: signed approval takes effect on-chain and consumes
        // exactly one nonce.
        uint256 alicePk = 0xA11CE;
        address alice = vm.addr(alicePk);
        address permitSpender = makeAddr("pmv-spender");
        uint256 value = 1000e18;
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonceBefore = IERC20PermitMin(token).nonces(alice);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(token, alicePk, permitSpender, value, deadline);
        IERC20PermitMin(token).permit(alice, permitSpender, value, deadline, v, r, s);
        assertEq(IERC20Min(token).allowance(alice, permitSpender), value, "permit did not set allowance");
        assertEq(IERC20PermitMin(token).nonces(alice), nonceBefore + 1, "permit did not consume nonce");

        // Votes semantics: pre-delegate votes zero, post self-delegate votes
        // equal current balance (checkpointing intact under the Permit path).
        uint256 buyerBal = IERC20Min(token).balanceOf(buyer);
        assertEq(tk.getVotes(buyer), 0, "votes should be zero before delegation");
        vm.prank(buyer);
        tk.delegate(buyer);
        assertEq(tk.getVotes(buyer), buyerBal, "getVotes should equal balance after self-delegate");

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
        ERC20WithStakingVotesGen tk = ERC20WithStakingVotesGen(token);

        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "staking did not carve out supply");

        // Fund buyer with float used by both legs.
        _warmBuy(curve, 0.5 ether);

        // Staking semantics: stake, accrue, claim, and confirm payout came
        // from the pre-carved reserve.
        uint256 stakeAmt = 1000e18;
        vm.prank(buyer);
        tk.stake(stakeAmt);
        assertEq(tk.stakingBalanceOf(buyer), stakeAmt, "stake ledger did not update");
        vm.warp(block.timestamp + 30 days);
        uint256 earned = tk.stakingEarned(buyer);
        assertGt(earned, 0, "stakingEarned should accrue after time advance");
        uint256 preClaim = IERC20Min(token).balanceOf(buyer);
        vm.prank(buyer);
        tk.stakingClaim();
        assertGt(IERC20Min(token).balanceOf(buyer), preClaim, "stakingClaim did not pay out");

        // Votes semantics: pre-delegate votes zero, post self-delegate votes
        // equal current balance — proves ERC20Votes checkpointing survived
        // the Staking fragment's stake/withdraw/claim transfer chain.
        uint256 buyerBal = IERC20Min(token).balanceOf(buyer);
        assertEq(tk.getVotes(buyer), 0, "votes should be zero before delegation");
        vm.prank(buyer);
        tk.delegate(buyer);
        assertEq(tk.getVotes(buyer), buyerBal, "getVotes should equal balance after self-delegate");

        _graduateAndSwap(token, curve);
    }

    /// Vesting + Votes. moduleData order: [0]=Vesting, [1]=Votes ("").
    /// Same super._afterTokenTransfer invariant as Staking+Votes, with the
    /// vesting beneficiary-address carve instead of the reward-pool carve.
    function test_VestingAndVotes_GraduatesWithReducedCurveSupply() public {
        bytes32 ch = _register("Vesting,Votes", address(new ERC20WithVestingVotesGen()), 3);
        bytes[] memory md = new bytes[](2);
        uint256 vested = 100_000_000e18;
        address bene = makeAddr("vv-beneficiary");
        md[0] = abi.encode(bene, vested, block.timestamp + 30 days, block.timestamp + 365 days);
        md[1] = "";
        (address token, BondingCurve curve) = _launch(ch, "Vest Votes", "VVT", md);
        ERC20WithVestingVotesGen tk = ERC20WithVestingVotesGen(token);

        assertLt(curve.curveSupply(), curveFactory.defaultCurveSupply(), "vesting did not carve out supply");
        assertEq(tk.vestingBeneficiary(), bene, "vesting beneficiary mis-stored");

        // Fund buyer with float used by the Votes leg.
        _warmBuy(curve, 0.5 ether);

        // Vesting semantics: warp past end, release, and confirm the
        // beneficiary received the full pre-carved reserve without inflating
        // total supply.
        vm.warp(uint256(tk.vestingEndTimestamp()) + 1 days);
        assertEq(tk.vestingReleasable(), vested, "full vested should be releasable after end");
        uint256 supplyBefore = IERC20Min(token).totalSupply();
        uint256 preRelease = IERC20Min(token).balanceOf(bene);
        tk.vestingRelease();
        assertEq(IERC20Min(token).balanceOf(bene) - preRelease, vested, "beneficiary did not receive full vested");
        assertEq(IERC20Min(token).totalSupply(), supplyBefore, "release must not mint");

        // Votes semantics: pre-delegate votes zero, post self-delegate votes
        // equal current balance — proves ERC20Votes checkpointing survived
        // the Vesting fragment's carve + release transfer chain.
        uint256 buyerBal = IERC20Min(token).balanceOf(buyer);
        assertEq(tk.getVotes(buyer), 0, "votes should be zero before delegation");
        vm.prank(buyer);
        tk.delegate(buyer);
        assertEq(tk.getVotes(buyer), buyerBal, "getVotes should equal balance after self-delegate");

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
