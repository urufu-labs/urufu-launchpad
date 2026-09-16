// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// Pair-currency unit tests. Complements Dn404Unit.t.sol (which covers
/// the ETH-only path). Wires up the full parallel DN404 curve stack
/// (Dn404PairCurrencyAllowlist + Dn404BondingCurve impl + Dn404CurveFactory
/// + a mock Dn404Graduator) and asserts:
///   - Launch with an allowlisted pair currency routes through the
///     Dn404 stack (curve at Dn404CurveFactory.predictCurveAddress)
///   - Buyer pays the pair currency to buy the DN404 base token and
///     receives auto-minted NFTs at whole-unit thresholds
///   - Un-allowlisted pair currency reverts inside Dn404CurveFactory
///   - LaunchParams.pairCurrency != 0 with dn404CurveFactory unset
///     reverts at the launch factory level
///
/// Graduation-side tests (v4 pool creation, currency0/1 sort, refund
/// ledger) live in the fork suite because they need live PoolManager.

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike as FactoryILoyalty,
    ICurveFactoryLike as FactoryICurveFactory,
    IDn404CurveFactoryLike as FactoryIDn404CurveFactory
} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404CurveFactory, IDn404PairCurrencyAllowlist} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";

// -----------------------------------------------------------------------------
// Mocks — kept minimal, only what these tests exercise
// -----------------------------------------------------------------------------

contract MockErc20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    constructor(string memory n, string memory s) { name = n; symbol = s; }
    function mint(address to, uint256 amount) external {
        totalSupply += amount; balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount); return true;
    }
}

contract MockNftFactoryFee {
    uint256 public minUruFee;
    function set(uint256 v) external { minUruFee = v; }
}

/// Stand-in graduator. Just needs to have code (URU-A05 requires code
/// length > 0) and satisfy the interface enough that buy/sell paths
/// work. Never actually reached in these tests — we don't push a curve
/// to graduation, we only exercise pre-graduation buys.
contract MockDn404Graduator {
    function execute(
        address, address, uint256, uint256, uint32, uint16, address
    ) external {
        // no-op
    }
}

interface IErc20Min {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IDn404MirrorView {
    function balanceOf(address who) external view returns (uint256);
    function baseERC20() external view returns (address);
}

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

contract Dn404PairCurrencyTest is Test {
    Dn404Template internal baseImpl;
    Dn404MirrorTemplate internal mirrorImpl;
    Dn404LaunchFactory internal factory;
    Dn404BondingCurve internal curveImpl;
    Dn404CurveFactory internal dn404CurveFactory;
    Dn404PairCurrencyAllowlist internal allowlist;
    MockDn404Graduator internal graduator;

    MockErc20 internal uru;
    MockErc20 internal usdg;
    MockErc20 internal unallowlisted;
    MockNftFactoryFee internal nftFactoryFee;

    address internal owner = address(0xA1);
    address internal launcher = address(0xB1);
    address internal buyer = address(0xB2);
    address internal uruSink = address(0xCFEE);
    address internal feeSplitter = address(0xD01);

    uint256 internal constant NFT_URU_FEE = 10e18;
    uint256 internal constant DN404_URU_FEE = 20e18;

    function setUp() public {
        // Peripherals
        uru = new MockErc20("URU", "URU");
        usdg = new MockErc20("USDG", "USDG");
        unallowlisted = new MockErc20("SCAM", "SCAM");
        nftFactoryFee = new MockNftFactoryFee();
        nftFactoryFee.set(NFT_URU_FEE);

        // Template impls
        baseImpl = new Dn404Template();
        mirrorImpl = new Dn404MirrorTemplate();

        // DN404 curve stack
        curveImpl = new Dn404BondingCurve();
        address[] memory seedTokens = new address[](1);
        seedTokens[0] = address(usdg);
        string[] memory seedLabels = new string[](1);
        seedLabels[0] = "USDG";
        allowlist = new Dn404PairCurrencyAllowlist(owner, seedTokens, seedLabels);

        dn404CurveFactory = new Dn404CurveFactory(
            owner,
            feeSplitter,
            address(curveImpl),
            IDn404PairCurrencyAllowlist(address(allowlist))
        );
        graduator = new MockDn404Graduator();
        vm.prank(owner);
        dn404CurveFactory.setGraduator(address(graduator));

        // Launch factory
        vm.prank(owner);
        factory = new Dn404LaunchFactory(owner, address(nftFactoryFee));

        bytes32 baseHash = keccak256(address(baseImpl).code);
        bytes32 mirrorHash = keccak256(address(mirrorImpl).code);
        vm.startPrank(owner);
        factory.setExpectedCodeHashes(baseHash, mirrorHash);
        factory.setImpls(address(baseImpl), address(mirrorImpl));
        factory.setUruConfig(
            FactoryIERC20(address(uru)),
            uruSink,
            DN404_URU_FEE,
            FactoryILoyalty(address(0))
        );
        factory.setFeeSplitter(feeSplitter);
        // Only wire Dn404CurveFactory here — leaving V10 curveFactory
        // unset means ETH-path launches would revert CurveFactoryNotSet,
        // which is fine because these tests exclusively exercise the
        // non-ETH path. Existing Dn404Unit.t.sol covers the ETH path.
        factory.setDn404CurveFactory(FactoryIDn404CurveFactory(address(dn404CurveFactory)));
        // Whitelist launch factory as trusted router on Dn404CurveFactory
        dn404CurveFactory.setTrustedRouter(address(factory), true);
        vm.stopPrank();

        // Fund the launcher (URU for launch fee) and buyer (USDG for buys).
        uru.mint(launcher, 1_000e18);
        usdg.mint(buyer, 10_000_000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
        vm.prank(buyer);
        usdg.approve(address(0), 0); // no-op; per-curve approve happens after launch
    }

    // ------------------------------------------------------------------------
    // Routing
    // ------------------------------------------------------------------------

    function test_Launch_WithUsdgPair_RoutesToDn404Curve() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = address(usdg);

        vm.prank(launcher);
        (address base, address mirror, address curve) = factory.launch(p);

        // Curve deployed at Dn404CurveFactory's predicted address.
        assertEq(curve, dn404CurveFactory.predictCurveAddress(base), "curve != dn404-predicted");
        assertTrue(base != address(0), "base zero");
        assertTrue(mirror != address(0), "mirror zero");

        // Curve's pairCurrency() view returns USDG.
        assertEq(Dn404BondingCurve(curve).pairCurrency(), address(usdg), "curve pair != USDG");

        // Curve holds the full DN404 supply and 0 NFTs (skip-listed at init).
        uint256 expectedSupply = p.collectionSize * p.unit * 1e18;
        assertEq(IErc20Min(base).balanceOf(curve), expectedSupply);
        assertEq(IDn404MirrorView(mirror).balanceOf(curve), 0);
    }

    // ------------------------------------------------------------------------
    // Buyer pays USDG for the DN404 base token
    // ------------------------------------------------------------------------

    function test_Buy_WithUsdgPair_PaysUsdgReceivesTokenAndNfts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = address(usdg);
        vm.prank(launcher);
        (address base, address mirror, address curve) = factory.launch(p);

        // Buyer approves USDG to the curve (per-curve approval).
        uint256 spendUsdg = 100e18; // 100 USDG buy
        vm.prank(buyer);
        usdg.approve(curve, spendUsdg);

        uint256 buyerUsdgBefore = usdg.balanceOf(buyer);
        uint256 buyerTokenBefore = IErc20Min(base).balanceOf(buyer);

        vm.prank(buyer);
        uint256 tokensOut = Dn404BondingCurve(curve).buy(spendUsdg, 0);

        // Buyer's USDG went down by the full spend.
        assertEq(usdg.balanceOf(buyer), buyerUsdgBefore - spendUsdg, "USDG not debited");
        // Buyer received the DN404 base tokens.
        assertEq(IErc20Min(base).balanceOf(buyer) - buyerTokenBefore, tokensOut, "tokensOut mismatch");
        assertGt(tokensOut, 0, "tokensOut zero");

        // NFTs auto-mint when balance crosses whole-unit thresholds. With
        // unit = 1M whole tokens (1e24 wei), a 100 USDG buy at the default
        // curve pricing may or may not cross the threshold — we assert the
        // invariant `nftBalance == tokenBalance / unit` (rounded down)
        // without pinning a specific count.
        uint256 buyerBase = IErc20Min(base).balanceOf(buyer);
        uint256 buyerNfts = IDn404MirrorView(mirror).balanceOf(buyer);
        uint256 expectedNfts = buyerBase / (p.unit * 1e18);
        assertEq(buyerNfts, expectedNfts, "NFT balance != tokenBalance / unit");
    }

    // ------------------------------------------------------------------------
    // Un-allowlisted pair currency reverts
    // ------------------------------------------------------------------------

    function test_Launch_WithUnallowlistedPair_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = address(unallowlisted);
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404CurveFactory.Dn404CurveFactory__PairCurrencyDisallowed.selector,
                address(unallowlisted)
            )
        );
        factory.launch(p);
    }

    // ------------------------------------------------------------------------
    // Pair currency set but Dn404CurveFactory not wired -> revert
    // ------------------------------------------------------------------------

    function test_Launch_PairSetButDn404CurveFactoryUnset_Reverts() public {
        // Spin up a fresh launch factory without Dn404CurveFactory wired.
        vm.prank(owner);
        Dn404LaunchFactory freshFactory = new Dn404LaunchFactory(owner, address(nftFactoryFee));
        bytes32 baseHash = keccak256(address(baseImpl).code);
        bytes32 mirrorHash = keccak256(address(mirrorImpl).code);
        vm.startPrank(owner);
        freshFactory.setExpectedCodeHashes(baseHash, mirrorHash);
        freshFactory.setImpls(address(baseImpl), address(mirrorImpl));
        freshFactory.setUruConfig(
            FactoryIERC20(address(uru)),
            uruSink,
            DN404_URU_FEE,
            FactoryILoyalty(address(0))
        );
        // Do NOT call setDn404CurveFactory
        vm.stopPrank();

        // Launcher needs URU approved for the fresh factory.
        vm.prank(launcher);
        uru.approve(address(freshFactory), type(uint256).max);

        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = address(usdg);
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__Dn404CurveFactoryNotSet.selector);
        freshFactory.launch(p);
    }

    // ------------------------------------------------------------------------
    // Allowlist mutability — governance can add tokens post-deploy
    // ------------------------------------------------------------------------

    function test_Allowlist_OwnerCanAddPostDeploy_LaunchWorksAfter() public {
        // "unallowlisted" ERC-20 initially rejected.
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = address(unallowlisted);
        vm.prank(launcher);
        vm.expectRevert();
        factory.launch(p);

        // Governance adds it.
        vm.prank(owner);
        allowlist.setAllowed(address(unallowlisted), true, "SCAM");
        assertTrue(allowlist.isAllowed(address(unallowlisted)));

        // Same launcher, same params, retry — now succeeds.
        vm.prank(launcher);
        (, , address curve) = factory.launch(p);
        assertEq(Dn404BondingCurve(curve).pairCurrency(), address(unallowlisted));
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _defaultParams() internal pure returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "PairTestCoin";
        p.ticker = "PTC";
        p.baseURI = "ipfs://pair/";
        p.contractURI = "ipfs://pair-contract";
        // Sized to match Dn404CurveFactory's defaultCurveSupply (800M).
        // Reachability check `defaultGraduationTargetPair < safeReachable`
        // where safeReachable = actualSupply * virtualPair / virtualToken
        // * 0.95 needs actualSupply to be at least defaultCurveSupply,
        // otherwise the 3.125e21 vs 4e21 imbalance trips the guard.
        // 800 x 1M = 800M tokens matches exactly.
        p.collectionSize = 800;
        p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.pairCurrency = address(0); // overridden per test
        p.uruAmount = DN404_URU_FEE;
    }
}
