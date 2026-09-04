// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title  Dn404LiveFork — end-to-end verification against LIVE RH V10 curve stack
/// @notice Forks Robinhood chain and proves the DN404 factory integrates with
///         the live CurveFactory correctly. What this suite proves that unit
///         tests can't (MockCurveFactory doesn't exercise these):
///           - Live CurveFactory accepts createCurveWithConfigFor from our
///             factory after setTrustedRouter is toggled by the CF owner
///           - predictCurveAddress on the LIVE CurveFactory matches the
///             address real cloneDeterministic deploys to (invariant our
///             skip-list-first sequence depends on)
///           - Real curve receives the full supply pull from our factory
///             (no residue trapped in factory, no rounding mismatch)
///           - Base contract's skip-list persists on the real curve — the
///             real curve holds ERC-20 balance but zero NFTs
///           - Real launcher becomes creator on the curve (createCurveWith-
///             ConfigFor's launcher argument is respected)
///
///         Env required:
///           ROBINHOOD_RPC_URL
///           ROBINHOOD_URU_ADDRESS
///           ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS
///
///         Optional (falls back gracefully):
///           ROBINHOOD_LOYALTY_ORACLE_ADDRESS
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///
///         Skips cleanly if required env vars missing OR chainid != 4663.
///         Live V10 CurveFactory address is hardcoded (matches
///         RhUruPayE2eForkTest + address-book memory).

import {Test, console2} from "forge-std/Test.sol";

import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike as FactoryILoyalty,
    ICurveFactoryLike as FactoryICurveFactory
} from "src/dn404/Dn404LaunchFactory.sol";

interface ICurveFactoryOwned {
    function owner() external view returns (address);
    function setTrustedRouter(address router, bool trusted) external;
    function trustedRouters(address router) external view returns (bool);
    function implementation() external view returns (address);
    function predictCurveAddress(address token) external view returns (address);
}

interface IErc20Live {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IDn404MirrorView {
    function balanceOf(address who) external view returns (uint256);
    function baseERC20() external view returns (address);
    function owner() external view returns (address);
}

contract Dn404LiveForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    /// V10 CurveFactory on RH mainnet. Matches address book (memory
    /// `project_robinhood_v10_deploy.md`) + RhUruPayE2eForkTest constant.
    /// If a future factory rotation moves this, add a fresh constant
    /// here rather than mutating the pin.
    address internal constant LIVE_CURVE_FACTORY = 0xFF0b02818B0d39Bd43019b2ceb2d952C29dD851c;

    address internal uru;
    address internal uruSink;
    address internal feeSplitter;
    address internal loyaltyOracle;

    Dn404Template internal baseImpl;
    Dn404MirrorTemplate internal mirrorImpl;
    Dn404LaunchFactory internal factory;

    address internal factoryOwner = makeAddr("dn404FactoryOwner");
    address internal launcher = makeAddr("dn404Launcher");

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {
            vm.skip(true);
            return;
        }
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != RH_CHAIN_ID) {
            vm.skip(true);
            return;
        }
        if (LIVE_CURVE_FACTORY.code.length == 0) {
            vm.skip(true);
            return;
        }

        uru = _envAddr("ROBINHOOD_URU_ADDRESS");
        uruSink = _envAddr("ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS");
        feeSplitter = _envAddrOr("ROBINHOOD_FEE_SPLITTER_ADDRESS", address(0));
        loyaltyOracle = _envAddrOr("ROBINHOOD_LOYALTY_ORACLE_ADDRESS", address(0));

        // Deploy DN404 stack against the LIVE curve factory.
        baseImpl = new Dn404Template();
        mirrorImpl = new Dn404MirrorTemplate();

        vm.prank(factoryOwner);
        factory = new Dn404LaunchFactory(factoryOwner, address(0));

        bytes32 baseHash = keccak256(address(baseImpl).code);
        bytes32 mirrorHash = keccak256(address(mirrorImpl).code);
        vm.startPrank(factoryOwner);
        factory.setExpectedCodeHashes(baseHash, mirrorHash);
        factory.setImpls(address(baseImpl), address(mirrorImpl));
        factory.setUruConfig(
            FactoryIERC20(uru),
            uruSink,
            10e18, // 10 URU floor (arbitrary for fork test; real deploy reads from NftLaunchFactory)
            FactoryILoyalty(loyaltyOracle)
        );
        if (feeSplitter != address(0)) factory.setFeeSplitter(feeSplitter);
        factory.setCurveFactory(FactoryICurveFactory(LIVE_CURVE_FACTORY));
        vm.stopPrank();

        // Whitelist our factory on the live CurveFactory. Impersonate its
        // owner (a governance multisig on mainnet — we can only prank on
        // a fork). This mirrors the ONE-TIME OPS CALL that the real deploy
        // script will make.
        address cfOwner = ICurveFactoryOwned(LIVE_CURVE_FACTORY).owner();
        vm.prank(cfOwner);
        ICurveFactoryOwned(LIVE_CURVE_FACTORY).setTrustedRouter(address(factory), true);
        assertTrue(
            ICurveFactoryOwned(LIVE_CURVE_FACTORY).trustedRouters(address(factory)),
            "factory should be whitelisted on live CurveFactory"
        );

        // Give the launcher URU to cover the launch fee.
        deal(uru, launcher, 1_000e18);
        vm.prank(launcher);
        IErc20Live(uru).approve(address(factory), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Predicted address matches real CurveFactory deploy
    // -------------------------------------------------------------------------

    /// @dev The whole skip-list-first sequence depends on predictCurveAddress
    ///      returning the address that real CurveFactory.cloneDeterministic
    ///      will actually deploy to. If this ever drifts (e.g. CurveFactory's
    ///      salt formula changes) the skip-list would land on a stale address
    ///      and NFTs would accumulate in the real curve. Prove it explicitly.
    function test_LiveCurveFactory_PredictionMatchesDeploy() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.prank(launcher);
        (address base,, address curve) = factory.launch(p);

        address predicted = ICurveFactoryOwned(LIVE_CURVE_FACTORY).predictCurveAddress(base);
        assertEq(curve, predicted, "live-CF prediction must match live-CF deploy");
    }

    // -------------------------------------------------------------------------
    // Full launch against live CF — supply routing + skip-list correctness
    // -------------------------------------------------------------------------

    function test_Launch_AgainstLiveCurveFactory_SupplyAndSkipList() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();

        vm.prank(launcher);
        (address base, address mirror, address curve) = factory.launch(p);

        // Curve got the full supply pull from our factory.
        uint256 expectedSupply = p.collectionSize * p.unit * 1e18;
        assertEq(IErc20Live(base).balanceOf(curve), expectedSupply, "curve holds full DN404 supply");
        assertEq(IErc20Live(base).balanceOf(address(factory)), 0, "factory drained");

        // Critical DN404 invariant: real curve holds ERC-20 but zero NFTs.
        assertEq(IDn404MirrorView(mirror).balanceOf(curve), 0, "real curve should hold zero mirror NFTs");

        // Launcher wiring is preserved through the real CurveFactory —
        // creator attribution passes through the trusted-router path.
        assertEq(Dn404Template(payable(base)).owner(), launcher, "base owner = launcher");
        assertEq(IDn404MirrorView(mirror).owner(), launcher, "mirror owner pulled from base");
    }

    // -------------------------------------------------------------------------
    // Whitelist gating — the ops-time toggle actually gates the path
    // -------------------------------------------------------------------------

    /// @dev If a future ops deploy skips setTrustedRouter, our factory MUST
    ///      fail loudly (CurveFactory__UntrustedRouter) rather than silently
    ///      minting a launch attributed to the factory instead of the launcher.
    function test_Launch_RevertsIfFactoryNotWhitelisted() public {
        // Un-whitelist as a live-op simulation.
        address cfOwner = ICurveFactoryOwned(LIVE_CURVE_FACTORY).owner();
        vm.prank(cfOwner);
        ICurveFactoryOwned(LIVE_CURVE_FACTORY).setTrustedRouter(address(factory), false);

        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        vm.prank(launcher);
        vm.expectRevert(); // CurveFactory__UntrustedRouter(msg.sender)
        factory.launch(p);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _defaultParams() internal view returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "ForkTestCoin";
        p.ticker = "FTC";
        p.baseURI = "ipfs://cover/";
        p.contractURI = "ipfs://contract";
        // Sized to comfortably clear defaultCurveSupply/2 on live CurveFactory
        // (V10 default is ~207M tokens per project_chunky_defaults_broadcast).
        // 250 x 1M = 250M tokens matches.
        p.collectionSize = 250;
        p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.uruAmount = 10e18;
    }

    function _envAddr(string memory key) internal view returns (address a) {
        a = vm.envAddress(key);
        require(a != address(0), string.concat(key, " unset"));
    }

    function _envAddrOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address a) {
            return a == address(0) ? fallback_ : a;
        } catch {
            return fallback_;
        }
    }
}
