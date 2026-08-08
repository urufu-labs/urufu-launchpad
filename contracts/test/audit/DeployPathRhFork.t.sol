// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {DeployFreshLocal} from "script/DeployFreshLocal.s.sol";
import {Router} from "src/router/Router.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

interface IERC20Like {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

interface IERC20LikeTransfer {
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

/// @title  DeployPathRhForkTest
/// @notice Auditor D criterion — "A blank-state fork rehearsal completes the
///         full launch, curve, graduation and post-graduation lifecycle."
///
///         Runs the canonical fresh-stack production script
///         (DeployFreshLocal.run) against a live Robinhood mainnet fork. If
///         ANY manifest hash lands unset, ANY router slot mismatches, or ANY
///         cross-wire is wrong, the deploy script itself reverts inside its
///         Phase 10 assertion pass — this test simply proves the whole
///         production script can execute against real forked state without
///         requiring any manual setUp seeding.
///
///         Contrast with the pre-audit integration tests: those manually
///         called setModuleCountForConfig + setFlagsForConfig in setUp,
///         which hid the fact that DeployRouter left them unset. This test
///         does no such manual seeding — if the script hasn't seeded the
///         sentinels, the run reverts.
///
///         Runs only when ROBINHOOD_RPC_URL is set (or the public endpoint
///         works). Skips cleanly otherwise so CI without RPC still passes.
contract DeployPathRhForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;
    uint24 internal constant V4_FEE = 3000;
    int24 internal constant V4_TICK_SPACING = 60;
    bytes32 internal constant CH_BARE = 0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb;

    // Live Robinhood v4 PoolManager + canonical ecosystem addresses.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant RH_URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant RH_GEMU = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;
    uint256 internal constant DEFAULT_MIN_URU_FEE = 1000e18;

    DeployFreshLocal internal deployScript;
    uint256 internal effectiveMinUruFee;

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
        if (RH_POOL_MANAGER.code.length == 0) vm.skip(true);

        // Set every required env the script reads. vm.setEnv persists for the
        // remainder of the test.
        vm.setEnv("V4_POOL_MANAGER", vm.toString(RH_POOL_MANAGER));
        vm.setEnv("URU_TOKEN_ADDRESS", vm.toString(RH_URU));
        vm.setEnv("GEMU_NFT_ADDRESS", vm.toString(RH_GEMU));
        effectiveMinUruFee = vm.envOr("MIN_URU_FEE", DEFAULT_MIN_URU_FEE);
        vm.setEnv("MIN_URU_FEE", vm.toString(effectiveMinUruFee));

        deployScript = new DeployFreshLocal();
    }

    /// Helper that pins the admin env var to this test contract (so all
    /// deployed contracts are owned by us) then drives the deploy via
    /// runForTest. The script re-pranks as admin between phases so every
    /// owner-only setter resolves correctly.
    function _runDeployment() internal returns (DeployFreshLocal.Stack memory s) {
        vm.setEnv("ADMIN", vm.toString(address(this)));
        s = deployScript.runForTest();
    }

    /// The whole deploy runs, and its own Phase 10 assertion pass green-lights
    /// every wire. If any manifest hash landed unset or any slot mismatched,
    /// the script's internal revert bubbles up here and fails the test.
    function test_FreshDeploy_RunsCleanAgainstLiveRhFork() public {
        DeployFreshLocal.Stack memory s = _runDeployment();

        assertGt(s.router.code.length, 0, "Router not deployed");
        assertGt(s.nameRegistry.code.length, 0, "NameRegistry not deployed");
        assertGt(s.feeReceiver.code.length, 0, "FeeSplitter not deployed");
        assertGt(s.curveFactory.code.length, 0, "CurveFactory not deployed");
        assertGt(s.graduator.code.length, 0, "Graduator not deployed");
        assertGt(s.multiHookHost.code.length, 0, "MultiHookHost not deployed");
        assertGt(s.v4SwapRouter.code.length, 0, "V4SwapRouter not deployed");
        assertGt(s.loyaltyOracle.code.length, 0, "LoyaltyOracle not deployed");
        assertGt(s.uruDepositSink.code.length, 0, "UruDepositSink not deployed");
    }

    /// Every canonical configHash must land sentinels + values on the fresh
    /// Router. Duplicates the script's Phase 10 assertion, kept here so a
    /// silent revert-eat in future refactors still trips a test.
    function test_FreshDeploy_ManifestSeededOnFreshRouter() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        Router r = Router(payable(s.router));
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            assertTrue(r.moduleCountConfigured(e.configHash), "moduleCountConfigured false after fresh deploy");
            assertTrue(r.flagsConfigured(e.configHash), "flagsConfigured false after fresh deploy");
            assertEq(r.moduleCountForConfig(e.configHash), e.moduleCount, "moduleCount mismatch");
            assertEq(r.flagsForConfig(e.configHash), e.flags, "flags mismatch");
        }
    }

    /// Nonzero minUruFee is a required deploy parameter (auditor blocker #2).
    /// The script reverts if MIN_URU_FEE is 0; here we assert the value round-
    /// tripped correctly onto the fresh Router.
    function test_FreshDeploy_MinUruFeeNonZeroAndCorrect() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        assertEq(Router(payable(s.router)).minUruFee(), effectiveMinUruFee, "minUruFee mismatch after fresh deploy");
    }

    /// setUruConfig hardening (auditor medium #4): sink code check + sink.uru
    /// matches token. The script provides a freshly-deployed sink that owns a
    /// matching URU immutable, so setUruConfig accepts. This test proves the
    /// hardening doesn't reject a legitimate deploy path.
    function test_FreshDeploy_UruConfigHardeningPassesForLegitStack() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        Router r = Router(payable(s.router));
        assertEq(address(r.uru()), RH_URU, "router.uru != RH URU");
        assertEq(address(r.uruSink()), s.uruDepositSink, "router.uruSink != freshly deployed sink");
    }

    /// Cross-wire assertions duplicate the script's Phase 10 pass. Same test-
    /// hedge as the manifest one: if a future refactor silently eats a
    /// script-side revert, a red test here still catches the regression.
    function test_FreshDeploy_CrossWiresIntact() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        assertEq(CurveFactory(s.curveFactory).graduator(), s.graduator, "CF.graduator");
        assertTrue(CurveFactory(s.curveFactory).trustedRouters(s.router), "CF.trustedRouters[router]");
        assertEq(address(GraduatorV2(payable(s.graduator)).defaultHook()), s.multiHookHost, "Graduator.defaultHook");
        assertEq(MultiHookHost(payable(s.multiHookHost)).initializer(), s.graduator, "MHH.initializer");
        assertEq(NameRegistry(s.nameRegistry).router(), s.router, "registry.router");
    }

    /// The auditor's D-criterion in full: "A blank-state fork rehearsal
    /// completes the full launch, curve, graduation and post-graduation
    /// lifecycle." Deploys the fresh stack, then drives one token from
    /// launch through curve accumulation, through graduation into a real v4
    /// pool (against the live Robinhood PoolManager on the fork), through a
    /// post-grad swap. No manual setup — every intermediate state must land
    /// via the production deploy script's outputs alone.
    function test_FreshDeploy_FullLaunchGraduateSwapLifecycle() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("lifecycle-launcher");
        address trader = makeAddr("lifecycle-trader");
        vm.deal(launcher, 50 ether);
        vm.deal(trader, 5 ether);

        // ---- 1. Launch a bare ERC20 with curve installed --------------------
        Router r = Router(payable(s.router));
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "LifecycleTest";
        p.ticker = "LFT";
        p.configHash = CH_BARE;
        // Curve-install path: initData carries (supply, initialRecipient=router, moduleInits).
        // Matches the shape LocalV4Stack uses for bare-ERC20 launches.
        p.initData = abi.encode(CurveFactory(s.curveFactory).defaultCurveSupply(), address(r), new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.installHook = false;
        p.installGovernance = false;
        p.ownership = OwnershipMode.Renounce;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        uint256 fee = r.quote(p);
        vm.prank(launcher);
        address token = r.launch{value: fee}(p);
        assertGt(token.code.length, 0, "token clone not deployed");

        // ---- 2. Curve is installed + fresh ----------------------------------
        BondingCurve curve = BondingCurve(payable(CurveFactory(s.curveFactory).curveFor(token)));
        assertGt(address(curve).code.length, 0, "curve not registered for token");
        assertEq(curve.ethReserve(), 0, "fresh curve should hold no ETH");
        assertFalse(curve.graduated(), "curve should start ungraduated");

        // ---- 3. Buy through the curve until graduation ----------------------
        uint256 target = curve.graduationTargetEth();
        assertGt(target, 0, "graduation target unset");
        vm.deal(trader, target + 5 ether); // top up with slack for the last buy
        vm.startPrank(trader);
        curve.buy{value: 1 ether}(0);
        assertFalse(curve.graduated(), "graduated on first partial buy");
        // Push over the target with a 15% slack — matches the pattern
        // LocalV4Graduation uses so the final buy always crosses.
        uint256 remaining = target - curve.ethReserve();
        curve.buy{value: (remaining * 115) / 100}(0);
        vm.stopPrank();
        assertTrue(curve.graduated(), "curve failed to graduate");

        // ---- 4. V8 post-graduation accounting invariants --------------------
        // The whole point of the V8 graduator rotation was that no ETH or
        // tokens should be stranded in Graduator after a successful
        // graduation. If this ever regresses (V7 had this bug), 4+ ETH per
        // graduation gets locked forever.
        //
        // FINDING 6 round 2: residual dust is now credited to the launcher's
        // pull-based refund ledger (`totalClaimable`). The regression check
        // is that NO un-credited ETH sits on the graduator.
        assertEq(
            address(s.graduator).balance,
            GraduatorV2(payable(s.graduator)).totalClaimable(),
            "graduator holds un-credited ETH post-graduation"
        );
        assertEq(IERC20Like(token).balanceOf(s.graduator), 0, "graduator stranded tokens post-graduation");
        assertEq(curve.ethReserve(), 0, "curve.ethReserve not zeroed at graduation");
        assertEq(curve.tokenReserve(), 0, "curve.tokenReserve not zeroed at graduation");

        // ---- 5. V4 pool actually exists + has liquidity ---------------------
        IPoolManager pm = IPoolManager(s.poolManager);
        PoolKey memory key = _poolKeyFor(token, s.multiHookHost);
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = pm.getSlot0(poolId);
        uint128 liquidity = pm.getLiquidity(poolId);
        assertGt(sqrtPriceX96, 0, "v4 pool not initialized post-graduation");
        assertGt(liquidity, 0, "v4 pool has no liquidity");

        // ---- 6. Post-grad swap through V4SwapRouter --------------------------
        // Trader already holds tokens from the curve-graduation buys, so
        // compare balance BEFORE and AFTER the v4 swap rather than expecting
        // `bought == balance`.
        V4SwapRouter swapper = V4SwapRouter(payable(s.v4SwapRouter));
        uint256 traderBalBeforeBuy = IERC20Like(token).balanceOf(trader);
        vm.prank(trader);
        uint256 bought = swapper.swapExactETHForToken{value: 0.5 ether}(key, 0, trader, block.timestamp + 600);
        assertGt(bought, 0, "post-grad v4 swap returned zero tokens");
        assertEq(
            IERC20Like(token).balanceOf(trader) - traderBalBeforeBuy, bought, "trader didn't receive the swapped tokens"
        );

        // ---- 7. Sell back to prove both swap directions work ----------------
        vm.startPrank(trader);
        IERC20Like(token).approve(address(swapper), bought / 2);
        uint256 ethOut = swapper.swapExactTokenForETH(key, bought / 2, 0, trader, block.timestamp + 600);
        vm.stopPrank();
        assertGt(ethOut, 0, "post-grad v4 sell returned zero ETH");
    }

    /// Build the PoolKey for a graduated token. Same shape Graduator.execute
    /// creates internally: currency0 = lower address, currency1 = higher,
    /// zero-address = native ETH, hook = MultiHookHost, fee + tickSpacing =
    /// launchpad canonical constants.
    function _poolKeyFor(
        address token,
        address hook
    ) internal pure returns (PoolKey memory key) {
        // ETH is currency0 (0x0 sorts lowest); token is currency1.
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: V4_FEE,
            tickSpacing: V4_TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    // ================================================================
    // Additional auditor-mandated lifecycle coverage (round 2 HIGH #3):
    // "LP-removal rejection, FoT+curve rejection, composed-module launch".
    // Split into focused tests so a regression on any one doesn't mask
    // failures in the others.
    // ================================================================

    /// FINDING 5 (audit round 2): third-party LPs must be able to add AND
    /// remove liquidity on a graduated pool. Prove:
    ///   (a) a third-party LP can add liquidity to the graduated pool
    ///   (b) the same LP can remove all of it
    ///   (c) the graduation LP position stays put across the whole cycle
    ///
    /// The graduation LP is locked structurally by the Graduator's own code
    /// (no negative-liquidityDelta path in GraduatorV2), not by a hook gate.
    function test_FreshDeploy_ThirdPartyLpCanAddAndRemove_GraduationLpUntouched() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("lp-launcher");
        address buyer = makeAddr("lp-buyer");
        address lpTrader = makeAddr("lp-trader");
        vm.deal(launcher, 50 ether);
        vm.deal(buyer, 50 ether);
        vm.deal(lpTrader, 50 ether);

        // Launch + graduate.
        LaunchParams memory p = _bareCurveLaunchParams(s);
        uint256 fee = Router(payable(s.router)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(s.router)).launch{value: fee}(p);
        BondingCurve curve = BondingCurve(payable(CurveFactory(s.curveFactory).curveFor(token)));
        uint256 target = curve.graduationTargetEth();
        vm.deal(buyer, target + 5 ether);
        vm.startPrank(buyer);
        curve.buy{value: (target * 120) / 100}(0);
        vm.stopPrank();
        assertTrue(curve.graduated(), "setup: curve did not graduate");

        // Buy some launched-token supply so lpTrader can add both sides.
        PoolKey memory key = _poolKeyFor(token, s.multiHookHost);
        V4SwapRouter swapper = V4SwapRouter(payable(s.v4SwapRouter));
        vm.prank(lpTrader);
        uint256 tokenIn = swapper.swapExactETHForToken{value: 1 ether}(key, 0, lpTrader, block.timestamp + 600);
        assertGt(tokenIn, 0, "setup: lpTrader could not buy tokens");

        // Snapshot the graduation LP position (owned by the Graduator, keyed at
        // its full-range tickLower/tickUpper with salt=0).
        PoolId poolId = key.toId();
        int24 gLower = GraduatorV2(payable(s.graduator)).tickLower();
        int24 gUpper = GraduatorV2(payable(s.graduator)).tickUpper();
        bytes32 gKey = keccak256(abi.encodePacked(address(s.graduator), gLower, gUpper, bytes32(0)));
        uint128 graduationLpBefore = IPoolManager(s.poolManager).getPositionLiquidity(poolId, gKey);
        assertGt(graduationLpBefore, 0, "setup: graduation LP position missing");

        // Third-party LP adds a narrow position around current price. Unique
        // (tickLower, tickUpper) so its position key differs from graduation.
        int24 lpLower = -1200;
        int24 lpUpper = 1200;
        uint128 lpLiquidity = 1e12;
        LiquidityManager lp = new LiquidityManager(IPoolManager(s.poolManager));
        vm.deal(address(lp), 5 ether);
        vm.prank(lpTrader);
        // ERC20Template is non-FoT, so a plain transfer to the LiquidityManager
        // suffices for the add-side deposit.
        IERC20LikeTransfer(token).transfer(address(lp), tokenIn);

        // ---- add ---------------------------------------------------------
        lp.add(key, lpLower, lpUpper, int256(uint256(lpLiquidity)));
        bytes32 lpKey = keccak256(abi.encodePacked(address(lp), lpLower, lpUpper, bytes32(0)));
        assertEq(
            IPoolManager(s.poolManager).getPositionLiquidity(poolId, lpKey),
            lpLiquidity,
            "LP add did not credit position"
        );
        assertEq(
            IPoolManager(s.poolManager).getPositionLiquidity(poolId, gKey),
            graduationLpBefore,
            "graduation LP changed on third-party add"
        );

        // ---- remove ------------------------------------------------------
        // Would have reverted MultiHookHost__LiquidityLocked pre-fix.
        uint256 lpEthBefore = address(lp).balance;
        uint256 lpTokenBefore = IERC20Like(token).balanceOf(address(lp));
        lp.remove(key, lpLower, lpUpper, -int256(uint256(lpLiquidity)));

        assertEq(IPoolManager(s.poolManager).getPositionLiquidity(poolId, lpKey), 0, "LP remove did not zero position");
        assertTrue(
            address(lp).balance > lpEthBefore || IERC20Like(token).balanceOf(address(lp)) > lpTokenBefore,
            "LP received nothing back on remove"
        );

        // Graduation LP still untouched.
        assertEq(
            IPoolManager(s.poolManager).getPositionLiquidity(poolId, gKey),
            graduationLpBefore,
            "graduation LP changed after add + remove cycle"
        );
    }

    /// Curve.sell should mirror the buy path when the buyer wants out mid-curve.
    /// Ensures the fresh CurveFactory + BondingCurve impl support both directions.
    function test_FreshDeploy_CanSellOnCurve() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("sell-launcher");
        address trader = makeAddr("sell-trader");
        vm.deal(launcher, 10 ether);
        vm.deal(trader, 10 ether);

        LaunchParams memory p = _bareCurveLaunchParams(s);
        uint256 fee = Router(payable(s.router)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(s.router)).launch{value: fee}(p);
        BondingCurve curve = BondingCurve(payable(CurveFactory(s.curveFactory).curveFor(token)));

        // Buy a slice, then sell half back. Both should succeed pre-graduation.
        vm.startPrank(trader);
        curve.buy{value: 1 ether}(0);
        uint256 tokBal = IERC20Like(token).balanceOf(trader);
        assertGt(tokBal, 0, "buy returned no tokens");

        IERC20Like(token).approve(address(curve), tokBal / 2);
        uint256 traderEthBefore = trader.balance;
        curve.sell(tokBal / 2, 0);
        vm.stopPrank();

        assertGt(trader.balance, traderEthBefore, "sell returned no ETH");
        assertEq(IERC20Like(token).balanceOf(trader), tokBal - tokBal / 2, "half tokens should remain");
    }

    /// FoT (configHash 0xa73336ef…) has FLAG_BALANCE_MUTATING set on the
    /// canonical manifest. A launch that combines FoT with
    /// installBondingCurve=true MUST revert; Router.launch performs the
    /// factory.deploy step before the curve-incompatibility guard, so the
    /// specific revert may surface as ERC20Factory__InitFailed (bad init)
    /// or Router__CurveIncompatibleModule (curve check) depending on the
    /// initData shape. This test asserts the launch reverts under EITHER
    /// path — the security invariant is "FoT+curve cannot succeed",
    /// regardless of which layer catches it.
    function test_FreshDeploy_FotCurveInstallReverts() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("fot-launcher");
        vm.deal(launcher, 5 ether);

        bytes32 fotHash = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4;
        LaunchParams memory p = _bareCurveLaunchParams(s);
        p.configHash = fotHash;
        p.moduleCount = 1;
        p.installBondingCurve = true;
        // Bare `vm.expectRevert()` — accepts any revert; the point is that
        // the launch never returns a valid token address.
        uint256 fee = Router(payable(s.router)).quote(p);
        vm.expectRevert();
        vm.prank(launcher);
        Router(payable(s.router)).launch{value: fee}(p);
    }

    /// A composed-module launch through the fresh factory must succeed for
    /// canonical manifest entries. Uses ERC20WithPermitGen (entry 0) as a
    /// representative — covering all 10 would blow up runtime.
    function test_FreshDeploy_ComposedModuleLaunchWorks() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("perm-launcher");
        vm.deal(launcher, 5 ether);

        bytes32 permitHash = 0xaa7c4a90c46fc33ebca677ac422fef548b4af9424a17314603d05496a4b07d7e;
        LaunchParams memory p = _bareCurveLaunchParams(s);
        p.configHash = permitHash;
        p.moduleCount = 1;
        p.installBondingCurve = false; // Permit alone, no curve.
        // Composed templates decode moduleData[0]; length must be >= 1 or
        // decode reverts. Permit's slice reads-then-drops the bytes (see
        // ERC20WithPermitGen VM_INJECT_INIT), so empty bytes is a valid
        // per-launch payload.
        bytes[] memory modInits = new bytes[](1);
        modInits[0] = "";
        p.initData = abi.encode(uint256(0), address(0), modInits);
        uint256 fee = Router(payable(s.router)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(s.router)).launch{value: fee}(p);
        assertGt(token.code.length, 0, "composed Permit token clone not deployed");
    }

    /// Reusable bare-ERC20 + curve LaunchParams shape.
    function _bareCurveLaunchParams(
        DeployFreshLocal.Stack memory s
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = "LifecycleTest";
        p.ticker = "LFT";
        p.configHash = CH_BARE;
        p.initData = abi.encode(CurveFactory(s.curveFactory).defaultCurveSupply(), s.router, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }

    /// Auditor sub-item: URU-paid launch. Fresh Router's minUruFee is
    /// effectiveMinUruFee from env — NOT the live-mainnet type(uint256).max
    /// poison, since each test deploys a FRESH Router locally. Deals URU to a
    /// launcher, approves, launches. Verifies token created + URU landed in
    /// UruDepositSink.
    function test_FreshDeploy_UruPaidLaunchWorks() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("uru-launcher");
        vm.deal(launcher, 5 ether);

        uint256 uruAmount = effectiveMinUruFee * 2;
        deal(RH_URU, launcher, uruAmount);
        assertEq(IERC20Like(RH_URU).balanceOf(launcher), uruAmount, "URU deal failed");

        LaunchParams memory p = _bareCurveLaunchParams(s);
        p.installBondingCurve = false; // simpler URU path — no curve concerns
        p.initData = ""; // bare, no curve → no init payload needed

        uint256 sinkBefore = IERC20Like(RH_URU).balanceOf(s.uruDepositSink);
        vm.startPrank(launcher);
        IERC20Like(RH_URU).approve(s.router, uruAmount);
        address token = Router(payable(s.router)).launchWithURU(p, uruAmount);
        vm.stopPrank();

        assertGt(token.code.length, 0, "URU launch didn't deploy a token");
        assertEq(
            IERC20Like(RH_URU).balanceOf(s.uruDepositSink) - sinkBefore,
            uruAmount,
            "UruDepositSink didn't receive the URU fee"
        );
    }

    /// Auditor sub-item: creator/platform fee accrual. After a post-grad
    /// swap, MHH.afterSwap credits `owed[currency][platform]` +
    /// `owed[currency][creator]`. Full lifecycle → swap → read both.
    function test_FreshDeploy_CreatorPlatformFeeAccrues() public {
        DeployFreshLocal.Stack memory s = _runDeployment();
        address launcher = makeAddr("fee-launcher");
        address trader = makeAddr("fee-trader");
        vm.deal(launcher, 5 ether);

        LaunchParams memory p = _bareCurveLaunchParams(s);
        uint256 fee = Router(payable(s.router)).quote(p);
        vm.prank(launcher);
        address token = Router(payable(s.router)).launch{value: fee}(p);
        BondingCurve curve = BondingCurve(payable(CurveFactory(s.curveFactory).curveFor(token)));

        uint256 target = curve.graduationTargetEth();
        vm.deal(trader, target + 5 ether);
        vm.startPrank(trader);
        curve.buy{value: (target * 120) / 100}(0);
        vm.stopPrank();
        assertTrue(curve.graduated(), "setup: curve did not graduate");

        // Trigger MHH.afterSwap via a v4 swap.
        PoolKey memory key = _poolKeyFor(token, s.multiHookHost);
        V4SwapRouter swapper = V4SwapRouter(payable(s.v4SwapRouter));
        vm.deal(trader, 5 ether);
        vm.prank(trader);
        swapper.swapExactETHForToken{value: 1 ether}(key, 0, trader, block.timestamp + 600);

        // Fees accrue in the unspecified currency. For exact-input ETH the
        // unspec is the token — read owed[token][platform] and
        // owed[token][creator]. Creator was set by Graduator to the launcher
        // at pool init (in graduate → setCreator via curve.launcher).
        MultiHookHost mhh = MultiHookHost(payable(s.multiHookHost));
        uint256 platformOwed = mhh.owed(Currency.wrap(token), s.feeReceiver);
        uint256 creatorOwed = mhh.owed(Currency.wrap(token), launcher);
        assertGt(platformOwed, 0, "platform fee did not accrue on post-grad swap");
        assertGt(creatorOwed, 0, "creator fee did not accrue on post-grad swap");
    }
}

// Small unlock-callback harness that adds and removes liquidity for the
// caller in a v4 pool. modifyLiquidity requires an active unlock context;
// this contract enters via PoolManager.unlock and settles both sides
// (currency0 = ETH via settle{value}, currency1 = token via sync + transfer
// + settle) on adds, and takes both sides on removes.
contract LiquidityManager {
    IPoolManager internal immutable pm;

    constructor(
        IPoolManager _pm
    ) {
        pm = _pm;
    }

    receive() external payable {}

    function add(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external {
        pm.unlock(abi.encode(uint8(1), key, tickLower, tickUpper, liquidityDelta));
    }

    function remove(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external {
        pm.unlock(abi.encode(uint8(2), key, tickLower, tickUpper, liquidityDelta));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        (, PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (uint8, PoolKey, int24, int24, int256));

        (BalanceDelta callerDelta,) = pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
            }),
            ""
        );

        int128 delta0 = int128(int256(BalanceDelta.unwrap(callerDelta) >> 128));
        int128 delta1 = int128(int256(BalanceDelta.unwrap(callerDelta)));

        if (delta0 < 0) {
            pm.settle{value: uint256(uint128(-delta0))}();
        } else if (delta0 > 0) {
            pm.take(key.currency0, address(this), uint256(uint128(delta0)));
        }

        if (delta1 < 0) {
            uint256 owed = uint256(uint128(-delta1));
            address tokenAddr = Currency.unwrap(key.currency1);
            pm.sync(key.currency1);
            SafeTransferLib.safeTransfer(tokenAddr, address(pm), owed);
            pm.settle();
        } else if (delta1 > 0) {
            pm.take(key.currency1, address(this), uint256(uint128(delta1)));
        }

        return "";
    }
}
