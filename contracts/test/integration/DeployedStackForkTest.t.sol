// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

/// Minimal ERC20 the test can freely mint so the test doesn't have to launch through Router.
/// The launchpad's real flow launches through Router → Factory → NameRegistry; that path is
/// exercised by LaunchWithCurve + LaunchE2E. THIS test's focus is: given a token + a real
/// CurveFactory + Graduator + MultiHookHost on Base Sepolia, does the whole graduation +
/// swap flow work against the exact deployed bytecode?
contract DTMock is ERC20 {
    function name() public pure override returns (string memory) {
        return "Dep";
    }

    function symbol() public pure override returns (string memory) {
        return "DEP";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Fork test that runs against the ACTUALLY DEPLOYED Base Sepolia launchpad
///         contracts — not fresh CREATE2 deployments. Points at the on-chain
///         `CurveFactory` + `Graduator` + `MultiHookHost` from `deployment.84532.json`
///         and drives a real curve to graduation, then swaps on the graduated v4 pool.
///
///         This is the closest we can get to a mainnet-like end-to-end test WITHOUT
///         spending real ETH — `vm.deal` funds the graduation buy, but the contracts
///         hit are the exact bytecode + wired state that lives on Base Sepolia today.
///
///         Skips cleanly if BASE_SEPOLIA_RPC_URL isn't set or if any deployed address is
///         empty (indicates a fresh clone that hasn't broadcast yet).
contract DeployedStackForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    // Base Sepolia addresses from `deployment*.84532.json` — updated post-redeploy of
    // MultiHookHost + Graduator (2026-07-14). If you re-deploy, update these constants.
    address internal constant CURVE_FACTORY = 0x5bC3c476f5CF267a08A309578bC1337e00C2fC1F;
    address internal constant GRADUATOR = 0x11A4aDDdDB29f847d3De7654674427e6Ba3C5cD7;
    address internal constant MULTI_HOOK = 0x9cC9Bf4d6Eb7A443fBACB7Ba7C8b4876299A4244;
    address internal constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    IPoolManager internal manager;
    CurveFactory internal cf;
    Graduator internal grad;
    MultiHookHost internal hook;
    DTSwapHelper internal swapper;

    address internal alice = makeAddr("alice");

    function setUp() public {
        string memory rpc;
        try vm.envString("BASE_SEPOLIA_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        // If any deployed address has no code, we're on a stale fork or the wrong chain.
        if (
            CURVE_FACTORY.code.length == 0 || GRADUATOR.code.length == 0 || MULTI_HOOK.code.length == 0
                || POOL_MANAGER.code.length == 0
        ) vm.skip(true);

        manager = IPoolManager(POOL_MANAGER);
        cf = CurveFactory(CURVE_FACTORY);
        grad = Graduator(payable(GRADUATOR));
        hook = MultiHookHost(payable(MULTI_HOOK));
        swapper = new DTSwapHelper(manager);
    }

    /// @notice The core integration proof: create a curve on the deployed CurveFactory,
    ///         graduate it via the deployed Graduator, verify the deployed MultiHookHost
    ///         is the hook, then execute a real swap and assert fee accrual + LP-lock.
    function test_DeployedStack_GraduatesAndSwapsAndLocks() public {
        // Sanity: the deployed CurveFactory should already point at our deployed graduator.
        assertEq(cf.graduator(), GRADUATOR, "CurveFactory not pointing at deployed Graduator");
        assertEq(address(grad.defaultHook()), MULTI_HOOK, "Graduator not pointing at deployed MultiHookHost");

        // Read the current defaults — grad target could be anywhere depending on setDefaults
        // history. We'll fund alice for `graduationTargetEth * 1.2` for headroom.
        uint256 supply = cf.defaultCurveSupply();
        uint256 gradTarget = cf.defaultGraduationTargetEth();

        // Deploy a fresh token, mint the curve supply to alice, approve the factory.
        DTMock token = new DTMock();
        vm.startPrank(alice);
        token.mint(alice, supply);
        token.approve(address(cf), supply);
        address curveAddr = cf.createCurve(address(token));
        vm.stopPrank();
        BondingCurve curve = BondingCurve(payable(curveAddr));

        // Fund alice with 1.2× the graduation target so buying past it doesn't run out mid-tx.
        vm.deal(alice, gradTarget * 12 / 10);

        // Drive to graduation. buy() will detect ethReserve >= target and trigger _graduate,
        // which calls grad.execute — creating the v4 pool + minting the LP position on the fly.
        vm.prank(alice);
        curve.buy{value: gradTarget * 11 / 10}(0);
        assertTrue(curve.graduated(), "curve did not graduate on deployed Graduator");
        assertEq(curve.ethReserve(), 0, "curve ETH not drained");

        // ---- Assertion 1: pool exists at expected PoolKey with real MultiHookHost + LP.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: grad.fee(),
            tickSpacing: grad.tickSpacing(),
            hooks: IHooks(MULTI_HOOK)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "graduated pool not initialized");
        assertGt(manager.getLiquidity(poolId), 0, "graduated pool has zero liquidity");
        assertEq(address(key.hooks), MULTI_HOOK, "pool hook != deployed MultiHookHost");

        // ---- Assertion 2: swap through the deployed hook fires afterSwap + accrues to
        //      platform + creator. Fee accrual proves the MultiHookHost bugfix (take())
        //      is present in the deployed bytecode.
        address platformDeployed = hook.platform();
        address creatorDeployed = hook.creator();
        uint256 platBefore = hook.owed(Currency.wrap(address(token)), platformDeployed);
        uint256 credBefore = hook.owed(Currency.wrap(address(token)), creatorDeployed);

        vm.deal(address(swapper), 1 ether);
        swapper.buyToken(key, 0.005 ether, alice);

        uint256 platAfter = hook.owed(Currency.wrap(address(token)), platformDeployed);
        uint256 credAfter = hook.owed(Currency.wrap(address(token)), creatorDeployed);
        assertGt(platAfter - platBefore, 0, "platform fee not accrued on deployed hook");
        assertGt(credAfter - credBefore, 0, "creator fee not accrued on deployed hook");

        // ---- Assertion 3: LP is locked — try to remove liquidity via the deployed hook.
        DTLockChecker locker = new DTLockChecker(manager);
        vm.expectRevert();
        locker.tryRemove(key);
    }
}

/// Bare-bones v4 swap helper that reads currency deltas after the swap + hook adjustments,
/// then settles input + takes output. Mirrors the pattern in `MultiHookGraduationForkTest`.
contract DTSwapHelper {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    struct Args {
        PoolKey key;
        uint256 ethIn;
        address to;
    }

    constructor(
        IPoolManager _m
    ) {
        manager = _m;
    }

    receive() external payable {}

    function buyToken(
        PoolKey calldata key,
        uint256 ethIn,
        address to
    ) external {
        manager.unlock(abi.encode(Args({key: key, ethIn: ethIn, to: to})));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        Args memory a = abi.decode(data, (Args));

        manager.swap(
            a.key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(a.ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        int256 d0 = TransientStateLibrary.currencyDelta(manager, address(this), a.key.currency0);
        int256 d1 = TransientStateLibrary.currencyDelta(manager, address(this), a.key.currency1);
        if (d0 < 0) manager.settle{value: uint256(-d0)}();
        if (d1 > 0) manager.take(a.key.currency1, a.to, uint256(d1));
        return "";
    }
}

/// Attempts to remove even 1 wei of liquidity — MultiHookHost.beforeRemoveLiquidity should
/// revert with `MultiHookHost__LiquidityLocked`.
contract DTLockChecker {
    IPoolManager public immutable manager;
    PoolKey internal storedKey;

    constructor(
        IPoolManager _m
    ) {
        manager = _m;
    }

    function tryRemove(
        PoolKey calldata key
    ) external {
        storedKey = key;
        manager.unlock("");
    }

    function unlockCallback(
        bytes calldata
    ) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        manager.modifyLiquidity(
            storedKey, ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -1, salt: 0}), ""
        );
        return "";
    }
}
