// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

contract MockToken20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockGraduatorL {
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

/// @title  AuditA17LowSeverityTest
/// @notice URU-A17 lower-severity fixes:
///           - quoteBuy floor matches buy() execution (tokenReserve - 1)
///           - UnverifiedCurveCreated event fires on permissionless direct
///             curve creation, does NOT fire on trusted-Router path
///         SafeTransferLib / safeApproveWithRetry replacements are proven by
///         the fact that the existing UruBuybackVault + UruDepositSink suites
///         continue to pass — a return-value regression there would break
///         those tests directly.
contract AuditA17LowSeverityTest is Test {
    // ============================================================
    // quoteBuy floor fixture
    // ============================================================
    BondingCurve internal impl;
    BondingCurve internal curve;
    MockToken20 internal token;
    MockGraduatorL internal grad;

    address internal alice = makeAddr("alice");
    address internal feeReceiver = makeAddr("feeReceiver");

    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;
    uint16 internal constant FEE_BPS = 100;

    function setUp() public {
        impl = new BondingCurve();
        curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token = new MockToken20();
        token.mint(address(curve), CURVE_SUPPLY);
        grad = new MockGraduatorL();
        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(grad),
            0,
            0,
            address(0)
        );
        vm.deal(alice, 1_000_000 ether);
    }

    /// AC: quoteBuy never returns more than tokenReserve - 1. Previously it
    /// clamped to tokenReserve, meaning a UI showing that quote would submit
    /// a buy that reverts BondingCurve__ExceedsSupply.
    function test_QuoteBuy_ClampsToTokenReserveMinusOne() public view {
        (uint256 tokensOut,) = curve.quoteBuy(1_000_000 ether);
        assertEq(tokensOut, curve.tokenReserve() - 1, "quoteBuy must clamp to tokenReserve - 1");
    }

    /// AC: quoteBuy never returns above tokenReserve - 1 for any input.
    /// Property-style check over a range of ETH inputs — a regression that
    /// reverts quoteBuy back to clamping at tokenReserve would break this at
    /// the extreme end.
    function testFuzz_QuoteBuy_NeverExceedsAvailable(
        uint256 ethIn
    ) public view {
        ethIn = bound(ethIn, 0, 10_000_000 ether);
        (uint256 tokensOut,) = curve.quoteBuy(ethIn);
        uint256 available = curve.tokenReserve() > 0 ? curve.tokenReserve() - 1 : 0;
        assertLe(tokensOut, available, "quoteBuy must respect the tokenReserve-1 execution floor");
    }

    // ============================================================
    // CurveFactory UnverifiedCurveCreated fixture
    // ============================================================
    CurveFactory internal factory;
    BondingCurve internal curveImpl;
    MockGraduatorL internal factoryGrad;

    address internal owner = makeAddr("owner");
    address internal factoryFeeReceiver = makeAddr("factoryFeeReceiver");
    address internal trustedRouter = makeAddr("trustedRouter");

    function _initFactory() internal {
        curveImpl = new BondingCurve();
        factoryGrad = new MockGraduatorL();
        // CurveFactory's constructor takes owner as an arg (not derived from
        // msg.sender), so no pre-deploy prank is needed. Nightly Foundry
        // rejects a stacked single-prank + startPrank sequence with
        // "cannot overwrite a prank until it is applied at least once".
        factory = new CurveFactory(owner, factoryFeeReceiver, address(curveImpl));
        vm.startPrank(owner);
        factory.setGraduator(address(factoryGrad));
        factory.setTrustedRouter(trustedRouter, true);
        vm.stopPrank();
    }

    /// AC: createCurve() (permissionless, no router) emits both CurveCreated
    /// AND UnverifiedCurveCreated. Indexer/UI can filter on the second event
    /// to exclude direct curves from the "canonical Urufu launches" view.
    function test_UnverifiedCurveCreated_FiresFromDirectCreateCurve() public {
        _initFactory();
        MockToken20 t = new MockToken20();
        t.mint(alice, CURVE_SUPPLY);
        vm.startPrank(alice);
        t.approve(address(factory), CURVE_SUPPLY);
        vm.recordLogs();
        factory.createCurve(address(t));
        vm.stopPrank();

        (bool unverified, bool canonical) =
            _findBothEvents(CurveFactory.UnverifiedCurveCreated.selector, CurveFactory.CurveCreated.selector);
        assertTrue(unverified, "UnverifiedCurveCreated must fire");
        assertTrue(canonical, "CurveCreated must also fire");
    }

    /// AC: createCurveWithConfig() from a NON-trusted caller emits
    /// UnverifiedCurveCreated.
    function test_UnverifiedCurveCreated_FiresFromDirectCreateCurveWithConfig() public {
        _initFactory();
        MockToken20 t = new MockToken20();
        t.mint(alice, CURVE_SUPPLY);
        vm.startPrank(alice);
        t.approve(address(factory), CURVE_SUPPLY);
        vm.recordLogs();
        factory.createCurveWithConfig(address(t), 0, 0);
        vm.stopPrank();

        (bool unverified,) =
            _findBothEvents(CurveFactory.UnverifiedCurveCreated.selector, CurveFactory.CurveCreated.selector);
        assertTrue(unverified, "UnverifiedCurveCreated must fire");
    }

    /// AC: createCurveWithConfig() from a TRUSTED router does NOT emit
    /// UnverifiedCurveCreated — those launches went through Router policy.
    function test_UnverifiedCurveCreated_DoesNotFireFromTrustedRouter() public {
        _initFactory();
        MockToken20 t = new MockToken20();
        t.mint(trustedRouter, CURVE_SUPPLY);
        vm.startPrank(trustedRouter);
        t.approve(address(factory), CURVE_SUPPLY);
        vm.recordLogs();
        factory.createCurveWithConfig(address(t), 0, 0);
        vm.stopPrank();

        (bool unverified, bool canonical) =
            _findBothEvents(CurveFactory.UnverifiedCurveCreated.selector, CurveFactory.CurveCreated.selector);
        assertFalse(unverified, "UnverifiedCurveCreated must NOT fire for Router-mediated launches");
        assertTrue(canonical, "CurveCreated must still fire");
    }

    /// Snapshot recorded logs ONCE and search for both signatures. Repeated
    /// `vm.getRecordedLogs()` calls return empty because it drains the buffer.
    function _findBothEvents(
        bytes32 a,
        bytes32 b
    ) internal returns (bool foundA, bool foundB) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            bytes32 t = logs[i].topics[0];
            if (t == a) foundA = true;
            if (t == b) foundB = true;
        }
    }
}
