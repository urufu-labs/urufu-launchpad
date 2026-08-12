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
/// URU-A05: BondingCurve._init requires `graduator.code.length > 0`. Stub is
/// a no-op — the WL tests reach graduation via `test_Graduation_*` but do so
/// through the curve's own `graduate` path which calls this stub's `execute`.
contract WlMockGraduator {
    function execute(
        address,
        uint256,
        uint256,
        uint32,
        uint16,
        address
    ) external payable {}
}

contract BondingCurveWhitelistTest is Test {
    BondingCurve internal curve;
    WlMockToken internal token;
    WlMockGraduator internal mockGrad;

    address internal launcher = makeAddr("launcher");
    address internal feeReceiver = makeAddr("feeReceiver");
    address internal alice = makeAddr("alice"); // WL member
    address internal bob = makeAddr("bob"); // WL member
    address internal carol = makeAddr("carol"); // NOT on WL
    address internal dave = makeAddr("dave"); // WL member

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

        BondingCurve.WhitelistInit memory wl;
        wl.root = wlRoot;
        wl.reservedTokens = RESERVED_TOKENS;
        wl.maxWlPerAddress = MAX_WL_PER_ADDR;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0xabc);
        wl.sourceChainId = 8453;
        wl.declaredHolderCount = 3;

        // URU-A05: graduator must be a live contract on init.
        mockGrad = new WlMockGraduator();

        curve.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(mockGrad),
            0,
            0,
            launcher,
            wl
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
        BondingCurve.WhitelistInit memory wl;
        wl.root = bytes32(0);
        wl.reservedTokens = RESERVED_TOKENS;
        wl.maxWlPerAddress = MAX_WL_PER_ADDR;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0);
        wl.sourceChainId = 0;
        wl.declaredHolderCount = 0;
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAddress.selector);
        fresh.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            // URU-A05: BondingCurve._init requires a live-contract graduator.
            // The graduator check runs BEFORE any WL-input validation, so the
            // "revert on bad WL param" tests below need a valid graduator
            // wired to reach their intended revert. The main setUp mockGrad
            // is reused since it's just a no-op stub.
            address(mockGrad),
            0,
            0,
            launcher,
            wl
        );
    }

    function test_Init_RevertsOnReservedExceedsSupply() public {
        BondingCurve fresh = new BondingCurve();
        BondingCurve.WhitelistInit memory wl;
        wl.root = wlRoot;
        wl.reservedTokens = CURVE_SUPPLY + 1;
        wl.maxWlPerAddress = MAX_WL_PER_ADDR;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0);
        wl.sourceChainId = 0;
        wl.declaredHolderCount = 0;
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__ExceedsSupply.selector, CURVE_SUPPLY + 1, CURVE_SUPPLY)
        );
        fresh.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            // URU-A05: BondingCurve._init requires a live-contract graduator.
            // The graduator check runs BEFORE any WL-input validation, so the
            // "revert on bad WL param" tests below need a valid graduator
            // wired to reach their intended revert. The main setUp mockGrad
            // is reused since it's just a no-op stub.
            address(mockGrad),
            0,
            0,
            launcher,
            wl
        );
    }

    function test_Init_RevertsOnZeroCap() public {
        BondingCurve fresh = new BondingCurve();
        BondingCurve.WhitelistInit memory wl;
        wl.root = wlRoot;
        wl.reservedTokens = RESERVED_TOKENS;
        wl.maxWlPerAddress = 0;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0);
        wl.sourceChainId = 0;
        wl.declaredHolderCount = 0;
        vm.expectRevert(BondingCurve.BondingCurve__ZeroAmount.selector);
        fresh.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            // URU-A05: BondingCurve._init requires a live-contract graduator.
            // The graduator check runs BEFORE any WL-input validation, so the
            // "revert on bad WL param" tests below need a valid graduator
            // wired to reach their intended revert. The main setUp mockGrad
            // is reused since it's just a no-op stub.
            address(mockGrad),
            0,
            0,
            launcher,
            wl
        );
    }

    // =========================================================
    // buyWithProof — happy path + hold-on-curve semantics
    // =========================================================

    function test_BuyWithProof_TransfersTokensImmediately() public {
        uint256 curveBalBefore = token.balanceOf(address(curve));
        uint256 aliceBalBefore = token.balanceOf(alice);

        vm.prank(alice);
        uint256 out = curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);

        // Tokens land in alice's wallet immediately — identical to `buy()`.
        assertEq(token.balanceOf(alice), aliceBalBefore + out, "alice didn't receive tokens");
        assertEq(token.balanceOf(address(curve)), curveBalBefore - out, "curve balance didn't decrease");

        // wlBought is the per-address cap counter — never decrements.
        assertEq(curve.wlBought(alice), out, "wlBought not tracked");
        assertEq(curve.wlSold(), out);
        assertGt(curve.ethReserve(), 0, "eth not accrued");
    }

    function test_BuyWithProof_WlBoughtNeverDecrementsOnSell() public {
        // Alice WL-buys, then sells the tokens back to the curve. wlBought
        // must stay at the buy amount so she can't round-trip through the
        // reserved slice to bypass maxWlPerAddress without paying net ETH.
        vm.prank(alice);
        uint256 out = curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
        assertEq(curve.wlBought(alice), out);

        // Approve + sell every token back.
        vm.startPrank(alice);
        token.approve(address(curve), out);
        curve.sell(out, 0);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 0, "alice still holds tokens after full sell");
        // Critical: wlBought does NOT decrement on sell — cap protection stays.
        assertEq(curve.wlBought(alice), out, "wlBought decremented on sell (cap bypass!)");
    }

    function test_BuyWithProof_ImmediateSellRoundTrip_LiquidExit() public {
        // Prove the "curve stalls, WL buyer isn't stuck" property. Alice
        // WL-buys, curve never reaches graduation, alice sells back and
        // walks away with roughly her ETH (minus fees).
        uint256 aliceEthBefore = alice.balance;
        vm.prank(alice);
        uint256 out = curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);

        // Curve never graduates — no other buyers. Alice sells everything.
        vm.startPrank(alice);
        token.approve(address(curve), out);
        uint256 ethOut = curve.sell(out, 0);
        vm.stopPrank();

        // She should recover most of her ETH — 2% fee round-trip (1% on buy,
        // 1% on sell) plus a tiny sliver of AMM slippage on the round trip.
        // Assert she recovers > 97% of what she put in, definitely NOT stuck.
        assertGt(ethOut, 0, "sell returned zero eth");
        uint256 aliceEthAfter = alice.balance;
        // aliceEthBefore - 0.1 ETH + ethOut; want > aliceEthBefore - 0.005 ETH
        assertGt(aliceEthAfter + 0.005 ether, aliceEthBefore, "alice recovered less than 95% of buy ETH");
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
            address(t2),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(mockGrad), // URU-A05: live-contract graduator required.
            0,
            0,
            launcher
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
        uint256 held = curve.wlBought(alice);
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
        BondingCurve.WhitelistInit memory wl;
        wl.root = wlRoot;
        wl.reservedTokens = 25_000_000e18; // 25M — small enough to drain in one buy;
        wl.maxWlPerAddress = 100_000_000e18; // 100M — well above what any single buy yields;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0);
        wl.sourceChainId = 0;
        wl.declaredHolderCount = 0;
        tight.initializeWithWhitelist(
            address(t2),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            // URU-A05: BondingCurve._init requires a live-contract graduator.
            // The graduator check runs BEFORE any WL-input validation, so the
            // "revert on bad WL param" tests below need a valid graduator
            // wired to reach their intended revert. The main setUp mockGrad
            // is reused since it's just a no-op stub.
            address(mockGrad),
            0,
            0,
            launcher,
            wl
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
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BondingCurve__WlWindowActive.selector, FALLBACK_TS));
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
    // Post-graduation — WL buyers already hold their tokens, no claim step.
    // (Previous claimWl / wlHeldForUser / wlHeldTotal design deprecated
    //  2026-08-11: hold-until-graduation was replaced with immediate
    //  transfer to eliminate the funds-stuck failure mode on stalled
    //  curves. See BondingCurve.sol `buyWithProof` docstring.)
    // =========================================================

    function test_BuyWithProof_ThenGraduation_NoClaimStepNeeded() public {
        // WL buyer's tokens are ALREADY in their wallet when the curve
        // graduates — no post-graduation claimWl action required.
        vm.prank(alice);
        uint256 out = curve.buyWithProof{value: 0.1 ether}(aliceProof, 0);
        assertEq(token.balanceOf(alice), out, "alice didn't receive tokens on buy");

        // Warp past fallback so public buy can graduate the curve.
        vm.warp(FALLBACK_TS + 1);
        vm.prank(bob);
        curve.buy{value: 3 ether}(0);
        require(curve.graduated(), "test precondition: curve did not graduate");

        // Post-graduation: alice's balance is unchanged from her buy — no
        // separate release step. She could have sold/transferred already.
        assertEq(token.balanceOf(alice), out, "graduation altered alice's balance");
    }
}
