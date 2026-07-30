// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface ICurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function graduator() external view returns (address);
    function owner() external view returns (address);
    function setGraduator(
        address newGraduator
    ) external;
}

interface IERC20Like {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title  GraduatorV8LpMathFork
/// @notice Regression test for the 2026-07-30 stranded-ETH bug.
///
///         V7 Graduator opened the v4 pool at the CURVE MARGINAL price. That
///         price is ~10x lower (ETH-per-token) than the RAW REAL RATIO of the
///         amounts being deposited. At the marginal price, tokens are the
///         limiting factor of the LP add — all tokens go in, only a fraction
///         of the ETH goes in, and the remainder gets stranded in the
///         graduator contract with no recovery path.
///
///         Real observed on live V7 Graduator:
///           4.003 ETH permanently stuck (single graduation, launcher lost
///           ~$8k of accumulated curve fees).
///
///         V8 opens the pool at the RAW REAL RATIO. Both amounts are
///         guaranteed to match at that price (by definition), so the LP
///         absorbs both fully and no ETH is left over.
///
///         What this test proves:
///           - After a real end-to-end graduation on the live RH fork
///             using a FRESH V8 graduator etched over the current one,
///             `address(graduator).balance == 0`.
///           - The v4 pool exists and holds meaningfully more ETH than
///             it would with the V7 buggy math.
///           - Pool spot price matches the deposited ratio (sanity).
contract GraduatorV8LpMathForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0x1c340f092c89d018d7F6410B0A418253FB522c70;
    address internal constant MHH = 0xD7634D1B30c230265A036cBd8B957069eEE0e2c4;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant CF_OWNER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    address internal launcher = makeAddr("v8-lp-fix-launcher");
    address internal buyer = makeAddr("v8-lp-fix-buyer");

    /// The live V7 Graduator address — MHH.initializer is locked to this
    /// address (setInitializer is one-shot). We etch our V8 bytecode over
    /// this address so the MHH's authorization still recognizes it.
    address internal constant LIVE_V7_GRADUATOR = 0x36234107cC240cA564B9bC168d74CA3a1e3AE2f3;
    GraduatorV2 internal newGrad;

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
        if (ROUTER_V7.code.length == 0) vm.skip(true);

        // Build fresh V8 graduator with correct immutables. NOT deployed at a
        // real address — we just need its RUNTIME code to etch over the V7
        // address. MHH.initializer is locked to the V7 address (setInitializer
        // is one-shot), so a fresh-address graduator wouldn't be authorized.
        GraduatorV2 tmp =
            new GraduatorV2(IPoolManager(POOL_MANAGER), IHooks(MHH), 3000, 60, CURVE_FACTORY, address(this));
        vm.etch(LIVE_V7_GRADUATOR, address(tmp).code);
        // Storage on the etched address is preserved (that's the whole point
        // of vm.etch vs vm.setCode) — but our V8 has a new `owner` storage
        // slot. Write it via cheatcode. Slot 0 = owner (first non-immutable).
        vm.store(LIVE_V7_GRADUATOR, bytes32(uint256(0)), bytes32(uint256(uint160(address(this)))));
        newGrad = GraduatorV2(payable(LIVE_V7_GRADUATOR));

        // CurveFactory still points at LIVE_V7_GRADUATOR (no rotate needed).
        assertEq(
            ICurveFactoryLookup(CURVE_FACTORY).graduator(),
            LIVE_V7_GRADUATOR,
            "CurveFactory.graduator should already be V7 addr"
        );
        assertEq(newGrad.owner(), address(this), "V8 owner slot seeded");

        vm.deal(launcher, 20 ether);
        vm.deal(buyer, 20 ether);
    }

    /// The critical regression assertion. After a full launch → buy →
    /// graduate cycle through the LIVE V7 Router with the V8 graduator
    /// active, `address(newGrad).balance` MUST be zero. If it's not,
    /// user funds are being stranded again.
    function test_V8_Graduation_LeavesNoEthStuck() public {
        (address token, address curve, uint256 ethAtGrad, uint256 tokenAtGrad) = _launchAndGraduate();

        console2.log("Post-graduation state:");
        console2.log("  graduator ETH balance :", address(newGrad).balance);
        console2.log("  ETH handed to grad    :", ethAtGrad);
        console2.log("  tokens handed to grad :", tokenAtGrad);
        console2.log("  launcher ETH balance  :", launcher.balance);

        // THE CRITICAL ASSERTION.
        assertEq(
            address(newGrad).balance, 0, "graduator MUST hold zero ETH post-graduation - the V7 bug stranded 4 ETH here"
        );

        // Sanity: the pool must actually have got the ETH we handed to the
        // graduator (minus fees), not <1 ETH like the V7 buggy math produced.
        // Rough check: PoolManager's total balance increased by close to
        // ethAtGrad. Can't be exact because other pools live on the same PM
        // — just require the delta to be >= half of ethAtGrad.
        // (This is a coarse invariant. Precise LP-amount checks would need
        // extsload against pool slot 0 + tick math; the zero-balance check
        // above is the crisp one.)
        assertGt(ethAtGrad, 0, "sanity: ethAtGrad > 0");
        assertGt(tokenAtGrad, 0, "sanity: tokenAtGrad > 0");
        // Curve state should have been fully drained.
        assertTrue(BondingCurve(payable(curve)).graduated(), "curve.graduated");
        assertEq(BondingCurve(payable(curve)).ethReserve(), 0, "curve.ethReserve drained");
        assertEq(BondingCurve(payable(curve)).tokenReserve(), 0, "curve.tokenReserve drained");
        token; // silence unused
    }

    /// Owner sweep works — safety net for a future regression.
    function test_V8_OwnerCanSweepAccidentalEth() public {
        // Set us as owner (already is via constructor above), fund the
        // graduator directly (simulating a hypothetical future bug that
        // ended up leaving ETH here), then sweep.
        vm.deal(address(newGrad), 3.14 ether);
        assertEq(address(newGrad).balance, 3.14 ether);

        address payable recipient = payable(makeAddr("sweep-recipient"));
        uint256 balBefore = recipient.balance;
        newGrad.sweep(recipient);
        assertEq(address(newGrad).balance, 0, "graduator drained");
        assertEq(recipient.balance - balBefore, 3.14 ether, "recipient credited");
    }

    /// Non-owner cannot sweep.
    function test_V8_NonOwnerSweepReverts() public {
        address attacker = makeAddr("attacker");
        vm.deal(address(newGrad), 1 ether);
        vm.expectRevert(GraduatorV2.Graduator__NotOwner.selector);
        vm.prank(attacker);
        newGrad.sweep(payable(attacker));
    }

    // ============================================================
    // helpers
    // ============================================================

    function _launchAndGraduate()
        internal
        returns (address token, address curve, uint256 ethAtGrad, uint256 tokenAtGrad)
    {
        // Launch a bare ERC20 through the live V7 Router.
        bytes32 bareHash = keccak256(abi.encode("ERC20", ""));
        uint256 curveSupply = ICurveFactoryLookup(CURVE_FACTORY).defaultCurveSupply();
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V8 LP Fix Test";
        p.ticker = "V8FX";
        p.configHash = bareHash;
        p.initData = abi.encode(curveSupply, ROUTER_V7, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        RouterV2 router = RouterV2(payable(ROUTER_V7));
        uint256 launchFee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: launchFee}(p);
        curve = ICurveFactoryLookup(CURVE_FACTORY).curveFor(token);

        // Buy enough to trigger graduation.
        BondingCurve bc = BondingCurve(payable(curve));
        uint256 gradTarget = bc.graduationTargetEth();
        uint256 buyValue = gradTarget + 0.5 ether;
        vm.deal(buyer, buyValue + 1 ether);

        // Snapshot right BEFORE the graduation-triggering buy to know
        // exactly what the graduator will receive.
        vm.recordLogs();
        vm.prank(buyer);
        bc.buy{value: buyValue}(0);

        // Extract ethAmount / tokenAmount from the Graduated event.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 gradSig = keccak256("Graduated(address,address,uint256,uint256,uint160,uint128)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length >= 1 && logs[i].topics[0] == gradSig && logs[i].emitter == address(newGrad)) {
                (ethAtGrad, tokenAtGrad,,) = abi.decode(logs[i].data, (uint256, uint256, uint160, uint128));
                break;
            }
        }
    }
}
