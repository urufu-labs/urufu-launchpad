// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";

contract RoyaltyRouterTest is Test {
    RoyaltyRouterImpl internal impl;
    RoyaltyRouterFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal platform = makeAddr("platform");
    address internal launcher = makeAddr("launcher");
    address internal collection = makeAddr("collection");
    address internal marketplace = makeAddr("marketplace");

    uint16 internal constant PLATFORM_BPS = 500; // 5%

    function setUp() public {
        impl = new RoyaltyRouterImpl();
        factory = new RoyaltyRouterFactory(owner, address(impl), platform, PLATFORM_BPS);
    }

    // ---- Factory ----------------------------------------------------------

    function test_Factory_DeployFor_HappyPath() public {
        address predicted = factory.predictFor(collection);
        address clone = factory.deployFor(collection, launcher);
        assertEq(clone, predicted, "predict matches deploy");

        RoyaltyRouterImpl router = RoyaltyRouterImpl(payable(clone));
        assertTrue(router.initialized());
        assertEq(router.launcherPayout(), launcher);
        assertEq(router.platformSink(), platform);
        assertEq(router.launcherBps(), 10_000 - PLATFORM_BPS);
        assertEq(router.platformBps(), PLATFORM_BPS);
        assertEq(router.owner(), launcher, "ownable wired to launcher");
    }

    function test_Factory_DeployFor_RevertsOnDuplicate() public {
        address clone = factory.deployFor(collection, launcher);
        vm.expectRevert(
            abi.encodeWithSelector(RoyaltyRouterFactory.RoyaltyRouterFactory__AlreadyDeployed.selector, clone)
        );
        factory.deployFor(collection, launcher);
    }

    function test_Factory_DeployFor_RevertsOnZeroCollection() public {
        vm.expectRevert(RoyaltyRouterFactory.RoyaltyRouterFactory__ZeroAddress.selector);
        factory.deployFor(address(0), launcher);
    }

    function test_Factory_DeployFor_RevertsOnZeroLauncher() public {
        vm.expectRevert(RoyaltyRouterFactory.RoyaltyRouterFactory__ZeroAddress.selector);
        factory.deployFor(collection, address(0));
    }

    function test_Factory_Constructor_RevertsOnBadPlatformBps() public {
        vm.expectRevert(abi.encodeWithSelector(RoyaltyRouterFactory.RoyaltyRouterFactory__BadBps.selector, 0));
        new RoyaltyRouterFactory(owner, address(impl), platform, 0);

        vm.expectRevert(abi.encodeWithSelector(RoyaltyRouterFactory.RoyaltyRouterFactory__BadBps.selector, 10_000));
        new RoyaltyRouterFactory(owner, address(impl), platform, 10_000);
    }

    function test_Factory_SetPlatformSink_OwnerOnly() public {
        address newSink = makeAddr("newSink");
        vm.expectRevert(); // Ownable.Unauthorized
        factory.setPlatformSink(newSink);

        vm.prank(owner);
        factory.setPlatformSink(newSink);
        assertEq(factory.platformSink(), newSink);
    }

    function test_Factory_SetPlatformSink_DoesNotRotateExistingClones() public {
        address clone = factory.deployFor(collection, launcher);
        address newSink = makeAddr("newSink");
        vm.prank(owner);
        factory.setPlatformSink(newSink);

        // Existing clone's sink is frozen — new deploys pick up the new sink.
        assertEq(RoyaltyRouterImpl(payable(clone)).platformSink(), platform);
    }

    function test_Factory_PredictFor_StableAcrossViewCalls() public view {
        address a = factory.predictFor(collection);
        address b = factory.predictFor(collection);
        assertEq(a, b);
    }

    // ---- Impl (via clone) -------------------------------------------------

    function test_Impl_Receive_SplitsPerBps() public {
        address clone = factory.deployFor(collection, launcher);
        vm.deal(marketplace, 10 ether);

        vm.prank(marketplace);
        (bool ok,) = clone.call{value: 10 ether}("");
        assertTrue(ok);

        assertEq(platform.balance, 0.5 ether, "5% platform cut");
        assertEq(launcher.balance, 9.5 ether, "95% launcher cut");
    }

    function test_Impl_Initialize_RevertsIfAlreadyInitialized() public {
        address clone = factory.deployFor(collection, launcher);
        vm.expectRevert(RoyaltyRouterImpl.RoyaltyRouterImpl__AlreadyInitialized.selector);
        RoyaltyRouterImpl(payable(clone)).initialize(launcher, 9500, platform, 500);
    }

    function test_Impl_Initialize_RevertsOnBadSum() public {
        RoyaltyRouterImpl fresh = new RoyaltyRouterImpl();
        vm.expectRevert(abi.encodeWithSelector(RoyaltyRouterImpl.RoyaltyRouterImpl__BadSum.selector, 9999));
        fresh.initialize(launcher, 9499, platform, 500);
    }

    function test_Impl_SetLauncherPayout_OwnerOnly() public {
        address clone = factory.deployFor(collection, launcher);
        RoyaltyRouterImpl router = RoyaltyRouterImpl(payable(clone));
        address newPayout = makeAddr("newPayout");

        vm.expectRevert(); // Ownable.Unauthorized
        router.setLauncherPayout(newPayout);

        vm.prank(launcher);
        router.setLauncherPayout(newPayout);
        assertEq(router.launcherPayout(), newPayout);
    }

    function test_Impl_SetLauncherPayout_RoutesFutureFunds() public {
        address clone = factory.deployFor(collection, launcher);
        address newPayout = makeAddr("newPayout");

        vm.prank(launcher);
        RoyaltyRouterImpl(payable(clone)).setLauncherPayout(newPayout);

        vm.deal(marketplace, 1 ether);
        vm.prank(marketplace);
        (bool ok,) = clone.call{value: 1 ether}("");
        assertTrue(ok);

        assertEq(newPayout.balance, 0.95 ether);
        assertEq(launcher.balance, 0);
    }

    function test_Impl_DistributeStuck_HandlesPreInitETH() public {
        address predicted = factory.predictFor(collection);
        // ETH lands at the deterministic address BEFORE the clone is materialized.
        vm.deal(marketplace, 2 ether);
        vm.prank(marketplace);
        (bool okPre,) = predicted.call{value: 2 ether}("");
        assertTrue(okPre);
        assertEq(predicted.balance, 2 ether);

        // Now materialize the clone; ETH remains stuck until distributeStuck is triggered.
        factory.deployFor(collection, launcher);
        assertEq(platform.balance, 0);
        assertEq(launcher.balance, 0);

        RoyaltyRouterImpl(payable(predicted)).distributeStuck();
        assertEq(platform.balance, 0.1 ether);
        assertEq(launcher.balance, 1.9 ether);
    }

    function test_Impl_Sweep_OwnerOnly() public {
        address clone = factory.deployFor(collection, launcher);
        vm.deal(clone, 1 ether);

        vm.expectRevert(); // Ownable.Unauthorized
        RoyaltyRouterImpl(payable(clone)).sweep(launcher);

        vm.prank(launcher);
        RoyaltyRouterImpl(payable(clone)).sweep(launcher);
        assertEq(launcher.balance, 1 ether);
    }
}
