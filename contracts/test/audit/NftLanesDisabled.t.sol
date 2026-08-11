// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {MockFactory} from "test/mocks/MockFactory.sol";

/// @title  NftLanesDisabledTest — URU-P1-M03 disposition guard
/// @notice We chose to NOT register NFT impls on fresh V8 deploys and to keep
///         `NFT_BASES_ENABLED = false` in the frontend rather than apply
///         auditor patch 0003. My PATCH-COVERAGE.md claim is that any
///         hand-crafted direct-Router bypass to an NFT base reverts LOUDLY
///         (honest failure), not silently. This test proves that claim.
///
///         The Router itself has no per-base gate — anyone can pass
///         `BaseType.ERC721A` or `BaseType.ERC1155` to `launch()`. Two guards
///         backstop the disposition:
///
///           (A) The Router config-metadata sentinels fail closed. Since
///               `RhConfigManifest.all()` returns only ERC20 entries and
///               `DeployFreshLocal` only calls `registerConfigMetadataBatch`
///               with those, any NFT configHash has
///               `moduleCountConfigured[h] == false`, and
///               `_validateLaunchPolicy` reverts
///               `Router__ConfigMetadataIncomplete(h)` BEFORE any factory is
///               reached.
///
///           (B) Even if that gate is somehow bypassed (owner registered NFT
///               metadata by mistake), the NFT factory has no impl for the
///               hash, so `ERC721AFactory.deploy` reverts
///               `ERC721AFactory__UnknownConfig(h)`.
///
///         Both branches are proven below. If either loses its revert, this
///         suite fails LOUD — the "NFT lanes disabled" disposition would then
///         no longer hold, and we'd either need to fix the guard or actually
///         enable NFT lanes.
contract NftLanesDisabledTest is Test {
    Router internal router;
    NameRegistry internal registry;
    FeeReceiver internal feeReceiver;
    MockFactory internal f20;
    ERC721AFactory internal f721;
    ERC1155Factory internal f1155;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal launcher = makeAddr("launcher");

    uint256 internal constant ERC20_FEE = 0.05 ether;
    uint256 internal constant NFT_FEE = 0.05 ether;
    bytes32 internal constant NFT_CONFIG = keccak256("some-nft-config");

    function setUp() public {
        registry = new NameRegistry(owner, treasury, new string[](0));
        feeReceiver = new FeeReceiver(owner);
        router = new Router(owner, registry, IFeeReceiver(address(feeReceiver)), ERC20_FEE, NFT_FEE, NFT_FEE, 0, 0, 0);

        // Fresh V8 wires NFT factories to Router even though no impl is
        // registered — matches DeployFreshLocal.s.sol behavior.
        f20 = new MockFactory();
        f20.setRouter(address(router));
        f721 = new ERC721AFactory(owner, address(router), owner);
        f1155 = new ERC1155Factory(owner, address(router), owner);

        vm.startPrank(owner);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setFactory(BaseType.ERC721A, address(f721));
        router.setFactory(BaseType.ERC1155, address(f1155));
        registry.setRouter(address(router));
        // Deliberately NOT calling registerConfigMetadata for NFT_CONFIG —
        // matches DeployFreshLocal.s.sol which only iterates ERC20 entries.
        vm.stopPrank();

        vm.deal(launcher, 10 ether);
    }

    function _nftLaunchParams(
        BaseType base
    ) internal pure returns (LaunchParams memory p) {
        p.base = base;
        p.name = "NftBypassAttempt";
        p.ticker = "NBA";
        p.configHash = NFT_CONFIG;
        p.initData = hex"";
        p.moduleCount = 0;
        p.installBondingCurve = false;
        p.ownership = OwnershipMode.Renounce;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
    }

    /// URU-P1-M03 disposition guard: ERC721A launch bypass reverts at the
    /// Router policy gate (ConfigMetadataIncomplete) because no NFT hash is
    /// seeded on fresh V8 deploys. Failure is loud + reason is specific.
    function test_M03_ERC721A_DirectBypass_RevertsConfigMetadataIncomplete() public {
        LaunchParams memory p = _nftLaunchParams(BaseType.ERC721A);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigMetadataIncomplete.selector, NFT_CONFIG));
        vm.prank(launcher);
        router.launch{value: NFT_FEE}(p);
    }

    /// Same for ERC1155.
    function test_M03_ERC1155_DirectBypass_RevertsConfigMetadataIncomplete() public {
        LaunchParams memory p = _nftLaunchParams(BaseType.ERC1155);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__ConfigMetadataIncomplete.selector, NFT_CONFIG));
        vm.prank(launcher);
        router.launch{value: NFT_FEE}(p);
    }

    /// Secondary guard: even if someone bypasses the Router metadata gate
    /// (owner registered NFT metadata by mistake), the NFT factory has no
    /// impl for the hash, so it reverts UnknownConfig. Simulate by having
    /// the owner register the NFT config's metadata (moduleCount + flags)
    /// then attempting the launch — should die at the factory, not fail
    /// silently.
    function test_M03_ERC721A_MetadataSeededButNoImpl_FactoryReverts() public {
        vm.prank(owner);
        router.registerConfigMetadata(NFT_CONFIG, 0, 0);

        LaunchParams memory p = _nftLaunchParams(BaseType.ERC721A);
        vm.expectRevert(abi.encodeWithSelector(ERC721AFactory.ERC721AFactory__UnknownConfig.selector, NFT_CONFIG));
        vm.prank(launcher);
        router.launch{value: NFT_FEE}(p);
    }

    /// Same secondary guard for ERC1155.
    function test_M03_ERC1155_MetadataSeededButNoImpl_FactoryReverts() public {
        vm.prank(owner);
        router.registerConfigMetadata(NFT_CONFIG, 0, 0);

        LaunchParams memory p = _nftLaunchParams(BaseType.ERC1155);
        vm.expectRevert(abi.encodeWithSelector(ERC1155Factory.ERC1155Factory__UnknownConfig.selector, NFT_CONFIG));
        vm.prank(launcher);
        router.launch{value: NFT_FEE}(p);
    }
}
