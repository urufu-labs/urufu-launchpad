// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice Golden-path integration: launch a bare ERC-20 through the real stack. No mocks.
///         Every contract is a real deployment; wires match the intended mainnet topology.
contract LaunchE2ETest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal factory;
    ERC20Template internal impl;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal multisig = makeAddr("multisig");
    address internal alice = makeAddr("alice");

    bytes32 internal constant BARE_CONFIG = keccak256(abi.encode("bare-ERC20", "v0"));

    uint256 internal constant ERC20_FEE = 0.05 ether;
    uint256 internal constant MODULE_ADD_ON = 0.01 ether;
    uint256 internal constant HOOK_ADD_ON = 0.1 ether;
    uint256 internal constant GOV_ADD_ON = 0.1 ether;

    function setUp() public {
        string[] memory reserved = new string[](2);
        reserved[0] = "ETH";
        reserved[1] = "USDC";
        registry = new NameRegistry(admin, treasury, reserved);

        feeReceiver = new FeeReceiver(admin);

        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            ERC20_FEE,
            ERC20_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON
        );

        factory = new ERC20Factory(admin, address(router), registrar);
        impl = new ERC20Template();

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(factory));
        registry.setRouter(address(router));
        vm.stopPrank();

        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));

        vm.deal(launcher, 100 ether);
    }

    function _bareParams(
        string memory name,
        string memory ticker,
        uint256 initialSupply,
        OwnershipMode mode
    ) internal view returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: name,
            ticker: ticker,
            configHash: BARE_CONFIG,
            initData: abi.encode(initialSupply, launcher, new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: mode,
            ownerTargetIfMultisig: mode == OwnershipMode.TransferToMultisig ? multisig : address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // Golden paths
    // =========================================================

    function test_E2E_LaunchBareERC20_Renounce() public {
        LaunchParams memory p = _bareParams("Vending Token", "VEND", 1000 ether, OwnershipMode.Renounce);

        // Predict deployed address before launch.
        address predicted = factory.predictAddress(launcher, p.name, p.ticker, BARE_CONFIG);

        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        assertEq(token, predicted, "predicted address mismatch");
        ERC20Template t = ERC20Template(token);
        assertEq(t.name(), "Vending Token");
        assertEq(t.symbol(), "VEND");
        assertEq(t.owner(), address(0), "should be renounced");
        assertEq(t.balanceOf(launcher), 1000 ether);
        assertEq(t.totalSupply(), 1000 ether);

        // Registry populated.
        bytes32 nameHash = keccak256(bytes("vending token"));
        assertEq(registry.reservationOf(nameHash).token, token);
        assertEq(registry.tickerOwner(keccak256(bytes("VEND"))), token);

        // Fee routed to receiver.
        assertEq(address(feeReceiver).balance, ERC20_FEE);
        assertEq(address(router).balance, 0);
    }

    function test_E2E_LaunchBareERC20_KeepEOA() public {
        LaunchParams memory p = _bareParams("Kept Token", "KEEP", 500 ether, OwnershipMode.KeepEOA);

        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        ERC20Template t = ERC20Template(token);
        assertEq(t.owner(), launcher, "launcher should own");

        // Launcher can still administer.
        vm.prank(launcher);
        t.transferOwnership(alice);
        assertEq(t.owner(), alice);
    }

    function test_E2E_LaunchBareERC20_TransferToMultisig() public {
        LaunchParams memory p = _bareParams("Multisig Token", "MULT", 100 ether, OwnershipMode.TransferToMultisig);

        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        assertEq(ERC20Template(token).owner(), multisig);
    }

    function test_E2E_LauncherReceivesRefund() public {
        LaunchParams memory p = _bareParams("Refund", "RFND", 0, OwnershipMode.Renounce);
        uint256 overpay = 2 ether;

        uint256 before = launcher.balance;
        vm.prank(launcher);
        router.launch{value: ERC20_FEE + overpay}(p);

        // Launcher paid exactly ERC20_FEE.
        assertEq(launcher.balance, before - ERC20_FEE);
        assertEq(address(feeReceiver).balance, ERC20_FEE);
    }

    function test_E2E_TokenIsTransferableAfterLaunch() public {
        LaunchParams memory p = _bareParams("Transfer", "TRAN", 1000 ether, OwnershipMode.Renounce);

        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        ERC20Template t = ERC20Template(token);
        vm.prank(launcher);
        t.transfer(alice, 400 ether);
        assertEq(t.balanceOf(alice), 400 ether);
        assertEq(t.balanceOf(launcher), 600 ether);
    }

    // =========================================================
    // Collision handling
    // =========================================================

    function test_E2E_DuplicateNameFromSameLauncherReverts() public {
        LaunchParams memory p = _bareParams("Once", "ONCE", 0, OwnershipMode.Renounce);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);

        // Same launcher, same name — CREATE2 salt is identical so LibClone reverts inside the
        // factory (before the registry check even fires).
        LaunchParams memory p2 = _bareParams("Once", "ONC2", 0, OwnershipMode.Renounce);
        vm.expectRevert();
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p2);
    }

    function test_E2E_DuplicateNameFromDifferentLauncherRevertsAtRegistry() public {
        LaunchParams memory p = _bareParams("Shared", "SHR1", 0, OwnershipMode.Renounce);
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);

        // Different launcher, same name — factory salt differs (new CREATE2 address is fine)
        // but NameRegistry rejects the duplicate name, unwinding the whole tx.
        address launcher2 = makeAddr("launcher2");
        vm.deal(launcher2, 10 ether);
        LaunchParams memory p2 = _bareParams("Shared", "SHR2", 0, OwnershipMode.Renounce);
        vm.expectRevert();
        vm.prank(launcher2);
        router.launch{value: ERC20_FEE}(p2);
    }

    function test_E2E_ReservedTickerRejected() public {
        // "USDC" is in the initial reserved-ticker seed.
        LaunchParams memory p = _bareParams("Fake USDC", "USDC", 0, OwnershipMode.Renounce);
        vm.expectRevert();
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    // =========================================================
    // Sequential launches
    // =========================================================

    function test_E2E_TwoLaunchesDifferentConfigs() public {
        LaunchParams memory p1 = _bareParams("First Token", "FST", 100 ether, OwnershipMode.Renounce);
        LaunchParams memory p2 = _bareParams("Second Token", "SND", 200 ether, OwnershipMode.Renounce);

        vm.startPrank(launcher);
        address t1 = router.launch{value: ERC20_FEE}(p1);
        address t2 = router.launch{value: ERC20_FEE}(p2);
        vm.stopPrank();

        assertTrue(t1 != t2);
        assertEq(ERC20Template(t1).totalSupply(), 100 ether);
        assertEq(ERC20Template(t2).totalSupply(), 200 ether);

        assertEq(factory.usageCount(BARE_CONFIG), 2);
        assertEq(address(feeReceiver).balance, 2 * ERC20_FEE);
    }

    // =========================================================
    // Ownership integrity across the pipeline
    // =========================================================

    function test_E2E_OwnershipTransitionIsAtomic() public {
        LaunchParams memory p = _bareParams("Atomic", "ATM", 100 ether, OwnershipMode.TransferToMultisig);

        vm.prank(launcher);
        address token = router.launch{value: ERC20_FEE}(p);

        ERC20Template t = ERC20Template(token);
        assertEq(t.owner(), multisig);

        // Router is NOT owner post-launch — dispatch happened inside the same tx.
        // Router calling transferOwnership now should revert.
        vm.expectRevert();
        vm.prank(address(router));
        t.transferOwnership(alice);
    }
}
