// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";

interface ILiveReads {
    function registry() external view returns (address);
    function feeReceiver() external view returns (address);
    function fees(
        BaseType b
    ) external view returns (uint256);
    function moduleAddOnFee() external view returns (uint256);
    function hookAddOnFee() external view returns (uint256);
    function governanceAddOnFee() external view returns (uint256);
    function uru() external view returns (address);
    function uruSink() external view returns (address);
    function factories(
        BaseType b
    ) external view returns (address);
}

interface IFactoryOwnedLike {
    function owner() external view returns (address);
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function implFor(
        bytes32
    ) external view returns (address);
    function updateImpl(
        bytes32,
        address
    ) external;
}

interface ICurveFactoryReadLike {
    function defaultCurveSupply() external view returns (uint256);
    function defaultGraduationTargetEth() external view returns (uint256);
    function defaultTradeFeeBps() external view returns (uint16);
}

/// @title  RhV5ComposedModulesCurveForkTest
/// @notice Covers the composed multi-module + bonding-curve + graduation path that the
///         solo module matrix in RhV5ModuleCurveGraduationForkTest doesn't exercise.
///
///         Every one of these composed impls is registered on-chain on Robinhood
///         mainnet — the FRONTEND blocks the curve path for baskets containing
///         `requiresOwner` or `taxesTransfers` modules, but a direct-tx caller can
///         still hit them. The V5 fix's Router auto-allowlist + AntiBot allowlisted-from
///         bypass has to survive those combined paths, not just the solo ones.
///
///         Combos exercised (all registered under composed configHashes):
///           - AntiBot,AntiWhale                    (both transfer gates active)
///           - AntiBot,Permit                       (AntiBot + transparent Permit)
///           - AntiBot,AntiWhale,Permit             (both gates + Permit)
///
///         Each launches through RouterV2 with `installBondingCurve = true`,
///         drives the curve to graduation, rolls past the gate window (semantically
///         correct — the launcher chose a restricted-trading window that also
///         applies to post-grad swaps), and verifies the token is freely
///         transferable after.
contract RhV5ComposedModulesCurveForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal constant ROUTER_V2 = 0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE;
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;

    // Composed impl addresses (LibClone targets) — etched with fresh source so
    // the AntiBot allowlisted-from bypass is exercised on-fork before any
    // on-chain redeploy.
    address internal constant IMPL_ANTIBOT_ANTIWHALE = 0x24DBa2875F7BDbF27b1167A297794674F9c51dF1;
    address internal constant IMPL_ANTIBOT_PERMIT = 0xa061E09e19e636E4B27D76c2fe62a7A9D160b760;
    address internal constant IMPL_ANTIBOT_ANTIWHALE_PERMIT = 0xaa0beeAcCDE24B6e2783181b9A1326f25120A800;

    bytes32 internal constant HASH_ANTIBOT_ANTIWHALE = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale"));
    bytes32 internal constant HASH_ANTIBOT_PERMIT = keccak256(abi.encode("ERC20", "AntiBot,Permit"));
    bytes32 internal constant HASH_ANTIBOT_ANTIWHALE_PERMIT =
        keccak256(abi.encode("ERC20", "AntiBot,AntiWhale,Permit"));

    RouterV2 internal router;
    address internal launcher = makeAddr("launcher");
    address internal alice = makeAddr("alice");

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
        if (ROUTER_V2.code.length == 0) vm.skip(true);

        _etchFreshRouter();
        // Etch fresh composed impls so the AntiBot check reflects the from/to
        // bypass fix. Storage lives on the CLONE address, not the impl — clones
        // read impl bytecode via delegatecall — so etching only changes logic.
        vm.etch(IMPL_ANTIBOT_ANTIWHALE, address(new ERC20WithAntiBotAntiWhaleGen()).code);
        vm.etch(IMPL_ANTIBOT_PERMIT, address(new ERC20WithAntiBotPermitGen()).code);
        vm.etch(IMPL_ANTIBOT_ANTIWHALE_PERMIT, address(new ERC20WithAntiBotAntiWhalePermitGen()).code);

        router = RouterV2(payable(ROUTER_V2));
        _ensureFactoryPointsAtLiveRouter(ERC20_FACTORY);
        _restoreV5LiveWiringOnFork();

        vm.deal(launcher, 100 ether);
        vm.deal(alice, 100 ether);
    }

    /// Post-V6-broadcast, V5 is paused and CurveFactory untrusts it. Etch preserves
    /// storage, so paused=true and trustedRouters[V5]=false persist. Fork-only undo.
    address internal constant DEPLOYER_FOR_UNPAUSE = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    function _restoreV5LiveWiringOnFork() internal {
        (bool ok, bytes memory ret) = ROUTER_V2.staticcall(abi.encodeWithSignature("paused()"));
        if (ok && ret.length == 32 && abi.decode(ret, (bool))) {
            vm.prank(DEPLOYER_FOR_UNPAUSE);
            (bool okSet,) = ROUTER_V2.call(abi.encodeWithSignature("setPaused(bool)", false));
            require(okSet, "fork-unpause of V5 Router failed");
        }
        (bool okT, bytes memory retT) =
            CURVE_FACTORY.staticcall(abi.encodeWithSignature("trustedRouters(address)", ROUTER_V2));
        if (okT && retT.length == 32 && !abi.decode(retT, (bool))) {
            vm.prank(DEPLOYER_FOR_UNPAUSE);
            (bool okSetT,) =
                CURVE_FACTORY.call(abi.encodeWithSignature("setTrustedRouter(address,bool)", ROUTER_V2, true));
            require(okSetT, "fork-retrust of V5 Router on CurveFactory failed");
        }
        // NameRegistry.router was rotated to V6 by broadcast. Registry gates
        // name reservation on msg.sender==router, so V5 launches revert
        // NotRouter without this restore. Deployed NameRegistry has the
        // pre-timelock unrestricted setRouter (verified via bytecode grep),
        // so a plain setRouter call succeeds even though router != 0.
        (bool okN, bytes memory retN) =
            address(0x60b797f18292d941E72B2b59916C0afC1A81118C).staticcall(abi.encodeWithSignature("router()"));
        if (okN && retN.length == 32 && abi.decode(retN, (address)) != ROUTER_V2) {
            (bool okOwn, bytes memory retOwn) =
                address(0x60b797f18292d941E72B2b59916C0afC1A81118C).staticcall(abi.encodeWithSignature("owner()"));
            require(okOwn && retOwn.length == 32, "NameRegistry owner read failed");
            address own = abi.decode(retOwn, (address));
            vm.prank(own);
            (bool okSet,) = address(0x60b797f18292d941E72B2b59916C0afC1A81118C)
                .call(abi.encodeWithSignature("setRouter(address)", ROUTER_V2));
            require(okSet, "fork-restore NameRegistry.router to V5 failed");
        }
    }

    function _etchFreshRouter() internal {
        ILiveReads live = ILiveReads(ROUTER_V2);
        RouterV2 fresh = new RouterV2(
            address(this),
            NameRegistry(live.registry()),
            IFeeReceiver(live.feeReceiver()),
            live.fees(BaseType.ERC20),
            live.fees(BaseType.ERC721A),
            live.fees(BaseType.ERC1155),
            live.moduleAddOnFee(),
            live.hookAddOnFee(),
            live.governanceAddOnFee(),
            live.uru(),
            UruDepositSink(payable(live.uruSink()))
        );
        vm.etch(ROUTER_V2, address(fresh).code);
    }

    function _ensureFactoryPointsAtLiveRouter(
        address factory
    ) internal {
        if (IFactoryOwnedLike(factory).router() == ROUTER_V2) return;
        address own = IFactoryOwnedLike(factory).owner();
        vm.prank(own);
        IFactoryOwnedLike(factory).setRouter(ROUTER_V2);
    }

    // ============================================================
    // Composed combo tests — each launches WITH curve, buys to
    // graduation, then verifies post-grad transferability.
    // ============================================================

    function test_AntiBotAntiWhale_LaunchAndGraduateWithCurve() public {
        bytes[] memory mods = new bytes[](2);
        mods[0] = abi.encode(uint16(5)); // AntiBot: gate=5 blocks
        mods[1] = abi.encode(uint128(1_000_000_000e18), uint128(1_000_000_000e18), uint32(1000));
        (address token, address curve) =
            _launchWithCurve(HASH_ANTIBOT_ANTIWHALE, "AntiBot AntiWhale Curve", "ABAWC", mods);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "did not graduate");
        // Roll past both gates so post-grad transferability is verifiable.
        vm.roll(block.number + 1010);
        _assertPostGradTransferrable(token);
    }

    function test_AntiBotPermit_LaunchAndGraduateWithCurve() public {
        bytes[] memory mods = new bytes[](2);
        mods[0] = abi.encode(uint16(5)); // AntiBot: gate=5 blocks
        mods[1] = ""; // Permit has no module data
        (address token, address curve) = _launchWithCurve(HASH_ANTIBOT_PERMIT, "AntiBot Permit Curve", "ABPC", mods);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "did not graduate");
        vm.roll(block.number + 10);
        _assertPostGradTransferrable(token);
    }

    function test_AntiBotAntiWhalePermit_LaunchAndGraduateWithCurve() public {
        bytes[] memory mods = new bytes[](3);
        mods[0] = abi.encode(uint16(5));
        mods[1] = abi.encode(uint128(1_000_000_000e18), uint128(1_000_000_000e18), uint32(1000));
        mods[2] = "";
        (address token, address curve) =
            _launchWithCurve(HASH_ANTIBOT_ANTIWHALE_PERMIT, "AntiBot AntiWhale Permit Curve", "ABAWPC", mods);
        _buyUntilGraduated(curve);
        assertTrue(BondingCurve(payable(curve)).graduated(), "did not graduate");
        vm.roll(block.number + 1010);
        _assertPostGradTransferrable(token);
    }

    // ============================================================
    // Helpers
    // ============================================================

    function _launchWithCurve(
        bytes32 configHash,
        string memory name_,
        string memory ticker_,
        bytes[] memory mods
    ) internal returns (address token, address curve) {
        uint256 supply = ICurveFactoryReadLike(CURVE_FACTORY).defaultCurveSupply();

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = name_;
        p.ticker = ticker_;
        p.configHash = configHash;
        p.initData = abi.encode(supply, ROUTER_V2, mods);
        p.moduleCount = uint8(mods.length);
        p.installHook = false;
        p.installGovernance = false;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
        p.ownerTargetIfMultisig = address(0);
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;

        uint256 fee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
        curve = _readCurveFromLogs(token);
    }

    /// The BondingCurve address is not returned from launch — read it via
    /// CurveFactory's deterministic mapping.
    function _readCurveFromLogs(
        address token
    ) internal view returns (address curve) {
        (bool ok, bytes memory ret) = CURVE_FACTORY.staticcall(abi.encodeWithSignature("curveFor(address)", token));
        require(ok, "curveFor failed");
        curve = abi.decode(ret, (address));
        require(curve != address(0), "curve missing");
    }

    /// Buy repeatedly through the curve until it graduates.
    function _buyUntilGraduated(
        address curve
    ) internal {
        BondingCurve bc = BondingCurve(payable(curve));
        while (!bc.graduated()) {
            vm.prank(alice);
            bc.buy{value: 0.5 ether}(0);
        }
    }

    /// After graduation the token should be freely transferable outside the
    /// module gates. We simulate by having alice transfer 1 token to a fresh
    /// address — that touches `_beforeTokenTransfer` with a non-owner, non-
    /// allowlisted sender, so any lingering gate would revert.
    function _assertPostGradTransferrable(
        address token
    ) internal {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", alice));
        require(ok, "balanceOf failed");
        uint256 bal = abi.decode(ret, (uint256));
        require(bal > 0, "alice has no tokens after graduation");

        address bob = makeAddr("bob");
        vm.prank(alice);
        (bool okT,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", bob, 1));
        require(okT, "post-grad transfer reverted (gate still active or curve not allowlisted)");
    }
}
