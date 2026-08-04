// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";

/// @notice URU-A04 AC #4 — WL solvency + LP-bound stateful invariant.
///
///         Covers the four properties the auditor requires:
///           (1) `token.balanceOf(curve) >= wlHeldTotal` — the curve always
///               holds enough real tokens to pay outstanding WL claims.
///               (Literal AC spec `wlHeldTotal <= tokenReserve + wlHeldTotal`
///               is trivially true; the real solvency check is against the
///               actual token balance, which drops to `wlHeldTotal` after
///               the Graduator pulls its LP inventory.)
///           (2) `tokenReserve >= 1` at all pre-graduation states (URU-A04
///               no-clamp floor).
///           (3) If `graduated`, then the Graduator's `execute` was invoked
///               with non-zero `tokenOut` (mock records the call).
///           (4) `sum(wlHeldForUser) == wlHeldTotal` across all actors.
contract WlToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "WlSolvency";
    }

    function symbol() public pure override returns (string memory) {
        return "WLS";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// Records graduation-call metadata so invariant #3 can assert non-zero
/// token flow. Also mimics the real Graduator by pulling its approved
/// token allotment from the curve — this way the curve's post-graduation
/// balance actually equals `wlHeldTotal` (the only tokens left on-curve
/// are the WL-locked slice).
contract RecordingGraduator {
    uint256 public lastTokenOut;
    uint256 public lastEthOut;
    uint256 public lastCalledAt;
    address public lastToken;
    uint256 public callCount;

    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32,
        uint16,
        address
    ) external payable {
        lastToken = token;
        lastTokenOut = tokenAmount;
        lastEthOut = ethAmount;
        lastCalledAt = block.number;
        ++callCount;
        // Pull the LP inventory the way a real Graduator would.
        if (tokenAmount > 0) {
            IERC20(token).transferFrom(msg.sender, address(this), tokenAmount);
        }
    }

    // Allow the mock to receive whatever ETH the curve forwards.
    receive() external payable {}
}

/// Handler drives WL buy, public buy, sell, and claimWl. Every action is
/// bounded so it either succeeds legitimately or reverts inside a try/catch
/// (invariants must hold across reverts too).
contract WlSolvencyHandler is Test {
    BondingCurve public immutable curve;
    WlToken public immutable token;

    address[] public actors;
    // Mirror of `whitelisted[actor]` cached from setUp; proofs indexed the
    // same way so the handler can look up proof for any actor cheaply.
    mapping(address => bool) public isWhitelisted;
    mapping(address => bytes32[]) internal _proofs;

    uint64 public immutable fallbackTs;

    uint256 public wlBuyCount;
    uint256 public publicBuyCount;
    uint256 public sellCount;
    uint256 public claimCount;

    constructor(
        BondingCurve _curve,
        WlToken _token,
        address[] memory _actors,
        bool[] memory _wl,
        bytes32[][] memory _actorProofs,
        uint64 _fallbackTs
    ) {
        curve = _curve;
        token = _token;
        fallbackTs = _fallbackTs;
        for (uint256 i; i < _actors.length; ++i) {
            actors.push(_actors[i]);
            isWhitelisted[_actors[i]] = _wl[i];
            _proofs[_actors[i]] = _actorProofs[i];
            vm.deal(_actors[i], 100 ether);
        }
    }

    function proofOf(
        address a
    ) external view returns (bytes32[] memory) {
        return _proofs[a];
    }

    /// WL buy — WL window must be active, actor must be on the tree.
    function wlBuy(
        uint256 actorSeed,
        uint256 ethIn
    ) public {
        if (curve.graduated()) return;
        if (block.timestamp >= fallbackTs) return;
        address actor = actors[actorSeed % actors.length];
        if (!isWhitelisted[actor]) return;
        uint256 bal = actor.balance;
        if (bal < 0.001 ether) return;
        ethIn = bound(ethIn, 0.0001 ether, bal > 2 ether ? 2 ether : bal / 2);

        vm.prank(actor);
        try curve.buyWithProof{value: ethIn}(_proofs[actor], 0) {
            ++wlBuyCount;
        } catch {}
    }

    /// Public buy — WL window MUST be elapsed (BondingCurve reverts
    /// WlWindowActive otherwise). If we're still in the window, warp past it
    /// so this call has a chance to succeed. Warping is one-way: subsequent
    /// WL buys will fail — that's fine, `fail_on_revert = false` swallows
    /// them and the invariants still hold.
    function publicBuy(
        uint256 actorSeed,
        uint256 ethIn
    ) public {
        if (curve.graduated()) return;
        if (block.timestamp < fallbackTs) {
            vm.warp(fallbackTs + 1);
        }
        address actor = actors[actorSeed % actors.length];
        uint256 bal = actor.balance;
        if (bal < 0.001 ether) return;
        ethIn = bound(ethIn, 0.0001 ether, bal > 2 ether ? 2 ether : bal / 2);

        vm.prank(actor);
        try curve.buy{value: ethIn}(0) {
            ++publicBuyCount;
        } catch {}
    }

    /// Sell — only pre-graduation, only if the actor holds tokens.
    function sellSome(
        uint256 actorSeed,
        uint256 tokensIn
    ) public {
        if (curve.graduated()) return;
        address actor = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;
        tokensIn = bound(tokensIn, 1, bal);
        vm.prank(actor);
        token.approve(address(curve), tokensIn);
        vm.prank(actor);
        try curve.sell(tokensIn, 0) {
            ++sellCount;
        } catch {}
    }

    /// claimWl — only post-graduation, only if the actor has WL held.
    function claim(
        uint256 actorSeed
    ) public {
        if (!curve.graduated()) return;
        address actor = actors[actorSeed % actors.length];
        if (curve.wlHeldForUser(actor) == 0) return;
        vm.prank(actor);
        try curve.claimWl() {
            ++claimCount;
        } catch {}
    }
}

contract WlSolvencyInvariantTest is StdInvariant, Test {
    BondingCurve internal curve;
    WlToken internal token;
    RecordingGraduator internal graduator;
    WlSolvencyHandler internal handler;

    address internal feeReceiver = makeAddr("feeReceiver");
    address internal launcher = makeAddr("launcher");

    // 4 actors — alice, bob, dave whitelisted; carol not.
    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;

    // Small enough that the fuzz sequence can actually cross the graduation
    // target via a handful of WL / public buys, exercising the post-grad
    // claim path. Max reachable at these reserves is
    //   maxEth = 800M * 5 / 800M = 5 ETH
    // Safe reachable at default 500 bps margin = 4.75 ETH.
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;
    uint16 internal constant FEE_BPS = 100;

    // Generous WL slice + per-address cap so WL buys can accumulate enough
    // ETH to actually cross the graduation target during a fuzz run.
    uint256 internal constant RESERVED_TOKENS = 400_000_000e18;
    uint256 internal constant MAX_WL_PER_ADDR = 200_000_000e18;
    uint64 internal FALLBACK_TS;

    bytes32 internal wlRoot;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        dave = makeAddr("dave");

        token = new WlToken();
        curve = new BondingCurve();
        token.mint(address(curve), CURVE_SUPPLY);

        FALLBACK_TS = uint64(block.timestamp + 7 days);

        // 4-leaf Merkle tree of {alice, bob, dave, dummy}; carol is NOT in it.
        address dummy = address(0xdead);
        bytes32 lA = keccak256(abi.encodePacked(alice));
        bytes32 lB = keccak256(abi.encodePacked(bob));
        bytes32 lD = keccak256(abi.encodePacked(dave));
        bytes32 lDummy = keccak256(abi.encodePacked(dummy));
        bytes32 nAB = _hashPair(lA, lB);
        bytes32 nDX = _hashPair(lD, lDummy);
        wlRoot = _hashPair(nAB, nDX);

        bytes32[] memory aliceProof = new bytes32[](2);
        aliceProof[0] = lB;
        aliceProof[1] = nDX;
        bytes32[] memory bobProof = new bytes32[](2);
        bobProof[0] = lA;
        bobProof[1] = nDX;
        bytes32[] memory daveProof = new bytes32[](2);
        daveProof[0] = lDummy;
        daveProof[1] = nAB;
        bytes32[] memory emptyProof = new bytes32[](0);

        BondingCurve.WhitelistInit memory wl;
        wl.root = wlRoot;
        wl.reservedTokens = RESERVED_TOKENS;
        wl.maxWlPerAddress = MAX_WL_PER_ADDR;
        wl.fallbackTs = FALLBACK_TS;
        wl.sourceTokenAddress = address(0xbeef);
        wl.sourceChainId = 4663;
        wl.declaredHolderCount = 3;

        graduator = new RecordingGraduator();
        curve.initializeWithWhitelist(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            FEE_BPS,
            address(graduator),
            0,
            0,
            launcher,
            wl
        );

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = dave;
        bool[] memory whitelisted = new bool[](4);
        whitelisted[0] = true;
        whitelisted[1] = true;
        whitelisted[2] = false;
        whitelisted[3] = true;
        bytes32[][] memory proofs = new bytes32[][](4);
        proofs[0] = aliceProof;
        proofs[1] = bobProof;
        proofs[2] = emptyProof;
        proofs[3] = daveProof;

        handler = new WlSolvencyHandler(curve, token, actors, whitelisted, proofs, FALLBACK_TS);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = WlSolvencyHandler.wlBuy.selector;
        selectors[1] = WlSolvencyHandler.publicBuy.selector;
        selectors[2] = WlSolvencyHandler.sellSome.selector;
        selectors[3] = WlSolvencyHandler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _hashPair(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // ------------------------------------------------------------
    // Invariant #1 — WL claim solvency
    // ------------------------------------------------------------
    /// The curve MUST always hold at least `wlHeldTotal` real tokens so
    /// every outstanding `claimWl()` call is guaranteed to succeed. Before
    /// graduation this is trivially satisfied (all curveSupply is on-curve);
    /// after graduation the Graduator pulls `tokenReserve` and only the
    /// WL-locked slice remains, so the equality is tight.
    function invariant_WlClaimSolvency() public view {
        uint256 heldOnCurve = token.balanceOf(address(curve));
        assertGe(heldOnCurve, curve.wlHeldTotal(), "curve cannot satisfy outstanding WL claims");
        // Literal AC restatement (tautology) — kept so the property line
        // in the auditor spec has a matching assertion in the tests.
        assertLe(curve.wlHeldTotal(), curve.tokenReserve() + curve.wlHeldTotal(), "wlHeldTotal overflow");
    }

    // ------------------------------------------------------------
    // Invariant #2 — pre-graduation token reserve floor
    // ------------------------------------------------------------
    /// URU-A04: buys leave `tokenReserve >= 1` so `_graduate` always has
    /// non-zero LP inventory. After graduation, `tokenReserve` resets to 0
    /// (all LP consumed), so the assertion is guarded on `!graduated`.
    function invariant_TokenReserveFloor() public view {
        if (!curve.graduated()) {
            assertGe(curve.tokenReserve(), 1, "pre-grad tokenReserve dropped below floor");
        }
    }

    // ------------------------------------------------------------
    // Invariant #3 — graduation implies non-zero graduator call
    // ------------------------------------------------------------
    /// If the curve reached `graduated == true`, then the Graduator's
    /// `execute` MUST have been called with `tokenOut > 0`. This is the
    /// contract that prevented the pre-fix "graduate + strand LP" bug.
    function invariant_GraduationCallsGraduator() public view {
        if (curve.graduated()) {
            assertEq(graduator.callCount(), 1, "graduator not called exactly once at graduation");
            assertGt(graduator.lastTokenOut(), 0, "graduator called with zero tokenOut");
            assertEq(graduator.lastToken(), address(token), "graduator got wrong token address");
        }
    }

    // ------------------------------------------------------------
    // Invariant #4 — wlHeldForUser sums to wlHeldTotal
    // ------------------------------------------------------------
    /// Per-user WL held balances always sum to `wlHeldTotal`. This catches
    /// any accounting drift between individual buys, claims, and the
    /// aggregate tally that the Graduator uses to size its LP transfer.
    function invariant_WlPerUserSumsToTotal() public view {
        uint256 sum = curve.wlHeldForUser(alice) + curve.wlHeldForUser(bob) + curve.wlHeldForUser(carol)
            + curve.wlHeldForUser(dave);
        assertEq(sum, curve.wlHeldTotal(), "per-user WL held drifted from wlHeldTotal");
    }
}
