// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {ERC20Template} from "src/templates/ERC20Template.sol";
import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairGraduator} from "src/fair/FairGraduator.sol";
import {FairHookHost} from "src/fair/FairHookHost.sol";

interface IERC20Min {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
    function transferFrom(
        address,
        address,
        uint256
    ) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// Aggregator-style executor: pulls the input into ITSELF first (wallet -> executor),
/// then opens its own PoolManager unlock, swaps, pays the pool from its own balance and
/// sends the output to the user. This is the 1inch / Odos / 0x executor shape, as
/// opposed to the Universal Router + Permit2 path that pays the pool straight from the
/// user. Supports both directions, exact-in (amountSpecified < 0) and exact-out (> 0).
contract AggregatorExecutor is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(
        IPoolManager _pm
    ) {
        pm = _pm;
    }

    struct Ctx {
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
        address recipient;
    }

    /// `maxIn`: for token input, pulled up front; for ETH input, `msg.value`. Unused
    /// input is returned to the caller.
    function swap(
        PoolKey calldata key,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 maxIn
    ) external payable returns (uint256 amountIn, uint256 amountOut) {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        if (!cin.isAddressZero()) {
            IERC20Min(Currency.unwrap(cin)).transferFrom(msg.sender, address(this), maxIn);
        }
        bytes memory ret = pm.unlock(abi.encode(Ctx(key, zeroForOne, amountSpecified, msg.sender)));
        (amountIn, amountOut) = abi.decode(ret, (uint256, uint256));
        uint256 left = maxIn - amountIn;
        if (left > 0) {
            if (cin.isAddressZero()) {
                (bool ok,) = msg.sender.call{value: left}("");
                require(ok, "refund");
            } else {
                IERC20Min(Currency.unwrap(cin)).transfer(msg.sender, left);
            }
        }
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        Ctx memory c = abi.decode(data, (Ctx));
        BalanceDelta d = pm.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: c.amountSpecified,
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 d0 = int128(int256(BalanceDelta.unwrap(d) >> 128));
        int128 d1 = int128(int256(BalanceDelta.unwrap(d)));
        (int128 dIn, int128 dOut) = c.zeroForOne ? (d0, d1) : (d1, d0);
        (Currency cin, Currency cout) = c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        uint256 amountIn = uint256(uint128(-dIn));
        uint256 amountOut = uint256(uint128(dOut));
        if (cin.isAddressZero()) {
            pm.settle{value: amountIn}();
        } else {
            pm.sync(cin);
            IERC20Min(Currency.unwrap(cin)).transfer(address(pm), amountIn);
            pm.settle();
        }
        pm.take(cout, c.recipient, amountOut);
        return abi.encode(amountIn, amountOut);
    }

    receive() external payable {}
}

/// Batch depositor that tries to re-enter `claim` from its ETH refund.
contract ReentrantClaimer {
    OpeningBatch public batch;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(
        OpeningBatch b
    ) {
        batch = b;
    }

    function deposit() external payable {
        batch.deposit{value: msg.value}();
    }

    function claim() external {
        batch.claim();
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try batch.claim() {
                reentrySucceeded = true;
            } catch {}
            try batch.claimFor(address(this)) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}

/// Full Fair-lane stack on a local v4 PoolManager. No fork, no RPC.
abstract contract FairTestBase is Test {
    using PoolIdLibrary for PoolKey;

    uint160 internal constant HOOK_FLAGS = 0x20C4;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 internal constant PLATFORM_BPS = 100;
    uint16 internal constant CREATOR_BPS = 100;

    IPoolManager internal pm;
    FairHookHost internal hook;
    FairGraduator internal graduator;
    FairLaunchFactory internal factory;
    AggregatorExecutor internal agg;

    address internal admin = makeAddr("fair-admin");
    address internal platform = makeAddr("fair-platform");
    address internal feeReceiver = makeAddr("fair-feeReceiver");
    address internal creator = makeAddr("fair-creator");

    function _deployFairStack(
        IPoolManager _pm,
        address _platform,
        address _feeReceiver
    ) internal {
        pm = _pm;
        platform = _platform;
        feeReceiver = _feeReceiver;
        address hookAddr = address((uint160(0xFA1F) << 144) | HOOK_FLAGS);
        deployCodeTo(
            "FairHookHost.sol:FairHookHost",
            abi.encode(pm, _platform, PLATFORM_BPS, CREATOR_BPS, uint16(2000), uint32(300), uint16(1000), admin),
            hookAddr
        );
        hook = FairHookHost(payable(hookAddr));
        graduator = new FairGraduator(pm, IHooks(hookAddr), FEE, TICK_SPACING, 0, admin);
        factory = new FairLaunchFactory(
            admin,
            address(new ERC20Template()),
            address(new FairBondingCurve()),
            address(new OpeningBatch()),
            address(graduator),
            _feeReceiver
        );
        vm.startPrank(admin);
        hook.setInitializer(address(graduator));
        graduator.setFactory(address(factory));
        factory.setLaunchesOpen(true);
        vm.stopPrank();
        agg = new AggregatorExecutor(pm);
    }

    function _launch(
        string memory name,
        uint256 creatorDeposit
    ) internal returns (address token, FairBondingCurve curve, OpeningBatch batch) {
        vm.deal(creator, creator.balance + creatorDeposit);
        vm.prank(creator);
        address c;
        address b;
        (token, c, b) = factory.launch{value: creatorDeposit}(name, "FAIR");
        curve = FairBondingCurve(payable(c));
        batch = OpeningBatch(payable(b));
    }

    function _deposit(
        OpeningBatch batch,
        address who,
        uint256 amount
    ) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        batch.deposit{value: amount}();
    }

    function _warpPast(
        OpeningBatch batch
    ) internal {
        vm.warp(uint256(batch.closeTs()) + 1);
    }

    function _key(
        address token
    ) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    /// Settle (if needed) and buy through the curve until it graduates.
    function _graduate(
        FairBondingCurve curve
    ) internal returns (PoolKey memory key) {
        if (!curve.batchSettled()) {
            vm.warp(uint256(curve.batchCloseTs()) + 1);
        }
        address whale = makeAddr("fair-grad-whale");
        uint256 need = curve.graduationTargetEth() - curve.ethReserve();
        uint256 gross = (need * 10_000) / (10_000 - curve.tradeFeeBps()) + 0.01 ether;
        vm.deal(whale, whale.balance + gross);
        vm.prank(whale);
        curve.buy{value: gross}(0);
        require(curve.graduated(), "did not graduate");
        key = _key(curve.token());
    }

    function _bal(
        address token,
        address who
    ) internal view returns (uint256) {
        return IERC20Min(token).balanceOf(who);
    }

    /// Hook holds enough of each currency to pay every owed balance plus the bank.
    function _assertHookSolvent(
        address token,
        address creatorAddr
    ) internal view {
        Currency eth = Currency.wrap(address(0));
        Currency tok = Currency.wrap(token);
        uint256 owedEth = hook.owed(eth, platform) + hook.owed(eth, creatorAddr);
        uint256 owedTok = hook.owed(tok, platform) + hook.owed(tok, creatorAddr);
        assertGe(address(hook).balance, owedEth + hook.totalBanked(), "hook ETH insolvent");
        assertGe(_bal(token, address(hook)), owedTok, "hook token insolvent");
    }
}
