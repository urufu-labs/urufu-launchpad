// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface ICurveFactoryLookup {
    function curveFor(
        address token
    ) external view returns (address);
    function defaultCurveSupply() external view returns (uint256);
}

interface IERC20Like {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// @title  LocalE2E
/// @notice Drives the full launchpad lifecycle as REAL broadcast transactions
///         against a stack previously deployed by `DeployFreshLocal.s.sol`.
///         Reads the address book from `deployment-fresh.<chainid>.json`.
///
///         Lifecycle exercised:
///           1. Router.launch(ERC20 + bonding curve)  → fresh token + curve
///           2. BondingCurve.buy()  ×N                → price discovery on curve
///           3. final buy crosses graduationTargetEth → _graduate()
///                → GraduatorV2.execute()
///                → PoolManager.initialize(key)   (real Uniswap v4)
///                → PoolManager.modifyLiquidity() (full-range LP)
///                → MultiHookHost.beforeInitialize / setPoolConfig / setCreator
///           4. V4SwapRouter.swapExactETHForToken()   → buy from the v4 pool
///           5. V4SwapRouter.swapExactTokenForETH()   → sell back into the pool
///           6. read MultiHookHost accrued fees + pool slot0
///
///         Run:
///           forge script script/LocalE2E.s.sol:LocalE2E \
///             --broadcast --rpc-url http://127.0.0.1:8545 --private-key $DEV_PRIVATE_KEY
contract LocalE2E is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    bytes32 internal constant CH_BARE = keccak256(abi.encode("ERC20", ""));
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    function run() external {
        string memory book = vm.readFile(string.concat("./deployment-fresh.", vm.toString(block.chainid), ".json"));

        address routerAddr = vm.parseJsonAddress(book, ".router");
        address curveFactory = vm.parseJsonAddress(book, ".curveFactory");
        address mhh = vm.parseJsonAddress(book, ".multiHookHost");
        address swapRouterAddr = vm.parseJsonAddress(book, ".v4SwapRouter");
        address poolManager = vm.parseJsonAddress(book, ".poolManager");

        console2.log("==== LocalE2E ====");
        console2.log("  sender       :", msg.sender);
        console2.log("  sender bal   :", msg.sender.balance);
        console2.log("  Router       :", routerAddr);
        console2.log("  CurveFactory :", curveFactory);
        console2.log("  MultiHookHost:", mhh);
        console2.log("  V4SwapRouter :", swapRouterAddr);

        Router router = Router(payable(routerAddr));

        // ---------------------------------------------------------------
        // 1. Launch an ERC20 with a bonding curve installed.
        // ---------------------------------------------------------------
        uint256 curveSupply = ICurveFactoryLookup(curveFactory).defaultCurveSupply();

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Fork E2E Token";
        p.ticker = "FRKE2E";
        p.configHash = CH_BARE;
        // initialRecipient = Router so it holds curve supply and can approve
        // the CurveFactory during launch.
        p.initData = abi.encode(curveSupply, routerAddr, new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        uint256 launchFee = router.quote(p);
        console2.log("  launch fee   :", launchFee);

        vm.startBroadcast();
        address token = router.launch{value: launchFee}(p);
        vm.stopBroadcast();

        address curveAddr = ICurveFactoryLookup(curveFactory).curveFor(token);
        require(token != address(0) && curveAddr != address(0), "launch failed");
        console2.log("  bal after launch:", msg.sender.balance);
        console2.log("  token        :", token);
        console2.log("  curve        :", curveAddr);

        BondingCurve curve = BondingCurve(payable(curveAddr));
        uint256 gradTarget = curve.graduationTargetEth();
        console2.log("  grad target  :", gradTarget);
        console2.log("  spot price   :", curve.priceWeiPerToken());

        // ---------------------------------------------------------------
        // 2. Partial buys — price discovery along the curve.
        // ---------------------------------------------------------------
        vm.startBroadcast();
        for (uint256 i = 0; i < 3; ++i) {
            uint256 got = curve.buy{value: 0.5 ether}(0);
            console2.log("  buy 0.5 ETH -> tokens:", got);
        }
        vm.stopBroadcast();

        console2.log("  bal after 3 buys:", msg.sender.balance);
        console2.log("  ethReserve   :", curve.ethReserve());
        console2.log("  tokenReserve :", curve.tokenReserve());
        console2.log("  spot price   :", curve.priceWeiPerToken());
        require(!curve.graduated(), "graduated too early");

        // ---------------------------------------------------------------
        // 3. Graduation-triggering buy. Grossed up over the target to clear
        //    the 1% trade-fee slice taken before ethReserve is credited.
        // ---------------------------------------------------------------
        uint256 remaining = gradTarget - curve.ethReserve();
        uint256 finalBuy = (remaining * 115) / 100;
        console2.log("  final buy    :", finalBuy);

        vm.startBroadcast();
        curve.buy{value: finalBuy}(0);
        vm.stopBroadcast();

        require(curve.graduated(), "curve did not graduate");
        console2.log("  GRADUATED");
        console2.log("  sender bal   :", msg.sender.balance);
        console2.log("  burned       :", IERC20Like(token).balanceOf(BURN));

        // ---------------------------------------------------------------
        // 4. Inspect the real Uniswap v4 pool the Graduator opened.
        // ---------------------------------------------------------------
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(mhh)
        });
        PoolId poolId = key.toId();

        (uint160 sqrtPriceX96, int24 tick,,) = IPoolManager(poolManager).getSlot0(poolId);
        uint128 liq = IPoolManager(poolManager).getLiquidity(poolId);
        console2.log("  ---- v4 pool ----");
        console2.log("  poolId       :", vm.toString(PoolId.unwrap(poolId)));
        console2.log("  sqrtPriceX96 :", sqrtPriceX96);
        console2.log("  tick         :", tick);
        console2.log("  liquidity    :", liq);
        require(sqrtPriceX96 > 0, "v4 pool not initialized");
        require(liq > 0, "v4 pool has no liquidity");

        // ---------------------------------------------------------------
        // 5. Swap ETH -> token through the pool (exercises MHH beforeSwap /
        //    afterSwap fee accrual on a real PoolManager).
        // ---------------------------------------------------------------
        V4SwapRouter swapRouter = V4SwapRouter(payable(swapRouterAddr));
        address me = msg.sender;
        uint256 tokBefore = IERC20Like(token).balanceOf(me);

        vm.startBroadcast();
        uint256 bought = swapRouter.swapExactETHForToken{value: 0.25 ether}(key, 0, me, block.timestamp + 600);
        vm.stopBroadcast();

        console2.log("  ---- v4 swap: 0.25 ETH in ----");
        console2.log("  tokens out   :", bought);
        require(bought > 0, "v4 buy returned zero");
        require(IERC20Like(token).balanceOf(me) > tokBefore, "token balance did not increase");

        // ---------------------------------------------------------------
        // 6. Swap token -> ETH back through the pool.
        // ---------------------------------------------------------------
        uint256 sellAmount = bought / 2;

        vm.startBroadcast();
        IERC20Like(token).approve(swapRouterAddr, sellAmount);
        uint256 ethOut = swapRouter.swapExactTokenForETH(key, sellAmount, 0, me, block.timestamp + 600);
        vm.stopBroadcast();

        console2.log("  ---- v4 swap: sell back ----");
        console2.log("  tokens in    :", sellAmount);
        console2.log("  eth out      :", ethOut);
        require(ethOut > 0, "v4 sell returned zero");

        // ---------------------------------------------------------------
        // 7. Hook fee accrual + final pool state.
        // ---------------------------------------------------------------
        (uint160 sqrtAfter, int24 tickAfter,,) = IPoolManager(poolManager).getSlot0(poolId);
        console2.log("  ---- final ----");
        console2.log("  sqrtPriceX96 :", sqrtAfter);
        console2.log("  tick         :", tickAfter);
        console2.log("  MHH ETH bal  :", mhh.balance);
        console2.log("  E2E COMPLETE");
    }
}
