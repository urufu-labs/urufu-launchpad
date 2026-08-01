// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20 as SoladyERC20} from "solady/tokens/ERC20.sol";

import {Router} from "src/router/Router.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {MockFactory} from "test/mocks/MockFactory.sol";

/// Minimal fee-receiver stub for the audit tests.
contract FakeFeeReceiver is IFeeReceiver {
    function receiveFee(
        address,
        BaseType
    ) external payable {}
    receive() external payable {}
}

/// Minimal Solady-backed ERC20 with a mint helper — used by tests that
/// need a real transferring token (CurveFactory positive-path, launch
/// paths that would otherwise fail on balanceOf(0xdead) etc.).
contract TestERC20 is SoladyERC20 {
    string internal _n;
    string internal _s;

    constructor(
        string memory n_,
        string memory s_,
        address to,
        uint256 amt
    ) {
        _n = n_;
        _s = s_;
        _mint(to, amt);
    }

    function name() public view override returns (string memory) {
        return _n;
    }

    function symbol() public view override returns (string memory) {
        return _s;
    }
}

/// @title  AuditFixV6
/// @notice Deterministic regression tests for the 2026-07-30 Tier 1 audit
///         fixes. Each test either exercises the vulnerable public entrypoint
///         end-to-end and asserts the exact fix-introduced revert, or shows
///         the positive path still succeeds. Read the tests below top-down:
///         every #N group has (vulnerable-path-blocked) + (legit-path-still-works)
///         coverage where possible.
///
///         Deploy-blocking: V6 broadcast should not proceed unless every
///         test in this file is green.
contract AuditFixV6Test is Test {
    Router router;
    CurveFactory curveFactory;
    NameRegistry nameRegistry;
    FakeFeeReceiver feeReceiver;
    MockFactory mockFactory20;

    address constant OWNER = address(0xA11CE);
    address constant ATTACKER = address(0xCAFE);
    address constant LAUNCHER = address(0xBEEF);

    uint256 constant BASE_FEE = 1 ether;
    uint256 constant MODULE_ADD_ON = 0.1 ether;

    function setUp() public {
        feeReceiver = new FakeFeeReceiver();
        vm.startPrank(OWNER);

        string[] memory reservedTickers = new string[](0);
        nameRegistry = new NameRegistry(OWNER, OWNER, reservedTickers);

        router = new Router(
            OWNER, nameRegistry, feeReceiver, BASE_FEE, BASE_FEE, BASE_FEE, MODULE_ADD_ON, 0.1 ether, 0.1 ether
        );
        nameRegistry.setRouter(address(router));

        BondingCurve curveImpl = new BondingCurve();
        curveFactory = new CurveFactory(OWNER, address(feeReceiver), address(curveImpl));

        vm.stopPrank();

        // MockFactory is instantiated OUTSIDE the prank because setRouter is
        // unrestricted; we bind it to router.  Router.setFactory + curveFactory
        // wiring happen under OWNER-prank below in the tests that need them.
        mockFactory20 = new MockFactory();
        mockFactory20.setRouter(address(router));

        vm.deal(LAUNCHER, 100 ether);
    }

    // ============================================================
    // #2  CurveFactory ACL
    //     Attack:  anyone calls createCurveWithConfigFor{,Wl}(token, ...,
    //              launcher = self) to plant themselves as recorded launcher
    //              for a token they don't own, hijacking creator-fee
    //              attribution on the graduated pool.
    //     Post-fix: trustedRouters[msg.sender] must be true.
    // ============================================================

    function test_Audit2_CurveFactory_UntrustedRouterRejected() public {
        address tok = address(0xD00D);
        vm.expectRevert(abi.encodeWithSelector(CurveFactory.CurveFactory__UntrustedRouter.selector, ATTACKER));
        vm.prank(ATTACKER);
        curveFactory.createCurveWithConfigFor(tok, 0, 0, ATTACKER);
    }

    function test_Audit2_CurveFactory_UntrustedRouter_WlVariantAlsoRejected() public {
        address tok = address(0xD00D);
        BondingCurve.WhitelistInit memory wl;
        vm.expectRevert(abi.encodeWithSelector(CurveFactory.CurveFactory__UntrustedRouter.selector, ATTACKER));
        vm.prank(ATTACKER);
        curveFactory.createCurveWithConfigForWl(tok, 0, 0, ATTACKER, wl);
    }

    function test_Audit2_CurveFactory_TrustedRouter_CreatesCurveAndRecordsLauncher() public {
        // Positive path: whitelist a router, deploy a real ERC20 that the
        // router-shaped caller holds, call createCurveWithConfigFor, and
        // verify:
        //   1. call succeeds (no ACL revert)
        //   2. curveFor[token] gets populated
        //   3. BondingCurve records LAUNCHER (not the caller/router)
        //
        // Prior test just asserted "revert selector isn't UntrustedRouter" —
        // that passes even if the function had NO body, so it can't
        // distinguish an actual working code path from a total no-op.

        // Impersonate a "router" — we use a plain EOA whitelisted as trusted.
        // Because CurveFactory pulls tokens FROM msg.sender via transferFrom,
        // the trusted caller must (a) hold curveSupply tokens and (b) have
        // approved CurveFactory for them.
        address trustedRouter = address(0xBB55);
        uint256 curveSupply = curveFactory.defaultCurveSupply();

        vm.prank(OWNER);
        curveFactory.setTrustedRouter(trustedRouter, true);

        TestERC20 token = new TestERC20("Legit", "LEG", trustedRouter, curveSupply);
        vm.prank(trustedRouter);
        token.approve(address(curveFactory), curveSupply);

        vm.prank(trustedRouter);
        curveFactory.createCurveWithConfigFor(address(token), 0, 0, LAUNCHER);

        address curve = curveFactory.curveFor(address(token));
        assertTrue(curve != address(0), "curveFor[token] must be populated");
        assertEq(
            BondingCurve(payable(curve)).launcher(),
            LAUNCHER,
            "BondingCurve.launcher must be LAUNCHER, NOT the router or msg.sender"
        );
    }

    // ============================================================
    // #3  Router moduleCount trust
    //     Attack:  launcher submits `params.moduleCount = 1` while the config
    //              actually has N modules, underpaying (N-1)*moduleAddOn.
    //     Post-fix: quote/launch derive count from moduleCountForConfig[hash]
    //              and ignore params.moduleCount.
    // ============================================================

    function test_Audit3_ModuleCount_QuoteIgnoresCallerValue() public {
        bytes32 hash5 = bytes32(uint256(0x1234));
        vm.prank(OWNER);
        router.setModuleCountForConfig(hash5, 5);

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.configHash = hash5;

        p.moduleCount = 1;
        uint256 attackerQuote = router.quote(p);
        p.moduleCount = 5;
        uint256 honestQuote = router.quote(p);
        assertEq(attackerQuote, honestQuote, "quote must ignore params.moduleCount");
        assertEq(
            attackerQuote,
            BASE_FEE + 4 * MODULE_ADD_ON,
            "registered count = 5 must produce base + 4 extras regardless of caller value"
        );
    }

    function test_Audit3_ModuleCount_LaunchChargesRegisteredValue() public {
        // Register a real ERC20 factory + impl for the hash, then launch
        // with a lying params.moduleCount and assert the ACTUAL ETH forwarded
        // to FeeReceiver matches the REGISTERED count's quote, not the
        // caller-supplied one. This is the exploit path — pre-fix, launcher
        // set moduleCount=1 and paid baseFee only; post-fix, they must pay
        // the registered count's fee or launch reverts InsufficientFee.
        bytes32 hash3 = bytes32(uint256(0xABCDEF));
        uint256 registeredExtras = 2; // registered count 3 → 2 extras

        vm.startPrank(OWNER);
        router.setFactory(BaseType.ERC20, address(mockFactory20));
        router.setModuleCountForConfig(hash3, 3);
        router.setFlagsForConfig(hash3, 0); // sentinel required (audit remediation #3)
        vm.stopPrank();

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Fee Test";
        p.ticker = "FEE";
        p.configHash = hash3;
        p.moduleCount = 1; // LIES — claims 1 module to underpay
        p.ownership = OwnershipMode.Renounce;

        uint256 honestFee = BASE_FEE + registeredExtras * MODULE_ADD_ON;
        uint256 liarFee = BASE_FEE;

        // Attacker attempts to underpay:
        vm.expectRevert(abi.encodeWithSelector(Router.Router__InsufficientFee.selector, honestFee, liarFee));
        vm.prank(LAUNCHER);
        router.launch{value: liarFee}(p);

        // Paying honest fee succeeds — same params, just correct amount.
        uint256 balBefore = address(feeReceiver).balance;
        vm.prank(LAUNCHER);
        router.launch{value: honestFee}(p);
        assertEq(
            address(feeReceiver).balance - balBefore, honestFee, "FeeReceiver must receive full registered-count fee"
        );
    }

    function test_Audit3_ModuleCount_BatchSetterMatchesSingle() public {
        // Batch setter must produce identical quotes to per-hash setters.
        bytes32[] memory hashes = new bytes32[](3);
        hashes[0] = bytes32(uint256(0xA));
        hashes[1] = bytes32(uint256(0xB));
        hashes[2] = bytes32(uint256(0xC));
        uint256[] memory counts = new uint256[](3);
        counts[0] = 1;
        counts[1] = 3;
        counts[2] = 7;
        vm.prank(OWNER);
        router.setModuleCountForConfigBatch(hashes, counts);
        for (uint256 i = 0; i < 3; i++) {
            LaunchParams memory p;
            p.base = BaseType.ERC20;
            p.configHash = hashes[i];
            p.moduleCount = 42; // deliberately wrong — must be ignored
            uint256 expectedExtras = counts[i] > 0 ? counts[i] - 1 : 0;
            assertEq(
                router.quote(p),
                BASE_FEE + expectedExtras * MODULE_ADD_ON,
                "batch-set count must drive the fee, not caller value"
            );
        }
    }

    // ============================================================
    // #5  FoT structural guard
    //     Attack:  launcher submits a config for a hash the owner has flagged
    //              FLAG_BALANCE_MUTATING with installBondingCurve=true — pre-fix,
    //              install succeeded (bug: only manual denylist was checked)
    //              and the first taxed trade eventually bricked the curve.
    //     Post-fix: flag alone triggers Router__CurveIncompatibleModule at
    //              install time in launch().
    // ============================================================

    /// The FLAG-only path: hash has flag set, NOT in manual denylist. Router
    /// must still reject curve install. This is the specific regression:
    /// pre-fix, only the denylist was checked, so a flagged hash was accepted.
    function test_Audit5_FoT_FlagOnly_LaunchWithCurve_Reverts() public {
        bytes32 fotHash = bytes32(uint256(0xF07));

        vm.startPrank(OWNER);
        router.setFactory(BaseType.ERC20, address(mockFactory20));
        router.setCurveFactory(address(curveFactory));
        router.setModuleCountForConfig(fotHash, 1);
        router.setFlagsForConfig(fotHash, 1); // FLAG_BALANCE_MUTATING
        vm.stopPrank();

        // Sanity: manual denylist is EXPLICITLY not set — proves this test
        // exercises the flag path, not the belt-and-braces denylist.
        assertFalse(
            router.curveIncompatibleConfigHash(fotHash),
            "manual denylist must NOT be set - test would otherwise pass on the denylist path"
        );

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "FoT Trap";
        p.ticker = "FOT";
        p.configHash = fotHash;
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = BASE_FEE; // 0 extras (count=1)
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, fotHash));
        vm.prank(LAUNCHER);
        router.launch{value: fee}(p);
    }

    /// The DENYLIST-only path: hash has NO flag set, but IS in manual denylist.
    /// Router must also reject — belt-and-braces older path still works.
    function test_Audit5_FoT_DenylistOnly_LaunchWithCurve_Reverts() public {
        bytes32 legacyHash = bytes32(uint256(0xFEEDBEEF));

        vm.startPrank(OWNER);
        router.setFactory(BaseType.ERC20, address(mockFactory20));
        router.setCurveFactory(address(curveFactory));
        router.setModuleCountForConfig(legacyHash, 1);
        // Sentinel required by audit remediation #3 fail-closed check —
        // set flags=0 explicitly to declare "no restricted behavior."
        router.setFlagsForConfig(legacyHash, 0);
        router.setCurveIncompatibleConfigHash(legacyHash, true);
        vm.stopPrank();

        // Sanity: flag bitset is 0 (declared but empty) — proves this test
        // exercises the denylist path, not the flag path.
        assertEq(router.flagsForConfig(legacyHash), 0, "flag bitset must be zero");

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Legacy FoT";
        p.ticker = "LFT";
        p.configHash = legacyHash;
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, legacyHash));
        vm.prank(LAUNCHER);
        router.launch{value: BASE_FEE}(p);
    }

    /// Positive path: clean hash (no flag, no denylist) with installBondingCurve
    /// must launch through the full pipeline. The prior version of this test
    /// used a MockFactory whose token doesn't fully support approve/transferFrom
    /// and swallowed every revert as long as it wasn't CurveIncompatibleModule —
    /// meaning the test passed even when curve launches were broken for an
    /// unrelated reason (T-2 from the 2026-07-30 audit). Replaced by the live
    /// stack coverage in ChunkyModuleMatrixFork::test_Matrix_Bare_LaunchGraduate
    /// and SetChunkyDefaultsFork::test_ChunkyDefaults_LiveStack_LaunchGraduateSwapFees_FullE2E,
    /// which both run through the REAL Router → NameRegistry → ERC20Factory →
    /// CurveFactory pipeline against a live RH mainnet fork and hard-assert
    /// token != 0 + curveFor(token) != 0 + a full graduation. Keeping this
    /// slot as a documentation stub so audit crossrefs still resolve.
    function test_Audit5_CleanConfig_LaunchWithCurve_NotBlockedByFix() public pure {
        // Intentionally empty. See docstring above.
    }
}
