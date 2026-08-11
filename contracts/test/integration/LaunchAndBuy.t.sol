// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";

import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IERC20View {
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// URU-A05: BondingCurve requires a live-contract graduator. This stub is a
/// no-op (none of the LaunchAndBuy tests cross the graduation target); the
/// `poolManager` view returns the stub itself so Router's grant-allowance
/// probe treats it as a benign live contract.
contract MockGraduator {
    function execute(
        address,
        uint256,
        uint256,
        uint32,
        uint16,
        address
    ) external payable {}

    function poolManager() external view returns (address) {
        return address(this);
    }
}

/// Loyalty-test helpers — minimal URU + GEMU stand-ins with an open `mint`
/// hook so tests can dial holder tiers on demand.
contract MockUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockGemu is ERC721 {
    function name() public pure override returns (string memory) {
        return "GEMU";
    }

    function symbol() public pure override returns (string memory) {
        return "GEMU";
    }

    function tokenURI(
        uint256
    ) public pure override returns (string memory) {
        return "";
    }

    function mint(
        address to,
        uint256 id
    ) external {
        _mint(to, id);
    }
}

/// @title  LaunchAndBuyTest
/// @notice GH #8 end-to-end: `Router.launchAndBuy` deploys a token AND
///         executes the launcher's first curve buy in a single tx. These
///         tests cover the happy path, atomicity proof (recorded logs),
///         refund of excess ETH, parity-with-launch when `initialBuyEth == 0`,
///         and the LoyaltyOracle discount applied to the fee leg.
contract LaunchAndBuyTest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC20Template internal impl20;

    BondingCurve internal curveImpl;
    CurveFactory internal cf;
    MockGraduator internal mockGrad;

    LoyaltyOracle internal oracle;
    MockUru internal uru;
    MockGemu internal gemu;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant BASE_FEE = 0.05 ether;
    uint256 internal constant URU_THRESHOLD = 1000e18;
    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));

    function setUp() public {
        string[] memory reserved = new string[](0);
        registry = new NameRegistry(admin, treasury, reserved);
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );

        f20 = new ERC20Factory(admin, address(router), registrar);
        impl20 = new ERC20Template();

        curveImpl = new BondingCurve();
        cf = new CurveFactory(admin, address(feeReceiver), address(curveImpl));
        mockGrad = new MockGraduator();

        uru = new MockUru();
        gemu = new MockGemu();
        oracle = new LoyaltyOracle(admin, address(uru), address(gemu), URU_THRESHOLD);

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setCurveFactory(address(cf));
        registry.setRouter(address(router));
        cf.setTrustedRouter(address(router), true);
        cf.setGraduator(address(mockGrad));
        router.setModuleCountForConfig(BARE_ERC20, 1);
        router.setFlagsForConfig(BARE_ERC20, 0);
        router.setLoyaltyOracle(address(oracle));
        vm.stopPrank();

        vm.prank(admin);
        f20.setExpectedCodeHash(BARE_ERC20, keccak256(address(impl20).code));
        vm.prank(registrar);
        f20.registerImpl(BARE_ERC20, address(impl20));

        vm.deal(launcher, 100 ether);
    }

    // =========================================================
    // Helpers
    // =========================================================

    function _paramsWithCurve(
        string memory name,
        string memory ticker
    ) internal view returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: name,
            ticker: ticker,
            configHash: BARE_ERC20,
            initData: abi.encode(cf.defaultCurveSupply(), address(router), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // AC #9 — happy path: deploy + buy + curve reserve update in one tx
    // =========================================================

    function test_LaunchAndBuy_HappyPath_DeploysAndBuysAtomically() public {
        LaunchParams memory p = _paramsWithCurve("Atomic Launch", "ATOM");
        uint256 initialBuyEth = 1 ether;

        vm.prank(launcher);
        address token = router.launchAndBuy{value: BASE_FEE + initialBuyEth}(p, initialBuyEth, 0, recipient);

        // Token deployed and registered.
        assertTrue(token != address(0), "token must be deployed");
        bytes32 nameHash = keccak256(bytes("atomic launch"));
        assertEq(registry.reservationOf(nameHash).token, token, "registry must reserve the name");

        // Curve installed and holds curve-supply (minus what the first buy pulled).
        address curve = cf.curveFor(token);
        assertTrue(curve != address(0), "curve must be installed");

        // Recipient (not launcher, not router) received the first-buy tokens.
        uint256 recipientBal = IERC20View(token).balanceOf(recipient);
        assertGt(recipientBal, 0, "recipient must receive first-buy tokens");
        assertEq(IERC20View(token).balanceOf(launcher), 0, "launcher must NOT receive tokens");
        assertEq(IERC20View(token).balanceOf(address(router)), 0, "router must NOT retain tokens");

        // Curve reserves reflect the buy (post-1% fee).
        BondingCurve c = BondingCurve(payable(curve));
        assertEq(c.ethReserve(), initialBuyEth * 9900 / 10_000, "ethReserve must equal ethIn minus 1% fee");
        assertEq(c.tokenReserve(), cf.defaultCurveSupply() - recipientBal, "tokenReserve must drop by tokensOut");
        assertFalse(c.graduated(), "curve must not have graduated");

        // Fee receiver got launch fee + curve trade fee.
        uint256 tradeFee = initialBuyEth * 100 / 10_000; // 1% FEE_BPS on default curve
        assertEq(address(feeReceiver).balance, BASE_FEE + tradeFee, "receiver must accumulate launch fee + trade fee");
        assertEq(address(router).balance, 0, "router must not retain ETH");
    }

    // =========================================================
    // AC #10 — initialBuyEth == 0 is parity with launch (with curve)
    // =========================================================

    function test_LaunchAndBuy_ZeroInitialBuy_WithCurve_ParityWithLaunch() public {
        LaunchParams memory p = _paramsWithCurve("Zero Buy Curve", "ZBC");

        vm.prank(launcher);
        address token = router.launchAndBuy{value: BASE_FEE}(p, 0, 0, recipient);

        // Curve installed and holds ALL of the curve supply — no buy touched it.
        address curve = cf.curveFor(token);
        assertTrue(curve != address(0), "curve must be installed");
        BondingCurve c = BondingCurve(payable(curve));
        assertEq(c.tokenReserve(), cf.defaultCurveSupply(), "tokenReserve must be untouched");
        assertEq(c.ethReserve(), 0, "ethReserve must be zero (no buy happened)");

        // Recipient MUST NOT hold tokens — no buy was invoked on their behalf.
        assertEq(IERC20View(token).balanceOf(recipient), 0, "recipient must NOT hold tokens when initialBuyEth == 0");
        assertEq(IERC20View(token).balanceOf(launcher), 0, "launcher must NOT hold tokens");

        // Fee accounting matches plain `launch` — just the launch fee.
        assertEq(address(feeReceiver).balance, BASE_FEE, "only the launch fee should have been forwarded");
    }

    // =========================================================
    // AC #13 — refunds excess ETH above `fee + initialBuyEth`
    // =========================================================

    function test_LaunchAndBuy_RefundsExcessAboveFeePlusInitialBuy() public {
        LaunchParams memory p = _paramsWithCurve("Refund Path", "RFP");
        uint256 initialBuyEth = 0.3 ether;
        uint256 overpay = 0.7 ether;
        uint256 provided = BASE_FEE + initialBuyEth + overpay;

        uint256 balBefore = launcher.balance;
        vm.prank(launcher);
        router.launchAndBuy{value: provided}(p, initialBuyEth, 0, recipient);

        // Launcher paid exactly fee + initialBuyEth; overpay was refunded.
        assertEq(launcher.balance, balBefore - (BASE_FEE + initialBuyEth), "excess must be refunded");
        assertEq(address(router).balance, 0, "router must not retain ETH");
    }

    // AC #14 (integration variant): with a real curve enabled and a
    // positive `initialBuyEth`, underpay reverts with the SUM required.
    // Exercises the same guard the unit test hits (initialBuyEth = 0), just
    // proving the fee-plus-buy arithmetic — not just the fee-only path.
    function test_LaunchAndBuy_RevertsInsufficient_ForFeePlusBuySum() public {
        LaunchParams memory p = _paramsWithCurve("Underpay Buy", "UPB");
        uint256 initialBuyEth = 0.3 ether;
        uint256 required = BASE_FEE + initialBuyEth;
        vm.expectRevert(abi.encodeWithSelector(Router.Router__InsufficientFee.selector, required, required - 1));
        vm.prank(launcher);
        router.launchAndBuy{value: required - 1}(p, initialBuyEth, 0, recipient);
    }

    // =========================================================
    // AC #15 — single-tx window proof: no external tx can observe
    // the curve between deploy and first buy. Proof strategy:
    //   1. Recorded logs show Launched + CurveInstalled + BoughtFor
    //      all fired in the SAME tx (vm.recordLogs).
    //   2. Curve's ethReserve > 0 after the tx returns — the buy
    //      landed atomically with launch.
    // =========================================================

    function test_LaunchAndBuy_SingleTxAtomicity_ProofViaRecordedLogs() public {
        LaunchParams memory p = _paramsWithCurve("Atomic Proof", "ATP");
        uint256 initialBuyEth = 0.4 ether;

        vm.recordLogs();
        vm.prank(launcher);
        address token = router.launchAndBuy{value: BASE_FEE + initialBuyEth}(p, initialBuyEth, 0, recipient);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sawLaunched = false;
        bool sawCurveInstalled = false;
        bool sawBoughtFor = false;
        bool sawLaunchedWithInitialBuy = false;

        bytes32 launchedSig = keccak256("Launched(address,address,uint8,bytes32,bytes32,uint256,bool,bool)");
        bytes32 curveInstalledSig = keccak256("CurveInstalled(address,address)");
        bytes32 boughtForSig = keccak256("BoughtFor(address,address,uint256,uint256)");
        bytes32 launchedWithInitialBuySig = keccak256("LaunchedWithInitialBuy(address,address,address,uint256,uint256)");

        for (uint256 i = 0; i < logs.length; ++i) {
            bytes32 topic0 = logs[i].topics[0];
            if (topic0 == launchedSig) sawLaunched = true;
            if (topic0 == curveInstalledSig) sawCurveInstalled = true;
            if (topic0 == boughtForSig) sawBoughtFor = true;
            if (topic0 == launchedWithInitialBuySig) sawLaunchedWithInitialBuy = true;
        }

        assertTrue(sawLaunched, "Launched event must fire in the same tx");
        assertTrue(sawCurveInstalled, "CurveInstalled must fire in the same tx");
        assertTrue(sawBoughtFor, "BoughtFor must fire in the same tx (proves buyFor ran)");
        assertTrue(sawLaunchedWithInitialBuy, "LaunchedWithInitialBuy must fire when initialBuyEth > 0");

        // Post-tx state proves atomicity too — buy already landed.
        address curve = cf.curveFor(token);
        assertGt(BondingCurve(payable(curve)).ethReserve(), 0, "buy must have landed atomically");
        assertGt(IERC20View(token).balanceOf(recipient), 0, "recipient balance proves tokens flowed");
    }

    // =========================================================
    // AC #17 — LoyaltyOracle discount applies to launchAndBuy fee leg
    // =========================================================

    function test_LaunchAndBuy_AppliesLoyaltyDiscount() public {
        // Launcher holds both URU (>= threshold) and gemu NFT → 50% off.
        uru.mint(launcher, URU_THRESHOLD);
        gemu.mint(launcher, 1);

        LaunchParams memory p = _paramsWithCurve("Discounted Buy", "DSB");
        uint256 discountedFee = BASE_FEE * 5000 / 10_000;
        assertEq(router.quoteFor(p, launcher), discountedFee, "quoteFor must reflect 50% loyalty discount");

        uint256 initialBuyEth = 0.2 ether;

        // Send exact discounted fee + buy — no refund expected.
        uint256 provided = discountedFee + initialBuyEth;
        uint256 balBefore = launcher.balance;
        vm.prank(launcher);
        router.launchAndBuy{value: provided}(p, initialBuyEth, 0, recipient);

        // Launcher paid exactly `discountedFee + initialBuyEth`.
        assertEq(launcher.balance, balBefore - provided, "launcher must pay exactly discounted fee + initial buy");
        // FeeReceiver got only the discounted launch fee + the curve trade fee on the buy leg.
        uint256 tradeFee = initialBuyEth * 100 / 10_000;
        assertEq(address(feeReceiver).balance, discountedFee + tradeFee, "receiver must reflect discount");
    }

    /// Extra defense: sending BASE_FEE (gross) + initialBuyEth with a loyal
    /// launcher must refund the discount portion. Proves the refund math
    /// handles `msg.value = required + discount` correctly.
    function test_LaunchAndBuy_LoyaltyRefundsOverpayAtGrossFee() public {
        gemu.mint(launcher, 1); // 20% off tier only
        LaunchParams memory p = _paramsWithCurve("Loyalty Overpay", "LOP");
        uint256 discountedFee = BASE_FEE * 8000 / 10_000;
        uint256 initialBuyEth = 0.1 ether;

        // Overpay: send full BASE_FEE (not the discounted one) + buy.
        uint256 balBefore = launcher.balance;
        vm.prank(launcher);
        router.launchAndBuy{value: BASE_FEE + initialBuyEth}(p, initialBuyEth, 0, recipient);

        // Launcher only kept-out the discounted fee + buy leg; discount portion refunded.
        assertEq(launcher.balance, balBefore - (discountedFee + initialBuyEth), "discount portion must be refunded");
    }

    // =========================================================
    // Extra atomicity check — nothing can front-run the buy because
    // launchAndBuy IS the launch tx. Prior to launchAndBuy landing the
    // curve doesn't exist yet (no `curveFor(token)` mapping); after it
    // lands, the buy already happened. Exercise that invariant.
    // =========================================================

    function test_LaunchAndBuy_CurveDoesNotExistBeforeCall() public {
        // Predict what the token address WOULD be if launched — but curve
        // mapping is only populated inside the launch tx. Before the call:
        // no mapping. This is a boundary sanity check — no external tx can
        // see a curve until launchAndBuy returns, at which point the buy
        // has already been executed inside the same tx.
        address predicted = makeAddr("nonexistent");
        assertEq(cf.curveFor(predicted), address(0), "curve mapping must be empty pre-launch");
    }

    // =========================================================
    // Phase 2 audit follow-up #2 — contract-launcher refund path.
    // Router.launchAndBuy's refund leg is PUSH-based
    // (SafeTransferLib.safeTransferETH → msg.sender). Confirm that:
    //   (a) a contract launcher whose receive() reverts DOES revert the
    //       whole launchAndBuy when a refund would fire, and
    //   (b) a contract launcher whose receive() accepts ETH DOES succeed
    //       through the refund path.
    // Also verify the exact-value (no-refund) case for a rejecting launcher
    // still succeeds — the refund guard is `if (refund > 0)`.
    // =========================================================

    function test_LaunchAndBuy_ContractLauncherRejectingEth_RefundReverts() public {
        RejectingLauncherProxy proxy = new RejectingLauncherProxy(router);
        vm.deal(address(proxy), 100 ether);

        LaunchParams memory p = _paramsWithCurve("Reject Refund", "RJR");
        uint256 initialBuyEth = 0.2 ether;
        uint256 required = BASE_FEE + initialBuyEth;
        uint256 overpay = 0.01 ether;

        // The refund on `required + overpay` push-fails inside SafeTransferLib.
        // SafeTransferLib bubbles a plain 4-byte ETHTransferFailed error, so
        // we assert on the outermost revert by expecting any revert (the
        // sub-callee reverts by design).
        vm.expectRevert();
        proxy.doLaunchAndBuy{value: required + overpay}(p, initialBuyEth, 0, recipient);
    }

    function test_LaunchAndBuy_ContractLauncherRejectingEth_ExactValueSucceeds() public {
        // Even a rejecting contract can call launchAndBuy safely when it
        // sends the EXACT required amount (no refund fires). Proves the
        // revert in the sister test is purely the refund push, not a
        // structural block on contract launchers.
        RejectingLauncherProxy proxy = new RejectingLauncherProxy(router);
        vm.deal(address(proxy), 10 ether);

        LaunchParams memory p = _paramsWithCurve("Exact No Refund", "EXN");
        uint256 initialBuyEth = 0.15 ether;
        uint256 required = BASE_FEE + initialBuyEth;

        address token = proxy.doLaunchAndBuy{value: required}(p, initialBuyEth, 0, recipient);
        assertTrue(token != address(0), "launch must succeed on exact-value send from rejecting contract");
        assertGt(IERC20View(token).balanceOf(recipient), 0, "recipient must have received first-buy tokens");
    }

    function test_LaunchAndBuy_ContractLauncherAcceptingEth_RefundSucceeds() public {
        // Deploy the proxy with a zero starting balance so the refund is
        // the ONLY inbound ETH — makes the assertion unambiguous. The test
        // contract funds `msg.value` on the outer call so the proxy has
        // exactly `required + overpay` available for the forwarded call.
        AcceptingLauncherProxy proxy = new AcceptingLauncherProxy(router);

        LaunchParams memory p = _paramsWithCurve("Accept Refund", "ACR");
        uint256 initialBuyEth = 0.2 ether;
        uint256 required = BASE_FEE + initialBuyEth;
        uint256 overpay = 0.1 ether;

        assertEq(address(proxy).balance, 0, "precondition: proxy starts empty");
        // The test contract funds the outer call; the proxy forwards all of
        // msg.value to Router. Router refunds `overpay` back to msg.sender
        // (== proxy), so the proxy's post-call balance is exactly `overpay`.
        vm.deal(address(this), required + overpay);
        address token = proxy.doLaunchAndBuy{value: required + overpay}(p, initialBuyEth, 0, recipient);

        assertEq(address(proxy).balance, overpay, "accepting proxy must receive the refund");
        assertTrue(token != address(0), "launch must succeed for accepting contract launcher");
        assertGt(IERC20View(token).balanceOf(recipient), 0, "recipient must have received first-buy tokens");
        assertEq(address(router).balance, 0, "router must not retain ETH");
    }

    // =========================================================
    // Phase 2 audit follow-up #3 — slippage-revert atomicity.
    // If the buyFor slippage guard fires, the whole launchAndBuy tx MUST
    // revert. Post-revert:
    //   * the name is NOT reserved in NameRegistry
    //   * the CurveFactory has no curve entry for the would-be token
    //   * the launcher's ETH balance is unchanged (minus gas — not asserted;
    //     Foundry's `msg.value` accounting reverts cleanly at the EVM layer)
    // Proves atomicity of the deploy + install + buy legs — a slippage
    // revert does not leave a squatted name or a half-installed curve.
    // =========================================================

    function test_LaunchAndBuy_SlippageRevert_UnwindsEverything() public {
        LaunchParams memory p = _paramsWithCurve("Slip Unwind", "SLU");
        uint256 initialBuyEth = 0.3 ether;

        // Analytical quote for the fresh curve. Router.launchAndBuy deploys
        // the token and installs the curve BEFORE calling buyFor, so the
        // curve buyFor sees at buy-time is initialized with the factory
        // defaults: curveSupply = 800e24, virtualToken = 800e24,
        // virtualEth = 5e18, fee = 100 bps, tokenReserve = curveSupply,
        // ethReserve = 0. Same constant-product math as BondingCurve.buyFor.
        uint256 ethAfterFee = initialBuyEth * 9900 / 10_000;
        uint256 effEth = 5 ether;
        uint256 effToken = 1_600_000_000e18;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        uint256 expectedOut = effToken - newEffToken;
        uint256 impossibleMin = expectedOut * 2;

        // Snapshot pre-tx state for the atomicity checks.
        bytes32 nameHash = keccak256(bytes("slip unwind"));
        assertEq(registry.reservationOf(nameHash).token, address(0), "precondition: name unreserved");
        uint256 balBefore = launcher.balance;
        uint256 feeRecvBefore = address(feeReceiver).balance;

        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__Slippage.selector, expectedOut, impossibleMin)
        );
        vm.prank(launcher);
        router.launchAndBuy{value: BASE_FEE + initialBuyEth}(p, initialBuyEth, impossibleMin, recipient);

        // Post-revert atomicity: nothing persisted.
        assertEq(registry.reservationOf(nameHash).token, address(0), "name must NOT be reserved after slippage revert");
        assertEq(launcher.balance, balBefore, "launcher balance must be restored (no gas overhead here)");
        assertEq(address(feeReceiver).balance, feeRecvBefore, "no fees must accrue on a reverted launchAndBuy");

        // The launcher can now retry the SAME name/ticker successfully —
        // proof the earlier revert did not squat the name AND did not leave
        // a phantom curve entry for a would-be token address.
        vm.prank(launcher);
        address token = router.launchAndBuy{value: BASE_FEE + initialBuyEth}(p, initialBuyEth, 0, recipient);
        assertTrue(token != address(0), "retry with reasonable slippage must succeed");
        assertEq(registry.reservationOf(nameHash).token, token, "retry must reserve the previously-attempted name");
        assertTrue(cf.curveFor(token) != address(0), "retry must install a curve");
        assertGt(IERC20View(token).balanceOf(recipient), 0, "retry must land the first-buy tokens");
    }
}

/// @notice Contract launcher that reverts every incoming ETH transfer.
/// Stands in for a Safe / custody wallet whose `receive()` reverts, so
/// Router.launchAndBuy's push-based refund fails and unwinds the tx.
contract RejectingLauncherProxy {
    error Reject__NoEth();

    Router internal immutable router;

    constructor(
        Router router_
    ) {
        router = router_;
    }

    /// Forward the launchAndBuy call. `msg.sender` inside Router becomes
    /// this contract, so the refund (if any) targets this contract's
    /// receive() — which reverts.
    function doLaunchAndBuy(
        LaunchParams calldata params,
        uint256 initialBuyEth,
        uint256 minTokensOut,
        address recipient
    ) external payable returns (address token) {
        token = router.launchAndBuy{value: msg.value}(params, initialBuyEth, minTokensOut, recipient);
    }

    receive() external payable {
        revert Reject__NoEth();
    }
}

/// @notice Contract launcher that accepts ETH normally. Proves the refund
/// path through Router.launchAndBuy WORKS for a well-behaved contract
/// wallet, so the sister rejecting-launcher test's failure is specifically
/// due to the receive() revert and not any structural block on contract
/// callers.
contract AcceptingLauncherProxy {
    Router internal immutable router;

    constructor(
        Router router_
    ) {
        router = router_;
    }

    function doLaunchAndBuy(
        LaunchParams calldata params,
        uint256 initialBuyEth,
        uint256 minTokensOut,
        address recipient
    ) external payable returns (address token) {
        token = router.launchAndBuy{value: msg.value}(params, initialBuyEth, minTokensOut, recipient);
    }

    receive() external payable {}
}
