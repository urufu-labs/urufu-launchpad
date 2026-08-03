// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
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
    Router internal router;
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

        router = new Router(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON
        );

        f20 = new MockFactory();
        f721 = new MockFactory();
        f1155 = new MockFactory();
        f20.setRouter(address(router));
        f721.setRouter(address(router));
        f1155.setRouter(address(router));

        vm.startPrank(owner);
        router.setUruConfig(address(uru), address(uruSink));
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

    function test_SetUruConfig_RevertsOnZeroURU() public {
        // Post-flatten, URU wiring is set via setUruConfig (previously done
        // in the RouterV2 shim's constructor). Same zero-check applies.
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        vm.prank(owner);
        router.setUruConfig(address(0), address(uruSink));
    }

    function test_SetUruConfig_RevertsOnZeroSink() public {
        vm.expectRevert(Router.Router__ZeroAddress.selector);
        vm.prank(owner);
        router.setUruConfig(address(uru), address(0));
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
        emit Router.LaunchedInURU(address(0), launcher, URU_FEE_AMOUNT);

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
        vm.expectRevert(Router.Router__ZeroURU.selector);
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
        // A fresh Router with no factory wired should surface FactoryUnset when
        // launchWithURU is called. This test isolates that guard, so we seed the
        // configHash sentinels first (URU-A08 fail-closed policy: without them,
        // launch reverts Router__ConfigMetadataIncomplete BEFORE reaching the
        // FactoryUnset guard).
        Router bare = new Router(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            NFT_FEE,
            ERC1155_FEE,
            MODULE_ADD_ON,
            HOOK_ADD_ON,
            GOV_ADD_ON
        );
        vm.startPrank(owner);
        bare.setUruConfig(address(uru), address(uruSink));
        // Fail-closed sentinels — else Router__ConfigMetadataIncomplete fires first.
        bare.setModuleCountForConfig(bytes32(uint256(1)), 1);
        bare.setFlagsForConfig(bytes32(uint256(1)), 0);
        vm.stopPrank();
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

    // =========================================================
    // bannedConfigHash — added 2026-08-01 after audit round 2 caught
    // that the earlier count-poison mitigation only blocked the ETH
    // path (URU + WL bypass _quote). This mapping is the clean fix:
    // owner-only, checked FIRST in every launch entrypoint.
    // =========================================================

    function test_SetConfigHashBanned_OnlyOwner() public {
        bytes32 h = bytes32(uint256(0xdead));
        // 0x82b42900 = Solady Ownable.Unauthorized() selector.
        vm.expectRevert(bytes4(0x82b42900));
        vm.prank(stranger);
        router.setConfigHashBanned(h, true);
    }

    /// URU-A10: banning a configHash is MONOTONIC. Previously the toggle was
    /// two-way, meaning an owner-key compromise could un-ban a retired shape
    /// and relaunch it (or censor a hash then quietly restore it). Post-fix:
    /// `banned=true` retires the hash and emits both events; a second `true`
    /// for the same hash is a no-op (idempotent); `banned=false` reverts
    /// `Router__ConfigRetirementIrreversible`. The only path to un-retire is
    /// a fresh Router deploy at a new address.
    function test_SetConfigHashBanned_TogglesAndEmits() public {
        bytes32 h = bytes32(uint256(0xdead));

        // (1) First ban emits BOTH ConfigHashBanned(h, true) and ConfigHashRetired(h)
        // and flips the state.
        vm.expectEmit(true, false, false, true, address(router));
        emit Router.ConfigHashBanned(h, true);
        vm.expectEmit(true, false, false, false, address(router));
        emit Router.ConfigHashRetired(h);
        vm.prank(owner);
        router.setConfigHashBanned(h, true);
        assertTrue(router.bannedConfigHash(h));

        // (2) Second ban with `true` is a no-op — no emit, no revert (idempotent).
        //     Recording logs empty and asserting no records lets vm.recordLogs
        //     prove the no-op contract.
        vm.recordLogs();
        vm.prank(owner);
        router.setConfigHashBanned(h, true);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 0, "second ban with true must be a silent no-op");
        assertTrue(router.bannedConfigHash(h));

        // (3) Attempting to un-ban reverts monotonically — the retirement cannot
        //     be reversed by the owner.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigRetirementIrreversible.selector, h));
        router.setConfigHashBanned(h, false);
        assertTrue(router.bannedConfigHash(h), "un-ban attempt must not flip state");
    }

    function test_BannedHash_LaunchReverts() public {
        bytes32 h = bytes32(uint256(1)); // the sentinel-seeded hash
        vm.prank(owner);
        router.setConfigHashBanned(h, true);

        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Banned", "BAN");
        p.configHash = h;
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, h));
        vm.prank(launcher);
        router.launch{value: ERC20_FEE}(p);
    }

    function test_BannedHash_LaunchWithURUReverts() public {
        bytes32 h = bytes32(uint256(1));
        vm.prank(owner);
        router.setConfigHashBanned(h, true);

        LaunchParams memory p = _defaultParams(BaseType.ERC20, "Banned", "BAN");
        p.configHash = h;
        vm.startPrank(launcher);
        uru.approve(address(router), URU_FEE_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, h));
        router.launchWithURU(p, URU_FEE_AMOUNT);
        vm.stopPrank();
    }
}

// Separate contract for the whitelist-path tests so the LaunchParams needs the
// bonding curve pre-conditions and the mock factory can accept it. Kept in the
// same file so it stays close to its sibling banned-hash tests above.
contract RouterBannedConfigHashWlTest is Test {
    Router internal router;
    NameRegistry internal registry;
    FeeReceiver internal feeReceiver;
    UruDepositSink internal uruSink;
    MockUruRV2 internal uru;
    MockFactory internal f20;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal launcher = makeAddr("launcher");

    uint256 internal constant ERC20_FEE = 0.05 ether;
    uint256 internal constant URU_AMOUNT = 100e18;
    bytes4 internal constant UNAUTHORIZED_SELECTOR = 0x82b42900;
    bytes32 internal constant HASH = bytes32(uint256(1));

    function setUp() public {
        registry = new NameRegistry(owner, treasury, new string[](0));
        feeReceiver = new FeeReceiver(owner);
        uru = new MockUruRV2();
        uruSink = new UruDepositSink(owner, address(uru), address(feeReceiver), 2 days);
        router = new Router(
            owner,
            registry,
            IFeeReceiver(address(feeReceiver)),
            ERC20_FEE,
            0.05 ether,
            0.05 ether,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );
        f20 = new MockFactory();
        f20.setRouter(address(router));

        vm.startPrank(owner);
        router.setUruConfig(address(uru), address(uruSink));
        router.setFactory(BaseType.ERC20, address(f20));
        registry.setRouter(address(router));
        router.setModuleCountForConfig(HASH, 1);
        router.setFlagsForConfig(HASH, 0);
        router.setConfigHashBanned(HASH, true); // ban the hash upfront
        vm.stopPrank();

        vm.deal(launcher, 100 ether);
        uru.mint(launcher, 10_000e18);
    }

    /// launchWithWhitelist should reject a banned hash BEFORE the WL-specific
    /// installBondingCurve check runs, so the revert selector is
    /// Router__ConfigHashBanned rather than Router__WlRequiresBondingCurve.
    function test_BannedHash_LaunchWithWhitelistReverts() public {
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Banned",
            ticker: "BAN",
            configHash: HASH,
            initData: hex"",
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        BondingCurve.WhitelistInit memory wl;
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, HASH));
        vm.prank(launcher);
        router.launchWithWhitelist{value: 1 ether}(p, wl);
    }

    function test_BannedHash_LaunchWithURUAndWhitelistReverts() public {
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Banned",
            ticker: "BAN",
            configHash: HASH,
            initData: hex"",
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true,
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        BondingCurve.WhitelistInit memory wl;
        vm.startPrank(launcher);
        uru.approve(address(router), URU_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigHashBanned.selector, HASH));
        router.launchWithURUAndWhitelist(p, URU_AMOUNT, wl);
        vm.stopPrank();
    }
}
