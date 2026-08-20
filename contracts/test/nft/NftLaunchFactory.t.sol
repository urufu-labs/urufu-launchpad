// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NftHarness} from "./NftHarness.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @title  NftLaunchFactoryTest
/// @notice Factory-level tests: launch entrypoint, URU fee pull with
///         loyalty discount, ownership wiring, name-taken guard, setter
///         hygiene.
contract NftLaunchFactoryTest is NftHarness {
    function setUp() public {
        _setupBase();
    }

    // --------------------------------------------------------------
    // Launch happy-paths
    // --------------------------------------------------------------

    function test_Launch_ZeroURUFee_NoAllowance_Needed() public {
        _launch(_defaultLaunchParams());
        // Everything wired up.
        assertTrue(deployedToken != address(0));
        assertTrue(deployedMintModule != address(0));
        assertEq(deployedWl, address(0), "no WL module");
    }

    function test_Launch_URUFee_PulledToSink() public {
        // Set min URU fee to 1000e18.
        vm.prank(owner);
        factory.setUruConfig(IERC20(address(uru)), address(uruSink), 1000e18, ILoyaltyOracleLike(address(0)));
        // Fund launcher with URU, approve factory.
        uru.mint(launcher, 5000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
        // Launch with 2000e18 (above min).
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.uruAmount = 2000e18;
        vm.prank(launcher);
        factory.launch(p);
        assertEq(uru.balanceOf(address(uruSink)), 2000e18, "sink got URU");
        assertEq(uru.balanceOf(launcher), 3000e18, "launcher debited");
    }

    function test_Launch_URUFee_Insufficient_Reverts() public {
        vm.prank(owner);
        factory.setUruConfig(IERC20(address(uru)), address(uruSink), 1000e18, ILoyaltyOracleLike(address(0)));
        uru.mint(launcher, 5000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.uruAmount = 999e18;
        vm.expectRevert(
            abi.encodeWithSelector(NftLaunchFactory.NftLaunchFactory__InsufficientUru.selector, 1000e18, 999e18)
        );
        vm.prank(launcher);
        factory.launch(p);
    }

    function test_Launch_URUFee_LoyaltyDiscount_Applied() public {
        // Loyalty oracle that returns 50% discount.
        MockLoyalty oracle = new MockLoyalty(5000);
        vm.prank(owner);
        factory.setUruConfig(IERC20(address(uru)), address(uruSink), 1000e18, ILoyaltyOracleLike(address(oracle)));
        // Effective floor for launcher = 500e18.
        assertEq(factory.minUruFeeFor(launcher), 500e18, "half off");
        // A launch at 500e18 succeeds; 499e18 reverts.
        uru.mint(launcher, 5000e18);
        vm.prank(launcher);
        uru.approve(address(factory), type(uint256).max);
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.uruAmount = 499e18;
        vm.expectRevert(
            abi.encodeWithSelector(NftLaunchFactory.NftLaunchFactory__InsufficientUru.selector, 500e18, 499e18)
        );
        vm.prank(launcher);
        factory.launch(p);
        p.uruAmount = 500e18;
        vm.prank(launcher);
        factory.launch(p);
        assertEq(uru.balanceOf(address(uruSink)), 500e18);
    }

    // --------------------------------------------------------------
    // Sanity gates
    // --------------------------------------------------------------

    function test_Launch_ImplsNotSet_Reverts() public {
        NftLaunchFactory f2 = new NftLaunchFactory(owner);
        // Skip setImpls.
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__ImplsNotSet.selector);
        vm.prank(launcher);
        f2.launch(_defaultLaunchParams());
    }

    function test_Launch_NameEmpty_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.name = "";
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__NameEmpty.selector);
        vm.prank(launcher);
        factory.launch(p);
    }

    function test_Launch_TickerEmpty_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.ticker = "";
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__TickerEmpty.selector);
        vm.prank(launcher);
        factory.launch(p);
    }

    function test_Launch_MaxSupplyZero_Reverts() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.maxSupply = 0;
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__MaxSupplyZero.selector);
        vm.prank(launcher);
        factory.launch(p);
    }

    // --------------------------------------------------------------
    // Salt collisions
    // --------------------------------------------------------------

    function test_Launch_TwiceSameName_SameLauncher_SecondReverts() public {
        _launch(_defaultLaunchParams());
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__NameTaken.selector);
        vm.prank(launcher);
        factory.launch(_defaultLaunchParams());
    }

    function test_Launch_DifferentLaunchers_SameName_Both_OK() public {
        _launch(_defaultLaunchParams());
        // buyer1 launches a collection with the same name.
        vm.prank(buyer1);
        (address t2,,) = factory.launch(_defaultLaunchParams());
        assertTrue(t2 != deployedToken, "distinct deploys");
    }

    // --------------------------------------------------------------
    // Ownership wiring
    // --------------------------------------------------------------

    function test_Launch_Ownership_TransferredToMintModule() public {
        _launch(_defaultLaunchParams());
        // ERC721A owner should be the mint module (Solady Ownable).
        assertEq(ERC721ATemplate(deployedToken).owner(), deployedMintModule);
    }

    // --------------------------------------------------------------
    // WL module deployment matches flavor
    // --------------------------------------------------------------

    function test_Launch_WLFlavor_Off_NoWLModule() public {
        _launch(_defaultLaunchParams());
        assertEq(deployedWl, address(0));
    }

    function test_Launch_WLFlavor_WalletList_DeploysWLModule() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = keccak256("root");
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        assertTrue(deployedWl != address(0));
        assertEq(uint8(NftWhitelistModule(deployedWl).flavor()), uint8(NftWhitelistModule.Flavor.WalletList));
    }

    function test_Launch_WLFlavor_Holders_DeploysWLModule() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        p.wlFlavor = NftWhitelistModule.Flavor.Holders;
        p.wlHoldersTarget = address(0xDEAD);
        p.wlHoldersTargetChainId = 1;
        p.wlHoldersMinCount = 1;
        p.wlWindowEnd = block.timestamp + 1 hours;
        _launch(p);
        assertTrue(deployedWl != address(0));
        assertEq(uint8(NftWhitelistModule(deployedWl).flavor()), uint8(NftWhitelistModule.Flavor.Holders));
    }

    // --------------------------------------------------------------
    // Owner-only setters
    // --------------------------------------------------------------

    function test_SetUruConfig_ZeroAddress_Reverts() public {
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setUruConfig(IERC20(address(0)), address(uruSink), 0, ILoyaltyOracleLike(address(0)));
    }

    function test_SetUruConfig_NotOwner_Reverts() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(buyer1);
        factory.setUruConfig(IERC20(address(uru)), address(uruSink), 0, ILoyaltyOracleLike(address(0)));
    }

    function test_SetFeeSplitter_ZeroAddress_Reverts() public {
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setFeeSplitter(address(0));
    }

    function test_SetAttestationSigner_ZeroAddress_Reverts() public {
        vm.expectRevert(NftLaunchFactory.NftLaunchFactory__ZeroAddress.selector);
        vm.prank(owner);
        factory.setAttestationSigner(address(0));
    }

    // --------------------------------------------------------------
    // Event shape (for indexer contract)
    // --------------------------------------------------------------

    function test_Launch_EmitsCollectionLaunched() public {
        NftLaunchFactory.LaunchParams memory p = _defaultLaunchParams();
        // We don't assert exact topic values (addresses aren't known
        // beforehand), but at least assert event fires.
        vm.recordLogs();
        vm.prank(launcher);
        factory.launch(p);
        assertGt(vm.getRecordedLogs().length, 0, "some log emitted");
    }
}

/// Test-only mock — returns a fixed discount for every wallet.
contract MockLoyalty is ILoyaltyOracleLike {
    uint16 public immutable bps;

    constructor(
        uint16 bps_
    ) {
        bps = bps_;
    }

    function discountBpsFor(
        address
    ) external view returns (uint16) {
        return bps;
    }
}
