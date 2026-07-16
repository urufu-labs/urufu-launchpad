// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice The critical invariant test for reserve-backed modules on bonding curves.
///         Proves total supply stays fixed at exactly the initial mint amount across
///         the whole launch → trade → reserve-payout lifecycle. If this test ever
///         starts failing, dilution has snuck back in and curve buyers are being
///         quietly diluted post-launch.
///
///         The scenario models a realistic launch: 800M curve default, launcher
///         reserves 100M for team vesting, curve gets 700M. Bob buys ~half the
///         curve, beneficiary releases all vested, total supply stays 800M through
///         every step, and no participant can extract more than their fair share.
contract CurveReserveIntegrationTest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC20Template internal bareImpl;
    ERC20WithVestingGen internal vestingImpl;
    ERC20WithAirdropGen internal airdropImpl;

    BondingCurve internal curveImpl;
    CurveFactory internal cf;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal beneficiary = makeAddr("beneficiary");
    address internal buyer = makeAddr("buyer");

    uint256 internal constant BASE_FEE = 0.05 ether;
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VESTING_ALLOCATION = 100_000_000e18;
    uint256 internal constant AIRDROP_ALLOCATION = 50_000_000e18;

    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));
    bytes32 internal VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal AIRDROP = keccak256(abi.encode("ERC20", "Airdrop"));

    function setUp() public {
        string[] memory reserved = new string[](1);
        reserved[0] = "ETH";
        registry = new NameRegistry(admin, treasury, reserved);
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );

        f20 = new ERC20Factory(admin, address(router), registrar);
        bareImpl = new ERC20Template();
        vestingImpl = new ERC20WithVestingGen();
        airdropImpl = new ERC20WithAirdropGen();

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(f20));
        vm.stopPrank();

        vm.prank(registrar);
        f20.registerImpl(BARE_ERC20, address(bareImpl));
        vm.prank(registrar);
        f20.registerImpl(VESTING, address(vestingImpl));
        vm.prank(registrar);
        f20.registerImpl(AIRDROP, address(airdropImpl));

        // Wire the curve factory. Uses CURVE_SUPPLY as the default; virtual reserves
        // sized so a modest ETH pool trips graduation before the curve token pool
        // runs dry — matches the mainnet config shape.
        curveImpl = new BondingCurve();
        cf = new CurveFactory(admin, address(feeReceiver), address(curveImpl));
        vm.startPrank(admin);
        router.setCurveFactory(address(cf));
        registry.setRouter(address(router));
        cf.setDefaults(CURVE_SUPPLY, 800_000_000e18, 5 ether, 2 ether, 100);
        vm.stopPrank();

        vm.deal(launcher, 5 ether);
        vm.deal(buyer, 100 ether);
    }

    function _launchWithVesting() internal returns (address token, address curve) {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(beneficiary, VESTING_ALLOCATION, uint64(block.timestamp + 1 days), uint64(block.timestamp + 365 days));
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "VestingCurve",
            ticker: "VC",
            configHash: VESTING,
            initData: abi.encode(CURVE_SUPPLY, address(router), m),
            moduleCount: 2,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        uint256 fee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
        curve = cf.curveFor(token);
    }

    // ============================================================================
    // Invariant: total supply == CURVE_SUPPLY, forever, no matter what happens
    // ============================================================================

    /// After launch, the curve holds (CURVE_SUPPLY - VESTING_ALLOCATION) and the
    /// token contract holds VESTING_ALLOCATION as the vesting reserve. Total supply
    /// stays exactly CURVE_SUPPLY — no dilution.
    function test_Launch_CurveGetsPostAllocationBalance() public {
        (address token, address curve) = _launchWithVesting();
        IERC20 t = IERC20(token);

        assertEq(t.totalSupply(), CURVE_SUPPLY, "supply is exactly initialSupply");
        assertEq(t.balanceOf(curve), CURVE_SUPPLY - VESTING_ALLOCATION, "curve holds supply minus reserve");
        assertEq(t.balanceOf(token), VESTING_ALLOCATION, "token holds the vesting reserve");
        assertEq(t.balanceOf(launcher), 0, "launcher held nothing after Router forwarded to curve");
        // The bonding curve was initialized with the ACTUAL curve balance, not the
        // hardcoded default. This is what makes reserve-backed modules coexist with
        // bonding curves without breaking the fixed-supply invariant.
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.curveSupply(), CURVE_SUPPLY - VESTING_ALLOCATION, "curveSupply matches actual balance");
    }

    /// Curve buys move tokens from the curve to the buyer. Reserve on the token
    /// contract is untouched. Total supply stays at CURVE_SUPPLY.
    function test_Buy_DoesNotTouchReserveOrChangeSupply() public {
        (address token, address curve) = _launchWithVesting();
        IERC20 t = IERC20(token);

        uint256 supplyBefore = t.totalSupply();
        uint256 curveBefore = t.balanceOf(curve);
        uint256 reserveBefore = t.balanceOf(token);

        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: 1 ether}(0);

        // Supply invariant.
        assertEq(t.totalSupply(), supplyBefore, "supply must not change on a curve buy");
        // Curve lost some tokens to buyer, reserve untouched.
        assertLt(t.balanceOf(curve), curveBefore, "curve lost tokens on buy");
        assertEq(t.balanceOf(token), reserveBefore, "reserve untouched by curve buy");
        assertGt(t.balanceOf(buyer), 0, "buyer received tokens");
    }

    /// The beneficiary releases their vested share. Tokens move from the reserve
    /// (address(this) = token) to the beneficiary. Total supply stays at CURVE_SUPPLY.
    /// Curve tokens are untouched — vesting cannot drain the curve.
    function test_Release_MovesFromReserveNotFromCurve() public {
        (address token, address curve) = _launchWithVesting();
        IERC20 t = IERC20(token);
        ERC20WithVestingGen v = ERC20WithVestingGen(token);

        // Fast-forward to full vest.
        vm.warp(block.timestamp + 365 days + 1);

        uint256 supplyBefore = t.totalSupply();
        uint256 curveBefore = t.balanceOf(curve);
        uint256 reserveBefore = t.balanceOf(token);

        v.vestingRelease();

        assertEq(t.totalSupply(), supplyBefore, "supply must not grow on vesting release");
        assertEq(t.balanceOf(curve), curveBefore, "curve balance untouched by release");
        assertEq(t.balanceOf(token), reserveBefore - VESTING_ALLOCATION, "reserve fully drained by release");
        assertEq(t.balanceOf(beneficiary), VESTING_ALLOCATION, "beneficiary got everything");
    }

    /// Full lifecycle: launch → curve buy → vesting release → verify supply is
    /// STILL exactly CURVE_SUPPLY. This is the money invariant.
    function test_FullLifecycle_SupplyInvariantHolds() public {
        (address token, address curve) = _launchWithVesting();
        IERC20 t = IERC20(token);

        // Multiple curve buys + partial vesting releases interleaved.
        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: 0.5 ether}(0);

        vm.warp(block.timestamp + 180 days); // partial vest
        ERC20WithVestingGen(token).vestingRelease();

        vm.prank(buyer);
        BondingCurve(payable(curve)).buy{value: 0.5 ether}(0);

        // Jump past the end timestamp so `vestingReleasable()` returns the FULL
        // remaining allocation. 400 days after start puts us safely past the 365-day
        // end. Anything less can leave a few % unvested and the reserve non-empty.
        vm.warp(block.timestamp + 400 days);
        ERC20WithVestingGen(token).vestingRelease();

        assertEq(t.totalSupply(), CURVE_SUPPLY, "total supply must NEVER grow past initial mint");
        // Every token accounted for:
        //   curve   → tokens still on the curve
        //   buyer   → tokens bought off the curve
        //   token   → reserve (should be 0 after full release)
        //   beneficiary → all VESTING_ALLOCATION
        uint256 accounted =
            t.balanceOf(curve) + t.balanceOf(buyer) + t.balanceOf(token) + t.balanceOf(beneficiary);
        assertEq(accounted, CURVE_SUPPLY, "every wei accounted for");
        assertEq(t.balanceOf(token), 0, "reserve empty after full vest");
    }

    // ============================================================================
    // Safety: launcher can't over-allocate
    // ============================================================================

    /// A launcher who tries to reserve MORE than the curve supply reverts loudly.
    /// This is safety-by-construction — no way to launch a token whose modules
    /// starve the curve of tokens or make the curve go zero-supply.
    function test_Launch_RevertsWhenAllocationExceedsSupply() public {
        bytes[] memory m = new bytes[](1);
        // Try to reserve MORE than the entire supply.
        m[0] = abi.encode(beneficiary, CURVE_SUPPLY + 1, uint64(block.timestamp + 1 days), uint64(block.timestamp + 365 days));
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Bad",
            ticker: "BAD",
            configHash: VESTING,
            initData: abi.encode(CURVE_SUPPLY, address(router), m),
            moduleCount: 2,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        uint256 fee = router.quote(p);
        vm.prank(launcher);
        vm.expectRevert(); // solady _transfer underflow revert bubbles up through router
        router.launch{value: fee}(p);
    }
}
