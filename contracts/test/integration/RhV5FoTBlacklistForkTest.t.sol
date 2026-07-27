// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IFactoryOwned {
    function owner() external view returns (address);
    function router() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function implFor(
        bytes32
    ) external view returns (address);
}

interface IERC20Like {
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

/// @title  RhV5FoTBlacklistForkTest
/// @notice Verifies the FoT-blacklist fix on the V5 RouterV2 (0x5EFA...). Each of the
///         four launch entrypoints MUST revert with Router__CurveIncompatibleModule
///         when called with the on-chain-blacklisted configHash + installBondingCurve.
///
///         Runs against a live RH mainnet fork. Only mutation is factory.setRouter
///         (needed because the on-chain factories still point at the paused OLD
///         router — a fork-only workaround, does not affect prod).
contract RhV5FoTBlacklistForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // V5 stack — new addresses
    address internal constant ROUTER_V2_NEW = 0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE;

    // Unchanged
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    // The on-chain blacklisted configHash (matches keccak256(abi.encode("ERC20", "FeeOnTransfer")))
    bytes32 internal constant FOT_BLACKLISTED_HASH = 0xa73336ef5d2b7ad3439ea3df1f32c5a34fe653411d944d8d0b005b1cd34e1ac4;

    address internal launcher = makeAddr("launcher");

    RouterV2 internal router;

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
        if (ROUTER_V2_NEW.code.length == 0) vm.skip(true);

        router = RouterV2(payable(ROUTER_V2_NEW));

        // Post-V6-broadcast: V5 Router (ROUTER_V2_NEW here) will be paused. This
        // test doesn't actually call any launch functions that check `paused`
        // (they revert on the FoT blacklist BEFORE the pause check via
        // Router__CurveIncompatibleModule), but future launch-flow additions
        // could hit the pause. Un-pause defensively on the fork.
        _restoreV5LiveWiringOnFork();

        // Sanity: blacklist actually set on the live router.
        assertTrue(
            router.curveIncompatibleConfigHash(FOT_BLACKLISTED_HASH),
            "precondition failed: FoT hash not blacklisted on new router"
        );

        // Sanity: FoT impl registered on factory (so deploy() step succeeds and we reach the blacklist check).
        assertTrue(
            IFactoryOwned(ERC20_FACTORY).implFor(FOT_BLACKLISTED_HASH) != address(0),
            "precondition failed: FoT impl not registered on ERC20 factory"
        );

        // Fork-only rewire: on-chain factories still point at the paused OLD router (0xb851...).
        // Prank each owner to point them at the NEW router so factory.deploy() gets past the
        // onlyRouter gate. Confirms only the LIVE router bytecode of 0x5EFA... is exercised.
        _rewireFactory(ERC20_FACTORY);
        _rewireFactory(ERC721A_FACTORY);
        _rewireFactory(ERC1155_FACTORY);

        vm.deal(launcher, 100 ether);
        // Give the launcher URU + approve router for URU-pay paths.
        deal(URU_TOKEN, launcher, 1000e18, true);
        vm.prank(launcher);
        IERC20Like(URU_TOKEN).approve(ROUTER_V2_NEW, type(uint256).max);
    }

    function _rewireFactory(
        address factory
    ) internal {
        address own = IFactoryOwned(factory).owner();
        vm.prank(own);
        IFactoryOwned(factory).setRouter(ROUTER_V2_NEW);
    }

    /// Build LaunchParams targeting the blacklisted FoT configHash with a curve install.
    /// initialRecipient = ROUTER so Router holds the supply if we ever reached the curve
    /// install (we don't — the blacklist check reverts first).
    function _fotParams(
        string memory name_,
        string memory ticker_
    ) internal view returns (LaunchParams memory) {
        // Valid FoT moduleData: 1% fee, 100% burn, 0% treasury, zero treasury address.
        bytes[] memory mods = new bytes[](1);
        mods[0] = abi.encode(uint16(100), uint16(10_000), uint16(0), address(0));

        return LaunchParams({
            base: BaseType.ERC20,
            name: name_,
            ticker: ticker_,
            configHash: FOT_BLACKLISTED_HASH,
            initData: abi.encode(uint256(800_000_000e18), ROUTER_V2_NEW, mods),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: true, // ← the flag that arms the blacklist check
            ownership: OwnershipMode.Renounce,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    function _wl() internal view returns (BondingCurve.WhitelistInit memory) {
        return BondingCurve.WhitelistInit({
            root: bytes32(uint256(0xabc)),
            reservedTokens: 100_000_000e18,
            maxWlPerAddress: 10_000_000e18,
            fallbackTs: uint64(block.timestamp + 7 days),
            sourceTokenAddress: address(0),
            sourceChainId: 0,
            declaredHolderCount: 0
        });
    }

    // ============================================================
    // 1/4 - Router.launch (parent)
    // ============================================================
    function test_Launch_FotBlacklisted_Reverts() public {
        LaunchParams memory p = _fotParams("FoT Launch A", "FOTA");
        uint256 fee = router.fees(BaseType.ERC20);

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, FOT_BLACKLISTED_HASH));
        router.launch{value: fee}(p);
    }

    // ============================================================
    // 2/4 - RouterV2.launchWithURU
    // ============================================================
    function test_LaunchWithURU_FotBlacklisted_Reverts() public {
        LaunchParams memory p = _fotParams("FoT Launch B", "FOTB");
        uint256 uruAmount = router.minUruFee();
        if (uruAmount == 0) uruAmount = 100e18;

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, FOT_BLACKLISTED_HASH));
        router.launchWithURU(p, uruAmount);
    }

    // ============================================================
    // 3/4 - RouterV2.launchWithWhitelist
    // ============================================================
    function test_LaunchWithWhitelist_FotBlacklisted_Reverts() public {
        LaunchParams memory p = _fotParams("FoT Launch C", "FOTC");
        uint256 fee = router.fees(BaseType.ERC20);

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, FOT_BLACKLISTED_HASH));
        router.launchWithWhitelist{value: fee}(p, _wl());
    }

    // ============================================================
    // 4/4 - RouterV2.launchWithURUAndWhitelist
    // ============================================================
    function test_LaunchWithURUAndWhitelist_FotBlacklisted_Reverts() public {
        LaunchParams memory p = _fotParams("FoT Launch D", "FOTD");
        uint256 uruAmount = router.minUruFee();
        if (uruAmount == 0) uruAmount = 100e18;

        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Router.Router__CurveIncompatibleModule.selector, FOT_BLACKLISTED_HASH));
        router.launchWithURUAndWhitelist(p, uruAmount, _wl());
    }

    address internal constant DEPLOYER_FOR_UNPAUSE = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    /// Fork-only undo of V6-broadcast state so tests running against V5 address
    /// still behave. See RhV5ModuleCurveGraduationForkTest for the same helper.
    function _restoreV5LiveWiringOnFork() internal {
        (bool ok, bytes memory ret) = ROUTER_V2_NEW.staticcall(abi.encodeWithSignature("paused()"));
        if (ok && ret.length == 32 && abi.decode(ret, (bool))) {
            vm.prank(DEPLOYER_FOR_UNPAUSE);
            (bool okSet,) = ROUTER_V2_NEW.call(abi.encodeWithSignature("setPaused(bool)", false));
            require(okSet, "fork-unpause of V5 Router failed");
        }
    }
}
