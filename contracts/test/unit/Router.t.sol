// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router, IVMFactory, IOwnable} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {MockFactory} from "test/mocks/MockFactory.sol";
import {MockToken} from "test/mocks/MockToken.sol";

contract RouterTest is Test {
    Router internal router;
    NameRegistry internal registry;
    FeeReceiver internal feeReceiver;
    MockFactory internal f20;
    MockFactory internal f721;
    MockFactory internal f1155;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal launcher = makeAddr("launcher");
    address internal multisig = makeAddr("multisig");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ERC20_FEE = 0.05 ether;
    uint256 internal constant NFT_FEE = 0.05 ether;
    uint256 internal constant ERC1155_FEE = 0.05 ether;
    uint256 internal constant MODULE_ADD_ON = 0.01 ether;
    uint256 internal constant HOOK_ADD_ON = 0.1 ether;
    uint256 internal constant GOV_ADD_ON = 0.1 ether;

    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900; // Solady Ownable Unauthorized()

    function setUp() public {
        registry = new NameRegistry(owner, treasury, new string[](0));
        feeReceiver = new FeeReceiver(owner);
        router = new Router(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON
        );

        f20 = new MockFactory();
        f721 = new MockFactory();
        f1155 = new MockFactory();
        f20.setRouter(address(router));
        f721.setRouter(address(router));
        f1155.setRouter(address(router));

        vm.startPrank(owner);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setFactory(BaseType.ERC721A, address(f721));
        router.setFactory(BaseType.ERC1155, address(f1155));
        registry.setRouter(address(router));
        // Fail-closed sentinels (audit 2026-08 remediation item #3): every
        // configHash must have EXPLICIT moduleCount and flags records before
        // Router.launch/quote will accept it. Seed the default test hash
        // used by _defaultParams so unrelated tests don't have to.
        router.setModuleCountForConfig(bytes32(uint256(1)), 1);
        router.setFlagsForConfig(bytes32(uint256(1)), 0);
        vm.stopPrank();

        vm.deal(launcher, 100 ether);
    }

    // =========================================================
    // Helpers
    // =========================================================

    function _defaultParams(
        BaseType base,
        string memory name,
        string memory ticker
    ) internal pure returns (LaunchParams memory) {
        return LaunchParams({
            base: base,
            name: name,
            ticker: ticker,
            configHash: bytes32(uint256(1)),
            initData: hex"",
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // Constructor
    // =========================================================

    function test_Constructor_StoresImmutablesAndFees() public view {
        assertEq(address(router.registry()), address(registry));
        assertEq(address(router.feeReceiver()), address(feeReceiver));
        assertEq(router.fees(BaseType.ERC20), ERC20_FEE);
        assertEq(router.fees(BaseType.ERC721A), NFT_FEE);
        assertEq(router.fees(BaseType.ERC1155), ERC1155_FEE);
        assertEq(router.moduleAddOnFee(), MODULE_ADD_ON);
        assertEq(router.hookAddOnFee(), HOOK_ADD_ON);
        assertEq(router.governanceAddOnFee(), GOV_ADD_ON);
        assertEq(router.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroRegistry() public {
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        new Router(owner, NameRegistry(address(0)), IFeeReceiver(address(feeReceiver)), 0, 0, 0, 0, 0, 0);
    }

    function test_Constructor_RevertsOnZeroReceiver() public {
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        new Router(owner, registry, IFeeReceiver(address(0)), 0, 0, 0, 0, 0, 0);
    }

    // =========================================================
    // Quote
    // =========================================================

    function test_Quote_SingleModule() public view {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        p.moduleCount = 1;
        assertEq(router.quote(p), ERC20_FEE);
    }

    function test_Quote_ThreeModules() public {
        // Audit fix #3: Router derives moduleCount from moduleCountForConfig,
        // not from caller-supplied params.moduleCount. Post-audit, setters are
        // ONE-SHOT — the default configHash in setUp is already registered as
        // "1", so we use a fresh hash here to register 3 and quote against it.
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        bytes32 freshHash = keccak256(abi.encode("QUOTE_THREE_MODULES"));
        p.configHash = freshHash;
        vm.prank(owner);
        router.setModuleCountForConfig(freshHash, 3);
        p.moduleCount = 3;
        assertEq(router.quote(p), ERC20_FEE + 2 * MODULE_ADD_ON);
    }

    function test_Quote_ZeroModules_TreatedAsOne() public view {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        p.moduleCount = 0;
        assertEq(router.quote(p), ERC20_FEE);
    }

    function test_Quote_WithHookAndGovernance() public view {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        p.moduleCount = 1;
        p.installHook = true;
        p.installGovernance = true;
        assertEq(router.quote(p), ERC20_FEE + HOOK_ADD_ON + GOV_ADD_ON);
    }

    function test_Quote_MonotonicInModuleCount() public view {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        uint256 prev;
        for (uint256 i = 1; i <= 8; ++i) {
            p.moduleCount = i;
            uint256 q = router.quote(p);
            assertGe(q, prev);
            prev = q;
        }
    }

    // =========================================================
    // Launch — happy paths
    // =========================================================

    function test_Launch_HappyPath_ERC20_Renounce() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Alpha Token", "ALPHA");
        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        // Factory got the right args.
        assertEq(f20.deployCount(), 1);
        assertEq(f20.lastName(), "Alpha Token");
        assertEq(f20.lastTicker(), "ALPHA");
        assertEq(f20.lastLauncher(), launcher);

        // Ownership dispatched to zero (renounced).
        assertEq(MockToken(token).owner(), address(0));

        // Reservation recorded.
        bytes32 nameHash = keccak256(bytes("alpha token"));
        assertEq(registry.reservationOf(nameHash).token, token);

        // Fee landed at receiver.
        assertEq(address(feeReceiver).balance, ERC20_FEE);
    }

    function test_Launch_HappyPath_ERC721A_TransferToMultisig() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC721A, "NFT Collection", "NFT");
        p.ownership = OwnershipMode.TransferToMultisig;
        p.ownerTargetIfMultisig = multisig;

        vm.prank(launcher);
        address token = router.launch{value: NFT_FEE}(p);

        assertEq(f721.deployCount(), 1);
        assertEq(MockToken(token).owner(), multisig);
    }

    function test_Launch_HappyPath_ERC1155_KeepEOA() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC1155, "Multi Item", "ITEM");
        p.ownership = OwnershipMode.KeepEOA;

        vm.prank(launcher);
        address token = router.launch{value: ERC1155_FEE}(p);

        assertEq(f1155.deployCount(), 1);
        assertEq(MockToken(token).owner(), launcher);
    }

    function test_Launch_EmitsLaunchedEvent() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Beta Token", "BETA");
        p.installHook = true;

        uint256 expectedFee = ERC20_FEE + HOOK_ADD_ON;
        bytes32 nameHash = keccak256(bytes("beta token"));
        bytes32 tickerHash = keccak256(bytes("BETA"));

        // Predict the deployed token address so we can match the indexed field.
        // MockFactory deploys `new MockToken(msg.sender)` (msg.sender = router) if no nextDeployedToken.
        // Predict via the standard CREATE nonce formula: nonce starts at 1 for a new contract.
        address predicted = vm.computeCreateAddress(address(f20), vm.getNonce(address(f20)));

        vm.prank(launcher);
        vm.expectEmit(true, true, true, true, address(router));
        emit Router.Launched(predicted, launcher, BaseType.ERC20, nameHash, tickerHash, expectedFee, true, false);
        router.launch{value: expectedFee}(p);
    }

    function test_Launch_RefundsExcess() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Refundable", "REFN");
        uint256 balBefore = launcher.balance;
        uint256 overpay = 1 ether;

        vm.prank(launcher);
        router.launch{value: ERC20_FEE + overpay}(p);

        assertEq(launcher.balance, balBefore - ERC20_FEE);
        assertEq(address(feeReceiver).balance, ERC20_FEE);
        assertEq(address(router).balance, 0);
    }

    function test_Launch_ForwardsCorrectFeeToReceiver_WithMultipleAddOns() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Loaded", "LOAD");
        // Audit fix #3: register moduleCount for the config hash — Router
        // sources it from moduleCountForConfig, not params.moduleCount.
        // Setters are one-shot (ConfigMetadataAlreadySet); use a fresh hash
        // since the default in setUp is already registered as 1.
        bytes32 freshHash = keccak256(abi.encode("LAUNCH_MULTI_ADDON"));
        p.configHash = freshHash;
        vm.startPrank(owner);
        router.setModuleCountForConfig(freshHash, 5);
        router.setFlagsForConfig(freshHash, 0);
        vm.stopPrank();
        p.moduleCount = 5; // 4 extra
        p.installHook = true;
        p.installGovernance = true;

        uint256 expectedFee = ERC20_FEE + 4 * MODULE_ADD_ON + HOOK_ADD_ON + GOV_ADD_ON;
        vm.prank(launcher);
        router.launch{value: expectedFee}(p);
        assertEq(address(feeReceiver).balance, expectedFee);
    }

    // =========================================================
    // Launch — revert branches
    // =========================================================

    function test_Launch_RevertsWhenPaused() public {
        vm.prank(owner);
        router.setPaused(true);

        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Paused", "PAUS");
        vm.expectRevert(Router.Router__Paused.selector);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_RevertsOnInsufficientFee() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Cheap", "CHP");
        vm.expectRevert(abi.encodeWithSelector(Router.Router__InsufficientFee.selector, ERC20_FEE, ERC20_FEE - 1));
        vm.prank(launcher);
        router.launch{value: ERC20_FEE - 1}(p);
    }

    function test_Launch_RevertsOnFactoryUnset() public {
        // URU-A08: setFactory now requires a live contract (rejects EOAs and
        // address(0x1)). The old test tried to "wipe" the factory by setting
        // it to 0x1, which was itself a security hole (unset-factory pointer
        // silently accepted). Use a fresh router that never had a factory
        // set to reach the FactoryUnset revert.
        Router freshRouter = new Router(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON
        );
        // Seed sentinels for the default test hash so this test reaches the
        // FactoryUnset guard rather than the earlier ModuleCountMissing gate.
        vm.startPrank(owner);
        freshRouter.setModuleCountForConfig(bytes32(uint256(1)), 1);
        freshRouter.setFlagsForConfig(bytes32(uint256(1)), 0);
        vm.stopPrank();

        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Nofact", "NFC");
        vm.expectRevert(abi.encodeWithSelector(Router.Router__FactoryUnset.selector, BaseType.ERC20));
        vm.prank(launcher);
        freshRouter.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_RevertsOnEmptyName() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "", "TICK");
        vm.expectRevert(Router.Router__EmptyName.selector);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_RevertsOnEmptyTicker() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Name", "");
        vm.expectRevert(Router.Router__EmptyTicker.selector);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_RevertsOnMultisigZeroTarget() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Multisig", "MS");
        p.ownership = OwnershipMode.TransferToMultisig;
        p.ownerTargetIfMultisig = address(0);

        vm.expectRevert(Router.Router__ZeroAddress.selector);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_UnwindsIfRegistryReserveFails() public {
        // Pre-populate the registry so the second reserve reverts.
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Dup Name", "DUPA");
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);

        // Launch again with the same name — registry reverts, whole tx unwinds.
        LaunchParams memory p2 = _defaultParams(BaseType.ERC20, "Dup Name", "DUPB");
        vm.expectRevert(); // NameTaken
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p2);

        // Factory count unchanged after failed attempt (revert unwinds the increment).
        // f20 saw 2 successful call preparations but the second reverted post-deploy — actually the
        // factory's deploy DID run and increment before the revert. Solidity's revert unwinds ALL
        // state changes in the tx, so lastCall + deployCount go back to their pre-tx values.
        assertEq(f20.deployCount(), 1); // still just 1
    }

    function test_Launch_RevertsIfFactoryReturnsZero() public {
        f20.setShouldReturnZero(true);
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Zero Ret", "ZERO");
        vm.expectRevert(Router.Router__DeployFailed.selector);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_Launch_BubblesUpFactoryRevert() public {
        f20.setShouldRevert(true);
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Forced", "FOR");
        vm.expectRevert(); // MockFactory.Forced
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    // =========================================================
    // Admin — onlyOwner + effect
    // =========================================================

    function test_SetFactory_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        router.setFactory(BaseType.ERC20, address(0x1234));
    }

    function test_SetFactory_RevertsOnZero() public {
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        vm.prank(owner);
        router.setFactory(BaseType.ERC20, address(0));
    }

    function test_SetFactory_EmitsAndUpdates() public {
        // URU-A08: setFactory rejects non-contracts. Use a fresh deployed
        // MockFactory (real contract with router wire) rather than an EOA.
        MockFactory newFactory = new MockFactory();
        newFactory.setRouter(address(router));
        vm.expectEmit(true, true, false, true, address(router));
        emit Router.FactorySet(BaseType.ERC20, address(newFactory));
        vm.prank(owner);
        router.setFactory(BaseType.ERC20, address(newFactory));
        assertEq(router.factories(BaseType.ERC20), address(newFactory));
    }

    function test_SetFee_UpdatesQuote() public {
        vm.prank(owner);
        router.setFee(BaseType.ERC20, 1 ether);
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        assertEq(router.quote(p), 1 ether);
    }

    function test_SetFee_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        router.setFee(BaseType.ERC20, 1 ether);
    }

    function test_SetAddOnFees_UpdatesAll() public {
        vm.prank(owner);
        router.setAddOnFees(1, 2, 3);
        assertEq(router.moduleAddOnFee(), 1);
        assertEq(router.hookAddOnFee(), 2);
        assertEq(router.governanceAddOnFee(), 3);
    }

    function test_SetPaused_TogglesState() public {
        assertFalse(router.paused());
        vm.prank(owner);
        router.setPaused(true);
        assertTrue(router.paused());
        vm.prank(owner);
        router.setPaused(false);
        assertFalse(router.paused());
    }

    function test_SetPaused_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        router.setPaused(true);
    }

    function test_SweepStuckETH_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        router.sweepStuckETH(makeAddr("sink"));
    }

    function test_SweepStuckETH_RevertsOnZero() public {
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        vm.prank(owner);
        router.sweepStuckETH(address(0));
    }

    function test_SweepStuckETH_MovesBalance() public {
        // Force ETH into Router — vm.deal directly.
        vm.deal(address(router), 5 ether);
        address sink = makeAddr("sink");
        vm.prank(owner);
        router.sweepStuckETH(sink);
        assertEq(address(router).balance, 0);
        assertEq(sink.balance, 5 ether);
    }

    // =========================================================
    // FeeReceiver
    // =========================================================

    function test_FeeReceiver_ReceiveFeeEmits() public {
        vm.deal(address(this), 1 ether);
        vm.expectEmit(true, true, false, true, address(feeReceiver));
        emit FeeReceiver.FeeReceived(launcher, BaseType.ERC20, 0.5 ether);
        feeReceiver.receiveFee{value: 0.5 ether}(launcher, BaseType.ERC20);
    }

    function test_FeeReceiver_ReceiveDirectETH() public {
        vm.deal(address(this), 1 ether);
        vm.expectEmit(true, true, false, true, address(feeReceiver));
        emit FeeReceiver.FeeReceived(address(0), BaseType.ERC20, 0.25 ether);
        (bool ok,) = address(feeReceiver).call{value: 0.25 ether}("");
        assertTrue(ok);
    }

    function test_FeeReceiver_Sweep_OnlyOwner() public {
        vm.expectRevert(UNAUTHORIZED_SELECTOR);
        vm.prank(stranger);
        feeReceiver.sweep(makeAddr("sink"));
    }

    function test_FeeReceiver_Sweep_RevertsOnZero() public {
        vm.expectRevert(FeeReceiver.FeeReceiver__ZeroAddress.selector);
        vm.prank(owner);
        feeReceiver.sweep(address(0));
    }

    function test_FeeReceiver_Sweep_MovesBalance() public {
        vm.deal(address(feeReceiver), 3 ether);
        address sink = makeAddr("sink");
        vm.prank(owner);
        feeReceiver.sweep(sink);
        assertEq(address(feeReceiver).balance, 0);
        assertEq(sink.balance, 3 ether);
    }

    // =========================================================
    // Invariant-ish: Router never holds ETH after a top-level call
    // =========================================================

    function test_RouterHoldsNoETHAfterLaunch() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Balance Check", "BAL");
        vm.prank(launcher);
        router.launch{value: ERC20_FEE + 2 ether}(p);
        assertEq(address(router).balance, 0);
    }

    // Allow this test contract to receive refunds.
    receive() external payable {}

    // =========================================================
    // GH #8 — launchAndBuy revert branches (unit)
    //
    // Integration coverage (happy path, curve install, atomic buyFor call,
    // refund, single-tx window proof, loyalty discount) lives in
    // test/integration/LaunchAndBuy.t.sol so it can use the real ERC20
    // template + CurveFactory stack. These unit tests exercise the revert
    // paths that fire BEFORE curve install and don't need the full stack.
    // =========================================================

    /// AC #12: `recipient == address(0)` reverts with the dedicated selector
    /// unconditionally — even when `initialBuyEth == 0` (recipient is
    /// required regardless of the buy leg).
    function test_LaunchAndBuy_RevertsOnZeroRecipient() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "ZeroRecip", "ZRC");
        vm.expectRevert(Router.Router__LaunchAndBuyZeroRecipient.selector);
        vm.prank(launcher);
        router.launchAndBuy{value: ERC20_FEE}(p, 0, 0, address(0));
    }

    /// AC #14: `msg.value < fee + initialBuyEth` reverts with the standard
    /// `Router__InsufficientFee(required, provided)` selector. Reuses the
    /// existing error so downstream tooling (indexer, frontend) doesn't need
    /// a new case. Unit-tested here with `initialBuyEth = 0` (no curve
    /// factory needed); the combined-sum insufficient path with a positive
    /// buy leg is exercised in the integration file.
    function test_LaunchAndBuy_RevertsOnInsufficientFee() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Cheap8", "CHP8");
        vm.expectRevert(abi.encodeWithSelector(Router.Router__InsufficientFee.selector, ERC20_FEE, ERC20_FEE - 1));
        vm.prank(launcher);
        router.launchAndBuy{value: ERC20_FEE - 1}(p, 0, 0, launcher);
    }

    /// AC #11: passing `initialBuyEth > 0` when `installBondingCurve == false`
    /// reverts with the dedicated selector. Fires BEFORE any factory / curve
    /// interaction — MockFactory is never touched.
    function test_LaunchAndBuy_RevertsRequiresCurveWhenNoCurve() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "NoCurve8", "NC8");
        p.installBondingCurve = false;
        vm.expectRevert(Router.Router__LaunchAndBuyRequiresCurve.selector);
        vm.prank(launcher);
        router.launchAndBuy{value: ERC20_FEE + 0.1 ether}(p, 0.1 ether, 0, launcher);
    }

    /// Pause gate is shared with `launch` — verify it applies on this
    /// entrypoint too, otherwise the atomic-buy path could survive a pause
    /// aimed at freezing the platform.
    function test_LaunchAndBuy_RevertsWhenPaused() public {
        vm.prank(owner);
        router.setPaused(true);
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Paused8", "PAUS8");
        vm.expectRevert(Router.Router__Paused.selector);
        vm.prank(launcher);
        router.launchAndBuy{value: ERC20_FEE}(p, 0, 0, launcher);
    }

    /// AC #10 (partial — installBondingCurve = false path): with
    /// `initialBuyEth == 0` and `installBondingCurve == false` the flow is
    /// equivalent to `launch`: deploys token, dispatches ownership, forwards
    /// fee. No curve, no buy, no atomic-buy event fires. Full parity coverage
    /// with installBondingCurve = true lives in the integration file.
    function test_LaunchAndBuy_ZeroInitialBuy_NoCurve_Parity() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "ZeroBuy8", "ZBY8");
        p.installBondingCurve = false;
        vm.prank(launcher);
        address token = router.launchAndBuy{value: ERC20_FEE}(p, 0, 0, launcher);
        assertTrue(token != address(0), "token must be deployed");
        assertEq(f20.deployCount(), 1, "factory must have been invoked once");
        assertEq(address(feeReceiver).balance, ERC20_FEE, "fee must land at receiver");
        assertEq(address(router).balance, 0, "router must not retain ETH");
    }
}
