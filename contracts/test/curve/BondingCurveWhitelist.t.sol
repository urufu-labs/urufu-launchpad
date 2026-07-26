// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";

contract WlMockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Whitelist Test";
    }

    function symbol() public pure override returns (string memory) {
        return "WLT";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Unit tests for the whitelist additions to BondingCurve — reserved-slice
///         accounting, proof verification, per-address cap, fallback timeout, hold-
///         until-graduation semantics, and the graduation flow with WL tokens
///         staying on-curve until claim.
///
///         Pricing math is unchanged from base BondingCurve so we intentionally don't
///         re-verify curve arithmetic here — see BondingCurve.t.sol for that.
contract BondingCurveWhitelistTest is Test {
    BondingCurve internal curve;
    WlMockToken internal token;

    address internal launcher = makeAddr("launcher");
    address internal feeReceiver = makeAddr("feeReceiver");
    address internal alice = makeAddr("alice");    // WL member
    address internal bob = makeAddr("bob");        // WL member
    address internal carol = makeAddr("carol");    // NOT on WL
    address internal dave = makeAddr("dave");      // WL member

    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;
    /// Deliberately picked so WL slice is 30% (240M tokens) and per-address cap is 40M —
    /// leaves room in the tests to exercise cap-hit + slice-exhaustion behaviors.
    uint256 internal constant RESERVED_TOKENS = 240_000_000e18;
    uint256 internal constant MAX_WL_PER_ADDR = 40_000_000e18;
    uint64 internal FALLBACK_TS;

    bytes32 internal wlRoot;
    bytes32[] internal aliceProof;
    bytes32[] internal bobProof;
    bytes32[] internal daveProof;
    bytes32[] internal carolProofFake; // matches the tree layout but with wrong leaf

    function setUp() public {
        token = new WlMockToken();
        curve = new BondingCurve();
        token.mint(address(curve), CURVE_SUPPLY);

        FALLBACK_TS = uint64(block.timestamp + 7 days);

        // Build a 4-leaf Merkle tree (alice, bob, dave, dummy) using sorted-pair hashing.
        // dummy is a made-up address to round out the tree to a power of 2. Carol is
        // intentionally NOT in the tree — she'll be used for the "reject non-member" test.
        address dummy = address(0xdead);
        bytes32 lA = keccak256(abi.encodePacked(alice));
        bytes32 lB = keccak256(abi.encodePacked(bob));
        bytes32 lD = keccak256(abi.encodePacked(dave));
        bytes32 lDummy = keccak256(abi.encodePacked(dummy));

        bytes32 nAB = _hashPair(lA, lB);
        bytes32 nDX = _hashPair(lD, lDummy);
        wlRoot = _hashPair(nAB, nDX);

        aliceProof = new bytes32[](2);
        aliceProof[0] = lB;
        aliceProof[1] = nDX;

        bobProof = new bytes32[](2);
        bobProof[0] = lA;
        bobProof[1] = nDX;

        daveProof = new bytes32[](2);
        daveProof[0] = lDummy;
        daveProof[1] = nAB;

        // Carol tries alice's proof — leaf mismatch, verification should fail.
        carolProofFake = aliceProof;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: RESERVED_TOKENS,
            maxWlPerAddress: MAX_WL_PER_ADDR,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0xabc),
            sourceChainId: 8453,
            declaredHolderCount: 3
        });

        curve.initializeWithWhitelist(
            address(token), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher, wl
        );

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(dave, 100 ether);
    }

    /// Sorted-pair hash — matches OpenZeppelin / Solady MerkleProof convention.
    function _hashPair(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // =========================================================
    // Init
    // =========================================================

    function test_Init_WhitelistStored() public view {
        assertEq(curve.whitelistRoot(), wlRoot);
        assertEq(curve.reservedTokens(), RESERVED_TOKENS);
        assertEq(curve.maxWlPerAddress(), MAX_WL_PER_ADDR);
        assertEq(curve.fallbackTs(), FALLBACK_TS);
        assertEq(curve.sourceTokenAddress(), address(0xabc));
        assertEq(curve.sourceChainId(), 8453);
        assertEq(curve.declaredHolderCount(), 3);
    }

    function test_Init_RevertsOnZeroRoot() public {
        BondingCurve fresh = new BondingCurve();
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: bytes32(0),
            reservedTokens: RESERVED_TOKENS,
            maxWlPerAddress: MAX_WL_PER_ADDR,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAddress.selector);
        fresh.initializeWithWhitelist(
            address(token), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher, wl
        );
    }

    function test_Init_RevertsOnReservedExceedsSupply() public {
        BondingCurve fresh = new BondingCurve();
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: CURVE_SUPPLY + 1,
            maxWlPerAddress: MAX_WL_PER_ADDR,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__ExceedsSupply.selector, CURVE_SUPPLY + 1, CURVE_SUPPLY)
        );
        fresh.initializeWithWhitelist(
            address(token), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher, wl
        );
    }

    function test_Init_RevertsOnZeroCap() public {
        BondingCurve fresh = new BondingCurve();
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: RESERVED_TOKENS,
            maxWlPerAddress: 0,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        fresh.initializeWithWhitelist(
            address(token), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher, wl
        );
    }

    // =========================================================
    // buyWithProof — happy path + hold-on-curve semantics
    // =========================================================

    function test_BuyWithProof_HoldsTokensOnCurve() public {
        uint256 curveBalBefore = token.balanceOf(address(curve));
        uint256 aliceBalBefore = token.balanceOf(alice);

        vm.prank(alice);
        uint256 out = curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);

        // Tokens NEVER left the curve — this is the lock.
        assertEq(token.balanceOf(alice), aliceBalBefore, "alice got tokens directly");
        assertEq(token.balanceOf(address(curve)), curveBalBefore, "curve token balance changed");

        // Curve accounting reflects the buy.
        assertEq(curve.wlHeldForUser(alice), out, "wlHeldForUser not tracked");
        assertEq(curve.wlSold(), out);
        assertEq(curve.wlHeldTotal(), out);
        assertGt(curve.ethReserve(), 0, "eth not accrued");
    }

    function test_BuyWithProof_RevertsOnInvalidProof() public {
        vm.expectRevert(BondingCurve.BondingCurve__WlProofInvalid.selector);
        vm.prank(carol);
        curve.buyWithProof{value: 0.1 ether}(carolProofFake, 0);
    }

    function test_BuyWithProof_RevertsWhenNoWhitelist() public {
        BondingCurve plain = new BondingCurve();
        WlMockToken t2 = new WlMockToken();
        t2.mint(address(plain), CURVE_SUPPLY);
        plain.initialize(
            address(t2), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher
        );
        vm.expectRevert(BondingCurve.BondingCurve__WlNotActive.selector);
        vm.prank(alice);
        plain.buyWithProof{value: 0.1 ether}(aliceProof, 0);
    }

    function test_BuyWithProof_RevertsPostFallback() public {
        vm.warp(FALLBACK_TS + 1);
        vm.expectRevert(BondingCurve.BondingCurve__WlNotActive.selector);
        vm.prank(alice);
        curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
    }

    function test_BuyWithProof_RevertsOnPerAddressCap() public {
        // First buy: small enough to stay under the 40M cap.
        vm.prank(alice);
        curve.buyWithProof{value: 0.05 ether}(aliceProof, 0);
        uint256 held = curve.wlHeldForUser(alice);
        require(held > 0 && held < MAX_WL_PER_ADDR, "test setup: first buy overshot cap");

        // Second buy is large enough to push tokensOut past the remaining cap. The
        // reserved-slice gate passes (240M cap, only ~15M consumed) so the per-address
        // cap check is the one that fires.
        vm.expectRevert(); // BondingCurve__WlPerAddressCapHit — exact args depend on pricing
        vm.prank(alice);
        curve.buyWithProof{value: 1 ether}(aliceProof, 0);
    }

    function test_BuyWithProof_RevertsOnReservedExhausted() public {
        // Fresh curve with a TINY reserved slice so a single buy exhausts it, and a big
        // enough per-address cap that the cap check doesn't fire first.
        BondingCurve tight = new BondingCurve();
        WlMockToken t2 = new WlMockToken();
        t2.mint(address(tight), CURVE_SUPPLY);
        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 25_000_000e18,      // 25M — small enough to drain in one buy
            maxWlPerAddress: 100_000_000e18,    // 100M — well above what any single buy yields
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
        tight.initializeWithWhitelist(
            address(t2), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100,
            address(0), 0, 0, launcher, wl
        );

        // Alice buys a small amount that fits under the 25M reserved (design reverts on
        // overshoot — no clamping). ~3M tokens for 0.01 ETH.
        vm.prank(alice);
        tight.buyWithProof{value: 0.01 ether}(aliceProof, 0);
        assertLt(tight.wlSold(), 25_000_000e18, "first buy already exhausted slice");

        // Any WL buy that would push wlSold past reservedTokens reverts. 1 ETH → ~100M
        // tokens requested → way over the ~22M remaining → WlReservedExhausted fires
        // before the per-address cap check.
        vm.expectRevert(); // BondingCurve__WlReservedExhausted
        vm.prank(bob);
        tight.buyWithProof{value: 1 ether}(bobProof, 0);
    }

    // =========================================================
    // Public `buy` respects the reserved slice
    // =========================================================

    function test_Buy_RevertsDuringWlWindow() public {
        // Time-gated design: with a whitelist configured, public `buy()` reverts with
        // WlWindowActive during the entire pre-fallback window — regardless of size.
        // Even a tiny buy from a non-WL wallet is blocked while the window is open.
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__WlWindowActive.selector, FALLBACK_TS)
        );
        vm.prank(carol);
        curve.buy{value: 0.01 ether}(0);
    }

    function test_Buy_PostFallback_OpensToPublic() public {
        vm.warp(FALLBACK_TS + 1);
        // Post-fallback: WL window closed, public `buy()` unlocked. Draws from the
        // full remaining tokenReserve (any WL slice they didn't consume merges in).
        vm.prank(carol);
        uint256 out = curve.buy{value: 0.5 ether}(0);
        assertGt(out, 0);
        assertEq(curve.publicSold(), out);
    }

    // =========================================================
    // claimWl — post-graduation withdrawal
    // =========================================================

    function test_ClaimWl_RevertsPreGraduation() public {
        vm.prank(alice);
        curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
        vm.expectRevert(BondingCurve.BondingCurve__NotGraduated.selector);
        vm.prank(alice);
        curve.claimWl();
    }

    function test_ClaimWl_TransfersHeldPostGraduation() public {
        vm.prank(alice);
        curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
        uint256 held = curve.wlHeldForUser(alice);

        // Warp past fallback so public buy can graduate the curve without WL blocking.
        vm.warp(FALLBACK_TS + 1);
        vm.prank(bob);
        curve.buy{value: 3 ether}(0);
        require(curve.graduated(), "test precondition: curve did not graduate");

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = curve.claimWl();
        assertEq(claimed, held);
        assertEq(token.balanceOf(alice) - aliceBefore, held, "claim didn't transfer");
        assertEq(curve.wlHeldForUser(alice), 0);
    }

    function test_ClaimWl_RevertsOnDoubleClaim() public {
        vm.prank(alice);
        curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
        vm.warp(FALLBACK_TS + 1);
        vm.prank(bob);
        curve.buy{value: 3 ether}(0);

        vm.prank(alice);
        curve.claimWl();
        vm.expectRevert(BondingCurve.BondingCurve__WlNothingToClaim.selector);
        vm.prank(alice);
        curve.claimWl();
    }
}
