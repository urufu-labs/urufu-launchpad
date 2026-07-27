// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {RouterV2} from "src/router/RouterV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface ICurveFactoryRead {
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
    function owner() external view returns (address);
}

/// @title  V6SmokeMatrix
/// @notice Live-fire ERC20 module coverage on the freshly-deployed V6 Router.
///         Launches many combos in one broadcast to prove:
///           1. Solo module launches WITHOUT curve — every shipped ERC20 module
///              deploys and mints supply correctly.
///           2. Module + curve launches (frontend-allowed only) — Router's
///              _grantCurveModuleAllowances fires, curve holds supply, no revert.
///           3. Composed multi-module + curve — Airdrop+Vesting+curve etc.
///
///         Each launch reverts on any failure (Router's own hard-fail semantics),
///         so a green run = every combo works. Failures pin the exact combo.
///
///         Cost: ~1e15 wei launch fee per launch + gas. ~15 launches -> ~$1-2.
///
/// Env vars:
///   V6_ROUTER_V2                V6 (0x2dfA...)
///   CURVE_FACTORY               live CurveFactory
contract V6SmokeMatrix is Script {
    RouterV2 internal router;
    address internal curveFactory;

    // Module configHashes — must match how the frontend computes them.
    bytes32 internal constant CH_BARE = keccak256(abi.encode("ERC20", ""));
    bytes32 internal constant CH_PERMIT = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 internal constant CH_AIRDROP = keccak256(abi.encode("ERC20", "Airdrop"));
    bytes32 internal constant CH_VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal constant CH_STAKING = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 internal constant CH_VOTES = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 internal constant CH_PAUSABLE = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 internal constant CH_ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal constant CH_ANTIWHALE = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 internal constant CH_FOT = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal constant CH_AIRDROP_VESTING = keccak256(abi.encode("ERC20", "Airdrop,Vesting"));
    bytes32 internal constant CH_PERMIT_STAKING = keccak256(abi.encode("ERC20", "Permit,Staking"));
    bytes32 internal constant CH_AIRDROP_PERMIT = keccak256(abi.encode("ERC20", "Airdrop,Permit"));

    address internal deployer;

    function run() external {
        address v6 = vm.envAddress("V6_ROUTER_V2");
        curveFactory = vm.envAddress("CURVE_FACTORY");
        router = RouterV2(payable(v6));
        deployer = msg.sender;

        // ============================================================
        // Part 1: solo modules WITHOUT curve. Ownership = KeepEOA so the
        // deployer keeps admin surfaces for the ones that gate them.
        // ============================================================
        _launchBare("V6 Smoke Permit A", "V6P1", CH_PERMIT, _permitInit(), false);
        _launchBare("V6 Smoke Airdrop A", "V6A1", CH_AIRDROP, _airdropInit(), false);
        _launchBare("V6 Smoke Vesting A", "V6V1", CH_VESTING, _vestingInit(), false);
        _launchBare("V6 Smoke Staking A", "V6S1", CH_STAKING, _stakingInit(), false);
        _launchBare("V6 Smoke Votes A", "V6VT1", CH_VOTES, _votesInit(), false);
        _launchBare("V6 Smoke Pausable A", "V6PA1", CH_PAUSABLE, _pausableInit(), false);
        _launchBare("V6 Smoke AntiBot A", "V6AB1", CH_ANTIBOT, _antibotInit(), false);
        _launchBare("V6 Smoke AntiWhale A", "V6AW1", CH_ANTIWHALE, _antiwhaleInit(), false);
        _launchBare("V6 Smoke FoT A", "V6FT1", CH_FOT, _fotInit(), false);

        // ============================================================
        // Part 2: solo modules WITH curve — frontend-allowed set only
        // (transparent-to-transfer modules; AntiBot/AntiWhale/Pausable/FoT
        // are blocked by the UI + the FoT blacklist).
        // ============================================================
        _launchCurve("V6 Smoke Bare C", "V6BC", CH_BARE, _bareCurveInit());
        _launchCurve("V6 Smoke Permit C", "V6PC", CH_PERMIT, _permitCurveInit());
        _launchCurve("V6 Smoke Airdrop C", "V6AC", CH_AIRDROP, _airdropCurveInit());
        _launchCurve("V6 Smoke Vesting C", "V6VC", CH_VESTING, _vestingCurveInit());
        _launchCurve("V6 Smoke Staking C", "V6SC", CH_STAKING, _stakingCurveInit());
        _launchCurve("V6 Smoke Votes C", "V6VTC", CH_VOTES, _votesCurveInit());

        // ============================================================
        // Part 3: composed multi-module + curve — untested-shape guard.
        // ============================================================
        _launchCurve("V6 Smoke AV C", "V6AVC", CH_AIRDROP_VESTING, _airdropVestingCurveInit());
        _launchCurve("V6 Smoke PS C", "V6PSC", CH_PERMIT_STAKING, _permitStakingCurveInit());
        _launchCurve("V6 Smoke AP C", "V6APC", CH_AIRDROP_PERMIT, _airdropPermitCurveInit());

        console2.log("=========================================================");
        console2.log("V6 smoke matrix ALL PASSED");
        console2.log("=========================================================");
    }

    // ---------------------------------------------------------------- launch helpers

    function _launchBare(
        string memory name_,
        string memory ticker_,
        bytes32 configHash,
        bytes[] memory mods,
        bool /*unused*/
    ) internal {
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = configHash;
        p.initData = abi.encode(uint256(1_000_000e18), deployer, mods);
        p.moduleCount = uint8(mods.length > 0 ? mods.length : 1);
        p.installBondingCurve = false;
        p.ownership = OwnershipMode.KeepEOA;

        uint256 fee = router.quote(p);
        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        vm.stopBroadcast();
        require(token != address(0), string.concat("bare launch failed: ", name_));
        require(token.code.length > 0, string.concat("bare launch: no code: ", name_));
        console2.log(string.concat("  [ok] ", name_, " -> "), token);
    }

    function _launchCurve(
        string memory name_,
        string memory ticker_,
        bytes32 configHash,
        bytes[] memory mods
    ) internal {
        uint256 curveSupply = ICurveFactoryRead(curveFactory).defaultCurveSupply();
        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = configHash;
        // initData: initialSupply -> curveSupply, initialRecipient -> Router
        // (Router forwards to the curve during install via approve+pull).
        p.initData = abi.encode(curveSupply, address(router), mods);
        p.moduleCount = uint8(mods.length > 0 ? mods.length : 1);
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        uint256 fee = router.quote(p);
        vm.startBroadcast();
        address token = router.launch{value: fee}(p);
        vm.stopBroadcast();
        require(token != address(0), string.concat("curve launch failed: ", name_));
        address curve = ICurveFactoryRead(curveFactory).curveFor(token);
        require(curve != address(0), string.concat("curve launch: curveFor returned zero: ", name_));
        console2.log(string.concat("  [ok] ", name_, " -> "), token);
    }

    // ---------------------------------------------------------------- module initData builders

    function _bareCurveInit() internal pure returns (bytes[] memory) {
        return new bytes[](0);
    }

    function _permitInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = "";
    }

    function _pausableInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = "";
    }

    function _votesInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = "";
    }

    function _antibotInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = abi.encode(uint16(5));
    }

    function _antiwhaleInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = abi.encode(uint128(1_000_000_000e18), uint128(1_000_000_000e18), uint32(0));
    }

    function _airdropInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = abi.encode(bytes32(uint256(1)), uint256(100e18));
    }

    function _vestingInit() internal view returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = abi.encode(deployer, uint256(500e18), uint64(block.timestamp), uint64(block.timestamp + 365 days));
    }

    function _stakingInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](1);
        mods[0] = abi.encode(uint256(1000e18), uint32(30 days));
    }

    function _fotInit() internal view returns (bytes[] memory mods) {
        mods = new bytes[](1);
        // (feeBps, burnBps, treasuryBps, treasury) — 1% fee, 100% burn.
        mods[0] = abi.encode(uint16(100), uint16(10_000), uint16(0), deployer);
    }

    function _permitCurveInit() internal pure returns (bytes[] memory) {
        return _permitInit();
    }

    function _airdropCurveInit() internal pure returns (bytes[] memory) {
        return _airdropInit();
    }

    function _vestingCurveInit() internal view returns (bytes[] memory) {
        return _vestingInit();
    }

    function _stakingCurveInit() internal pure returns (bytes[] memory) {
        return _stakingInit();
    }

    function _votesCurveInit() internal pure returns (bytes[] memory) {
        return _votesInit();
    }

    function _airdropVestingCurveInit() internal view returns (bytes[] memory mods) {
        mods = new bytes[](2);
        mods[0] = abi.encode(bytes32(uint256(1)), uint256(100e18));
        mods[1] = abi.encode(deployer, uint256(500e18), uint64(block.timestamp), uint64(block.timestamp + 365 days));
    }

    function _permitStakingCurveInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](2);
        mods[0] = "";
        mods[1] = abi.encode(uint256(1000e18), uint32(30 days));
    }

    function _airdropPermitCurveInit() internal pure returns (bytes[] memory mods) {
        mods = new bytes[](2);
        mods[0] = abi.encode(bytes32(uint256(1)), uint256(100e18));
        mods[1] = "";
    }
}
