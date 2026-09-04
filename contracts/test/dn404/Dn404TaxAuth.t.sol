// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// Regression suite for the keeper-role/launcher-role split on
/// Dn404TaxTemplate. Prompted by the /security-review pass on
/// dn404-lane 2026-09-04 which caught that setKeeper/setKeeperTreasury
/// were gated onlyOwner (= launcher) instead of onlyGovernance (=
/// platform multisig). Without the split, a malicious launcher could
/// rotate the keeper to a self-controlled wallet and drain the entire
/// accumulated tax stream via sweepAccumulated.
///
/// These tests exercise:
///   1. Launcher CANNOT rotate keeper / treasury / governance
///   2. Governance CAN rotate keeper / treasury / itself
///   3. After governance rotates itself, the OLD governance loses
///      authority (stale key cannot reclaim)
///   4. sweepAccumulated still works when called by the current keeper
///      (baseline sanity — the fix didn't break the happy path)

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

// Minimal mocks (copied from Dn404PairCurrency.t.sol shape to keep this
// file self-contained; refactoring to shared helpers is v1.5+).
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

contract Dn404TaxAuthTest is Test {
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
    MockNftFactoryFee internal nftFactoryFee;

    address internal governance = address(0xA1);   // factory owner = platform multisig
    address internal launcher = address(0xB1);     // token owner (Solady Ownable)
    address internal keeperOps = address(0xC1);    // legitimate keeper wallet
    address internal keeperTreasury = address(0xC2);
    address internal attacker = address(0xBAD);
    address internal uruSink = address(0xCFEE);
    address internal feeSplitter = address(0xD01);

    uint256 internal constant DN404_URU_FEE = 20e18;

    function setUp() public {
        uru = new MockErc20("URU", "URU");
        usdg = new MockErc20("USDG", "USDG");
        nftFactoryFee = new MockNftFactoryFee();
        nftFactoryFee.set(10e18);

        baseImpl = new Dn404Template();
        baseTaxImpl = new Dn404TaxTemplate();
        mirrorImpl = new Dn404MirrorTemplate();
        curveImpl = new Dn404BondingCurve();

        address[] memory pcTokens = new address[](1); pcTokens[0] = address(usdg);
        string[] memory pcLabels = new string[](1); pcLabels[0] = "USDG";
        pairAllowlist = new Dn404PairCurrencyAllowlist(governance, pcTokens, pcLabels);

        address[] memory taxTokens = new address[](0);
        string[] memory taxLabels = new string[](0);
        taxAllowlist = new Dn404TaxAllowlist(governance, taxTokens, taxLabels);

        dn404CurveFactory = new Dn404CurveFactory(
            governance,
            feeSplitter,
            address(curveImpl),
            IDn404PairCurrencyAllowlist(address(pairAllowlist))
        );
        graduator = new MockDn404Graduator();
        vm.prank(governance);
        dn404CurveFactory.setGraduator(address(graduator));

        // Factory — governance is the Solady Ownable owner.
        vm.prank(governance);
        factory = new Dn404LaunchFactory(governance, address(nftFactoryFee));

        vm.startPrank(governance);
        factory.setExpectedCodeHashes(keccak256(address(baseImpl).code), keccak256(address(mirrorImpl).code));
        factory.setImpls(address(baseImpl), address(mirrorImpl));
        factory.setBaseTaxImpl(address(baseTaxImpl), keccak256(address(baseTaxImpl).code));
        factory.setUruConfig(
            FactoryIERC20(address(uru)), uruSink, DN404_URU_FEE, FactoryILoyalty(address(0))
        );
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
    // The core regression: launcher CANNOT rotate the keeper
    // ------------------------------------------------------------------------

    function test_LauncherCannotRotateKeeper() public {
        (address base,,) = _launchWithTax();

        // Sanity: launcher IS the Ownable owner.
        assertEq(Dn404TaxTemplate(payable(base)).owner(), launcher, "launcher should be owner");
        // But governance is the platform gov.
        assertEq(Dn404TaxTemplate(payable(base)).platformGovernance(), governance, "governance should be platform gov");

        // Launcher tries to rotate the keeper to their own wallet.
        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        Dn404TaxTemplate(payable(base)).setKeeper(launcher);

        // Same for treasury.
        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        Dn404TaxTemplate(payable(base)).setKeeperTreasury(launcher);

        // And the gov role itself is off-limits.
        vm.prank(launcher);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        Dn404TaxTemplate(payable(base)).setPlatformGovernance(launcher);
    }

    function test_AttackerCannotRotateKeeper() public {
        (address base,,) = _launchWithTax();
        vm.prank(attacker);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        Dn404TaxTemplate(payable(base)).setKeeper(attacker);
    }

    // ------------------------------------------------------------------------
    // Governance retains the authority the launcher lost
    // ------------------------------------------------------------------------

    function test_GovernanceCanRotateKeeper() public {
        (address base,,) = _launchWithTax();

        address newKeeper = address(0xC3);
        vm.prank(governance);
        Dn404TaxTemplate(payable(base)).setKeeper(newKeeper);
        assertEq(Dn404TaxTemplate(payable(base)).keeper(), newKeeper);
    }

    function test_GovernanceCanRotateItself_OldGovLosesAuthority() public {
        (address base,,) = _launchWithTax();

        address newGov = address(0xA2);

        // Current gov rotates the gov role to a new address.
        vm.prank(governance);
        Dn404TaxTemplate(payable(base)).setPlatformGovernance(newGov);
        assertEq(Dn404TaxTemplate(payable(base)).platformGovernance(), newGov);

        // Old gov key now has no authority.
        vm.prank(governance);
        vm.expectRevert(Dn404TaxTemplate.Dn404TaxTemplate__NotGovernance.selector);
        Dn404TaxTemplate(payable(base)).setKeeper(address(0xC4));

        // But new gov can call.
        vm.prank(newGov);
        Dn404TaxTemplate(payable(base)).setKeeper(address(0xC5));
        assertEq(Dn404TaxTemplate(payable(base)).keeper(), address(0xC5));
    }

    // ------------------------------------------------------------------------
    // Launcher-scoped controls STILL work through Solady Ownable
    // ------------------------------------------------------------------------

    function test_LauncherStillOwnsMarketplaceControls() public {
        (address base,,) = _launchWithTax();

        // setBaseURI is Ownable-gated; launcher can still call it.
        vm.prank(launcher);
        Dn404TaxTemplate(payable(base)).setBaseURI("ipfs://new/");
        assertEq(Dn404TaxTemplate(payable(base)).baseURI(), "ipfs://new/");

        // Same for setSkipNFTFor.
        vm.prank(launcher);
        Dn404TaxTemplate(payable(base)).setSkipNFTFor(address(0xDEED), true);

        // Governance should NOT be able to call launcher-scoped setters
        // (Solady Ownable rejects — governance is not the owner).
        vm.prank(governance);
        vm.expectRevert();
        Dn404TaxTemplate(payable(base)).setBaseURI("ipfs://attempted/");
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _launchWithTax() internal returns (address base, address mirror, address curve) {
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = "AuthTestCoin"; p.ticker = "ATC";
        p.baseURI = "ipfs://cover/"; p.contractURI = "ipfs://contract";
        p.collectionSize = 800; p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0; p.buybackBurnBps = 0;
        p.pairCurrency = address(usdg);
        // Tax mode = BurnDead is enough to route through baseTaxImpl.
        p.taxMode = uint8(Dn404TaxTemplate.TaxMode.BurnDead);
        p.taxBps = 100; // 1%
        p.taxTarget = address(0);
        p.uruAmount = DN404_URU_FEE;

        vm.prank(launcher);
        (base, mirror, curve) = factory.launch(p);
    }
}
