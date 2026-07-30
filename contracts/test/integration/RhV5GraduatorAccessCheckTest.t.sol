// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev Minimum surface of the V5 Graduator we need on-fork. Full ABI is not needed
///      — we only exercise the `execute` entrypoint + its `curveFactory()` immutable.
interface IGraduatorV5 {
    error Graduator__NotAuthorizedCurve(address caller, address expected);

    function curveFactory() external view returns (address);

    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable;
}

/// @dev Minimum surface of the live CurveFactory we need — createCurveWithConfigFor
///      to mint a curve clone (which registers `curveFor[token]`), plus the mapping
///      + `graduator()` slot readers so we can assert the wire is set to the V5 grad.
interface ICurveFactoryV5 {
    function graduator() external view returns (address);
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
    function createCurveWithConfigFor(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve);
}

interface IBondingCurve {
    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256);
    function graduated() external view returns (bool);
    function graduationTargetEth() external view returns (uint256);
    function graduator() external view returns (address);
    function ethReserve() external view returns (uint256);
    function tokenReserve() external view returns (uint256);
}

/// Minimal ERC20 with public mint — needed so this test contract can seed itself
/// with the curve supply, approve CurveFactory, and drive the WHOLE happy path
/// against the live V5 Graduator (rather than mocking the access-check target
/// away in a unit test).
contract MintableERC20 is ERC20 {
    string private _n;
    string private _s;

    constructor(
        string memory n_,
        string memory s_
    ) {
        _n = n_;
        _s = s_;
    }

    function name() public view override returns (string memory) {
        return _n;
    }

    function symbol() public view override returns (string memory) {
        return _s;
    }

    function mint(
        address to,
        uint256 amt
    ) external {
        _mint(to, amt);
    }
}

/// A stand-in attacker contract that impersonates a rogue graduator client and
/// tries to fire `execute()` on the V5 Graduator with a token it never owned.
/// Under the V5 fix the call must revert with `Graduator__NotAuthorizedCurve`
/// because `curveFactory.curveFor(dummyToken) == address(0) != attacker`.
contract Attacker {
    function tryExecute(
        address graduator,
        address token
    ) external payable {
        IGraduatorV5(graduator).execute{value: msg.value}(token, 1, 1, 0, 0, address(0));
    }
}

/// @title  RhV5GraduatorAccessCheckTest
/// @notice Forks Robinhood mainnet (chain 4663) and verifies the V5 Graduator's
///         `msg.sender == curveFactory.curveFor(token)` access-check both ways:
///
///           (1) NEGATIVE - a random attacker contract that is NOT registered
///               with the CurveFactory as the curve for its target token gets
///               rejected with `Graduator__NotAuthorizedCurve(attacker, 0x0)`.
///
///           (2) POSITIVE - a real BondingCurve clone produced by the LIVE
///               CurveFactory (via `createCurveWithConfigFor`) is accepted by
///               the V5 Graduator during its OWN graduation — the curve calls
///               `execute` from `_graduate()` after we drive it past the target.
contract RhV5GraduatorAccessCheckTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // ---- V5 (2026-07-26) ----
    address internal constant GRADUATOR_V5 = 0x0d63E9D1b8EA9b3620ba75F1D6DA69eFf4adbd02;
    address internal constant MULTI_HOOK_HOST_V5 = 0x1Bb4666b905D81aE0b70aC63Df76Eea096efA2C4;

    // ---- Unchanged (immutable wire targets across V4->V5) ----
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;

    // ---- V4 dead-but-still-onchain (for cross-check the wire has moved) ----
    address internal constant GRADUATOR_V4_OLD = 0xbf3DAdD9EE1538F7cd7de012f71cf8626829939b;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (GRADUATOR_V5.code.length == 0) vm.skip(true);
    }

    // ============================================================
    // Sanity: the live wire we assume is actually in place. If any
    // of these fail the two behavior tests below are meaningless.
    // ============================================================
    function test_V5_Wire_GraduatorImmutable_PointsAtCurveFactory() public view {
        assertEq(
            IGraduatorV5(GRADUATOR_V5).curveFactory(),
            CURVE_FACTORY,
            "V5 Graduator.curveFactory() must equal the live CurveFactory"
        );
    }

    function test_V5_Wire_CurveFactory_GraduatorRotated() public view {
        assertEq(
            ICurveFactoryV5(CURVE_FACTORY).graduator(),
            GRADUATOR_V5,
            "CurveFactory.graduator() must be rotated to the V5 Graduator"
        );
        assertTrue(
            ICurveFactoryV5(CURVE_FACTORY).graduator() != GRADUATOR_V4_OLD,
            "CurveFactory.graduator() still points at the dead V4 Graduator"
        );
    }

    // ============================================================
    // (1) Attacker path — call rejected
    // ============================================================
    function test_V5_AccessCheck_RejectsUnregisteredCaller() public {
        // Fresh token that CurveFactory has never seen — curveFor(token) = 0.
        MintableERC20 token = new MintableERC20("Dummy", "DUM");

        Attacker attacker = new Attacker();
        vm.deal(address(attacker), 1 ether);

        // Sanity that we really are testing the "unregistered curve" branch.
        assertEq(
            ICurveFactoryV5(CURVE_FACTORY).curveFor(address(token)),
            address(0),
            "precondition: CurveFactory must not know the dummy token"
        );

        vm.expectRevert(
            abi.encodeWithSelector(IGraduatorV5.Graduator__NotAuthorizedCurve.selector, address(attacker), address(0))
        );
        attacker.tryExecute{value: 1}(GRADUATOR_V5, address(token));
    }

    // Same class of check but with a NON-ZERO expected curve — a curve is
    // registered for the token, and a different contract (attacker) tries to
    // graduate it. Rejection must name the true curve as `expected`, not zero.
    function test_V5_AccessCheck_RejectsWrongCallerWhenCurveExists() public {
        (MintableERC20 token, address curve) = _mintAndRegisterCurve();

        Attacker attacker = new Attacker();
        vm.deal(address(attacker), 1 ether);

        vm.expectRevert(
            abi.encodeWithSelector(IGraduatorV5.Graduator__NotAuthorizedCurve.selector, address(attacker), curve)
        );
        attacker.tryExecute{value: 1}(GRADUATOR_V5, address(token));
    }

    // ============================================================
    // (2) Real curve path — end-to-end graduation through V5 Graduator
    // ============================================================
    function test_V5_AccessCheck_AcceptsRealCurveDuringGraduation() public {
        (MintableERC20 token, address curveAddr) = _mintAndRegisterCurve();
        IBondingCurve curve = IBondingCurve(payable(curveAddr));

        // Sanity: the curve was initialized with the V5 Graduator as its wire.
        // If CurveFactory.setGraduator hadn't been rotated, the curve would call
        // the old graduator instead and this test would silently pass without
        // actually exercising V5's access check.
        assertEq(curve.graduator(), GRADUATOR_V5, "curve wired to wrong graduator");

        uint256 target = curve.graduationTargetEth();
        assertGt(target, 0, "curve missing graduation target");

        // Buy enough ETH to blow past the target after the 1% fee.
        // headroom = 5% to cover fee + rounding; graduationTargetEth is bounded
        // (mainnet default 4 ETH), so this fits comfortably in a fork wallet.
        uint256 gross = (target * 110) / 100 + 1;

        address alice = makeAddr("alice");
        vm.deal(alice, gross + 1 ether);

        vm.prank(alice);
        curve.buy{value: gross}(0);

        // If the V5 access check REJECTED the real curve, `_graduate()` would
        // bubble up `Graduator__NotAuthorizedCurve` and the buy call above would
        // have reverted — we'd never reach here.
        assertTrue(curve.graduated(), "curve did not graduate via V5 Graduator");
        assertEq(curve.ethReserve(), 0, "graduation did not drain eth reserve");
        assertEq(curve.tokenReserve(), 0, "graduation did not drain token reserve");
    }

    // ============================================================
    // (2b) Isolated positive path — bypass CurveFactory wire, prank
    //      as the registered curve and hit newGraduator.execute directly.
    //      This confirms the ACCESS-CHECK GATE alone accepts a registered
    //      curve caller — independent of whether CurveFactory has been
    //      rotated to the V5 Graduator (which on RH mainnet, at the block
    //      this fork snapshots, it has NOT — see the wire test's failure).
    //      Success criterion: the call must not revert with
    //      `Graduator__NotAuthorizedCurve`; a revert from a downstream
    //      cause (pool init / already initialized) still proves the gate
    //      accepted the caller.
    // ============================================================
    function test_V5_AccessCheck_AcceptsRegisteredCurveWhenPranked() public {
        (MintableERC20 token, address curveAddr) = _mintAndRegisterCurve();

        // Fund the "curve" prank identity with ETH + tokens + approval so
        // Graduator.execute survives past the gate into safeTransferFrom.
        uint256 ethAmount = 1 ether;
        uint256 tokenAmount = 1_000_000e18;
        token.mint(curveAddr, tokenAmount);
        vm.deal(curveAddr, ethAmount);

        vm.startPrank(curveAddr);
        token.approve(GRADUATOR_V5, tokenAmount);

        // We deliberately do NOT assert non-revert of the whole call — the
        // downstream v4 pool init on RH mainnet's live PoolManager may
        // revert for reasons unrelated to the gate (e.g. hook config,
        // pool already existing at that key). Instead we prove the gate
        // is passed by asserting the exact NotAuthorizedCurve selector
        // does not appear in the returndata when it reverts.
        try IGraduatorV5(GRADUATOR_V5).execute{value: ethAmount}(
            address(token), ethAmount, tokenAmount, 0, 0, address(this)
        ) {
        // gate passed AND full graduation succeeded
        }
        catch (bytes memory reason) {
            bytes4 sel;
            assembly {
                sel := mload(add(reason, 32))
            }
            assertTrue(
                sel != IGraduatorV5.Graduator__NotAuthorizedCurve.selector, "V5 gate rejected registered curve caller"
            );
        }
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers
    function _mintAndRegisterCurve() internal returns (MintableERC20 token, address curve) {
        ICurveFactoryV5 factory = ICurveFactoryV5(CURVE_FACTORY);
        uint256 supply = factory.defaultCurveSupply();
        assertGt(supply, 0, "factory default supply must be non-zero");

        token = new MintableERC20("CurveToken", "CRV");
        token.mint(address(this), supply);
        token.approve(CURVE_FACTORY, supply);
        curve = factory.createCurveWithConfigFor(address(token), 0, 0, address(this));
        assertEq(factory.curveFor(address(token)), curve, "factory did not register curve");
    }
}
