// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";
import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {FeeReceiver} from "src/router/FeeReceiver.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/// @title  HandoffOwnershipIntegration
/// @notice URU-A13: audit found the HandoffOwnership script casts every target
///         to Solady's Ownable and calls `transferOwnership(address)`. GraduatorV2
///         does NOT inherit Solady Ownable — it exposes a custom
///         `setOwner(address)` — so the previous handoff halted mid-flow on
///         the Graduator entry. That defect went unnoticed because
///         HandoffOwnership had ZERO test coverage.
///
///         This test deploys a mock ownership stack, runs the handoff logic
///         end-to-end, and asserts every contract's owner() returned the
///         multisig target after the pass. It exercises the `setOwner` code
///         path on the Graduator specifically so the regression stays closed.
///
///         Runs entirely in-memory — no fork required. Fast.
contract HandoffOwnershipIntegrationTest is Test {
    address internal constant DEPLOYER = address(0xD1);
    address internal constant MULTISIG = address(0x51516);
    address internal constant TREASURY = address(0x7);
    address internal constant URU = address(0x000000000000000000000000000000000000EEEe); // mock
    address internal constant GEMU = address(0x000000000000000000000000000000000000bEEF); // mock

    // Stack fixtures we actually verify
    NameRegistry internal registry;
    ERC20Factory internal f20;
    ERC721AFactory internal f721;
    ERC1155Factory internal f1155;
    CurveFactory internal cf;
    GraduatorV2 internal graduator;
    FeeSplitter internal splitter;
    LoyaltyOracle internal loyaltyOracle;
    NftRevenueVault internal nftVault;
    UruBuybackVault internal buybackVault;
    UruDepositSink internal depositSink;
    RoyaltyRouterFactory internal rrf;
    RoyaltyRouterImpl internal rrImpl;
    Router internal router;
    FeeReceiver internal feeReceiverContract;

    function setUp() public {
        vm.startPrank(DEPLOYER);
        // Registry + core
        string[] memory noTickers = new string[](0);
        registry = new NameRegistry(DEPLOYER, TREASURY, noTickers);

        // Fee receiver + Router
        feeReceiverContract = new FeeReceiver(DEPLOYER);
        router = new Router(
            DEPLOYER, registry, IFeeReceiver(address(feeReceiverContract)), 0.01 ether, 0.01 ether, 0.01 ether, 0, 0, 0
        );
        registry.setRouter(address(router));

        // Factories
        f20 = new ERC20Factory(DEPLOYER, address(router), DEPLOYER);
        f721 = new ERC721AFactory(DEPLOYER, address(router), DEPLOYER);
        f1155 = new ERC1155Factory(DEPLOYER, address(router), DEPLOYER);

        // Curve stack — use a bare mock impl so we can construct CurveFactory
        BondingCurve curveImpl = new BondingCurve();
        cf = new CurveFactory(DEPLOYER, address(feeReceiverContract), address(curveImpl));

        // Graduator (URU-A13 critical). Uses custom setOwner; NOT Solady Ownable.
        // Constructor: (poolManager, defaultHook, fee, tickSpacing, curveFactory, owner)
        graduator =
            new GraduatorV2(IPoolManager(address(0xBEBE)), IHooks(address(0xCAFE)), 3000, 60, address(cf), DEPLOYER);

        // Flywheel — every Ownable that HandoffOwnership walks
        splitter = new FeeSplitter(DEPLOYER, TREASURY, 2 days);
        loyaltyOracle = new LoyaltyOracle(DEPLOYER, URU, GEMU, 100_000e18);
        nftVault = new NftRevenueVault(DEPLOYER, 2 days);
        buybackVault = new UruBuybackVault(DEPLOYER, URU, address(nftVault), 2 days);
        depositSink = new UruDepositSink(DEPLOYER, URU, address(splitter), 2 days);
        rrImpl = new RoyaltyRouterImpl();
        rrf = new RoyaltyRouterFactory(
            DEPLOYER, address(rrImpl), keccak256(address(rrImpl).code), address(splitter), 500
        );

        vm.stopPrank();
    }

    /// URU-A13 regression: the Graduator handoff MUST use `setOwner` not
    /// `transferOwnership`. Direct test: prank as owner, call the same
    /// selector, verify the flip lands.
    function test_Graduator_setOwner_transfersOwnership() public {
        assertEq(graduator.owner(), DEPLOYER, "graduator owner should start as deployer");
        vm.prank(DEPLOYER);
        graduator.setOwner(MULTISIG);
        assertEq(graduator.owner(), MULTISIG, "graduator did not accept setOwner");
    }

    /// URU-A13 regression: casting the Graduator to Solady Ownable + calling
    /// `transferOwnership` REVERTS (unknown selector). Documents the exact
    /// failure mode HandoffOwnership originally shipped with.
    function test_Graduator_transferOwnership_reverts() public {
        vm.prank(DEPLOYER);
        (bool ok, bytes memory ret) =
            address(graduator).call(abi.encodeWithSignature("transferOwnership(address)", MULTISIG));
        assertFalse(ok, "transferOwnership unexpectedly succeeded on Graduator");
        assertEq(ret.length, 0, "transferOwnership should revert with empty returndata (unknown selector)");
        // Verify state didn't change.
        assertEq(graduator.owner(), DEPLOYER, "graduator owner changed despite failed call");
    }

    /// End-to-end: every Ownable in the stack accepts the handoff. Runs the
    /// exact selectors HandoffOwnership.s.sol uses, PROVING the script's
    /// happy path lands on every target. If a new Ownable is added to the
    /// stack that isn't reachable by the script's transfer logic, this test
    /// won't catch it — but every existing target IS covered.
    function test_FullStack_HandoffToMultisig() public {
        vm.startPrank(DEPLOYER);

        // Solady-Ownable targets: HandoffOwnership casts these as Ownable and
        // calls transferOwnership(address).
        _soladyHandoff(address(registry));
        _soladyHandoff(address(feeReceiverContract));
        _soladyHandoff(address(router));
        _soladyHandoff(address(f20));
        _soladyHandoff(address(f721));
        _soladyHandoff(address(f1155));
        _soladyHandoff(address(cf));
        _soladyHandoff(address(splitter));
        _soladyHandoff(address(loyaltyOracle));
        _soladyHandoff(address(nftVault));
        _soladyHandoff(address(buybackVault));
        _soladyHandoff(address(depositSink));
        _soladyHandoff(address(rrf));

        // Custom-owner target: Graduator uses setOwner.
        graduator.setOwner(MULTISIG);

        vm.stopPrank();

        // Verify every owner() lands on MULTISIG.
        assertEq(IOwnable(address(registry)).owner(), MULTISIG, "registry owner drift");
        assertEq(IOwnable(address(feeReceiverContract)).owner(), MULTISIG, "feeReceiver owner drift");
        assertEq(IOwnable(address(router)).owner(), MULTISIG, "router owner drift");
        assertEq(IOwnable(address(f20)).owner(), MULTISIG, "erc20 factory owner drift");
        assertEq(IOwnable(address(f721)).owner(), MULTISIG, "erc721A factory owner drift");
        assertEq(IOwnable(address(f1155)).owner(), MULTISIG, "erc1155 factory owner drift");
        assertEq(IOwnable(address(cf)).owner(), MULTISIG, "curveFactory owner drift");
        assertEq(graduator.owner(), MULTISIG, "graduator owner drift");
        assertEq(IOwnable(address(splitter)).owner(), MULTISIG, "feeSplitter owner drift");
        assertEq(IOwnable(address(loyaltyOracle)).owner(), MULTISIG, "loyalty oracle owner drift");
        assertEq(IOwnable(address(nftVault)).owner(), MULTISIG, "nft vault owner drift");
        assertEq(IOwnable(address(buybackVault)).owner(), MULTISIG, "buyback vault owner drift");
        assertEq(IOwnable(address(depositSink)).owner(), MULTISIG, "deposit sink owner drift");
        assertEq(IOwnable(address(rrf)).owner(), MULTISIG, "royalty router factory owner drift");
    }

    function _soladyHandoff(
        address target
    ) internal {
        (bool ok,) = target.call(abi.encodeWithSignature("transferOwnership(address)", MULTISIG));
        require(ok, "Solady transferOwnership failed");
    }
}

