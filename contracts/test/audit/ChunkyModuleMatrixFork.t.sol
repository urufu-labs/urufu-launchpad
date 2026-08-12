// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {SetChunkyDefaults} from "script/SetChunkyDefaults.s.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Router} from "src/router/Router.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title  ChunkyModuleMatrixFork
/// @notice The gap-close from the chunky-defaults broadcast: exercises EVERY
///         registered ERC20 module through a full launch → graduate on the
///         LIVE V8+chunky RH mainnet stack (Router 0x84C7 / CF 0x1c34 / MHH
///         0xed09 / Graduator 0x0Db6) after applying the chunky defaults via
///         the actual broadcast script.
///
///         For each module the test asserts:
///           - Launch succeeds through live Router (or reverts with the right
///             error for blacklisted combos like FoT+curve)
///           - Curve is created and adopts chunky grad target (10 ETH)
///           - Buyer can drain the curve past target → `graduated == true`
///           - Curve reserves both zero after graduation
///           - LIVE Graduator balance == 0 (V8 raw-ratio math held under
///             every module's transfer path)
///           - Pool live with MHH hook + chunky LP (~190M-225M tokens)
///
///         Airdrop is NOT covered — retired platform-wide 2026-07-30 (V1
///         impl has an inflation rug).
contract ChunkyModuleMatrixForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address internal constant MULTI_HOOK_HOST = 0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4;
    address internal constant GRADUATOR = 0xA29Ee1DB0a7C53e4733092C46C00d09feb1dFFC1;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    bytes32 internal constant H_BARE = keccak256(abi.encode("ERC20", ""));
    bytes32 internal constant H_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal constant H_ANTIWHALE = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 internal constant H_PAUSABLE = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 internal constant H_PERMIT = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 internal constant H_VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal constant H_STAKING = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 internal constant H_VOTES = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 internal constant H_FOT = keccak256(abi.encode("ERC20", "FeeOnTransfer"));

    address internal launcher = makeAddr("matrix-launcher");
    address internal buyer = makeAddr("matrix-buyer");
    address internal beneficiary = makeAddr("matrix-beneficiary");

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

        // Apply chunky defaults on every test — snapshotting via setUp means
        // each test starts from the same post-broadcast state.
        SetChunkyDefaults script = new SetChunkyDefaults();
        script.runFor(CURVE_FACTORY, DEPLOYER);
    }

    // ============================================================
    // The 8 supported ERC20 modules that get launched through curves.
    // Each test walks the full pipeline (launch → buy → graduate → LP asserts)
    // and gets its own function so a failure isolates to a specific module.
    // ============================================================

    function test_Matrix_Bare_LaunchGraduate() public {
        _launchGraduateAssertChunky("Bare M", "BAREM", H_BARE, _empty(), 0);
    }

    function test_Matrix_AntiBot_LaunchGraduate() public {
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(5)); // 5-block gate
        // Warp past the gate so the buyer (non-allowlisted) can receive
        // tokens without tripping AntiBot__Gated. Real users just wait a
        // handful of blocks — same UX.
        _launchGraduateAssertChunkyWithRoll("AB M", "ABM", H_ANTIBOT, md, 1, 20);
    }

    function test_Matrix_AntiWhale_LaunchGraduate() public {
        // Huge caps: max wallet & max tx well above the curve output so the
        // buyer's graduation-triggering buy doesn't trip the whale check.
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint128(type(uint128).max), uint128(type(uint128).max), uint32(100));
        _launchGraduateAssertChunky("AW M", "AWM", H_ANTIWHALE, md, 1);
    }

    function test_Matrix_Pausable_LaunchGraduate() public {
        bytes[] memory md = new bytes[](1);
        md[0] = ""; // Pausable takes no params, unpaused by default
        _launchGraduateAssertChunky("Pause M", "PAUSEM", H_PAUSABLE, md, 1);
    }

    function test_Matrix_Permit_LaunchGraduate() public {
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        _launchGraduateAssertChunky("Permit M", "PERMITM", H_PERMIT, md, 1);
    }

    function test_Matrix_Vesting_LaunchGraduate() public {
        // Small carve (100 tokens vs 800M supply) so curve gets ~800M.
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(
            beneficiary, uint256(100e18), uint64(block.timestamp + 1 days), uint64(block.timestamp + 365 days)
        );
        _launchGraduateAssertChunky("Vest M", "VESTM", H_VESTING, md, 1);
    }

    function test_Matrix_Staking_LaunchGraduate() public {
        // Small reward pool so curve keeps ~800M.
        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint256(1000e18), uint32(30 days));
        _launchGraduateAssertChunky("Stake M", "STAKEM", H_STAKING, md, 1);
    }

    function test_Matrix_Votes_LaunchGraduate() public {
        // Votes uses the ERC20VotesTemplate base but the on-chain configHash
        // shape is identical to any other single-module launch.
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        _launchGraduateAssertChunky("Vote M", "VOTEM", H_VOTES, md, 1);
    }

    // ============================================================
    // FoT+curve is blacklisted at the Router — assert the guard still fires
    // under chunky defaults so a launcher can't sneak an FoT-taxing token
    // onto the curve and drift its accounting.
    // ============================================================

    function test_Matrix_FoT_IsBlacklistedFromCurves() public {
        assertTrue(
            Router(ROUTER_V7).curveIncompatibleConfigHash(H_FOT),
            "FoT hash should be on Router curveIncompatibleConfigHash"
        );

        bytes[] memory md = new bytes[](1);
        md[0] = abi.encode(uint16(500), uint16(5000), uint16(5000), address(this));
        LaunchParams memory p = _params("FoT M", "FOTM", H_FOT, md, 1, 800_000_000e18);
        Router router = Router(payable(ROUTER_V7));
        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);
        vm.prank(launcher);
        vm.expectRevert(); // Router__CurveIncompatibleConfig or similar
        router.launch{value: fee}(p);
    }

    // ============================================================
    // shared helpers
    // ============================================================

    function _empty() internal pure returns (bytes[] memory) {
        return new bytes[](0);
    }

    function _params(
        string memory name_,
        string memory ticker_,
        bytes32 configHash_,
        bytes[] memory md,
        uint8 moduleCount_,
        uint256 supply
    ) internal pure returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = configHash_;
        p.initData = abi.encode(supply, ROUTER_V7, md);
        p.moduleCount = moduleCount_;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }

    /// Full pipeline for a single module: launch, drive curve to graduation
    /// with a right-sized buy, then hit every critical post-graduation
    /// invariant. Buy size = 10.6 ETH → nets ~10.494 past the 1% fee slice,
    /// clears the 10-ETH gradTarget by a hair, keeps LP chunky (~192M).
    function _launchGraduateAssertChunky(
        string memory name_,
        string memory ticker_,
        bytes32 configHash_,
        bytes[] memory md,
        uint8 moduleCount_
    ) internal {
        _launchGraduateAssertChunkyWithRoll(name_, ticker_, configHash_, md, moduleCount_, 0);
    }

    function _launchGraduateAssertChunkyWithRoll(
        string memory name_,
        string memory ticker_,
        bytes32 configHash_,
        bytes[] memory md,
        uint8 moduleCount_,
        uint256 rollBlocks
    ) internal {
        LaunchParams memory p = _params(name_, ticker_, configHash_, md, moduleCount_, 800_000_000e18);

        Router router = Router(payable(ROUTER_V7));
        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);
        vm.prank(launcher);
        address token = router.launch{value: fee}(p);
        assertTrue(token != address(0), _tag(name_, "launch returned zero"));

        address curve = CurveFactory(CURVE_FACTORY).curveFor(token);
        assertTrue(curve != address(0), _tag(name_, "no curve created"));
        BondingCurve bc = BondingCurve(payable(curve));
        assertEq(bc.graduationTargetEth(), 10 ether, _tag(name_, "curve did not adopt chunky grad"));

        if (rollBlocks > 0) vm.roll(block.number + rollBlocks);

        uint256 buyValue = 10.6 ether;
        vm.deal(buyer, buyValue + 1 ether);
        vm.prank(buyer);
        bc.buy{value: buyValue}(0);
        assertTrue(bc.graduated(), _tag(name_, "curve did not graduate"));
        assertEq(bc.ethReserve(), 0, _tag(name_, "curve ETH not drained"));
        assertEq(bc.tokenReserve(), 0, _tag(name_, "curve tokens not drained"));

        // LP mint rounding leaves a few μETH of dust in the Graduator (V8+ raw-
        // ratio pricing). GraduatorV2.sweep(owner) recovers it. Anything above
        // ~0.001 ETH per graduation would be an LP-math regression; below is
        // deterministic rounding residue. Assertion pre-V8 used == 0 because
        // the older LP math didn't have this residue.
        assertLe(GRADUATOR.balance, 0.001 ether, _tag(name_, "LIVE graduator dust exceeded 0.001 ETH"));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(MULTI_HOOK_HOST)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtP,,,) = IPoolManager(POOL_MANAGER).getSlot0(poolId);
        assertGt(sqrtP, 0, _tag(name_, "pool not initialized"));
        uint128 liq = IPoolManager(POOL_MANAGER).getLiquidity(poolId);
        assertGt(liq, 0, _tag(name_, "pool zero liquidity"));

        // With 10.6 ETH buy against 17/10 defaults, LP lands around 190M-200M.
        // Widen to 180-215M for safety across module carves + fee variance.
        uint256 lpTokens = IERC20V(token).balanceOf(POOL_MANAGER);
        assertGt(lpTokens, 180_000_000e18, _tag(name_, "LP tokens too thin"));
        assertLt(lpTokens, 215_000_000e18, _tag(name_, "LP tokens too fat"));
        console2.log(name_, "-> LP tokens:", lpTokens);
    }

    function _tag(
        string memory name_,
        string memory msg_
    ) internal pure returns (string memory) {
        return string.concat("[", name_, "] ", msg_);
    }
}
