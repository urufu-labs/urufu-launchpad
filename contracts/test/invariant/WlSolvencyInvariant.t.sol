// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";

/// @notice Whitelist invariants after the immediate-transfer redesign
///         (2026-08-11). Previous incarnation covered the hold-until-graduation
///         solvency property (`token.balanceOf(curve) >= wlHeldTotal`), which
///         no longer applies: WL buyers receive tokens directly in their
///         wallets, so the curve holds nothing on their behalf and there is
///         no funds-stuck failure mode on stalled curves.
///
///         Properties still worth pinning under fuzz:
///           (1) Post-graduation curve token balance == 0 (nothing held back).
///           (2) Pre-graduation `tokenReserve >= 1` (URU-A04 no-clamp floor).
///           (3) Graduation implies `execute(tokenOut > 0)` was called on the
///               graduator exactly once (defense against the pre-fix
///               "graduate + strand LP" state).
///           (4) `wlBought[user]` is monotonic — never decrements — so a WL
///               buyer cannot round-trip through the reserved slice to bypass
///               `maxWlPerAddress`.
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
/// token flow. Pulls the LP inventory the way a real Graduator would, so
/// the curve's post-graduation balance drops to zero (matching invariant #1).
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
        if (tokenAmount > 0) {
            IERC20(token).transferFrom(msg.sender, address(this), tokenAmount);
        }
    }

    receive() external payable {}
}

/// Handler drives WL buy, public buy, and sell. Every action is bounded
/// so it either succeeds legitimately or reverts inside a try/catch —
/// invariants must hold across reverts too.
contract WlSolvencyHandler is Test {
    BondingCurve public immutable curve;
    WlToken public immutable token;

    address[] public actors;
    mapping(address => bool) public isWhitelisted;
    mapping(address => bytes32[]) internal _proofs;

    uint64 public immutable fallbackTs;

    uint256 public wlBuyCount;
    uint256 public publicBuyCount;
    uint256 public sellCount;
    // Tracks max wlBought[actor] we've ever seen for the monotonicity check.
    mapping(address => uint256) public maxSeenWlBought;

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

    function _snapshotWlBought() internal {
        for (uint256 i; i < actors.length; ++i) {
            uint256 cur = curve.wlBought(actors[i]);
            if (cur > maxSeenWlBought[actors[i]]) {
                maxSeenWlBought[actors[i]] = cur;
            }
        }
    }

    function actorAt(
        uint256 i
    ) external view returns (address) {
        return actors[i];
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

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
            _snapshotWlBought();
        } catch {}
    }

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
}

contract WlSolvencyInvariantTest is StdInvariant, Test {
    BondingCurve internal curve;
    WlToken internal token;
    RecordingGraduator internal graduator;
    WlSolvencyHandler internal handler;

    address internal feeReceiver = makeAddr("feeReceiver");
    address internal launcher = makeAddr("launcher");

    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;

    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;
    uint16 internal constant FEE_BPS = 100;

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
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = WlSolvencyHandler.wlBuy.selector;
        selectors[1] = WlSolvencyHandler.publicBuy.selector;
        selectors[2] = WlSolvencyHandler.sellSome.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _hashPair(
        bytes32 a,
        bytes32 b
    ) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // ------------------------------------------------------------
    // Invariant #1 — post-graduation the curve holds no tokens
    // ------------------------------------------------------------
    /// Immediate-transfer design: WL buyers already have their tokens in
    /// wallet, so the curve hands the entire remaining tokenReserve to the
    /// Graduator at graduation and the curve's post-grad balance is zero.
    function invariant_PostGradCurveHoldsNothing() public view {
        if (curve.graduated()) {
            assertEq(token.balanceOf(address(curve)), 0, "curve should hold no tokens post-graduation");
        }
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
    function invariant_GraduationCallsGraduator() public view {
        if (curve.graduated()) {
            assertEq(graduator.callCount(), 1, "graduator not called exactly once at graduation");
            assertGt(graduator.lastTokenOut(), 0, "graduator called with zero tokenOut");
            assertEq(graduator.lastToken(), address(token), "graduator got wrong token address");
        }
    }

    // ------------------------------------------------------------
    // Invariant #4 — wlBought is monotonic per address
    // ------------------------------------------------------------
    /// Critical for the immediate-transfer design: `wlBought[user]` MUST
    /// never decrement, otherwise a WL wallet could round-trip through the
    /// reserved slice (buy → sell → buy again) to bypass `maxWlPerAddress`
    /// without paying net ETH. The handler snapshots `wlBought` after each
    /// successful wlBuy; this invariant checks the current value never
    /// dropped below that snapshot for any actor.
    function invariant_WlBoughtMonotonic() public view {
        uint256 n = handler.actorsLength();
        for (uint256 i; i < n; ++i) {
            address a = handler.actorAt(i);
            assertGe(curve.wlBought(a), handler.maxSeenWlBought(a), "wlBought decremented for an actor");
        }
    }
}
