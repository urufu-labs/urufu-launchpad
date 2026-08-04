// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice URU-A03 AC #3 — Property-based reachability fuzz for CurveFactory
///         defaults. The auditor wants proof that any tuple accepted by
///         `_validateCurveDefaults` / `_validateActualSupply` actually admits a
///         path to graduation, and that every tuple that would strand a curve
///         is rejected.
///
///         Uses plain `testFuzz_*` functions rather than stateful invariants
///         because we're checking creation-time predicates, not multi-tx state
///         drift. `bound()` keeps inputs in the realistic (100M..2B token,
///         0.1..1000 ETH) envelope that admins might actually configure.
contract FuzzMockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Fuzz";
    }

    function symbol() public pure override returns (string memory) {
        return "FZM";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// URU-A05: BondingCurve._init requires `graduator.code.length > 0`. No-op stub
/// with a `poolManager()` view for compatibility with the wider stack.
contract FuzzMockGraduator {
    function execute(
        address,
        uint256,
        uint256,
        uint32,
        uint16,
        address
    ) external payable {}

    function poolManager() external view returns (address) {
        return address(this);
    }
}

contract CurveReachabilityFuzzTest is Test {
    BondingCurve internal impl;
    CurveFactory internal factory;
    FuzzMockGraduator internal mockGrad;

    address internal owner = makeAddr("owner");
    address internal feeReceiver = makeAddr("feeReceiver");

    // Realistic admin-configurable envelope. Anything outside is not a real
    // production tuple; the fuzz would drown in trivial reverts and waste
    // shrink budget.
    uint256 internal constant MIN_SUPPLY = 100_000_000e18;
    uint256 internal constant MAX_SUPPLY = 2_000_000_000e18;
    uint256 internal constant MIN_VTOKEN = 100_000_000e18;
    uint256 internal constant MAX_VTOKEN = 2_000_000_000e18;
    uint256 internal constant MIN_VETH = 0.1 ether;
    uint256 internal constant MAX_VETH = 1000 ether;
    uint256 internal constant MIN_TARGET = 0.05 ether;
    uint256 internal constant MAX_TARGET = 500 ether;

    function setUp() public {
        impl = new BondingCurve();
        factory = new CurveFactory(owner, feeReceiver, address(impl));
        mockGrad = new FuzzMockGraduator();
        vm.prank(owner);
        factory.setGraduator(address(mockGrad));
    }

    // ------------------------------------------------------------
    // Fuzz #1 — setDefaults reachability contract
    // ------------------------------------------------------------
    /// For any (supply, vToken, vEth, target, fee) tuple in the realistic
    /// envelope: either `setDefaults` rejects the tuple, OR the tuple is
    /// mathematically reachable (target + safety margin < maxReachable).
    function testFuzz_SetDefaultsReachabilityInvariant(
        uint256 supply,
        uint256 vToken,
        uint256 vEth,
        uint256 target,
        uint16 feeBps
    ) public {
        supply = bound(supply, MIN_SUPPLY, MAX_SUPPLY);
        vToken = bound(vToken, MIN_VTOKEN, MAX_VTOKEN);
        vEth = bound(vEth, MIN_VETH, MAX_VETH);
        target = bound(target, MIN_TARGET, MAX_TARGET);
        // Only sample the legitimate-fee half of the space so the property we
        // actually care about (reachability) isn't drowned out by trivial
        // fee-cap reverts. Fee-cap enforcement is covered by unit tests.
        feeBps = uint16(bound(uint256(feeBps), 0, uint256(factory.MAX_TRADE_FEE_BPS())));

        uint16 marginBps = factory.graduationSafetyMarginBps();
        uint256 maxReachable = (supply * vEth) / vToken;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(marginBps))) / 10_000;
        bool shouldAccept = target < safeReachable && maxReachable > 0;

        vm.prank(owner);
        if (shouldAccept) {
            factory.setDefaults(supply, vToken, vEth, target, feeBps);
            // Post-condition: the stored tuple graduates by the same formula
            // the source uses.
            uint256 storedMax = (factory.defaultCurveSupply() * factory.defaultVirtualEthReserve())
                / factory.defaultVirtualTokenReserve();
            assertGt(storedMax, factory.defaultGraduationTargetEth(), "target unreachable post-accept");
        } else {
            // Any predicate rejection is acceptable — reachability is one
            // of several validation gates. The factory MUST NOT silently
            // store an unreachable tuple.
            vm.expectRevert();
            factory.setDefaults(supply, vToken, vEth, target, feeBps);
        }
    }

    // ------------------------------------------------------------
    // Fuzz #2 — setDefaultCurveSupply must revalidate the FULL tuple
    // ------------------------------------------------------------
    /// After seeding the factory with a known-good tuple, mutating supply via
    /// `setDefaultCurveSupply`:
    ///   - accepts values that keep the tuple reachable;
    ///   - reverts on values that push the tuple below the safety margin.
    /// URU-A03: this setter previously skipped `_validateCurveDefaults`; the
    /// fuzz proves the plug holds under random supply mutations.
    function testFuzz_SetDefaultCurveSupplyRevalidates(
        uint256 newSupply
    ) public {
        // Seed with reachable defaults: max = 800M * 10 / 800M = 10 ETH,
        // target 4 ETH, margin 5% -> safe reachable = 9.5 ETH > 4 ETH.
        vm.prank(owner);
        factory.setDefaults(800_000_000e18, 800_000_000e18, 10 ether, 4 ether, 100);

        newSupply = bound(newSupply, 0, 2_000_000_000e18);

        uint256 vToken = factory.defaultVirtualTokenReserve();
        uint256 vEth = factory.defaultVirtualEthReserve();
        uint256 target = factory.defaultGraduationTargetEth();
        uint16 marginBps = factory.graduationSafetyMarginBps();

        uint256 maxReachable = (newSupply * vEth) / vToken;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(marginBps))) / 10_000;
        bool reachable = newSupply != 0 && target < safeReachable;

        vm.prank(owner);
        if (reachable) {
            factory.setDefaultCurveSupply(newSupply);
            assertEq(factory.defaultCurveSupply(), newSupply, "supply not stored");
        } else {
            vm.expectRevert();
            factory.setDefaultCurveSupply(newSupply);
            assertTrue(factory.defaultCurveSupply() != newSupply, "unreachable supply persisted");
        }
    }

    // ------------------------------------------------------------
    // Fuzz #3 — _validateActualSupply under a WL-style reserve carve
    // ------------------------------------------------------------
    /// Reserve-backed modules can leave the factory holding less than the
    /// nominal `defaultCurveSupply`. `_createCurve` re-validates against the
    /// ACTUAL received balance. This fuzz seeds a reachable tuple, then
    /// simulates a curve creation with a carved supply and asserts the same
    /// reachability formula holds — a curve accepted MUST admit graduation
    /// against its true starting inventory.
    function testFuzz_ActualSupplyReachabilityInvariant(
        uint256 carveBps
    ) public {
        // Start with reachable defaults.
        vm.prank(owner);
        factory.setDefaults(800_000_000e18, 800_000_000e18, 10 ether, 4 ether, 100);

        // Carve between 0% (no reserve) and 50% (the on-chain cap). Anything
        // >50% is blocked by `CurveFactory__ModulesOverAllocated`, so
        // sampling above that would just measure the module-cap plug.
        carveBps = bound(carveBps, 0, 5000);
        uint256 nominal = factory.defaultCurveSupply();
        uint256 actualSupply = (nominal * (10_000 - carveBps)) / 10_000;
        if (actualSupply < nominal / 2) actualSupply = nominal / 2;

        uint256 vToken = factory.defaultVirtualTokenReserve();
        uint256 vEth = factory.defaultVirtualEthReserve();
        uint256 target = factory.defaultGraduationTargetEth();
        uint16 marginBps = factory.graduationSafetyMarginBps();
        uint256 maxReachable = (actualSupply * vEth) / vToken;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(marginBps))) / 10_000;
        bool reachable = target < safeReachable;

        FuzzMockToken tok = new FuzzMockToken();
        address launcher = makeAddr("carveLauncher");
        tok.mint(launcher, actualSupply);
        vm.prank(launcher);
        tok.approve(address(factory), type(uint256).max);

        vm.prank(launcher);
        if (reachable) {
            address curve = factory.createCurve(address(tok));
            assertTrue(curve != address(0), "reachable actualSupply rejected");
        } else {
            vm.expectRevert();
            factory.createCurve(address(tok));
        }
    }

    // ------------------------------------------------------------
    // Fuzz #4 — safety-margin monotonicity + bounds
    // ------------------------------------------------------------
    /// Tightening the safety margin can only shrink the accepted-tuple set,
    /// never grow it. The setter must reject margins outside (0, 5000) bps,
    /// AND revalidate the current defaults so a tightened margin never
    /// leaves a stale invalid tuple live.
    function testFuzz_SafetyMarginBoundsAndMonotonicity(
        uint16 newMarginBps
    ) public {
        // Seed a reachable tuple with room to tighten.
        // max = 10 ETH, current margin 500 bps -> safe = 9.5 ETH; target 4 ETH.
        vm.prank(owner);
        factory.setDefaults(800_000_000e18, 800_000_000e18, 10 ether, 4 ether, 100);

        uint16 oldMargin = factory.graduationSafetyMarginBps();
        uint256 vToken = factory.defaultVirtualTokenReserve();
        uint256 vEth = factory.defaultVirtualEthReserve();
        uint256 supply = factory.defaultCurveSupply();
        uint256 target = factory.defaultGraduationTargetEth();
        uint256 maxReachable = (supply * vEth) / vToken;

        vm.prank(owner);
        if (newMarginBps == 0 || newMarginBps >= 5000) {
            vm.expectRevert();
            factory.setGraduationSafetyMarginBps(newMarginBps);
            assertEq(factory.graduationSafetyMarginBps(), oldMargin, "margin drifted on rejected setter");
            return;
        }

        uint256 newSafe = (maxReachable * (10_000 - uint256(newMarginBps))) / 10_000;
        if (target < newSafe) {
            factory.setGraduationSafetyMarginBps(newMarginBps);
            assertEq(factory.graduationSafetyMarginBps(), newMarginBps, "margin not stored");
            // Monotonicity: the stored tuple is still reachable at the new margin.
            uint256 storedSafe =
                ((factory.defaultCurveSupply() * factory.defaultVirtualEthReserve())
                        / factory.defaultVirtualTokenReserve())
                    * (10_000 - uint256(factory.graduationSafetyMarginBps())) / 10_000;
            assertLt(factory.defaultGraduationTargetEth(), storedSafe, "post-tightening: target unreachable");
        } else {
            vm.expectRevert();
            factory.setGraduationSafetyMarginBps(newMarginBps);
            assertEq(factory.graduationSafetyMarginBps(), oldMargin, "margin drifted on invalidating tighten");
        }
    }

    // ------------------------------------------------------------
    // Fuzz #5 — boundary: an unreachable supply MUST revert
    // ------------------------------------------------------------
    /// Direct assertion of the AC boundary: any admin call that would move
    /// the tuple below the reachability threshold MUST revert. Fuzzes only
    /// over the KNOWN-BAD half of the supply space so 100% of iterations
    /// exercise the guard.
    function testFuzz_UnreachableSupplyAlwaysReverts(
        uint256 badSupply
    ) public {
        // Seed with tuple where max = 10 ETH, target = 8 ETH. Safe reachable
        // with 500 bps margin = 9.5 ETH. Room for target to be uncomfortably
        // close to max so shrinking supply immediately trips the guard.
        vm.prank(owner);
        factory.setDefaults(800_000_000e18, 800_000_000e18, 10 ether, 8 ether, 100);

        uint256 vToken = factory.defaultVirtualTokenReserve();
        uint256 vEth = factory.defaultVirtualEthReserve();
        uint256 target = factory.defaultGraduationTargetEth();
        uint16 marginBps = factory.graduationSafetyMarginBps();

        // Compute the largest supply that still leaves target >= safeReachable
        // (i.e., unreachable). Fuzz only under that ceiling.
        // safeReachable(supply) = supply * vEth * (10000 - margin) / (vToken * 10000)
        // Solve for supply such that safeReachable <= target:
        //   supply <= target * vToken * 10000 / (vEth * (10000 - margin))
        uint256 ceiling = (target * vToken * 10_000) / (vEth * (10_000 - uint256(marginBps)));
        // Include the boundary (target == safeReachable is rejected as ">=").
        badSupply = bound(badSupply, 1, ceiling + 1);

        vm.prank(owner);
        vm.expectRevert();
        factory.setDefaultCurveSupply(badSupply);
        assertEq(factory.defaultCurveSupply(), 800_000_000e18, "unreachable supply mutation slipped through");
    }
}
