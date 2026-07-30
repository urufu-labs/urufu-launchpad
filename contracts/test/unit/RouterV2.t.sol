// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {MockFactory} from "test/mocks/MockFactory.sol";
import {MockToken} from "test/mocks/MockToken.sol";

contract MockUruRV2 is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract RouterV2Test is Test {
    RouterV2 internal router;
    NameRegistry internal registry;
    FeeReceiver internal feeReceiver;
    UruDepositSink internal uruSink;
    MockUruRV2 internal uru;
    MockFactory internal f20;
    MockFactory internal f721;
    MockFactory internal f1155;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal launcher = makeAddr("launcher");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ERC20_FEE = 0.05 ether;
    uint256 internal constant NFT_FEE = 0.05 ether;
    uint256 internal constant ERC1155_FEE = 0.05 ether;
    uint256 internal constant MODULE_ADD_ON = 0.01 ether;
    uint256 internal constant HOOK_ADD_ON = 0.1 ether;
    uint256 internal constant GOV_ADD_ON = 0.1 ether;

    /// Convenience — launchers approve at least this URU when calling launchWithURU
    /// in the happy-path tests. The contract doesn't quote on-chain so the number
    /// is arbitrary; picked to be visually obvious in balance assertions.
    uint256 internal constant URU_FEE_AMOUNT = 100e18;

    function setUp() public {
        registry = new NameRegistry(owner, treasury, new string[](0));
        feeReceiver = new FeeReceiver(owner);
        uru = new MockUruRV2();
        uruSink = new UruDepositSink(owner, address(uru), address(feeReceiver), 2 days);

        router = new RouterV2(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON,
            address(uru),
            uruSink
        );

        f20 = new MockFactory();
        f721 = new MockFactory();
        f1155 = new MockFactory();
        f20.setRouter(address(router));
        f721.setRouter(address(router));
        f1155.setRouter(address(router));

        vm.startPrank(owner);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setFactory(BaseType.ERC721A, address(f721));
        router.setFactory(BaseType.ERC1155, address(f1155));
        registry.setRouter(address(router));
        // Audit remediation #3 (fail-closed sentinels).
        router.setModuleCountForConfig(bytes32(uint256(1)), 1);
        router.setFlagsForConfig(bytes32(uint256(1)), 0);
        vm.stopPrank();

        vm.deal(launcher, 100 ether);
        uru.mint(launcher, 10_000e18);
    }

    function _defaultParams(
        BaseType base,
        string memory name_,
        string memory ticker_
    ) internal pure returns (LaunchParams memory) {
        return LaunchParams({
            base: base,
            name: name_,
            ticker: ticker_,
            configHash: bytes32(uint256(1)),
            initData: hex"",
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // Constructor
    // =========================================================

    function test_Constructor_StoresURUAndSink() public view {
        assertEq(address(router.uru()), address(uru));
        assertEq(address(router.uruSink()), address(uruSink));
    }

    function test_Constructor_InheritedFieldsStillCorrect() public view {
        assertEq(address(router.registry()), address(registry));
        assertEq(address(router.feeReceiver()), address(feeReceiver));
        assertEq(router.fees(BaseType.ERC20), ERC20_FEE);
    }

    function test_Constructor_RevertsOnZeroURU() public {
        vm.expectRevert(RouterV2.RouterV2__ZeroAddress.selector);
        new RouterV2(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON,
            address(0),
            uruSink
        );
    }

    function test_Constructor_RevertsOnZeroSink() public {
        vm.expectRevert(RouterV2.RouterV2__ZeroAddress.selector);
        new RouterV2(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON,
            address(uru),
            UruDepositSink(payable(address(0)))
        );
    }

    // =========================================================
    // launchWithURU — happy paths
    // =========================================================

    function test_LaunchWithURU_HappyPath_PullsURUIntoSink() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Alpha Token", "ALPHA");

        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);
        address token = router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();

        // URU pulled from launcher into sink.
        assertEq(uru.balanceOf(address(uruSink)), URU_FEE_AMOUNT);
        assertEq(uru.balanceOf(launcher), 10_000e18 - URU_FEE_AMOUNT);

        // Factory got the right args.
        assertEq(f20.deployCount(), 1);
        assertEq(f20.lastName(), "Alpha Token");
        assertEq(f20.lastLauncher(), launcher);

        // Ownership dispatched.
        assertEq(MockToken(token).owner(), address(0));

        // Name reservation recorded.
        bytes32 nameHash = keccak256(bytes("alpha token"));
        assertEq(registry.reservationOf(nameHash).token, token);

        // No ETH sent — feeReceiver stays empty on the URU path.
        assertEq(address(feeReceiver).balance, 0);
    }

    function test_LaunchWithURU_EmitsLaunchedInURU() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Beta", "BETA");

        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);

        // We can't easily predict `token` before the call, so match on the launchedBy
        // topic + non-indexed uruPaid amount and let token slot through.
        vm.expectEmit(false, true, false, true, address(router));
        emit RouterV2.LaunchedInURU(address(0), launcher, URU_FEE_AMOUNT);

        router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }

    function test_LaunchWithURU_InheritedLaunchStillWorks() public {
        // Confirms the ETH path (inherited) is unbroken after the URU addition.
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "ETH Path Token", "ETHP");
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
        assertEq(address(feeReceiver).balance, ERC20_FEE);
        assertEq(uru.balanceOf(address(uruSink)), 0);
    }

    // =========================================================
    // launchWithURU — reverts
    // =========================================================

    function test_LaunchWithURU_RevertsOnZeroURU() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        vm.expectRevert(RouterV2.RouterV2__ZeroURU.selector);
        vm.prank(launcher);
        router.launchWithURU(p, 0);
    }

    function test_LaunchWithURU_RevertsWhenPaused() public {
        vm.prank(owner);
        router.setPaused(true);
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        vm.expectRevert(Router.Router__Paused.selector);
        vm.prank(launcher);
        router.launchWithURU(p, URU_FEE_AMOUNT);
    }

    function test_LaunchWithURU_RevertsOnFactoryUnset() public {
        // Wipe the ERC20 factory (setFactory to non-zero only — use a fresh factory
        // then reset via a workaround: the guard is `factory == address(0)`, and
        // setFactory rejects zero. Simulate by launching a base with no factory set.)
        // Simpler: unset ERC1155 factory via a fresh RouterV2 that doesn't wire it.
        RouterV2 bare = new RouterV2(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON,
            address(uru),
            uruSink
        );
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        vm.startPrank(launcher);
        uru.approve(address(bare), URU_FEE_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__FactoryUnset.selector, BaseType.ERC20));
        bare.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }

    function test_LaunchWithURU_RevertsOnEmptyName() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "", "T");
        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);
        vm.expectRevert(Router.Router__EmptyName.selector);
        router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }

    function test_LaunchWithURU_RevertsOnEmptyTicker() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "");
        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);
        vm.expectRevert(Router.Router__EmptyTicker.selector);
        router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }

    function test_LaunchWithURU_RevertsOnMultisigZeroTarget() public {
        LaunchParams memory p = _defaultParams(BaseType.ERC20, "N", "T");
        p.ownership = OwnershipMode.TransferToMultisig;
        p.ownerTargetIfMultisig = address(0);
        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }
}
