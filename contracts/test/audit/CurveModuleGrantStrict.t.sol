// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// Minimal ERC20-shaped impl base: cloned by ERC20Factory, so it must
/// implement `initialize(bytes)` + the ERC20 methods the launch pipeline
/// touches (transfer, transferFrom, approve, balanceOf, allowance). These
/// tokens don't need to be real ERC20s — the CurveFactory reads balance
/// and Router calls approve — so we implement only enough to reach the
/// module-grant phase.
abstract contract MinimalTokenBase {
    address internal _owner;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) internal _allowances;
    uint256 internal _totalSupply;
    bool internal _initialized;

    function initialize(
        bytes calldata data
    ) external {
        require(!_initialized, "init");
        _initialized = true;
        // ERC20Factory.deploy packs: (router, name, ticker, initialSupply, initialRecipient, moduleData).
        (address router_,,, uint256 initialSupply, address initialRecipient,) =
            abi.decode(data, (address, string, string, uint256, address, bytes[]));
        _owner = router_;
        if (initialSupply > 0 && initialRecipient != address(0)) {
            _balances[initialRecipient] = initialSupply;
            _totalSupply = initialSupply;
        }
    }

    function balanceOf(
        address who
    ) external view returns (uint256) {
        return _balances[who];
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function allowance(
        address o,
        address s
    ) external view returns (uint256) {
        return _allowances[o][s];
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function approve(
        address spender,
        uint256 amount
    ) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(
        address to,
        uint256 amount
    ) external returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (from != msg.sender) {
            _allowances[from][msg.sender] -= amount;
        }
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    // OwnershipMode.Renounce path calls renounceOwnership(); provide a no-op
    // so the dispatch doesn't revert before the grant phase runs.
    function renounceOwnership() external {
        _owner = address(0);
    }

    function transferOwnership(
        address n
    ) external {
        _owner = n;
    }
}

/// A token that IMPLEMENTS the AntiBot view but reverts on the setter.
/// Simulates the exact failure mode URU-A14 flagged: a token that looks like
/// it has AntiBot installed (view responds) but whose setter is broken. Prior
/// to the fix, Router.try/catch'd both calls and produced a launched curve
/// that would fail its first `buy` with a bot-guard revert.
contract BrokenAntiBotToken is MinimalTokenBase {
    error BrokenSetter();

    function antiBotIsAllowed(
        address
    ) external pure returns (bool) {
        return false;
    }

    function antiWhaleIsExcluded(
        address
    ) external pure returns (bool) {
        return false;
    }

    function setAntiBotAllowed(
        address,
        bool
    ) external pure {
        revert BrokenSetter();
    }

    function setAntiWhaleExcluded(
        address,
        bool
    ) external pure {
        revert BrokenSetter();
    }
}

/// A token that: view says "yes" AntiBot is installed AND setter succeeds
/// silently, BUT the read-back still returns false. Simulates a token whose
/// setter has been tampered with to no-op while lying to the caller. Router
/// must catch this at read-back time.
contract LyingAntiBotToken is MinimalTokenBase {
    function antiBotIsAllowed(
        address
    ) external pure returns (bool) {
        return false; // always false — read-back never confirms
    }

    function antiWhaleIsExcluded(
        address
    ) external pure returns (bool) {
        return true; // already excluded — Router's Antiwhale grant will skip
    }

    function setAntiBotAllowed(
        address,
        bool
    ) external pure {
        // No-op: doesn't revert, but doesn't actually record either. This is
        // the honeypot Router must catch via post-setter read-back.
    }

    function setAntiWhaleExcluded(
        address,
        bool
    ) external pure {
        // No-op — irrelevant for AntiBot test.
    }
}

/// Minimal graduator stub — has poolManager() so Router's strict grant path
/// can call it without reverting.
contract StubGraduator {
    function poolManager() external view returns (address) {
        return address(this);
    }

    function execute(
        address,
        uint256,
        uint256,
        uint32,
        uint16,
        address
    ) external payable {}
}

/// A CurveFactory stub that lets Router treat any address as "the token"
/// during the grant phase. We bypass the real curve-creation flow because
/// the goal is to exercise `_grantCurveModuleAllowances` — not curve math.
/// Returns a fresh minimal contract on `createCurve*` so Router has SOMETHING
/// to pass as `curve` into the grant helpers.
contract GrantOnlyCurveFactory {
    address public immutable graduator;

    constructor(
        address graduator_
    ) {
        graduator = graduator_;
    }

    function defaultCurveSupply() external pure returns (uint256) {
        return 800_000_000e18;
    }

    // Router calls these; we return a fresh address that DOES have code but
    // no meaningful behavior. Router treats it as `curve` for the grant path.
    function createCurve(
        address
    ) external returns (address) {
        return _spawn();
    }

    function createCurveWithConfig(
        address,
        uint32,
        uint16
    ) external returns (address) {
        return _spawn();
    }

    function createCurveWithConfigFor(
        address,
        uint32,
        uint16,
        address
    ) external returns (address) {
        return _spawn();
    }

    function _spawn() internal returns (address) {
        return address(new StubGraduator()); // any contract with code
    }
}

/// @title  CurveModuleGrantStrictTest — URU-A14 (round 3 follow-up)
/// @notice The auditor rejected the prior `try/catch {}` swallowers in
///         `Router._grantCurveModuleAllowances`. Round 3 replaced them with
///         a strict probe→grant→verify pattern (see Router.sol:1121+):
///           * If the module view returns unknown-selector, skip cleanly.
///           * If the module view returns cleanly, the setter MUST succeed
///             AND the read-back MUST return true, else revert
///             `Router__CurveModuleGrantFailed(token, who, module)`.
///         These tests prove both the failure paths surface at launch time
///         instead of at first-buy time (which was the prior silent-brick).
contract CurveModuleGrantStrictTest is Test {
    Router internal router;
    NameRegistry internal registry;
    FeeReceiver internal fees;
    ERC20Factory internal factory;
    StubGraduator internal graduator;
    GrantOnlyCurveFactory internal curveFactory;

    address internal admin = makeAddr("admin");
    address internal launcher = makeAddr("launcher");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant CFG_BROKEN = keccak256("broken");
    bytes32 internal constant CFG_LYING = keccak256("lying");

    /// Wire up a Router that will hit `_grantCurveModuleAllowances` on any
    /// curve launch. Register the two custom impls (broken + lying) at
    /// dedicated configHashes so the launch path can pick which failure mode
    /// to exercise.
    function setUp() public {
        registry = new NameRegistry(admin, treasury, new string[](0));
        fees = new FeeReceiver(admin);

        router = new Router(admin, registry, IFeeReceiver(address(fees)), 0, 0, 0, 0, 0, 0);
        factory = new ERC20Factory(admin, address(router), admin);

        graduator = new StubGraduator();
        curveFactory = new GrantOnlyCurveFactory(address(graduator));

        // Pin + register the two adversarial impls.
        address brokenImpl = address(new BrokenAntiBotToken());
        address lyingImpl = address(new LyingAntiBotToken());
        vm.startPrank(admin);
        factory.setExpectedCodeHash(CFG_BROKEN, keccak256(brokenImpl.code));
        factory.registerImpl(CFG_BROKEN, brokenImpl);
        factory.setExpectedCodeHash(CFG_LYING, keccak256(lyingImpl.code));
        factory.registerImpl(CFG_LYING, lyingImpl);

        // Wire Router — register factory, mark configHashes as "no modules"
        // (moduleCount = 0), and pin flags = 0 so _validateLaunchPolicy lets
        // the launch through to the grant path.
        router.setFactory(BaseType.ERC20, address(factory));
        router.setCurveFactory(address(curveFactory));
        router.registerConfigMetadata(CFG_BROKEN, 0, 0);
        router.registerConfigMetadata(CFG_LYING, 0, 0);
        registry.setRouter(address(router));
        vm.stopPrank();

        vm.deal(launcher, 10 ether);
    }

    // -------------------------------------------------------------
    // Broken setter — reverts inside the setter call
    // -------------------------------------------------------------

    /// Token's AntiBot view responds (module "installed"), but the setter
    /// itself reverts. Prior behavior: try/catch swallow, launch succeeds,
    /// bricked curve. New behavior: Router bubbles the setter's revert
    /// through the launch, launcher sees actionable failure at launch time.
    function test_BrokenSetter_LaunchReverts() public {
        LaunchParams memory p = _paramsFor(CFG_BROKEN, "BrokenBot", "BOT");
        // The setter's `BrokenSetter()` custom error bubbles out of Router.launch.
        // The exact selector match ensures the revert path is the module-grant
        // failure, not any other unrelated revert somewhere else in the flow.
        // Prior to URU-A14, the try/catch swallowed this and the launch quietly
        // succeeded with a bricked curve.
        vm.expectRevert(BrokenAntiBotToken.BrokenSetter.selector);
        vm.prank(launcher);
        router.launch(p);
    }

    // -------------------------------------------------------------
    // Lying token — setter no-ops but doesn't revert; read-back catches it
    // -------------------------------------------------------------

    /// Token's AntiBot setter is a no-op honeypot (silently succeeds without
    /// recording). Router's post-setter read-back must catch this:
    /// `antiBotIsAllowed(curve)` still returns false, so Router reverts
    /// `Router__CurveModuleGrantFailed(token, curve, "AntiBot")`.
    function test_LyingSetter_LaunchRevertsWithCurveModuleGrantFailed() public {
        LaunchParams memory p = _paramsFor(CFG_LYING, "LyingBot", "LIE");
        // Selector-prefix match — the args (token, curve, "AntiBot") are
        // runtime-computed, so we don't hand-encode the full payload; the
        // selector alone proves this is the URU-A14 revert path.
        vm.expectPartialRevert(Router.Router__CurveModuleGrantFailed.selector);
        vm.prank(launcher);
        router.launch(p);
    }

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    function _paramsFor(
        bytes32 configHash,
        string memory name_,
        string memory ticker_
    ) internal pure returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = configHash;
        p.initData = hex"";
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
    }
}
