// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployV6AuditFixStack} from "script/DeployV6AuditFixStack.s.sol";
import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  V6FullLifecycleFork
/// @notice End-to-end validation of the V6 audit-fix deploy against a live RH
///         mainnet fork. Sequence:
///           1. Fork RH mainnet at head
///           2. Prank as the deployer wallet + invoke DeployV6AuditFixStack's
///              run() to deploy the full V6 stack (Router, CurveFactory, MHH,
///              Graduator) and rotate NameRegistry + factories to point at it
///           3. Assert on-chain state matches expectations post-deploy
///           4. Launch a fresh bare-ERC20 token through the V6 Router
///           5. Assert the token was actually deployed, the curve was
///              installed, and the launcher recorded correctly
///           6. Sanity-check that the V5 stack is disconnected (V5 Router
///              can't reach factories anymore)
///
///         If this test passes, the deploy script broadcast is safe to
///         execute — the same behavior will land on-chain.
contract V6FullLifecycleForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant V5_ROUTER = 0x2dfA89FF6822C53509127b4943c97A48952dD973;
    // Unchanged across V6 rotation — v4 core + launcher's own swap router + flywheel
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

    DeployV6AuditFixStack.Deployed internal v6;

    address internal launcher = makeAddr("v6-launcher");

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

        // Deploy V6 by invoking the actual deploy script's test entrypoint.
        // runForTest(DEPLOYER) tells the script to prank as DEPLOYER
        // internally for every owner-gated call. No outer prank needed
        // (would collide with the script's own vm.startPrank).
        DeployV6AuditFixStack script = new DeployV6AuditFixStack();
        vm.deal(address(script), 1 ether);
        v6 = script.runForTest(DEPLOYER);
    }

    // ============================================================
    // 1. Deploy sanity — the script's own post-deploy asserts already
    //    passed by the time run() returned, but re-check the key ones
    //    from the outside so this test is self-contained.
    // ============================================================

    function test_V6_DeployedContracts_HaveCode() public view {
        assertGt(v6.router.code.length, 0, "V6 Router missing code");
        assertGt(v6.curveFactory.code.length, 0, "V6 CurveFactory missing code");
        assertGt(v6.multiHookHost.code.length, 0, "V6 MHH missing code");
        assertGt(v6.graduator.code.length, 0, "V6 Graduator missing code");
    }

    function test_V6_Wiring_MHHInitializerIsGraduator() public view {
        // The exact invariant whose breakage stranded FDGDFVS + TIGER pre-V5.
        assertEq(
            MultiHookHost(payable(v6.multiHookHost)).initializer(), v6.graduator, "MHH.initializer must equal Graduator"
        );
    }

    function test_V6_Wiring_GraduatorPointsAtV6Stack() public view {
        assertEq(address(GraduatorV2(payable(v6.graduator)).defaultHook()), v6.multiHookHost, "grad.defaultHook");
        assertEq(address(GraduatorV2(payable(v6.graduator)).curveFactory()), v6.curveFactory, "grad.curveFactory");
    }

    function test_V6_Wiring_CurveFactoryPointsAtGraduator() public view {
        assertEq(CurveFactory(v6.curveFactory).graduator(), v6.graduator, "cf.graduator");
        assertTrue(CurveFactory(v6.curveFactory).trustedRouters(v6.router), "cf.trustedRouters[V6]");
    }

    function test_V6_Wiring_RouterPointsAtCurveFactory() public view {
        assertEq(Router(v6.router).curveFactory(), v6.curveFactory, "router.curveFactory");
    }

    function test_V6_Rotation_NameRegistryPointsAtV6Router() public view {
        // NameRegistry.router() must have rotated from V5 to V6.
        (bool ok, bytes memory ret) = NAME_REGISTRY.staticcall(abi.encodeWithSignature("router()"));
        require(ok, "NameRegistry.router() call failed");
        address current = abi.decode(ret, (address));
        assertEq(current, v6.router, "NameRegistry.router still points at V5");
        assertNotEq(current, V5_ROUTER, "NameRegistry.router still on V5");
    }

    function test_V6_Rotation_ERC20FactoryTrustsV6() public view {
        (bool ok, bytes memory ret) = ERC20_FACTORY.staticcall(abi.encodeWithSignature("router()"));
        require(ok, "ERC20Factory.router() call failed");
        address current = abi.decode(ret, (address));
        assertEq(current, v6.router, "ERC20Factory.router still points at V5");
    }

    // ============================================================
    // 2. Audit-fix behavior — verify the fixes are actually live in
    //    the deployed V6 bytecode by exercising each attack scenario
    //    against the on-chain V6 contracts.
    // ============================================================

    function test_V6_Fix2_CurveFactoryACL_RejectsUnauthorizedCaller() public {
        address attacker = makeAddr("attacker-v6");
        vm.expectRevert(abi.encodeWithSelector(CurveFactory.CurveFactory__UntrustedRouter.selector, attacker));
        vm.prank(attacker);
        CurveFactory(v6.curveFactory).createCurveWithConfigFor(address(0xdeadbeef), 0, 0, attacker);
    }

    function test_V6_Fix3_RouterModuleCount_UsesRegisteredValue() public {
        // The regression: pre-fix `_quote` used `params.moduleCount` directly,
        // letting a launcher underpay. Post-fix it MUST derive count from
        // moduleCountForConfig[hash]. Call quote() twice with mismatched
        // params.moduleCount values and require they match. If the fix was
        // reverted, they'd diverge and this asserts fails.
        bytes32 antiWhaleHash = 0x638593049fc24c8e112d3d12c307afdc8ae86f6968c7fd3baf7d6c5662b53821;
        assertEq(Router(v6.router).moduleCountForConfig(antiWhaleHash), 1, "antiwhale hash count wrong");

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.configHash = antiWhaleHash;

        p.moduleCount = 42; // caller lies
        uint256 liarQuote = Router(v6.router).quote(p);
        p.moduleCount = 1; // honest
        uint256 honestQuote = Router(v6.router).quote(p);
        assertEq(liarQuote, honestQuote, "quote must ignore caller-supplied moduleCount post-fix");
    }

    function test_V6_Fix5_FoTStructuralFlag_BlocksLaunch() public {
        // The regression: pre-fix curve install only consulted the manual
        // denylist. Post-fix it OR's the FLAG_BALANCE_MUTATING flag too.
        //
        // Live FoT hash requires exact FoT-module initData shape to survive
        // the factory-init call and reach the curve-incompatible check — too
        // brittle to encode inline. Instead we test the flag path with a
        // hash we control: take the bare ERC20 hash (whose initData is
        // trivially valid), owner-set the flag on it, explicitly ensure the
        // denylist is NOT set, then attempt a curve launch. If the fix is
        // live, the FLAG alone triggers Router__CurveIncompatibleModule.
        // If the fix were reverted, curve install would proceed (denylist=false).
        bytes32 bareHash = keccak256(abi.encode("ERC20", ""));

        vm.startPrank(DEPLOYER);
        Router(v6.router).setFlagsForConfig(bareHash, 1); // FLAG_BALANCE_MUTATING
        // Deliberately do NOT setCurveIncompatibleConfigHash — prove the
        // FLAG PATH fires, not the denylist path.
        vm.stopPrank();
        assertEq(Router(v6.router).flagsForConfig(bareHash), 1, "flag must be set");
        assertFalse(
            Router(v6.router).curveIncompatibleConfigHash(bareHash),
            "denylist must NOT be set on bareHash - would false-green through denylist path"
        );

        // Live FoT hash on prod still has both set:
        bytes32 fotHash = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4;
        assertEq(Router(v6.router).flagsForConfig(fotHash), 1, "live FoT flag missing");
        assertTrue(Router(v6.router).curveIncompatibleConfigHash(fotHash), "live FoT denylist missing");

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "FlagOnly Trap";
        p.ticker = "FLGT";
        p.configHash = bareHash;
        p.initData = abi.encode(uint256(800_000_000e18), v6.router, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        address feeSpoofer = makeAddr("fot-launcher");
        vm.deal(feeSpoofer, 10 ether);
        uint256 fee = Router(v6.router).quote(p);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, bareHash));
        vm.prank(feeSpoofer, feeSpoofer);
        Router(v6.router).launch{value: fee}(p);
    }

    // ============================================================
    // 3. V5 disconnected — confirm the OLD Router lost factory access
    //    so it can't accidentally continue serving launches. Any tx
    //    landing on V5 Router post-V6 rotation should fail.
    // ============================================================

    function test_V6_Rotation_V5RouterCannotReachERC20Factory() public view {
        // ERC20Factory.router() no longer equals V5 Router post-rotation.
        (bool ok, bytes memory ret) = ERC20_FACTORY.staticcall(abi.encodeWithSignature("router()"));
        require(ok, "ERC20Factory.router() call failed");
        address current = abi.decode(ret, (address));
        assertNotEq(current, V5_ROUTER, "V5 Router still trusted by ERC20Factory");
    }

    function test_V6_Rotation_V5RouterCannotReserveNames() public {
        // NameRegistry.reserve is Router-only. V5 Router calling reserve() should
        // revert with NotRouter now that the registry points at V6.
        vm.prank(V5_ROUTER);
        (bool ok,) = NAME_REGISTRY.call(
            abi.encodeWithSignature("reserve(string,string,address,address)", "test", "TEST", address(0x1), DEPLOYER)
        );
        assertFalse(ok, "V5 Router should no longer be able to reserve names");
    }

    // ============================================================
    // 4. End-to-end launch through V6. Uses a raw call so we can test
    //    with a minimal LaunchParams tuple without depending on the full
    //    LaunchParams struct's field layout (which may shift across
    //    RouterV2 versions). Not a full lifecycle test — the module
    //    curve graduation suite (RhV5ModuleCurveGraduationForkTest)
    //    already exercises that flow at length; we only need to prove
    //    V6 accepts a launch call and dispatches through the new stack.
    // ============================================================

    // ============================================================
    // 5. FULL LIFECYCLE on the freshly-deployed V6 stack:
    //    launch → curve buy → graduate → v4 pool → post-grad swap
    //    → fee accrual to FeeSplitter. This is the most important
    //    single test in the suite — if this fails, don't broadcast.
    // ============================================================

    function test_V6_FullLifecycle_LaunchBuyGraduateSwapFees() public {
        // PHASE 1: launch with curve installed
        uint256 curveSupply = CurveFactory(v6.curveFactory).defaultCurveSupply();
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V6 Lifecycle";
        p.ticker = "V6LC";
        p.configHash = keccak256(abi.encode("ERC20", ""));
        p.initData = abi.encode(curveSupply, v6.router, new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        vm.deal(launcher, 20 ether);
        uint256 launchFee = Router(v6.router).quote(p);
        vm.prank(launcher, launcher);
        address token = Router(v6.router).launch{value: launchFee}(p);
        assertTrue(token != address(0), "phase1: token addr zero");

        address curve = CurveFactory(v6.curveFactory).curveFor(token);
        assertTrue(curve != address(0), "phase1: curveFor zero");
        BondingCurve bc = BondingCurve(payable(curve));
        assertFalse(bc.graduated(), "phase1: curve pre-graduated");

        // PHASE 2: buy through the curve until graduation
        uint256 gradTarget = CurveFactory(v6.curveFactory).defaultGraduationTargetEth();
        uint256 buyValue = gradTarget + 0.5 ether;
        address buyer = makeAddr("v6-lc-buyer");
        vm.deal(buyer, buyValue + 1 ether);
        vm.prank(buyer);
        bc.buy{value: buyValue}(0);
        assertTrue(bc.graduated(), "phase2: curve did not graduate");
        assertEq(bc.ethReserve(), 0, "phase2: eth reserve not drained");
        assertEq(bc.tokenReserve(), 0, "phase2: token reserve not drained");

        // PHASE 3: verify v4 pool exists with V6 MHH as hook
        PoolKey memory poolKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(v6.multiHookHost)
        });
        PoolId poolId = poolKey.toId();
        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "phase3: pool not initialized");
        uint128 liquidity = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        assertGt(liquidity, 0, "phase3: pool zero liquidity");

        // PHASE 4: post-grad swap through V4SwapRouter
        address swapper = makeAddr("v6-lc-swapper");
        vm.deal(swapper, 5 ether);
        uint256 owedTokenBefore = MultiHookHost(payable(v6.multiHookHost)).owed(Currency.wrap(token), FEE_SPLITTER);
        uint256 owedEthBefore = MultiHookHost(payable(v6.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER);

        uint256 swapperTokensBefore = IERC20V(token).balanceOf(swapper);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactETHForToken{value: 0.1 ether}(
            poolKey, 1, swapper, block.timestamp + 300
        );
        uint256 swapperTokensAfter = IERC20V(token).balanceOf(swapper);
        assertGt(swapperTokensAfter, swapperTokensBefore, "phase4: swap didn't credit tokens");

        // PHASE 5: fees accrued to FeeSplitter on V6 MHH (token side from buy)
        uint256 owedTokenAfter = MultiHookHost(payable(v6.multiHookHost)).owed(Currency.wrap(token), FEE_SPLITTER);
        assertGt(owedTokenAfter, owedTokenBefore, "phase5: FeeSplitter owed[token] didn't grow");

        // Now sell to accrue ETH-side owed
        uint256 sellSize = IERC20V(token).balanceOf(swapper) / 4;
        vm.prank(swapper);
        IERC20V(token).approve(V4_SWAP_ROUTER, sellSize);
        vm.prank(swapper);
        V4SwapRouter(payable(V4_SWAP_ROUTER)).swapExactTokenForETH(poolKey, sellSize, 1, swapper, block.timestamp + 300);
        uint256 owedEthAfter = MultiHookHost(payable(v6.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER);
        assertGt(owedEthAfter, owedEthBefore, "phase5b: FeeSplitter owed[eth] didn't grow");

        // PHASE 6: claim proves the V6 MHH → FeeSplitter routing works
        vm.prank(FEE_SPLITTER);
        MultiHookHost(payable(v6.multiHookHost)).claim(Currency.wrap(address(0)));
        assertEq(
            MultiHookHost(payable(v6.multiHookHost)).owed(Currency.wrap(address(0)), FEE_SPLITTER),
            0,
            "phase6: owed[eth] not zeroed after claim"
        );
    }

    function test_V6_Launch_BareERC20_Succeeds() public {
        // Bare ERC20 (empty module set) → configHash = keccak(abi.encode('ERC20', ''))
        bytes32 bareHash = keccak256(abi.encode("ERC20", ""));

        // The bare ERC20 impl is already registered on the ERC20 factory from
        // pre-existing launches; we don't need to registerImpl here.
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "V6TestToken";
        p.ticker = "V6TT";
        p.configHash = bareHash;
        // For curve mode, initialRecipient MUST be the Router — Router receives
        // the full supply and forwards it to the CurveFactory which transfers
        // to the new curve. If we put `launcher` here, CurveFactory can't pull
        // (Router has 0 balance) and reverts NotEnoughSupply.
        bytes[] memory md = new bytes[](0);
        p.initData = abi.encode(uint256(800_000_000e18), v6.router, md);
        p.moduleCount = 0;
        p.installHook = false;
        p.installGovernance = false;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        vm.deal(launcher, 1 ether);
        uint256 quoted = Router(v6.router).quote(p);
        vm.prank(launcher, launcher);
        (bool ok,) = v6.router.call{value: quoted}(abi.encodeCall(Router.launch, (p)));
        // Note: we assert the call succeeded rather than assertEq'ing the token
        // address because the addressing depends on the factory's clone pattern
        // + the specific salt scheme used. The point is that V6 Router routes
        // the launch cleanly through V6 CurveFactory + V6 Graduator wiring.
        assertTrue(ok, "V6 launch(bare ERC20) failed - deploy wiring is broken");
    }
}
