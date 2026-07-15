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

import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

contract V4RMock is ERC20 {
    function name() public pure override returns (string memory) {
        return "V4";
    }

    function symbol() public pure override returns (string memory) {
        return "V4";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Forks Base Sepolia at current block, uses the deployed launchpad stack to
///         create + graduate a curve, then round-trips ETH → token → ETH through the new
///         `V4SwapRouter`. Proves the router works against real deployed bytecode + the
///         MultiHookHost fee-redirect leg fires correctly.
contract V4SwapRouterForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant CURVE_FACTORY = 0x5bC3c476f5CF267a08A309578bC1337e00C2fC1F;
    address internal constant GRADUATOR = 0x11A4aDDdDB29f847d3De7654674427e6Ba3C5cD7;
    address internal constant MULTI_HOOK = 0x9cC9Bf4d6Eb7A443fBACB7Ba7C8b4876299A4244;
    address internal constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    IPoolManager internal manager;
    CurveFactory internal cf;
    Graduator internal grad;
    MultiHookHost internal hook;
    V4SwapRouter internal router;

    // makeAddr on the fork can collide with EIP-7702-delegated accounts (a random user
    // already delegated their EOA there) — that breaks native ETH receive tests. Use raw
    // addresses derived from private keys instead; those are guaranteed to have no code.
    address internal alice = vm.addr(0xa71c3);
    address internal bob = vm.addr(0xb0b);

    function setUp() public {
        string memory rpc;
        try vm.envString("BASE_SEPOLIA_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        if (CURVE_FACTORY.code.length == 0) vm.skip(true);

        manager = IPoolManager(POOL_MANAGER);
        cf = CurveFactory(CURVE_FACTORY);
        grad = Graduator(payable(GRADUATOR));
        hook = MultiHookHost(payable(MULTI_HOOK));
        router = new V4SwapRouter(manager);
    }

    function test_V4Router_BuyAndSellPostGraduation() public {
        // ---- 1. Create + graduate a fresh curve via deployed CurveFactory.
        uint256 supply = cf.defaultCurveSupply();
        uint256 gradTarget = cf.defaultGraduationTargetEth();

        V4RMock token = new V4RMock();
        vm.startPrank(alice);
        token.mint(alice, supply);
        token.approve(address(cf), supply);
        address curveAddr = cf.createCurve(address(token));
        vm.stopPrank();

        vm.deal(alice, gradTarget * 12 / 10 + 1 ether);
        vm.prank(alice);
        BondingCurve(payable(curveAddr)).buy{value: gradTarget * 11 / 10}(0);
        assertTrue(BondingCurve(payable(curveAddr)).graduated(), "curve did not graduate");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: grad.fee(),
            tickSpacing: grad.tickSpacing(),
            hooks: IHooks(MULTI_HOOK)
        });

        // ---- 2. Buy some token via the V4SwapRouter (ETH → token).
        vm.deal(bob, 1 ether);
        uint256 bobEthBefore = bob.balance;

        vm.prank(bob);
        uint256 tokensReceived = router.swapExactETHForToken{value: 0.01 ether}(key, 1, bob);
        assertGt(tokensReceived, 0, "router buy returned zero tokens");
        assertEq(token.balanceOf(bob), tokensReceived, "bob did not receive tokens");
        assertLt(bob.balance, bobEthBefore, "bob's ETH did not decrease");

        // Hook fees accrued.
        uint256 owedPlatform = hook.owed(Currency.wrap(address(token)), hook.platform());
        assertGt(owedPlatform, 0, "platform fee not accrued on buy");

        // ---- 3. Sell those tokens back via the router (token → ETH).
        uint256 bobEthMid = bob.balance;
        vm.startPrank(bob);
        token.approve(address(router), tokensReceived);
        uint256 ethReceived = router.swapExactTokenForETH(key, tokensReceived, 1, bob);
        vm.stopPrank();

        assertGt(ethReceived, 0, "router sell returned zero ETH");
        assertEq(bob.balance, bobEthMid + ethReceived, "ETH not delivered");
        assertEq(token.balanceOf(bob), 0, "bob still holds tokens");

        // Hook now has fees on both currencies.
        uint256 owedPlatformEth = hook.owed(Currency.wrap(address(0)), hook.platform());
        assertGt(owedPlatformEth, 0, "platform fee not accrued on sell");

        // Sanity: bob's round-trip loss should be small (curve/pool fee + hook 2% + slippage).
        // Not asserting an exact bound — this is directional. Ballpark 3-5% loss.
        uint256 netLoss = bobEthBefore - bob.balance;
        assertLt(netLoss, 0.01 ether / 10, "round-trip loss > 10% is suspicious");
    }
}
