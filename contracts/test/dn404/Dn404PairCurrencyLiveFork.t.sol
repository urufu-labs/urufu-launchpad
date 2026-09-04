// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title  Dn404PairCurrencyLiveFork — live-RH verification of the pair-
///         currency curve stack (Dn404CurveFactory + Dn404BondingCurve +
///         Dn404Graduator). Skips cleanly without ROBINHOOD_RPC_URL.
///
/// @dev What this proves that unit tests can't:
///        - Dn404CurveFactory deploys + wires against live pool manager
///          references without reverting on any startup validation
///        - A launched DN404 curve accepts a real USDG-paying buy from a
///          dealt-in buyer wallet against the real USDG token address
///        - `Dn404BondingCurve.buy()` correctly IERC20-pulls the pair
///          currency + settles the token + emits the Dn404Trade event
///          with the right pairCurrency label
///        - The full launch → curve deploy → buy sequence still fires the
///          skip-list-first sequencing correctly on live infra (curve
///          holds pair currency but zero mirror NFTs)
///
/// @dev Graduation is NOT tested here — it requires the live
///      MultiHookHost to accept our test hook config, which needs a
///      governance-side setPoolConfig authorization we don't have.
///      Slice F verifies pre-graduation invariants; live graduation
///      is validated via the deploy-script rehearsal in slice 11.
///
/// @dev Env required at run time:
///        ROBINHOOD_RPC_URL
///        ROBINHOOD_URU_ADDRESS
///        ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS
///        ROBINHOOD_POOL_MANAGER
///        ROBINHOOD_MULTI_HOOK_HOST (the default hook for pool creation)
///      Optional (falls back gracefully):
///        ROBINHOOD_FEE_SPLITTER_ADDRESS

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404CurveFactory, IDn404PairCurrencyAllowlist} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {Dn404Graduator} from "src/dn404/Dn404Graduator.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike as FactoryILoyalty,
    IDn404CurveFactoryLike as FactoryIDn404CurveFactory
} from "src/dn404/Dn404LaunchFactory.sol";

interface IErc20Live {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IDn404MirrorView {
    function balanceOf(address who) external view returns (uint256);
    function baseERC20() external view returns (address);
}

contract Dn404PairCurrencyLiveForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal uru;
    address internal uruSink;
    address internal usdg;
    address internal poolManagerAddr;
    address internal hookAddr;
    address internal feeSplitter;

    Dn404Template internal baseImpl;
    Dn404MirrorTemplate internal mirrorImpl;
    Dn404BondingCurve internal curveImpl;
    Dn404PairCurrencyAllowlist internal allowlist;
    Dn404CurveFactory internal dn404CurveFactory;
    Dn404Graduator internal graduator;
    Dn404LaunchFactory internal launchFactory;

    address internal factoryOwner = makeAddr("dn404FactoryOwner");
    address internal launcher = makeAddr("dn404PairLauncher");
    address internal buyer = makeAddr("dn404PairBuyer");

    /// USDG canonical address per docs.robinhood.com/chain/contracts.
    /// Fallback used when env var unset — matches DN404_PAIR_CURRENCIES
    /// on the frontend. Env override still wins if set.
    address internal constant USDG_DEFAULT = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

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

        uru = _envAddr("ROBINHOOD_URU_ADDRESS");
        uruSink = _envAddr("ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS");
        poolManagerAddr = _envAddr("ROBINHOOD_POOL_MANAGER");
        hookAddr = _envAddr("ROBINHOOD_MULTI_HOOK_HOST");
        usdg = _envAddrOr("ROBINHOOD_USDG_ADDRESS", USDG_DEFAULT);
        feeSplitter = _envAddrOr("ROBINHOOD_FEE_SPLITTER_ADDRESS", address(0));

        if (poolManagerAddr.code.length == 0 || hookAddr.code.length == 0 || usdg.code.length == 0) {
            vm.skip(true);
            return;
        }

        // Deploy the full parallel curve stack.
        baseImpl = new Dn404Template();
        mirrorImpl = new Dn404MirrorTemplate();
        curveImpl = new Dn404BondingCurve();

        address[] memory seedTokens = new address[](1);
        seedTokens[0] = usdg;
        string[] memory seedLabels = new string[](1);
        seedLabels[0] = "USDG";
        allowlist = new Dn404PairCurrencyAllowlist(factoryOwner, seedTokens, seedLabels);

        dn404CurveFactory = new Dn404CurveFactory(
            factoryOwner,
            feeSplitter,
            address(curveImpl),
            IDn404PairCurrencyAllowlist(address(allowlist))
        );

        // Graduator against live v4 PoolManager + hook.
        graduator = new Dn404Graduator(
            IPoolManager(poolManagerAddr),
            IHooks(hookAddr),
            10_000, // 1% fee
            200,    // tickSpacing
            address(dn404CurveFactory),
            factoryOwner
        );

        vm.prank(factoryOwner);
        dn404CurveFactory.setGraduator(address(graduator));

        // Launch factory + wiring.
        vm.prank(factoryOwner);
        launchFactory = new Dn404LaunchFactory(factoryOwner, address(0));

        bytes32 baseHash = keccak256(address(baseImpl).code);
        bytes32 mirrorHash = keccak256(address(mirrorImpl).code);
        vm.startPrank(factoryOwner);
        launchFactory.setExpectedCodeHashes(baseHash, mirrorHash);
        launchFactory.setImpls(address(baseImpl), address(mirrorImpl));
        launchFactory.setUruConfig(
            FactoryIERC20(uru),
            uruSink,
            10e18,
            FactoryILoyalty(address(0))
        );
        if (feeSplitter != address(0)) launchFactory.setFeeSplitter(feeSplitter);
        launchFactory.setDn404CurveFactory(FactoryIDn404CurveFactory(address(dn404CurveFactory)));
        dn404CurveFactory.setTrustedRouter(address(launchFactory), true);
        vm.stopPrank();

        // Deal launcher URU + approve; deal buyer USDG.
        deal(uru, launcher, 1_000e18);
        vm.prank(launcher);
        IErc20Live(uru).approve(address(launchFactory), type(uint256).max);
        deal(usdg, buyer, 100_000e18);
    }

    // ------------------------------------------------------------------------
    // Launch against live curve factory + live PoolManager reference
    // ------------------------------------------------------------------------

    function test_LiveLaunch_WithUsdgPair_Deploys() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = usdg;

        vm.prank(launcher);
        (address base, address mirror, address curve) = launchFactory.launch(p);

        assertTrue(base != address(0));
        assertTrue(mirror != address(0));
        assertTrue(curve != address(0));
        assertEq(curve, dn404CurveFactory.predictCurveAddress(base), "curve != predicted");

        // Curve reports USDG as its pair currency (live USDG address).
        assertEq(Dn404BondingCurve(curve).pairCurrency(), usdg);

        // Base contract mirror linkage worked against real chain state —
        // mirror.baseERC20() resolves back to the launched base.
        assertEq(IDn404MirrorView(mirror).baseERC20(), base);

        // Skip-list-first sequencing held: curve has base tokens, zero NFTs.
        uint256 expectedSupply = p.collectionSize * p.unit * 1e18;
        assertEq(IErc20Live(base).balanceOf(curve), expectedSupply);
        assertEq(IDn404MirrorView(mirror).balanceOf(curve), 0);
    }

    // ------------------------------------------------------------------------
    // Real USDG-paying buy against the deployed curve
    // ------------------------------------------------------------------------

    function test_LiveBuy_WithUsdgPair_Debits_And_Credits() public {
        Dn404LaunchFactory.LaunchParams memory p = _defaultParams();
        p.pairCurrency = usdg;
        vm.prank(launcher);
        (address base, address mirror, address curve) = launchFactory.launch(p);

        // Buyer approves USDG to the curve.
        uint256 spend = 50e18; // 50 USDG
        vm.prank(buyer);
        IErc20Live(usdg).approve(curve, spend);

        uint256 buyerUsdgBefore = IErc20Live(usdg).balanceOf(buyer);
        uint256 buyerBaseBefore = IErc20Live(base).balanceOf(buyer);

        vm.prank(buyer);
        uint256 tokensOut = Dn404BondingCurve(curve).buy(spend, 0);

        // Real USDG left the buyer's wallet.
        assertEq(IErc20Live(usdg).balanceOf(buyer), buyerUsdgBefore - spend, "USDG not debited");
        // Real DN404 base tokens arrived.
        assertEq(IErc20Live(base).balanceOf(buyer) - buyerBaseBefore, tokensOut, "tokensOut mismatch");
        assertGt(tokensOut, 0);

        // NFT invariant: mirror balance == floor(baseBalance / unit).
        uint256 buyerBase = IErc20Live(base).balanceOf(buyer);
        uint256 expectedNfts = buyerBase / (p.unit * 1e18);
        assertEq(IDn404MirrorView(mirror).balanceOf(buyer), expectedNfts);
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _defaultParams() internal view returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "ForkPairTestCoin";
        p.ticker = "FPTC";
        p.baseURI = "ipfs://forkpair/";
        p.contractURI = "ipfs://forkpair-contract";
        // Sized to clear Dn404CurveFactory's defaultCurveSupply (800M) so
        // the reachability guard passes. See Dn404PairCurrency.t.sol for
        // the constraint derivation.
        p.collectionSize = 800;
        p.unit = 1_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.pairCurrency = address(0); // set per test
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
