// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice Test-only ERC20 with unrestricted `mint`. Never ships.
contract StackToken is ERC20 {
    string private _n;
    string private _s;

    constructor(
        string memory n_,
        string memory s_
    ) {
        _n = n_;
        _s = s_;
    }

    function name() public view override returns (string memory) {
        return _n;
    }

    function symbol() public view override returns (string memory) {
        return _s;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @title  LocalV4Stack
/// @notice Deploys the full curve → graduation → Uniswap v4 stack **entirely in
///         memory**, with a real `v4-core` `PoolManager` — no fork, no RPC, no
///         live-chain addresses.
///
///         Every pre-existing v4 test in this repo is a fork test pinned to
///         Robinhood mainnet, which makes them slow, network-dependent, and
///         unusable for invariant fuzzing (256 runs × 32 depth against a remote
///         RPC is not viable). Because `v4-core` is vendored in `lib/`, the
///         PoolManager can simply be `new`-ed locally and the whole graduation
///         path exercised deterministically at full fuzz budget.
///
/// @dev    v4 encodes a hook's permissions in the low 14 bits of its address, so
///         `MultiHookHost` cannot live at an arbitrary address. Rather than
///         CREATE2-mine a salt on every `setUp` (slow), the hook is deployed
///         straight to a hand-picked address whose low bits already equal the
///         required flag mask. `MHH_FLAGS` below must stay in sync with
///         `MultiHookHost.getHookPermissions()`.
abstract contract LocalV4Stack is Test {
    using PoolIdLibrary for PoolKey;

    /// beforeInitialize | beforeRemoveLiquidity | beforeSwap | afterSwap |
    /// afterSwapReturnsDelta  ==  0x2000 | 0x200 | 0x80 | 0x40 | 0x04
    uint160 internal constant MHH_FLAGS = 0x22C4;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    PoolManager public poolManager;
    /// Same instance as `poolManager`, pre-cast — `StateLibrary` and
    /// `modifyLiquidity` both bind to the interface type, not the concrete one.
    IPoolManager public ipm;
    FeeReceiver public feeReceiver;
    BondingCurve public curveImpl;
    CurveFactory public curveFactory;
    GraduatorV2 public graduator;
    MultiHookHost public mhh;
    V4SwapRouter public swapRouter;

    // ---- real launch path (Router → factory → template → curve) ----------
    NameRegistry public registry;
    Router public router;
    ERC20Factory public erc20Factory;
    ERC20Template public erc20Impl;

    /// Matches the frontend's `configHashFor('ERC20', [])`.
    bytes32 internal constant CH_BARE = keccak256(abi.encode("ERC20", ""));

    address public admin = makeAddr("stack-admin");

    function _deployStack() internal {
        poolManager = new PoolManager(admin);
        ipm = IPoolManager(address(poolManager));
        feeReceiver = new FeeReceiver(admin);
        curveImpl = new BondingCurve();
        curveFactory = new CurveFactory(admin, address(feeReceiver), address(curveImpl));

        // Hook must sit at a flag-valid address. Pick a high, obviously-synthetic
        // prefix so it can't collide with anything else the test deploys.
        address hookAddr = address((uint160(0xBEEF) << 144) | MHH_FLAGS);
        deployCodeTo(
            "MultiHookHost.sol:MultiHookHost",
            abi.encode(
                IPoolManager(address(poolManager)), address(feeReceiver), admin, uint16(100), uint16(100), admin
            ),
            hookAddr
        );
        mhh = MultiHookHost(payable(hookAddr));

        graduator = new GraduatorV2(
            IPoolManager(address(poolManager)), IHooks(hookAddr), FEE, TICK_SPACING, address(curveFactory), admin
        );

        vm.prank(admin);
        mhh.setInitializer(address(graduator));
        vm.prank(admin);
        curveFactory.setGraduator(address(graduator));

        // Some suites drive the curve directly, standing in for Router. That
        // entrypoint is gated on the trusted-router allowlist, so register.
        vm.prank(admin);
        curveFactory.setTrustedRouter(address(this), true);

        swapRouter = new V4SwapRouter(IPoolManager(address(poolManager)));

        _deployRouterPath();
    }

    /// The production launch path: NameRegistry → Router → ERC20Factory →
    /// ERC20Template → CurveFactory. Deployed alongside the curve stack so
    /// suites can launch the way a real user does rather than poking
    /// `CurveFactory` directly.
    ///
    /// @dev Note the live chain runs `RouterV2`, but `Router is Router` and
    ///      does NOT override `launch()` — a standard ETH launch executes this
    ///      exact code on both. RouterV2's additions (`launchWithURU`,
    ///      `launchWithWhitelist`) are separate entrypoints, out of scope here.
    function _deployRouterPath() internal {
        string[] memory noReserved = new string[](0);
        registry = new NameRegistry(admin, admin, noReserved);

        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            0.05 ether, // ERC20 launch fee
            0.05 ether, // ERC721A
            0.05 ether, // ERC1155
            0.01 ether, // module add-on
            0.01 ether, // hook add-on
            0.01 ether // governance add-on
        );

        vm.prank(admin);
        registry.setRouter(address(router)); // one-shot

        erc20Impl = new ERC20Template();
        erc20Factory = new ERC20Factory(admin, address(router), admin);

        vm.startPrank(admin);
        erc20Factory.registerImpl(CH_BARE, address(erc20Impl));
        router.setFactory(BaseType.ERC20, address(erc20Factory));
        // Router fails closed without both of these registered for a hash.
        router.setModuleCountForConfig(CH_BARE, 1);
        router.setFlagsForConfig(CH_BARE, 0);
        router.setCurveFactory(address(curveFactory));
        vm.stopPrank();

        vm.prank(admin);
        curveFactory.setTrustedRouter(address(router), true);
    }

    /// Launch exactly the way the frontend does: one `Router.launch()` call that
    /// reserves the name, deploys the token, installs the curve, and dispatches
    /// ownership. Returns the token and its curve.
    function _launchViaRouter(
        string memory name_,
        string memory sym_,
        address launcher
    ) internal returns (address token, BondingCurve curve) {
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = sym_;
        p.configHash = CH_BARE;
        // initialRecipient = Router so it holds curve supply and can approve
        // the CurveFactory mid-launch.
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), new bytes[](0));
        p.moduleCount = 1;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.deal(launcher, launcher.balance + fee);

        vm.prank(launcher);
        token = router.launch{value: fee}(p);

        curve = BondingCurve(payable(curveFactory.curveFor(token)));
    }

    /// Mint a fresh token and register a curve for it through the real
    /// CurveFactory (which pulls the caller's whole balance into the curve).
    function _newTokenWithCurve(
        string memory name_,
        string memory sym_,
        address launcher
    ) internal returns (StackToken token, BondingCurve curve) {
        token = new StackToken(name_, sym_);
        uint256 supply = curveFactory.defaultCurveSupply();
        token.mint(address(this), supply);
        token.approve(address(curveFactory), supply);
        curve = BondingCurve(payable(curveFactory.createCurveWithConfigFor(address(token), 0, 0, launcher)));
    }

    function _poolKeyFor(
        address token
    ) internal view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(mhh))
        });
    }

    function _poolIdFor(
        address token
    ) internal view returns (PoolId) {
        return _poolKeyFor(token).toId();
    }
}
