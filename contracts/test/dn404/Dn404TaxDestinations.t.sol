// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// Full-matrix test suite for the DN404 tax hook (Dn404TaxTemplate).
/// Complements Dn404TaxAuth.t.sol (which regressed the launcher-owner
/// vs. platform-governance split from the security-review vuln fix).
///
/// This file exercises the actual on-chain behavior of the six tax
/// destinations plus the keeper sweep, the exemption list, and the
/// split invariant that net + tax == amount for every taxed transfer.
///
/// Reuses the same mock pattern as Dn404TaxAuth.t.sol (inline mocks
/// for brevity; a shared mocks helper file is v1.5+ cleanup).

import {Test} from "forge-std/Test.sol";

import {Dn404TaxTemplate} from "src/dn404/Dn404TaxTemplate.sol";
import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404CurveFactory, IDn404PairCurrencyAllowlist} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {Dn404TaxAllowlist} from "src/dn404/Dn404TaxAllowlist.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike as FactoryILoyalty,
    IDn404CurveFactoryLike as FactoryIDn404CurveFactory
} from "src/dn404/Dn404LaunchFactory.sol";

contract MockErc20 {
    string public name; string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed o, address indexed s, uint256 amount);
    constructor(string memory n, string memory s) { name = n; symbol = s; }
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; emit Transfer(address(0), to, a); }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); return true;
    }
}
contract MockNftFactoryFee { uint256 public minUruFee; function set(uint256 v) external { minUruFee = v; } }
contract MockDn404Graduator { function execute(address, address, uint256, uint256, uint32, uint16, address) external {} }

interface IErc20Min { function balanceOf(address who) external view returns (uint256); function transfer(address to, uint256 a) external returns (bool); }

contract Dn404TaxDestinationsTest is Test {
    Dn404Template internal baseImpl;
    Dn404TaxTemplate internal baseTaxImpl;
    Dn404MirrorTemplate internal mirrorImpl;
    Dn404BondingCurve internal curveImpl;
    Dn404LaunchFactory internal factory;
    Dn404CurveFactory internal dn404CurveFactory;
    Dn404PairCurrencyAllowlist internal pairAllowlist;
    Dn404TaxAllowlist internal taxAllowlist;
    MockDn404Graduator internal graduator;
    MockErc20 internal uru;
    MockErc20 internal usdg;
    MockErc20 internal cost;    // "COST" — sits on the tax destination allowlist
    MockNftFactoryFee internal nftFactoryFee;

    address internal governance = address(0xA1);
    address internal launcher = address(0xB1);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal keeperOps = address(0xC1);
    address internal keeperTreasury = address(0xC2);
    address internal uruSink = address(0xCFEE);
    address internal feeSplitter = address(0xD01);

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant DN404_URU_FEE = 20e18;

    function setUp() public {
        uru = new MockErc20("URU", "URU");
        usdg = new MockErc20("USDG", "USDG");
        cost = new MockErc20("COST", "COST");
        nftFactoryFee = new MockNftFactoryFee();
        nftFactoryFee.set(10e18);

        baseImpl = new Dn404Template();
        baseTaxImpl = new Dn404TaxTemplate();
        mirrorImpl = new Dn404MirrorTemplate();
        curveImpl = new Dn404BondingCurve();

        address[] memory pcTokens = new address[](1); pcTokens[0] = address(usdg);
        string[] memory pcLabels = new string[](1); pcLabels[0] = "USDG";
        pairAllowlist = new Dn404PairCurrencyAllowlist(governance, pcTokens, pcLabels);

        address[] memory taxTokens = new address[](1); taxTokens[0] = address(cost);
        string[] memory taxLabels = new string[](1); taxLabels[0] = "COST";
        taxAllowlist = new Dn404TaxAllowlist(governance, taxTokens, taxLabels);

        dn404CurveFactory = new Dn404CurveFactory(
            governance, feeSplitter, address(curveImpl),
            IDn404PairCurrencyAllowlist(address(pairAllowlist))
        );
        graduator = new MockDn404Graduator();
        vm.prank(governance);
        dn404CurveFactory.setGraduator(address(graduator));

        vm.prank(governance);
        factory = new Dn404LaunchFactory(governance, address(nftFactoryFee));

        vm.startPrank(governance);
        factory.setExpectedCodeHashes(keccak256(address(baseImpl).code), keccak256(address(mirrorImpl).code));
        factory.setImpls(address(baseImpl), address(mirrorImpl));
        factory.setBaseTaxImpl(address(baseTaxImpl), keccak256(address(baseTaxImpl).code));
        factory.setUruConfig(FactoryIERC20(address(uru)), uruSink, DN404_URU_FEE, FactoryILoyalty(address(0)));
        factory.setFeeSplitter(feeSplitter);
        factory.setDn404CurveFactory(FactoryIDn404CurveFactory(address(dn404CurveFactory)));
        factory.setTaxWiring(keeperOps, keeperTreasury, address(taxAllowlist));
        dn404CurveFactory.setTrustedRouter(address(factory), true);
        vm.stopPrank();

        uru.mint(launcher, 1_000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
    }

    // ------------------------------------------------------------------------
    // Baseline: taxMode=Off — no accumulation, no split
    // ------------------------------------------------------------------------

    function test_TaxOff_NoAccumulation() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.Off, 0, address(0));
        // No tax config populated when Off routes through bare template.
        // But we DO launch with Off through the tax template to prove the
        // fast-path short-circuit works. Actually — with taxMode=0 our
        // factory routes to baseImpl (bare Dn404Template), not the tax
        // template. So a truly "Off through tax template" launch isn't
        // reachable via the factory. That's by design — Off launches
        // pay no per-transfer gas overhead.
        //
        // Test instead: the launched contract IS a bare Dn404Template
        // (no taxMode() view exists on it).
        (bool ok,) = base.staticcall(abi.encodeWithSignature("taxMode()"));
        assertFalse(ok, "Off launch should not have taxMode() view");
    }

    // ------------------------------------------------------------------------
    // BurnDead — in-tx burn to 0xdEaD
    // ------------------------------------------------------------------------

    function test_TaxBurnDead_BurnsCorrectAmount() public {
        uint16 taxBps =100; // 1%
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BurnDead, taxBps, address(0));

        // Move some tokens from the founder-premint address (== launcher)
        // out to alice. But launcher is auto-exempt (added by factory),
        // so use a non-exempt path: mint some to alice manually, then
        // alice → bob. Since we can't mint directly, we route through
        // curve which is skip-listed but also auto-exempt on the tax side.
        //
        // Actually simplest path: transfer from curve (exempt) to alice
        // (not exempt) — first transfer LANDS on alice untaxed (curve is
        // sender exempt). Then alice → bob is the taxed transfer we care
        // about.
        address curve = dn404CurveFactory.predictCurveAddress(base);
        uint256 seed = 1000e18;
        vm.prank(curve);
        IErc20Min(base).transfer(alice, seed);
        assertEq(IErc20Min(base).balanceOf(alice), seed, "seed lands untaxed (curve exempt)");

        // Now alice → bob: neither is exempt. 1% should burn.
        uint256 xfer = 100e18;
        uint256 deadBefore = IErc20Min(base).balanceOf(DEAD);
        vm.prank(alice);
        IErc20Min(base).transfer(bob, xfer);
        uint256 tax = xfer * taxBps / 10_000;
        assertEq(IErc20Min(base).balanceOf(bob), xfer - tax, "bob gets net");
        assertEq(IErc20Min(base).balanceOf(DEAD) - deadBefore, tax, "DEAD gets tax");
        assertEq(IErc20Min(base).balanceOf(alice), seed - xfer, "alice debited full amount");
    }

    // ------------------------------------------------------------------------
    // Accumulator destinations — all follow the same on-chain pattern
    // (accumulate on `this`; keeper sweeps). Test just one representative
    // (BuybackURU) end-to-end; the others exercise the same _transfer
    // branch. BuyAllowedToken gets a separate test for target validation.
    // ------------------------------------------------------------------------

    function test_TaxBuybackURU_Accumulates() public {
        uint16 taxBps =200; // 2%
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BuybackURU, taxBps, address(0));

        address curve = dn404CurveFactory.predictCurveAddress(base);
        uint256 seed = 1000e18;
        vm.prank(curve);
        IErc20Min(base).transfer(alice, seed);

        uint256 xfer = 500e18;
        vm.prank(alice);
        IErc20Min(base).transfer(bob, xfer);
        uint256 tax = xfer * taxBps / 10_000;

        // Accumulator: tax lands on the token contract itself.
        assertEq(IErc20Min(base).balanceOf(base), tax, "accumulator holds tax");
        assertEq(Dn404TaxTemplate(payable(base)).accumulatedTax(), tax, "accumulatedTax matches");
        assertEq(IErc20Min(base).balanceOf(bob), xfer - tax);
    }

    function test_TaxBuyAllowedToken_RequiresAllowlistedTarget() public {
        // COST is allowlisted; USDG is NOT (only pair-currency allowlisted).
        // Trying to launch BuyAllowedToken with USDG as target reverts.
        // NOTE: _launch() does its own vm.prank(launcher); wrapping with
        // an outer vm.prank before vm.expectRevert confuses the cheatcode
        // dispatcher ("call didn't revert at a lower depth than cheatcode
        // call depth"). expectRevert must directly precede the reverting
        // external call, and _launch's own prank is enough.
        Dn404LaunchFactory.LaunchParams memory badP = _paramsFor(
            Dn404TaxTemplate.TaxMode.BuyAllowedToken, 100, address(usdg)
        );
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404TaxTemplate.Dn404TaxTemplate__TaxTargetNotAllowed.selector,
                address(usdg)
            )
        );
        factory.launch(badP);

        // COST works.
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BuyAllowedToken, 100, address(cost));
        assertEq(Dn404TaxTemplate(payable(base)).taxTarget(), address(cost));
    }

    // ------------------------------------------------------------------------
    // Keeper sweep — 5% fee, only keeper can call
    // ------------------------------------------------------------------------

    function test_Sweep_ByKeeper_TakesFiveBpsFee() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BuybackURU, 200, address(0));
        address curve = dn404CurveFactory.predictCurveAddress(base);

        // Seed alice, generate some taxed transfers.
        vm.prank(curve);
        IErc20Min(base).transfer(alice, 1000e18);
        vm.prank(alice);
        IErc20Min(base).transfer(bob, 500e18);
        uint256 accum = Dn404TaxTemplate(payable(base)).accumulatedTax();
        assertGt(accum, 0);

        address recipient = address(0xF00D);
        vm.prank(keeperOps);
        (uint256 net, uint256 fee) = Dn404TaxTemplate(payable(base)).sweepAccumulated(recipient, accum);

        assertEq(fee, accum * 500 / 10_000, "fee should be 5% of swept");
        assertEq(net, accum - fee, "net should be sweep - fee");
        assertEq(IErc20Min(base).balanceOf(recipient), net);
        assertEq(IErc20Min(base).balanceOf(keeperTreasury), fee);
        assertEq(Dn404TaxTemplate(payable(base)).accumulatedTax(), 0, "accumulator drained");
    }

    function test_Sweep_ByLauncher_Reverts() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BuybackURU, 200, address(0));
        address curve = dn404CurveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IErc20Min(base).transfer(alice, 1000e18);
        vm.prank(alice);
        IErc20Min(base).transfer(bob, 500e18);

        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotKeeper.selector);
        Dn404TaxTemplate(payable(base)).sweepAccumulated(launcher, 1);
    }

    // ------------------------------------------------------------------------
    // Exemption list — factory / curve / launcher transfers don't get taxed
    // ------------------------------------------------------------------------

    function test_TaxExempt_CurveTransfersUntaxed() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BurnDead, 500, address(0));
        address curve = dn404CurveFactory.predictCurveAddress(base);

        // Curve → alice: curve is exempt, so alice gets full amount.
        uint256 deadBefore = IErc20Min(base).balanceOf(DEAD);
        vm.prank(curve);
        IErc20Min(base).transfer(alice, 100e18);
        assertEq(IErc20Min(base).balanceOf(alice), 100e18, "alice untaxed (sender exempt)");
        assertEq(IErc20Min(base).balanceOf(DEAD), deadBefore, "no burn on exempt transfer");
    }

    // ------------------------------------------------------------------------
    // Split invariant — net + tax always == amount, no dust, no round-up
    // ------------------------------------------------------------------------

    function test_SplitInvariant_NetPlusTaxEqualsAmount() public {
        uint16 taxBps =137; // deliberately odd
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BurnDead, taxBps, address(0));
        address curve = dn404CurveFactory.predictCurveAddress(base);

        vm.prank(curve);
        IErc20Min(base).transfer(alice, 1000e18);

        uint256 aliceStart = IErc20Min(base).balanceOf(alice);
        uint256 deadStart = IErc20Min(base).balanceOf(DEAD);
        uint256 bobStart = IErc20Min(base).balanceOf(bob);

        uint256 xfer = 777e18; // deliberately odd relative to bps
        vm.prank(alice);
        IErc20Min(base).transfer(bob, xfer);

        uint256 aliceDebit = aliceStart - IErc20Min(base).balanceOf(alice);
        uint256 bobGain = IErc20Min(base).balanceOf(bob) - bobStart;
        uint256 deadGain = IErc20Min(base).balanceOf(DEAD) - deadStart;

        assertEq(aliceDebit, xfer, "alice debited the exact amount she signed");
        assertEq(bobGain + deadGain, xfer, "no wei of dust: net + tax == amount");
    }

    // ------------------------------------------------------------------------
    // Post-launch destination change — launcher can flip among enum
    // values (SPEC #1). Cannot change tax rate (SPEC #2 — no setter).
    // ------------------------------------------------------------------------

    function test_SetTaxDestination_LauncherCanFlipAmongEnumValues() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BurnDead, 100, address(0));
        assertEq(uint8(Dn404TaxTemplate(payable(base)).taxMode()), uint8(Dn404TaxTemplate.TaxMode.BurnDead));

        // Launcher (Ownable owner) flips to BuybackURU.
        vm.prank(launcher);
        Dn404TaxTemplate(payable(base)).setTaxDestination(Dn404TaxTemplate.TaxMode.BuybackURU, address(0));
        assertEq(uint8(Dn404TaxTemplate(payable(base)).taxMode()), uint8(Dn404TaxTemplate.TaxMode.BuybackURU));

        // Verify subsequent transfers now accumulate instead of burning.
        address curve = dn404CurveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IErc20Min(base).transfer(alice, 1000e18);
        uint256 accBefore = Dn404TaxTemplate(payable(base)).accumulatedTax();
        vm.prank(alice);
        IErc20Min(base).transfer(bob, 100e18);
        assertGt(Dn404TaxTemplate(payable(base)).accumulatedTax(), accBefore, "accum grew after mode flip");
    }

    function test_SetTaxDestination_ToBuyAllowedTokenNeedsValidTarget() public {
        (address base,,) = _launch(Dn404TaxTemplate.TaxMode.BurnDead, 100, address(0));

        // Bad target reverts. setTaxDestination is a direct call (not
        // wrapped by a helper) so the expectRevert -> prank -> call
        // ordering is fine as written.
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404TaxTemplate.Dn404TaxTemplate__TaxTargetNotAllowed.selector,
                address(usdg)
            )
        );
        Dn404TaxTemplate(payable(base)).setTaxDestination(Dn404TaxTemplate.TaxMode.BuyAllowedToken, address(usdg));

        // Allowlisted target works.
        vm.prank(launcher);
        Dn404TaxTemplate(payable(base)).setTaxDestination(Dn404TaxTemplate.TaxMode.BuyAllowedToken, address(cost));
        assertEq(Dn404TaxTemplate(payable(base)).taxTarget(), address(cost));
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _launch(
        Dn404TaxTemplate.TaxMode mode,
        uint16 bps,
        address target
    ) internal returns (address base, address mirror, address curve) {
        Dn404LaunchFactory.LaunchParams memory p = _paramsFor(mode, bps, target);
        vm.prank(launcher);
        (base, mirror, curve) = factory.launch(p);
    }

    /// Split out so tests that want to pair vm.expectRevert with a
    /// direct factory.launch call (bypassing _launch's inner prank) can
    /// build the params without duplicating field boilerplate.
    function _paramsFor(
        Dn404TaxTemplate.TaxMode mode,
        uint16 bps,
        address target
    ) internal view returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "DestTestCoin"; p.ticker = "DTC";
        p.baseURI = "ipfs://cover/"; p.contractURI = "ipfs://contract";
        p.collectionSize = 800; p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0; p.buybackBurnBps = 0;
        p.pairCurrency = address(usdg);
        p.taxMode = uint8(mode);
        p.taxBps = bps;
        p.taxTarget = target;
        p.uruAmount = DN404_URU_FEE;
    }
}
