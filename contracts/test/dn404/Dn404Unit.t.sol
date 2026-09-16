// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// Unit test suite for the DN404 launch lane. Covers:
///   - Dn404Template   (base ERC-20 half)
///   - Dn404MirrorTemplate (mirror ERC-721 half)
///   - Dn404LaunchFactory  (one-tx factory)
///
/// Fork tests against the live CurveFactory + Graduator come in slice 6b.

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike as FactoryILoyalty,
    ICurveFactoryLike as FactoryICurveFactory
} from "src/dn404/Dn404LaunchFactory.sol";

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

/// Minimal ERC-20 for URU launch-fee tests. Standard transferFrom + approve.
contract MockErc20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// Loyalty oracle returning a configurable per-holder bps discount.
contract MockLoyaltyOracle {
    mapping(address => uint16) public bps;

    function set(address who, uint16 v) external {
        bps[who] = v;
    }

    function discountBpsFor(address holder) external view returns (uint16) {
        return bps[holder];
    }
}

/// Stand-in NftLaunchFactory exposing `minUruFee()` so the DN404 factory's
/// constructor can read + seed at 2x.
contract MockNftFactoryFee {
    uint256 public minUruFee;

    function set(uint256 v) external {
        minUruFee = v;
    }
}

/// Minimal curve stand-in. Just needs to hold the pulled DN404 supply so
/// balances line up during unit tests. Not a real bonding curve.
contract MockCurveImpl {
    address public token;
    address public launcher;
    uint256 public initialSupply;
    bool public initialized;

    function initialize(address token_, address launcher_, uint256 supply_) external {
        require(!initialized, "already");
        initialized = true;
        token = token_;
        launcher = launcher_;
        initialSupply = supply_;
    }
}

/// Stand-in CurveFactory that satisfies ICurveFactoryLike. Uses LibClone
/// with the same salt shape as real CurveFactory (`keccak256(abi.encode(
/// token, block.chainid))`) so predictCurveAddress + createCurveWithConfigFor
/// address-match exactly.
contract MockCurveFactory {
    address public immutable implementation;

    uint32 public lastAntiSniperBlocks;
    uint16 public lastBuybackBurnBps;
    address public lastLauncher;

    constructor() {
        implementation = address(new MockCurveImpl());
    }

    function predictCurveAddress(address token) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }

    function createCurveWithConfigFor(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);
        lastAntiSniperBlocks = antiSniperBlocks;
        lastBuybackBurnBps = buybackBurnBps;
        lastLauncher = launcher;

        uint256 supply = IERC20Min(token).balanceOf(msg.sender);
        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);
        MockCurveImpl(curve).initialize(token, launcher, supply);
    }
}

interface IERC20Min {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IDn404Mirror {
    function owner() external view returns (address);
    function balanceOf(address who) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function tokenURI(uint256 id) external view returns (string memory);
    function ownerOf(uint256 id) external view returns (address);
    function contractURI() external view returns (string memory);
    function baseERC20() external view returns (address);
}

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

contract Dn404UnitTest is Test {
    Dn404Template internal baseImpl;
    Dn404MirrorTemplate internal mirrorImpl;
    Dn404LaunchFactory internal factory;
    MockErc20 internal uru;
    MockLoyaltyOracle internal loyalty;
    MockCurveFactory internal curveFactory;
    MockNftFactoryFee internal nftFactoryFee;

    address internal owner = address(0xA1);
    address internal launcher = address(0xB1);
    address internal uruSink = address(0xCFEE);
    address internal feeSplitter = address(0xD01);

    uint256 internal constant NFT_URU_FEE = 10e18;
    uint256 internal constant DN404_URU_FEE = 20e18; // 2x

    function setUp() public {
        // Impls
        baseImpl = new Dn404Template();
        mirrorImpl = new Dn404MirrorTemplate();

        // Peripherals
        uru = new MockErc20("URU", "URU");
        loyalty = new MockLoyaltyOracle();
        curveFactory = new MockCurveFactory();
        nftFactoryFee = new MockNftFactoryFee();
        nftFactoryFee.set(NFT_URU_FEE);

        // Factory. Constructor reads nftFactoryFee.minUruFee() and stores 2x.
        vm.prank(owner);
        factory = new Dn404LaunchFactory(owner, address(nftFactoryFee));

        // Pin code hashes then bind impls (URU-A08 posture).
        bytes32 baseHash = keccak256(address(baseImpl).code);
        bytes32 mirrorHash = keccak256(address(mirrorImpl).code);
        vm.startPrank(owner);
        factory.setExpectedCodeHashes(baseHash, mirrorHash);
        factory.setImpls(address(baseImpl), address(mirrorImpl));
        factory.setUruConfig(
            FactoryIERC20(address(uru)),
            uruSink,
            DN404_URU_FEE,
            FactoryILoyalty(address(loyalty))
        );
        factory.setFeeSplitter(feeSplitter);
        factory.setCurveFactory(FactoryICurveFactory(address(curveFactory)));
        vm.stopPrank();

        // Launcher gets URU to pay the fee.
        uru.mint(launcher, 1_000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Factory constructor
    // -------------------------------------------------------------------------

    function test_Constructor_SeedsUruFeeAt2xNftFactory() public view {
        assertEq(factory.minUruFee(), DN404_URU_FEE, "seed should be 2x");
        assertEq(factory.nftFactory(), address(nftFactoryFee), "nft factory ref stored");
    }

    function test_Constructor_ZeroNftFactory_LeavesFeeUnset() public {
        vm.prank(owner);
        Dn404LaunchFactory f = new Dn404LaunchFactory(owner, address(0));
        assertEq(f.minUruFee(), 0, "no seed when nftFactory=0");
    }

    // -------------------------------------------------------------------------
    // Impl slot one-shotness
    // -------------------------------------------------------------------------

    function test_SetImpls_TwiceReverts() public {
        vm.prank(owner);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__AlreadySet.selector);
        factory.setImpls(address(baseImpl), address(mirrorImpl));
    }

    function test_SetImpls_WithWrongCodeHashReverts() public {
        // Fresh factory to reset one-shot state.
        Dn404LaunchFactory f = new Dn404LaunchFactory(owner, address(0));
        vm.startPrank(owner);
        f.setExpectedCodeHashes(bytes32(uint256(1)), bytes32(uint256(2))); // wrong hashes
        vm.expectRevert(); // Dn404LaunchFactory__CodeHashMismatch(...)
        f.setImpls(address(baseImpl), address(mirrorImpl));
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Launch happy path — end-to-end sanity
    // -------------------------------------------------------------------------

    function test_Launch_HappyPath() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.prank(launcher);
        (address base, address mirror, address curve) = factory.launch(p);

        // All three addresses populated + curve match prediction.
        assertTrue(base != address(0), "base zero");
        assertTrue(mirror != address(0), "mirror zero");
        assertTrue(curve != address(0), "curve zero");
        assertEq(curve, curveFactory.predictCurveAddress(base), "curve != predicted");

        // Base metadata
        Dn404Template baseC = Dn404Template(payable(base));
        assertEq(baseC.name(), p.name);
        assertEq(baseC.symbol(), p.ticker);
        assertEq(baseC.baseURI(), p.baseURI);
        assertEq(baseC.contractURI(), p.contractURI);
        assertEq(baseC.unit(), p.unit * 1e18, "unit stored as wei");
        assertEq(baseC.owner(), launcher, "owner = launcher");

        // Mirror wiring
        IDn404Mirror mirrorC = IDn404Mirror(mirror);
        assertEq(mirrorC.baseERC20(), base, "mirror linked to base");
        assertEq(mirrorC.owner(), launcher, "mirror owner pulled from base");
        assertEq(mirrorC.contractURI(), p.contractURI, "contractURI read-through");

        // Supply routing: no premint, so all supply lives on the curve.
        uint256 expectedSupply = p.collectionSize * p.unit * 1e18;
        assertEq(IERC20Min(base).totalSupply(), expectedSupply);
        assertEq(IERC20Min(base).balanceOf(curve), expectedSupply, "curve holds full supply");
        assertEq(IERC20Min(base).balanceOf(launcher), 0, "launcher has none");
        assertEq(IERC20Min(base).balanceOf(address(factory)), 0, "factory drained");

        // Curve holds ERC-20 supply but NO NFTs (skip-listed at init).
        assertEq(mirrorC.balanceOf(curve), 0, "curve should hold zero NFTs");

        // URU fee reached the sink.
        assertEq(uru.balanceOf(uruSink), DN404_URU_FEE, "URU fee to sink");
    }

    // -------------------------------------------------------------------------
    // Skip-list correctness — the load-bearing invariant
    // -------------------------------------------------------------------------

    function test_TransferToNonSkippedRecipient_MintsNFTs() public {
        (address base, address mirror,) = _launch();
        address alice = address(0xA11CE);

        // Small ERC-20 buy: 3 units → alice should own 3 NFTs after transfer.
        Dn404Template baseC = Dn404Template(payable(base));
        uint256 unitWei = baseC.unit();
        uint256 threeUnits = 3 * unitWei;

        // Simulate a curve sell: transfer from the curve (skip-listed) to alice.
        // Curve → alice: alice not skip-listed, so 3 NFTs mint to her.
        address curve = curveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IERC20Min(base).transfer(alice, threeUnits);

        assertEq(IERC20Min(base).balanceOf(alice), threeUnits);
        assertEq(IDn404Mirror(mirror).balanceOf(alice), 3, "alice should hold 3 NFTs");
    }

    function test_TransferToSkippedRecipient_NoNFTs() public {
        (address base, address mirror,) = _launch();

        // Simulate a normal user selling BACK to the curve (skip-listed).
        // Set up: give alice tokens first, then have her transfer to curve.
        address alice = address(0xA11CE);
        Dn404Template baseC = Dn404Template(payable(base));
        uint256 twoUnits = 2 * baseC.unit();
        address curve = curveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IERC20Min(base).transfer(alice, twoUnits);
        assertEq(IDn404Mirror(mirror).balanceOf(alice), 2);

        // Alice sells back to curve. Curve balance goes up but NO NFTs mint to it.
        uint256 curveNftBefore = IDn404Mirror(mirror).balanceOf(curve);
        vm.prank(alice);
        IERC20Min(base).transfer(curve, twoUnits);
        assertEq(IDn404Mirror(mirror).balanceOf(curve), curveNftBefore, "curve NFT balance unchanged");
        assertEq(IDn404Mirror(mirror).balanceOf(alice), 0, "alice NFTs burned");
    }

    function test_OwnerSetSkipNFTFor_PostLaunch() public {
        (address base, address mirror,) = _launch();
        address graduatedPool = address(0xB007);

        // Before: graduatedPool not skipped. A transfer would mint NFTs to it.
        Dn404Template baseC = Dn404Template(payable(base));
        uint256 oneUnit = baseC.unit();
        address curve = curveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IERC20Min(base).transfer(graduatedPool, oneUnit);
        assertEq(IDn404Mirror(mirror).balanceOf(graduatedPool), 1, "before skip: NFT mints");

        // Launcher skip-lists the pool. Subsequent transfers no longer mint.
        vm.prank(launcher);
        baseC.setSkipNFTFor(graduatedPool, true);

        vm.prank(curve);
        IERC20Min(base).transfer(graduatedPool, oneUnit);
        // NFT count doesn't grow (still 1 from before). Confirms skip took effect.
        assertEq(IDn404Mirror(mirror).balanceOf(graduatedPool), 1, "after skip: no additional mints");
    }

    function test_NonOwnerSetSkipNFTFor_Reverts() public {
        (address base,,) = _launch();
        vm.expectRevert();
        vm.prank(address(0xBAD));
        Dn404Template(payable(base)).setSkipNFTFor(address(0xB007), true);
    }

    // -------------------------------------------------------------------------
    // Founder pre-mint
    // -------------------------------------------------------------------------

    function test_Launch_FounderPremint_TransfersToLauncherAndMintsNFTs() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.founderPremintBps = 1000; // 10%
        vm.prank(launcher);
        (address base, address mirror,) = factory.launch(p);

        uint256 totalSupply = p.collectionSize * p.unit * 1e18;
        uint256 expectedFounderWei = totalSupply / 10;
        uint256 expectedFounderNfts = p.collectionSize / 10;

        assertEq(IERC20Min(base).balanceOf(launcher), expectedFounderWei, "launcher got 10%");
        assertEq(IDn404Mirror(mirror).balanceOf(launcher), expectedFounderNfts, "launcher got NFTs");
    }

    function test_Launch_FounderPremintOverCap_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.founderPremintBps = 2001; // just over 20%
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404LaunchFactory.Dn404LaunchFactory__FounderPremintBpsTooHigh.selector, 2001, 2000
            )
        );
        factory.launch(p);
    }

    function test_Launch_FounderPremintNftCountOverCap_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        // 2000 collection × 20% = 400 NFTs > MAX_PREMINT_NFT_COUNT (100)
        p.collectionSize = 2000;
        p.founderPremintBps = 2000;
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404LaunchFactory.Dn404LaunchFactory__FounderPremintNftCountExceedsCap.selector, 400, 100
            )
        );
        factory.launch(p);
    }

    // -------------------------------------------------------------------------
    // URU fee guard
    // -------------------------------------------------------------------------

    function test_Launch_InsufficientUru_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.uruAmount = DN404_URU_FEE - 1;
        vm.prank(launcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                Dn404LaunchFactory.Dn404LaunchFactory__InsufficientUru.selector, DN404_URU_FEE, DN404_URU_FEE - 1
            )
        );
        factory.launch(p);
    }

    function test_Launch_LoyaltyDiscount_HalvesRequiredFee() public {
        loyalty.set(launcher, 5000); // 50% discount
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.uruAmount = DN404_URU_FEE / 2;
        vm.prank(launcher);
        factory.launch(p);
        assertEq(uru.balanceOf(uruSink), DN404_URU_FEE / 2, "discounted fee to sink");
    }

    // -------------------------------------------------------------------------
    // Sanity gates
    // -------------------------------------------------------------------------

    function test_Launch_NameEmpty_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.name = "";
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__NameEmpty.selector);
        factory.launch(p);
    }

    function test_Launch_TickerEmpty_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.ticker = "";
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__TickerEmpty.selector);
        factory.launch(p);
    }

    function test_Launch_CollectionSizeZero_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.collectionSize = 0;
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__CollectionSizeZero.selector);
        factory.launch(p);
    }

    function test_Launch_UnitZero_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.unit = 0;
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__UnitZero.selector);
        factory.launch(p);
    }

    function test_Launch_TotalSupplyOverflow_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        // Pushes totalSupplyWei past uint96.max
        p.unit = 10_000_000_000; // 1e10 whole tokens
        p.collectionSize = 100_000_000; // 1e8 collection
        // totalSupplyWei = 1e10 * 1e8 * 1e18 = 1e36 >> 2^96 - 1 (~7.9e28)
        vm.prank(launcher);
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__TotalSupplyOverflow.selector);
        factory.launch(p);
    }

    function test_Launch_NameCollisionForSameLauncher_Reverts() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.startPrank(launcher);
        factory.launch(p);
        // Second launch with same (launcher, name, ticker) reuses the salt.
        vm.expectRevert(Dn404LaunchFactory.Dn404LaunchFactory__NameTaken.selector);
        factory.launch(p);
        vm.stopPrank();
    }

    function test_Launch_SameNameDifferentLauncher_OK() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.prank(launcher);
        factory.launch(p);

        // Different launcher, same name — new salt, should succeed.
        address launcher2 = address(0xB2);
        uru.mint(launcher2, 1_000e18);
        vm.prank(launcher2);
        uru.approve(address(factory), type(uint256).max);
        vm.prank(launcher2);
        factory.launch(p);
    }

    // -------------------------------------------------------------------------
    // Template init: not directly callable, but confirm re-init reverts
    // -------------------------------------------------------------------------

    function test_Template_ReinitReverts() public {
        (address base,,) = _launch();
        bytes memory data = abi.encode(
            launcher, address(0xdead), address(0xdead), address(0),
            "x", "x", "", "", uint256(1e18), uint256(1e18)
        );
        vm.expectRevert(Dn404Template.Dn404Template__AlreadyInitialized.selector);
        Dn404Template(payable(base)).initialize(data);
    }

    // -------------------------------------------------------------------------
    // Metadata: tokenURI shape
    // -------------------------------------------------------------------------

    function test_TokenURI_HasJsonSuffix() public {
        (address base, address mirror,) = _launch();

        // Trigger a mint to alice so token id 1 exists.
        address alice = address(0xA11CE);
        // Read unit() BEFORE the prank — vm.prank applies to the NEXT
        // external call only, and inlining unit() into the transfer
        // argument would consume the prank on the staticcall.
        uint256 unitWei = Dn404Template(payable(base)).unit();
        address curve = curveFactory.predictCurveAddress(base);
        vm.prank(curve);
        IERC20Min(base).transfer(alice, unitWei);

        assertEq(IDn404Mirror(mirror).tokenURI(1), "ipfs://cover/1.json");
    }

    function test_OwnerSetBaseURI() public {
        (address base,,) = _launch();
        vm.prank(launcher);
        Dn404Template(payable(base)).setBaseURI("ipfs://new/");
        assertEq(Dn404Template(payable(base)).baseURI(), "ipfs://new/");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _defaultParams() internal pure returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "TestCoin";
        p.ticker = "TC";
        p.baseURI = "ipfs://cover/";
        p.contractURI = "ipfs://contract";
        p.collectionSize = 100;
        p.unit = 1_000_000; // 1M tokens per NFT
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.uruAmount = DN404_URU_FEE;
    }

    function _launch() internal returns (address base, address mirror, address curve) {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.prank(launcher);
        (base, mirror, curve) = factory.launch(p);
    }
}
