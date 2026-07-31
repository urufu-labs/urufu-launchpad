// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";

import {LocalV4Stack, StackToken} from "test/helpers/LocalV4Stack.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

/// @title  RouterV2EntrypointsTest
/// @notice Covers the three launch entrypoints that `RouterV2` adds on top of
///         the inherited `Router.launch()` — `launchWithURU`,
///         `launchWithWhitelist`, and `launchWithURUAndWhitelist` — each driven
///         through to graduation on a locally deployed Uniswap v4 PoolManager.
///
///         These are the paths the live Robinhood stack (RouterV6, a RouterV2
///         deployment) actually exposes for URU-paid and whitelist launches.
contract RouterV2EntrypointsTest is LocalV4Stack {
    using StateLibrary for IPoolManager;

    RouterV2 internal routerV2;
    NameRegistry internal registryV2;
    ERC20Factory internal factoryV2;
    StackToken internal uru;
    UruDepositSink internal uruSink;

    address internal launcher = makeAddr("v2-launcher");
    address internal buyer = makeAddr("v2-buyer");
    address internal wlAlice = makeAddr("wl-alice");
    address internal wlBob = makeAddr("wl-bob");

    uint256 internal constant MIN_URU_FEE = 100e18;

    function setUp() public {
        _deployStack();

        uru = new StackToken("URU", "URU");
        uruSink = new UruDepositSink(admin, address(uru), address(feeReceiver), 2 days);

        // RouterV2 needs its own NameRegistry — `setRouter` is one-shot and the
        // base stack already bound its registry to the V1 Router.
        registryV2 = new NameRegistry(admin, admin, new string[](0));
        routerV2 = new RouterV2(
            admin,
            registryV2,
            IFeeReceiver(address(feeReceiver)),
            0.05 ether,
            0.05 ether,
            0.05 ether,
            0.01 ether,
            0.01 ether,
            0.01 ether,
            address(uru),
            uruSink
        );

        vm.prank(admin);
        registryV2.setRouter(address(routerV2));

        ERC20Template implV2 = new ERC20Template();
        factoryV2 = new ERC20Factory(admin, address(routerV2), admin);

        vm.startPrank(admin);
        factoryV2.registerImpl(CH_BARE, address(implV2));
        routerV2.setFactory(BaseType.ERC20, address(factoryV2));
        routerV2.setModuleCountForConfig(CH_BARE, 1);
        routerV2.setFlagsForConfig(CH_BARE, 0);
        routerV2.setCurveFactory(address(curveFactory));
        routerV2.setMinUruFee(MIN_URU_FEE);
        vm.stopPrank();

        vm.prank(admin);
        curveFactory.setTrustedRouter(address(routerV2), true);

        vm.deal(launcher, 100 ether);
        vm.deal(buyer, 100 ether);
        vm.deal(wlAlice, 100 ether);
        vm.deal(wlBob, 100 ether);
    }

    function _params(
        string memory name_,
        string memory sym_
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = CH_BARE;
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(routerV2), new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }

    /// Two-leaf Merkle tree over {wlAlice, wlBob}, matching the curve's
    /// `keccak256(abi.encodePacked(addr))` leaf format and solady's sorted-pair
    /// hashing.
    function _wlTree() internal view returns (bytes32 root, bytes32[] memory proofAlice) {
        bytes32 la = keccak256(abi.encodePacked(wlAlice));
        bytes32 lb = keccak256(abi.encodePacked(wlBob));
        root = la < lb ? keccak256(abi.encodePacked(la, lb)) : keccak256(abi.encodePacked(lb, la));
        proofAlice = new bytes32[](1);
        proofAlice[0] = lb;
    }

    function _graduate(
        BondingCurve curve
    ) internal {
        uint256 need = curve.graduationTargetEth() - curve.ethReserve();
        vm.prank(buyer);
        curve.buy{value: (need * 120) / 100}(0);
        assertTrue(curve.graduated(), "curve failed to graduate");
    }

    function _assertPoolLive(
        address token
    ) internal view {
        PoolId id = _poolIdFor(token);
        (uint160 sqrtPriceX96,,,) = ipm.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "v4 pool not initialized");
        assertGt(ipm.getLiquidity(id), 0, "v4 pool has no liquidity");
    }

    // =====================================================================
    // launchWithURU
    // =====================================================================

    function test_LaunchWithURU_GraduatesAndSeedsPool() public {
        uru.mint(launcher, 1_000e18);
        vm.prank(launcher);
        uru.approve(address(routerV2), type(uint256).max);

        uint256 sinkBefore = uru.balanceOf(address(uruSink));

        // Build params BEFORE the prank — `_params` makes an external call, and
        // `vm.prank` binds to the next external call, not the next statement.
        LaunchParams memory p = _params("URU Pay", "URUP");
        vm.prank(launcher);
        address token = routerV2.launchWithURU(p, 500e18);

        assertEq(uru.balanceOf(address(uruSink)) - sinkBefore, 500e18, "URU did not reach the deposit sink");
        assertEq(uru.balanceOf(launcher), 500e18, "launcher URU not debited correctly");

        BondingCurve curve = BondingCurve(payable(curveFactory.curveFor(token)));
        assertTrue(address(curve) != address(0), "no curve installed on URU launch");

        _graduate(curve);
        _assertPoolLive(token);
        assertEq(address(graduator).balance, 0, "graduator stranded ETH");
    }

    function test_LaunchWithURU_RevertsBelowMinFee() public {
        uru.mint(launcher, 1_000e18);
        vm.prank(launcher);
        uru.approve(address(routerV2), type(uint256).max);

        LaunchParams memory p = _params("Cheap", "CHP");
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(RouterV2.RouterV2__InsufficientUru.selector, MIN_URU_FEE, 1e18));
        routerV2.launchWithURU(p, 1e18);
    }

    // =====================================================================
    // launchWithWhitelist
    // =====================================================================

    function test_LaunchWithWhitelist_ReservesSliceAndGraduates() public {
        (bytes32 root, bytes32[] memory proofAlice) = _wlTree();

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: root,
            reservedTokens: 100_000_000e18,
            maxWlPerAddress: 50_000_000e18,
            fallbackTs: uint64(block.timestamp + 1 days),
            sourceTokenAddress: address(uru),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 2
        });

        LaunchParams memory p = _params("WL Token", "WLT");
        uint256 fee = routerV2.quote(p);

        vm.prank(launcher);
        address token = routerV2.launchWithWhitelist{value: fee}(p, wl);

        BondingCurve curve = BondingCurve(payable(curveFactory.curveFor(token)));
        assertEq(curve.whitelistRoot(), root, "whitelist root not bound to the curve");
        assertEq(curve.reservedTokens(), 100_000_000e18, "reserved slice not set");

        // Public buys are locked out during the exclusive window.
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.BondingCurve__WlWindowActive.selector, curve.fallbackTs())
        );
        curve.buy{value: 1 ether}(0);

        // A whitelisted wallet can buy, and the tokens are HELD on the curve
        // until graduation rather than delivered immediately.
        vm.prank(wlAlice);
        uint256 got = curve.buyWithProof{value: 0.1 ether}(proofAlice, 0);
        assertGt(got, 0, "whitelist buy returned nothing");
        assertEq(StackToken(token).balanceOf(wlAlice), 0, "WL tokens should be locked until graduation");
        assertEq(curve.wlHeldForUser(wlAlice), got, "WL holding not recorded");

        // A non-whitelisted wallet cannot use the proof path.
        vm.prank(buyer);
        vm.expectRevert(BondingCurve.BondingCurve__WlProofInvalid.selector);
        curve.buyWithProof{value: 1 ether}(proofAlice, 0);

        // After the window, public buys open and drive graduation.
        vm.warp(curve.fallbackTs() + 1);
        _graduate(curve);
        _assertPoolLive(token);

        // Post-graduation the WL buyer claims exactly what was held.
        vm.prank(wlAlice);
        uint256 claimed = curve.claimWl();
        assertEq(claimed, got, "claimed amount != held amount");
        assertEq(StackToken(token).balanceOf(wlAlice), got, "WL tokens not delivered on claim");

        vm.prank(wlAlice);
        vm.expectRevert(BondingCurve.BondingCurve__WlNothingToClaim.selector);
        curve.claimWl();
    }

    // =====================================================================
    // launchWithURUAndWhitelist
    // =====================================================================

    function test_LaunchWithURUAndWhitelist_GraduatesAndSeedsPool() public {
        (bytes32 root,) = _wlTree();
        uru.mint(launcher, 1_000e18);
        vm.prank(launcher);
        uru.approve(address(routerV2), type(uint256).max);

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: root,
            reservedTokens: 10_000_000e18,
            maxWlPerAddress: 5_000_000e18,
            fallbackTs: uint64(block.timestamp + 1 hours),
            sourceTokenAddress: address(uru),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 2
        });

        LaunchParams memory p = _params("URU WL", "UWL");
        vm.prank(launcher);
        address token = routerV2.launchWithURUAndWhitelist(p, 500e18, wl);

        BondingCurve curve = BondingCurve(payable(curveFactory.curveFor(token)));
        assertEq(curve.whitelistRoot(), root, "whitelist root not bound on the URU+WL path");
        assertEq(uru.balanceOf(address(uruSink)), 500e18, "URU did not reach the sink");

        vm.warp(curve.fallbackTs() + 1);
        _graduate(curve);
        _assertPoolLive(token);
        assertEq(address(graduator).balance, 0, "graduator stranded ETH");
    }

    /// WL variants are meaningless without a curve and must reject that combo
    /// rather than silently launching a curve-less token with a bound root.
    function test_WhitelistWithoutCurve_Reverts() public {
        (bytes32 root,) = _wlTree();
        LaunchParams memory p = _params("NoCurve", "NOC");
        p.installBondingCurve = false;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: root,
            reservedTokens: 1e18,
            maxWlPerAddress: 1e18,
            fallbackTs: uint64(block.timestamp + 1 hours),
            sourceTokenAddress: address(uru),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 2
        });

        uint256 fee = routerV2.quote(p);
        vm.prank(launcher);
        vm.expectRevert(RouterV2.RouterV2__WlRequiresBondingCurve.selector);
        routerV2.launchWithWhitelist{value: fee}(p, wl);
    }
}
