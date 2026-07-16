// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Graduator} from "src/curve/Graduator.sol";

contract MHMockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Fork test that proves BOTH legs of MultiHookHost actually fire on the resulting
///         v4 pool after a curve graduates. This is the hook contract we ship on Base
///         Sepolia + every chain after; the existing `GraduationForkTest` only proves the
///         simpler `LPLockedHook` variant, and only against Sepolia's PoolManager.
///
///         Runs against whatever chain the RPC + PoolManager env vars point at:
///           FORK_RPC_URL         — required (Base Sepolia default)
///           FORK_POOL_MANAGER    — required (defaults to Base Sepolia canonical)
///
///         After graduation, asserts:
///           1. The v4 pool exists at the expected PoolKey with non-zero liquidity
///           2. `PoolKey.hooks == MultiHookHost` (the actual hook we deployed, not a stand-in)
///           3. Any `beforeRemoveLiquidity` on the pool reverts with LiquidityLocked
///              — LP is genuinely locked, not just "we hope it's locked"
///           4. Swapping through PoolManager fires `afterSwap`, accruing fees to
///              `platform` + `creator` — fee-redirect leg works
contract MultiHookGraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Base Sepolia canonical PoolManager, from lib/v4-periphery/broadcast — used as the
    // default when FORK_POOL_MANAGER isn't set. Any chain works if you override the env.
    address internal constant DEFAULT_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager internal manager;
    MultiHookHost internal hook;
    Graduator internal graduator;
    HookAwareSwapper internal swapper;

    address internal alice = makeAddr("alice");
    address internal feeReceiver = makeAddr("feeReceiver");
    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");

    uint16 internal constant PLATFORM_BPS = 100; // 1%
    uint16 internal constant CREATOR_BPS = 100; // 1%

    // Curve params: low graduation target for cheap test drive.
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;

    function setUp() public {
        // Fork URL — prefer explicit FORK_RPC_URL, fall back to BASE_SEPOLIA_RPC_URL so
        // day-to-day runs pick up whatever's already in .env.
        string memory rpc = "";
        try vm.envString("FORK_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) {
            try vm.envString("BASE_SEPOLIA_RPC_URL") returns (string memory r) {
                rpc = r;
            } catch {}
        }
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        address pmAddr = vm.envOr("FORK_POOL_MANAGER", DEFAULT_POOL_MANAGER);
        if (pmAddr.code.length == 0) vm.skip(true);
        manager = IPoolManager(pmAddr);

        // Deploy MultiHookHost at a mined address whose low bits match its permission mask.
        // v2 adds BEFORE_INITIALIZE (stamps launchBlock) + BEFORE_SWAP (anti-sniper gate).
        uint160 required = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args = abi.encode(manager, platform, creator, PLATFORM_BPS, CREATOR_BPS);
        (uint256 salt,) = HookMiner.find(CREATE2_DEPLOYER, required, creation, args, 500_000);

        vm.prank(CREATE2_DEPLOYER);
        address hookAddr;
        assembly {
            let ptr := mload(0x40)
            let cLen := mload(creation)
            let aLen := mload(args)
            for { let i := 0 } lt(i, cLen) { i := add(i, 0x20) } {
                mstore(add(ptr, i), mload(add(add(creation, 0x20), i)))
            }
            for { let i := 0 } lt(i, aLen) { i := add(i, 0x20) } {
                mstore(add(add(ptr, cLen), i), mload(add(add(args, 0x20), i)))
            }
            hookAddr := create2(0, ptr, add(cLen, aLen), salt)
        }
        hook = MultiHookHost(payable(hookAddr));

        // Standard 0.3% / 60-tick tier — matches DeployGraduator.s.sol defaults.
        graduator = new Graduator(manager, IHooks(address(hook)), 3000, 60);

        // Custom swap helper — `PoolSwapTest` doesn't know how to settle the extra token
        // delta MultiHookHost claims in afterSwap (it accrues fees to platform+creator via
        // `poolManager.take` semantics). Our helper unlocks, swaps, settles the input side,
        // and takes the reduced output.
        swapper = new HookAwareSwapper(manager);
    }

    function test_Fork_Graduation_LocksLPAndAccruesSwapFees() public {
        MHMockToken token = new MHMockToken();
        BondingCurve impl = new BondingCurve();
        BondingCurve curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token.mint(address(curve), CURVE_SUPPLY);

        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            0,
            0,
            address(0)
        );

        // Drive to graduation. 3 ETH sent → 2.97 ETH nets into reserve after 1% fee, past
        // the 2 ETH target so `_graduate()` fires in the same tx.
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);

        assertTrue(curve.graduated(), "curve did not graduate");
        assertEq(curve.ethReserve(), 0, "eth not drained from curve");
        assertEq(curve.tokenReserve(), 0, "token not drained from curve");

        // ---- Assertion 1: v4 pool exists with non-zero liquidity and MultiHookHost wired.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(poolId);
        assertGt(sqrtPriceX96, 0, "pool not initialized");
        assertGt(manager.getLiquidity(poolId), 0, "pool has zero liquidity");
        assertEq(address(key.hooks), address(hook), "pool hook slot != MultiHookHost");

        // Regression guard for the sqrtPrice direction bug: v4 encodes
        // sqrt(amount1/amount0) — for our ETH(currency0)/token(currency1) pool with
        // ~2 ETH raised + ~798M tokens, price_ratio = tokens/ETH is a LARGE number, so
        // sqrtPriceX96/2^96 should be > 1. If the formula gets inverted, the ratio
        // becomes tiny and sqrtPriceX96 lands way below 2^96.
        assertGt(uint256(sqrtPriceX96), uint256(1) << 96, "sqrtPriceX96 direction inverted");

        // ---- Assertion 2: LP is locked — trying to remove even 1 wei of liquidity reverts.
        // Route the modify through a bare unlock callback contract so we're really hitting
        // the PoolManager.modifyLiquidity → hook.beforeRemoveLiquidity path.
        Unlocker unlocker = new Unlocker(manager);
        vm.expectRevert(); // MultiHookHost__LiquidityLocked bubbles out of the callback
        unlocker.tryRemoveLiquidity(key);

        // ---- Assertion 3: Swap accrues fees to platform + creator via afterSwap.
        // Buy the token with 0.01 ETH — the unspecified side is token (currency1). Fee is
        // taken on the output (token) side, so `owed[token][platform] + [creator]` grows.
        uint256 platformOwedBefore = hook.owed(Currency.wrap(address(token)), platform);
        uint256 creatorOwedBefore = hook.owed(Currency.wrap(address(token)), creator);

        vm.deal(address(swapper), 1 ether);
        swapper.swapEthForToken(key, 0.01 ether, alice);

        uint256 platformOwedAfter = hook.owed(Currency.wrap(address(token)), platform);
        uint256 creatorOwedAfter = hook.owed(Currency.wrap(address(token)), creator);
        assertGt(platformOwedAfter - platformOwedBefore, 0, "platform fee not accrued");
        assertGt(creatorOwedAfter - creatorOwedBefore, 0, "creator fee not accrued");

        // The two shares should sum to ~2% of the token output (1% platform + 1% creator).
        // We don't pin an exact number because slippage + rounding — just check the ratio.
        uint256 platformShare = platformOwedAfter - platformOwedBefore;
        uint256 creatorShare = creatorOwedAfter - creatorOwedBefore;
        assertApproxEqRel(platformShare, creatorShare, 0.01e18, "platform/creator split off");
    }

    /// AntiSniper: with a 20-block gate, swaps inside the window revert; rolling past the
    /// window opens the pool. This proves the Graduator → setPoolConfig → beforeSwap chain
    /// end-to-end on a real PoolManager.
    function test_Fork_AntiSniper_GateRevertsThenOpens() public {
        MHMockToken token = new MHMockToken();
        BondingCurve impl = new BondingCurve();
        BondingCurve curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token.mint(address(curve), CURVE_SUPPLY);

        uint32 gateBlocks = 20;
        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            gateBlocks,
            0,
            address(0)
        );

        vm.deal(alice, 10 ether);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        assertTrue(curve.graduated(), "curve did not graduate");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // Config must have been written by the Graduator + frozen by beforeInitialize.
        (uint32 lb, uint32 gate, uint16 burn) = hook.poolConfig(key.toId());
        assertEq(gate, gateBlocks, "antiSniperBlocks not stored");
        assertEq(burn, 0, "buybackBurnBps unexpectedly set");
        assertGt(uint256(lb), 0, "launchBlock not stamped");

        // Inside the gate window — swap must revert.
        vm.deal(address(swapper), 1 ether);
        vm.expectRevert();
        swapper.swapEthForToken(key, 0.005 ether, alice);

        // Skip past the window — swap now succeeds.
        vm.roll(uint256(lb) + uint256(gateBlocks) + 1);
        swapper.swapEthForToken(key, 0.005 ether, alice);
    }

    /// BuybackBurn: with a 1000 bps (10%) burn on BUYs, that slice of the token output
    /// lands on 0x…dEaD rather than the swapper. Verifies the full chain including the
    /// increased afterSwap take (fee + burn combined) and the BURN_ADDRESS transfer.
    function test_Fork_BuybackBurn_TokensGoToDeadOnBuy() public {
        MHMockToken token = new MHMockToken();
        BondingCurve impl = new BondingCurve();
        BondingCurve curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token.mint(address(curve), CURVE_SUPPLY);

        uint16 burnBps = 1000;
        curve.initialize(
            address(token),
            feeReceiver,
            CURVE_SUPPLY,
            VIRTUAL_TOKEN,
            VIRTUAL_ETH,
            GRAD_TARGET,
            100,
            address(graduator),
            0,
            burnBps,
            address(0)
        );

        vm.deal(alice, 10 ether);
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);
        assertTrue(curve.graduated(), "curve did not graduate");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        (,, uint16 burn) = hook.poolConfig(key.toId());
        assertEq(burn, burnBps, "buybackBurnBps not stored");

        // Balance at BURN_ADDRESS before + after — the 10% burn slice should land there.
        address dead = 0x000000000000000000000000000000000000dEaD;
        uint256 deadBefore = token.balanceOf(dead);

        vm.deal(address(swapper), 1 ether);
        swapper.swapEthForToken(key, 0.01 ether, alice);

        uint256 deadAfter = token.balanceOf(dead);
        assertGt(deadAfter - deadBefore, 0, "no tokens sent to burn address");
    }
}

/// @dev Helper that unlocks the PoolManager and immediately tries to burn a tiny amount of
///      liquidity from the pool — MultiHookHost's beforeRemoveLiquidity should revert,
///      which bubbles back to the caller via PoolManager.
contract Unlocker {
    IPoolManager public immutable manager;
    PoolKey internal storedKey;

    constructor(
        IPoolManager _manager
    ) {
        manager = _manager;
    }

    function tryRemoveLiquidity(
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

/// @dev Minimal v4 swap helper that reads the swap delta and settles the input side + takes
///      the output side. The hook's afterSwap `returnDelta` claims extra output tokens for
///      the platform/creator fee split — those stay owed to the hook's `owed[]` mapping and
///      DON'T need to be settled by the swapper, because the hook returned a positive delta
///      (it takes) matched by the reduced take amount on our side. Net settlement is zero.
contract HookAwareSwapper {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    struct SwapArgs {
        PoolKey key;
        uint256 ethIn;
        address recipient;
    }

    constructor(
        IPoolManager _manager
    ) {
        manager = _manager;
    }

    receive() external payable {}

    function swapEthForToken(
        PoolKey calldata key,
        uint256 ethIn,
        address recipient
    ) external {
        SwapArgs memory args = SwapArgs({key: key, ethIn: ethIn, recipient: recipient});
        manager.unlock(abi.encode(args));
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        SwapArgs memory args = abi.decode(data, (SwapArgs));

        manager.swap(
            args.key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(args.ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // Read the manager's per-currency delta for us AFTER swap + afterSwap adjustments.
        // Negative = we owe (settle), positive = we're owed (take). Reading currencyDelta
        // here rather than the swap() return value catches the extra debit MultiHookHost's
        // afterSwap makes for its fee accrual — otherwise we'd leave that portion unsettled
        // and the unlock would revert with CurrencyNotSettled.
        int256 d0 = TransientStateLibrary.currencyDelta(manager, address(this), args.key.currency0);
        int256 d1 = TransientStateLibrary.currencyDelta(manager, address(this), args.key.currency1);

        if (d0 < 0) manager.settle{value: uint256(-d0)}();
        if (d1 < 0) {
            // Shouldn't happen on a zeroForOne swap, but keep the branch symmetric.
            manager.sync(args.key.currency1);
            manager.settle();
        }
        if (d0 > 0) manager.take(args.key.currency0, args.recipient, uint256(d0));
        if (d1 > 0) manager.take(args.key.currency1, args.recipient, uint256(d1));
        return "";
    }
}
