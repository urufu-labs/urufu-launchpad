// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

interface IFactoryOwned {
    function owner() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function implFor(
        bytes32
    ) external view returns (address);
}

interface ICurveFactoryOwned {
    function owner() external view returns (address);
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function curveFor(
        address token
    ) external view returns (address);
}

interface IERC20Metadata {
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// @notice Fork test that exercises the full whitelisted-curve launch flow through
///         Router on Robinhood. Proves the launchWithWhitelist entry actually
///         installs a WL curve, that eligible wallets can buy the reserved slice via
///         proof, and non-eligible wallets can't drain past the public cap.
///
///         Same pipeline setup as RhUruPayE2eForkTest (Flywheel + Router + wire
///         factories + repoint NameRegistry). Adds a live WL launch on top.
contract RhWhitelistLaunchE2eForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant OLD_ROUTER = 0x50200Eda4693f4b839d8c436D42568B5e92EADE3;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    /// The RH-deployed CurveFactory address — kept as reference. This test does NOT
    /// use it because the on-chain factory doesn't have `createCurveWithConfigForWl`.
    /// We deploy a fresh WL-aware CurveFactory (+ fresh BondingCurve impl) in setUp
    /// and point Router at that instead. Same pattern will be needed for real RH
    /// deploy — a SetChunkyDefaults step tracked as a follow-up task.
    address internal constant OLD_CURVE_FACTORY = 0xFF0b02818B0d39Bd43019b2ceb2d952C29dD851c;
    /// Existing RH Graduator — WL launches reuse this; hook migration is orthogonal.
    address internal constant RH_GRADUATOR = 0x426294dC9afFEF39033412611433f91f59438Ac9;
    /// Existing RH MultiHookHost (V3) — graduated pools land here since the existing
    /// Graduator is wired to it. Full hook-migration is tested separately in
    /// RhHookMigrationForkTest; this WL graduation test just needs graduation to WORK
    /// against a real hook, not a specific fee-routing outcome.
    address internal constant RH_MULTIHOOK = 0x5295Ee9c86A40667A46C525A99931a29c354e2C4;
    address internal constant V4_SWAP_ROUTER = 0x96E040a16A8B8B17a7896BDbDf02978895368bf6;

    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;
    address internal constant UNI_UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    bytes32 internal constant BARE_ERC20_CONFIG = keccak256(abi.encode("ERC20", ""));

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal launcher = makeAddr("launcher");
    address internal alice = makeAddr("alice"); // WL member
    address internal bob = makeAddr("bob"); // WL member
    address internal carol = makeAddr("carol"); // NOT on WL

    FeeSplitter internal splitter;
    UruDepositSink internal uruSink;
    Router internal routerV2;
    /// Fresh WL-aware CurveFactory — replaces the RH-deployed one for launches through RouterV2.
    CurveFactory internal newCurveFactory;

    bytes32 internal wlRoot;
    bytes32[] internal aliceProof;
    bytes32[] internal bobProof;
    uint64 internal FALLBACK_TS;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (NAME_REGISTRY.code.length == 0 || OLD_CURVE_FACTORY.code.length == 0) vm.skip(true);

        _deployNewCurveFactory();
        _deployPipeline();
        _buildMerkleTree();

        FALLBACK_TS = uint64(block.timestamp + 7 days);
        vm.deal(launcher, 10 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    /// Deploy a fresh WL-aware CurveFactory + BondingCurve impl. Wires the same
    /// graduator that RH already uses so graduated pools land at the existing
    /// MultiHookHost. Real deploy needs the equivalent as a SetChunkyDefaults
    /// script (tracked as a follow-up task).
    function _deployNewCurveFactory() internal {
        BondingCurve impl = new BondingCurve();
        vm.startPrank(admin);
        newCurveFactory = new CurveFactory(admin, admin, address(impl));
        newCurveFactory.setGraduator(RH_GRADUATOR);
        // Defaults intentionally left at CurveFactory's built-in values; matches
        // pump.fun-style bonding curve shape.
        vm.stopPrank();
    }

    function _deployPipeline() internal {
        vm.startPrank(admin);
        splitter = new FeeSplitter(admin, treasury, 2 days);
        NftRevenueVault nftVault = new NftRevenueVault(admin);
        UruBuybackVault buybackVault = new UruBuybackVault(admin, URU_TOKEN, address(nftVault), 2 days);
        buybackVault.setKeeper(keeper, true);
        buybackVault.setSwapTarget(UNI_UR, true);
        vm.warp(block.timestamp + splitter.minConfigDelay() + 1);
        splitter.setConfig(address(buybackVault), address(nftVault), treasury, 4000, 3500, 2500);

        LoyaltyOracle oracle = new LoyaltyOracle(admin, URU_TOKEN, GEMU_NFT, 100_000e18);
        uruSink = new UruDepositSink(admin, URU_TOKEN, address(splitter), 2 days);

        Router old = Router(payable(OLD_ROUTER));
        routerV2 = new Router(
            admin,
            NameRegistry(NAME_REGISTRY),
            IFeeReceiver(address(splitter)),
            old.fees(BaseType.ERC20),
            old.fees(BaseType.ERC721A),
            old.fees(BaseType.ERC1155),
            old.moduleAddOnFee(),
            old.hookAddOnFee(),
            old.governanceAddOnFee()
        );
        routerV2.setUruConfig(URU_TOKEN, address(uruSink));
        routerV2.setFactory(BaseType.ERC20, ERC20_FACTORY);
        routerV2.setFactory(BaseType.ERC721A, ERC721A_FACTORY);
        routerV2.setFactory(BaseType.ERC1155, ERC1155_FACTORY);
        routerV2.setCurveFactory(address(newCurveFactory)); // ← the fresh WL-aware one
        routerV2.setLoyaltyOracle(address(oracle));
        // Audit remediation #3 (fail-closed sentinels) — must seed BARE_ERC20
        // config on the fresh router so launch/quote pass the moduleCount +
        // flags gates.
        routerV2.setModuleCountForConfig(BARE_ERC20_CONFIG, 1);
        routerV2.setFlagsForConfig(BARE_ERC20_CONFIG, 0);
        vm.stopPrank();

        _authorizeOnFactory(ERC20_FACTORY);
        _authorizeOnFactory(ERC721A_FACTORY);
        _authorizeOnFactory(ERC1155_FACTORY);
        // The fresh factory is admin-owned; add Router as trusted without pranking.
        vm.prank(admin);
        newCurveFactory.setTrustedRouter(address(routerV2), true);
        address regOwner = _ownerOf(NAME_REGISTRY);
        vm.prank(regOwner);
        (bool ok,) = NAME_REGISTRY.call(abi.encodeWithSignature("setRouter(address)", address(routerV2)));
        require(ok);
    }

    function _authorizeOnFactory(
        address factory
    ) internal {
        address own = IFactoryOwned(factory).owner();
        vm.prank(own);
        IFactoryOwned(factory).setRouter(address(routerV2));
    }

    function _ownerOf(
        address c
    ) internal view returns (address) {
        (bool ok, bytes memory ret) = c.staticcall(abi.encodeWithSignature("owner()"));
        require(ok);
        return abi.decode(ret, (address));
    }

    /// 2-address Merkle tree — smallest tree that still exercises the proof mechanics.
    function _buildMerkleTree() internal {
        bytes32 lA = keccak256(abi.encodePacked(alice));
        bytes32 lB = keccak256(abi.encodePacked(bob));
        wlRoot = lA < lB ? keccak256(abi.encodePacked(lA, lB)) : keccak256(abi.encodePacked(lB, lA));
        aliceProof = new bytes32[](1);
        aliceProof[0] = lB;
        bobProof = new bytes32[](1);
        bobProof[0] = lA;
    }

    function _wlLaunchParams(
        string memory tokenName,
        string memory ticker
    ) internal pure returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: tokenName,
            ticker: ticker,
            configHash: BARE_ERC20_CONFIG,
            // 800M initial supply — matches CurveFactory's default curveSupply so the
            // reservedTokens config (~25% = 200M) fits comfortably.
            initData: abi.encode(uint256(800_000_000e18), address(0), new bytes[](0)),
            moduleCount: 0,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true, // WL requires curve
            ownership: OwnershipMode.Renounce, // curve launches auto-renounce
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // launchWithWhitelist E2E
    // =========================================================

    function test_LaunchWithWhitelist_HappyPath() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        uint256 fee = routerV2.fees(BaseType.ERC20);

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 200_000_000e18, // 25% of default 800M curve supply
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: URU_TOKEN, // pretend WL is for URU holders
            sourceChainId: 4663,
            declaredHolderCount: 2
        });

        LaunchParams memory p = _wlLaunchParams("WL Launch", "WLLAUNCH");

        vm.prank(launcher);
        address token = routerV2.launchWithWhitelist{value: fee}(p, wl);

        // Curve was installed with WL config wired.
        address curve = newCurveFactory.curveFor(token);
        assertGt(curve.code.length, 0, "no curve deployed");
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.whitelistRoot(), wlRoot, "curve WL root not set");
        assertEq(bc.reservedTokens(), 200_000_000e18);
        assertEq(bc.maxWlPerAddress(), 40_000_000e18);
        assertEq(bc.fallbackTs(), FALLBACK_TS);
        assertEq(bc.sourceTokenAddress(), URU_TOKEN);
        assertEq(bc.sourceChainId(), 4663);
    }

    function test_WlBuyerCanClaimReservedSlice() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 2
        });
        LaunchParams memory p = _wlLaunchParams("WL Buy Test", "WLBUY");
        uint256 fee = routerV2.fees(BaseType.ERC20);

        vm.prank(launcher);
        address token = routerV2.launchWithWhitelist{value: fee}(p, wl);
        BondingCurve bc = BondingCurve(payable(newCurveFactory.curveFor(token)));

        // Alice (on WL) buys via proof — tokens should be held on the curve, not in her wallet.
        uint256 tokenBalBefore = IERC20Metadata(token).balanceOf(alice);
        vm.prank(alice);
        uint256 out = bc.buyWithProof{value: 0.05 ether}(aliceProof, 0);

        assertGt(out, 0, "no tokens bought");
        assertEq(IERC20Metadata(token).balanceOf(alice), tokenBalBefore, "alice got tokens directly");
        assertEq(bc.wlHeldForUser(alice), out, "wl held not tracked");
        assertEq(bc.wlSold(), out);
    }

    function test_NonWlBuyerBlockedFromReservedSlice() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 2
        });
        LaunchParams memory p = _wlLaunchParams("Non WL Test", "NONWL");
        uint256 fee = routerV2.fees(BaseType.ERC20);

        vm.prank(launcher);
        address token = routerV2.launchWithWhitelist{value: fee}(p, wl);
        BondingCurve bc = BondingCurve(payable(newCurveFactory.curveFor(token)));

        // Carol isn't on the WL — buyWithProof should reject her.
        vm.expectRevert(BondingCurve.BondingCurve__WlProofInvalid.selector);
        vm.prank(carol);
        bc.buyWithProof{value: 0.05 ether}(aliceProof, 0);

        // Time-gated design: any public `buy()` during the WL window reverts with
        // WlWindowActive — no matter the size. Even a tiny non-WL buy is blocked
        // while the exclusive window is open.
        vm.expectRevert(); // BondingCurve__WlWindowActive
        vm.prank(carol);
        bc.buy{value: 0.05 ether}(0);
    }

    function test_LaunchWithWhitelist_RevertsWhenNoCurve() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
        LaunchParams memory p = _wlLaunchParams("No Curve", "NOCURVE");
        p.installBondingCurve = false; // ← the offending flag

        // vm.prank first, then vm.expectRevert immediately before the call — Foundry
        // pairs expectRevert with the next external call, and pranks in between can
        // confuse the pairing.
        uint256 fee = routerV2.fees(BaseType.ERC20);
        vm.prank(launcher);
        vm.expectRevert(Router.Router__WlRequiresBondingCurve.selector);
        routerV2.launchWithWhitelist{value: fee}(p, wl);
    }

    // =========================================================
    // Full WL lifecycle: launch → WL buy → graduate → claim → post-grad swap
    // =========================================================

    /// Proves the held-on-curve WL design survives graduation cleanly:
    ///   1. LP mint at graduation sends only tokenReserve (not wlHeldTotal) to Uniswap
    ///   2. Curve's post-grad token balance == wlHeldTotal (the WL slice)
    ///   3. claimWl transfers those tokens to the WL buyer's wallet
    ///   4. Post-grad swaps on the graduated pool still work (hook fires, tokens flow)
    function test_WlCurve_GraduatesAndClaimsWork() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        BondingCurve.WhitelistInit memory wl = BondingCurve.WhitelistInit({
            root: wlRoot,
            reservedTokens: 200_000_000e18,
            maxWlPerAddress: 40_000_000e18,
            fallbackTs: FALLBACK_TS,
            sourceTokenAddress: URU_TOKEN,
            sourceChainId: 4663,
            declaredHolderCount: 2
        });
        LaunchParams memory p = _wlLaunchParams("Grad WL Test", "GRADWL");
        uint256 fee = routerV2.fees(BaseType.ERC20);
        vm.prank(launcher);
        address token = routerV2.launchWithWhitelist{value: fee}(p, wl);
        BondingCurve bc = BondingCurve(payable(newCurveFactory.curveFor(token)));

        // Alice WL-buys — a small amount so we don't hit the per-address cap. Tokens
        // are held on the curve, NOT transferred to her wallet.
        vm.prank(alice);
        bc.buyWithProof{value: 0.05 ether}(aliceProof, 0);
        uint256 wlHeld = bc.wlHeldForUser(alice);
        assertGt(wlHeld, 0, "alice's WL buy didn't register");
        assertEq(IERC20Metadata(token).balanceOf(alice), 0, "alice should have zero tokens pre-graduation");

        // Warp past the fallback timestamp so bob can drain the whole tokenReserve
        // (curve pricing puts a 5 ETH buy at ~707M tokens, which exceeds the 600M
        // publicCap pre-fallback → WlReservedSliceLocked. Post-fallback the reserved
        // slice merges into public and the buy fits within tokenReserve).
        vm.warp(FALLBACK_TS + 1);

        // Bob drives the curve to graduation via public buys. Size the buy off
        // the live grad target + a small buffer so the test survives CurveFactory
        // default rotations (was 4 ETH pre-chunky, 10 ETH post-chunky).
        uint256 gradTarget = bc.graduationTargetEth();
        uint256 buyValue = gradTarget + 1 ether;
        vm.deal(bob, buyValue + 5 ether);
        vm.prank(bob);
        bc.buy{value: buyValue}(0);
        assertTrue(bc.graduated(), "curve failed to graduate with WL held tokens");

        // The LP mint at graduation should have consumed tokenReserve; the WL-held
        // slice stays on the curve for claiming. Curve's balance == wlHeldTotal.
        uint256 curveBalPostGrad = IERC20Metadata(token).balanceOf(address(bc));
        assertEq(bc.wlHeldTotal(), wlHeld, "wlHeldTotal drifted from alice's held");
        assertEq(curveBalPostGrad, wlHeld, "curve's post-grad balance != wlHeldTotal");

        // Alice claims — tokens land in her wallet.
        uint256 aliceBefore = IERC20Metadata(token).balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = bc.claimWl();
        assertEq(claimed, wlHeld, "claim returned wrong amount");
        assertEq(IERC20Metadata(token).balanceOf(alice) - aliceBefore, wlHeld, "alice didn't receive tokens");
        assertEq(bc.wlHeldForUser(alice), 0, "alice's WL held not zeroed");
        assertEq(bc.wlHeldTotal(), 0, "wlHeldTotal not zeroed after claim");
        assertEq(IERC20Metadata(token).balanceOf(address(bc)), 0, "curve balance not zero after claim");

        // Post-grad swap on the graduated pool via the deployed V4SwapRouter — the
        // pool wires the existing RH MultiHookHost since we reused RH_GRADUATOR.
        // Just prove ETH→token swaps work; fee-routing coverage lives elsewhere.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(RH_MULTIHOOK)
        });
        // Fresh V4SwapRouter matching the V4 stack's fixed bytecode (deadline + slippage hoist).
        V4SwapRouter swapRouter = new V4SwapRouter(IPoolManager(payable(0x8366a39CC670B4001A1121B8F6A443A643e40951)));
        vm.deal(carol, 5 ether);
        vm.prank(carol);
        uint256 swapOut = swapRouter.swapExactETHForToken{value: 0.1 ether}(key, 0, carol, block.timestamp + 1);
        assertGt(swapOut, 0, "post-grad swap on WL-launched pool produced 0 tokens");
    }
}
