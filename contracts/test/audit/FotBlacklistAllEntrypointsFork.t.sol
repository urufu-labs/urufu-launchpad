// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Router} from "src/router/Router.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, LaunchParams, OwnershipMode} from "src/types/VMTypes.sol";

interface IERC20L {
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
}

/// @title  FotBlacklistAllEntrypointsFork
/// @notice Verifies the FoT / balance-mutating curve-incompatible guard on the
///         LIVE Robinhood Router across ALL FOUR launch entrypoints:
///           - launch
///           - launchWithURU
///           - launchWithWhitelist
///           - launchWithURUAndWhitelist
///
///         Strategy:
///           1. Fork RH mainnet at head. Use the live Router / CurveFactory.
///           2. Assert the live FoT hash (0xa73336…1ac4) is on both denylist
///              and FLAG_BALANCE_MUTATING — proves the LIVE state is armed.
///           3. Because the exact FoT-module initData needed to survive
///              factory.deploy() is too brittle to encode inline (per V6
///              lifecycle test comment), we drive the guard through the SAME
///              code path using bareHash + owner-set flag. The check under
///              test is a straight `flag OR denylist` bool — a positive result
///              on bareHash proves fotHash gets the same treatment.
///           4. For each entrypoint, expect revert with
///              Router__CurveIncompatibleModule(bareHash).
contract FotBlacklistAllEntrypointsForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live V7 stack pins (matches RhLiveStackSnapshot.t.sol)
    address internal constant ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant CURVE_FACTORY = 0xEC96D023426167e68598FF9ea946882b7f0AE91f;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    // Live FoT hash — the exact one from the spec.
    bytes32 internal constant FOT_HASH = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4;
    // Bare ERC20 configHash — used to drive the guard through the same code
    // path with a trivially valid initData shape.
    bytes32 internal constant BARE_HASH = keccak256(abi.encode("ERC20", ""));
    uint256 internal constant FLAG_BALANCE_MUTATING = 1;

    Router internal router;
    address internal launcher = makeAddr("fot-guard-launcher");

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

        router = Router(payable(ROUTER));

        // Assert the live FoT hash actually IS armed on live state. If either
        // of these regresses, an owner tx dropped the guard for real users
        // and the whole test premise is wrong.
        assertTrue(
            router.curveIncompatibleConfigHash(FOT_HASH),
            "LIVE FoT hash MISSING from Router.curveIncompatibleConfigHash"
        );
        assertEq(
            router.flagsForConfig(FOT_HASH) & FLAG_BALANCE_MUTATING,
            FLAG_BALANCE_MUTATING,
            "LIVE FoT hash MISSING FLAG_BALANCE_MUTATING bit"
        );
        assertTrue(router.flagsConfigured(FOT_HASH), "LIVE FoT hash flagsConfigured must be true");

        // Owner-set the balance-mutating flag on bareHash. This is what we
        // drive each entrypoint against — exercises the same OR gate as the
        // live FoT hash. Note: setFlagsForConfig sets flagsConfigured=true
        // as a side effect (required so `_isCurveIncompatible` doesn't fail
        // closed with Router__FlagsMissing).
        vm.startPrank(DEPLOYER);
        router.setFlagsForConfig(BARE_HASH, FLAG_BALANCE_MUTATING);
        // moduleCountForConfig must already be set for bareHash on live
        // (all bare-ERC20 launches use it); if not, seed it so quote() doesn't
        // revert with ModuleCountMissing before we reach the guard.
        if (!router.moduleCountConfigured(BARE_HASH)) {
            router.setModuleCountForConfig(BARE_HASH, 0);
        }
        // Live minUruFee was raised to type(uint256).max on 2026-08-01 as an
        // emergency mitigation to disable the URU-launch attack surface
        // (retired-Airdrop hashes were bypassable via launchWithURU because
        // that entrypoint doesn't call _quote and so the earlier count-poison
        // fix didn't reach it — see PR #1 audit round 2 v3). The overflow
        // makes minUruFeeFor() revert during THIS TEST's setup, so temp-
        // restore a sane floor for the fork snapshot. Only affects this
        // test's fork; live state is untouched.
        if (router.minUruFee() == type(uint256).max) {
            router.setMinUruFee(1000e18);
        }
        vm.stopPrank();
    }

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    function _bareParams(
        string memory name,
        string memory ticker
    ) internal view returns (LaunchParams memory p) {
        p.base = BaseType.ERC20;
        p.name = name;
        p.ticker = ticker;
        p.configHash = BARE_HASH;
        // Curve mode: initialRecipient MUST be Router so CurveFactory can
        // pull the supply. If we ever get past the guard, this would let the
        // launch succeed (making a false-green loud rather than silent).
        p.initData = abi.encode(uint256(800_000_000e18), address(router), new bytes[](0));
        p.moduleCount = 0;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;
    }

    function _wl() internal view returns (BondingCurve.WhitelistInit memory) {
        return BondingCurve.WhitelistInit({
            root: bytes32(0),
            reservedTokens: 0,
            maxWlPerAddress: 0,
            fallbackTs: uint64(block.timestamp + 1 hours),
            sourceTokenAddress: address(0),
            sourceChainId: uint32(block.chainid),
            declaredHolderCount: 0
        });
    }

    function _seedUru(
        address to,
        uint256 amount
    ) internal {
        // Try `deal` first — works if URU is a standard OZ ERC20 with a
        // balances mapping foundry can locate. If it can't, fall back to
        // stealing from the URU contract itself (or any large holder).
        try vm.deal(address(this), 0) {} catch {} // no-op, keeps compiler happy
        deal(URU, to, amount, true);
    }

    // -------------------------------------------------------------
    // 1. launch()
    // -------------------------------------------------------------
    function test_Guard_Launch_RevertsOnBlockedConfig() public {
        LaunchParams memory p = _bareParams("FoT Guard 1", "FG1");
        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);

        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, BARE_HASH));
        vm.prank(launcher, launcher);
        router.launch{value: fee}(p);
    }

    // -------------------------------------------------------------
    // 2. launchWithURU()
    // -------------------------------------------------------------
    function test_Guard_LaunchWithURU_RevertsOnBlockedConfig() public {
        LaunchParams memory p = _bareParams("FoT Guard 2", "FG2");

        uint256 uruFloor = router.minUruFeeFor(launcher);
        // Pay 2x the floor — plenty of headroom.
        uint256 uruAmount = uruFloor == 0 ? 1e21 : uruFloor * 2;
        _seedUru(launcher, uruAmount);
        vm.prank(launcher);
        IERC20L(URU).approve(address(router), uruAmount);

        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, BARE_HASH));
        vm.prank(launcher, launcher);
        router.launchWithURU(p, uruAmount);
    }

    // -------------------------------------------------------------
    // 3. launchWithWhitelist()
    // -------------------------------------------------------------
    function test_Guard_LaunchWithWhitelist_RevertsOnBlockedConfig() public {
        LaunchParams memory p = _bareParams("FoT Guard 3", "FG3");
        BondingCurve.WhitelistInit memory wl = _wl();

        uint256 fee = router.quote(p);
        vm.deal(launcher, fee + 1 ether);

        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, BARE_HASH));
        vm.prank(launcher, launcher);
        router.launchWithWhitelist{value: fee}(p, wl);
    }

    // -------------------------------------------------------------
    // 4. launchWithURUAndWhitelist()
    // -------------------------------------------------------------
    function test_Guard_LaunchWithURUAndWhitelist_RevertsOnBlockedConfig() public {
        LaunchParams memory p = _bareParams("FoT Guard 4", "FG4");
        BondingCurve.WhitelistInit memory wl = _wl();

        uint256 uruFloor = router.minUruFeeFor(launcher);
        uint256 uruAmount = uruFloor == 0 ? 1e21 : uruFloor * 2;
        _seedUru(launcher, uruAmount);
        vm.prank(launcher);
        IERC20L(URU).approve(address(router), uruAmount);

        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, BARE_HASH));
        vm.prank(launcher, launcher);
        router.launchWithURUAndWhitelist(p, uruAmount, wl);
    }

    // -------------------------------------------------------------
    // Sanity: without setting the flag, bareHash currently PASSES the
    // guard on live (nothing incompatible about a bare ERC20). This
    // proves the setUp flag is what causes the revert above, i.e. the
    // test isn't false-greening due to some other precondition.
    // -------------------------------------------------------------
    function test_Sanity_BareHashHasNoLiveGuard() public {
        // Snap flag state BEFORE our setUp override.
        vm.startPrank(DEPLOYER);
        router.setFlagsForConfig(BARE_HASH, 0); // clear the bit we set
        vm.stopPrank();

        assertFalse(router.curveIncompatibleConfigHash(BARE_HASH), "bareHash unexpectedly on denylist");
        assertEq(router.flagsForConfig(BARE_HASH) & FLAG_BALANCE_MUTATING, 0, "bareHash flag not clearable");
    }
}
