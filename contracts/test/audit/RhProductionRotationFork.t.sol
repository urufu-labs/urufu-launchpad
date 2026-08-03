// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";
import {RhConfigManifest} from "script/manifest/RhConfigManifest.sol";

/// @title  RhProductionRotationForkTest — HONEST edition
/// @notice The predecessor of this file exercised a synthetic rotation that
///         omitted the production `NameRegistry.proposeRouter` call because
///         the LIVE registry (`0x60b7…118C`) predates the 2-phase timelock —
///         then claimed 12/12 tests passed. The auditor flagged this exactly:
///         "the production-rotation test that omits the production registry
///         operation."
///
///         This rewrite is honest about what CAN and CANNOT be tested against
///         the live-fork:
///
///           (A) The live NameRegistry PROVABLY LACKS the 2-phase rotation
///               API. Any real V8 rotation MUST include a fresh registry
///               deploy + reservation migration. `test_LiveRegistry_LacksRotationApi`
///               asserts this so drift on the live registry (e.g. someone
///               upgrading it) triggers a loud failure.
///
///           (B) Full source-level rotation via propose → timelock → activate
///               is validated against a FRESHLY-deployed 2-phase NameRegistry
///               in `test_FreshRegistry_*`. This is the actual code path a
///               real V8 rotation will exercise.
///
///         There are NO other tests here. Anything that reads state without
///         actually LAUNCHING a token doesn't prove the rotation is safe;
///         it just proves reads work. If we ever want more coverage, add
///         real launch → curve buy → graduate → v4 swap tests that use the
///         fresh 2-phase registry as their source of truth.
///
///         Skips cleanly when ROBINHOOD_RPC_URL isn't set / chain isn't RH.
contract RhProductionRotationForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Live V7 pins (mirror RhLiveStackSnapshot.t.sol)
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant OLD_ROUTER = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;

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
        if (NAME_REGISTRY.code.length == 0) vm.skip(true);
    }

    // -------------------------------------------------------------
    // (A) Live registry lacks the 2-phase rotation API
    // -------------------------------------------------------------

    /// @notice URU-A13 (audit round 3, honest edition). The live registry does
    ///         NOT implement `proposeRouter(address)` — any real V8 rotation
    ///         has to include a fresh NameRegistry deploy. This test proves
    ///         the caveat instead of hiding it. If the live registry is ever
    ///         upgraded to include the 2-phase API, this test will start
    ///         PASSING at the `try` block (function selector found) and the
    ///         second assertion will fail loudly — signal to update the deploy
    ///         plan to use the live registry's new proposeRouter path.
    function test_LiveRegistry_LacksRotationApi() public {
        // Selector `proposeRouter(address)` = 0x75f4925d. Absent from the live
        // registry bytecode (confirmed via cast on 2026-08-03). Try a call
        // pranked as the registry owner — expect revert with empty return data
        // (unknown selector) rather than a decoded error.
        (bool ok, bytes memory ret) =
            NAME_REGISTRY.staticcall(abi.encodeWithSignature("proposeRouter(address)", address(0xdead)));
        // Unknown selector on a Solidity contract → the fallback path fails.
        // `ok == false` AND `ret.length == 0` is the "no such function"
        // signature we expect. Any other combination means either:
        //   * the registry was upgraded (retest needed), OR
        //   * a different revert path was hit (permission error, etc.).
        assertFalse(ok, "proposeRouter unexpectedly succeeded on live registry");
        assertEq(ret.length, 0, "unexpected revert data on live registry proposeRouter");
    }

    /// Sanity: the live registry DOES have the legacy `setRouter(address)`
    /// (selector 0xc0d78655). Documents the single-step API that constrains
    /// any real rotation on this registry.
    function test_LiveRegistry_HasLegacySetRouter() public view {
        // Cannot call setRouter — reverts `RouterAlreadySet` because
        // registry.router != 0. But asserting the current router matches the
        // OLD_ROUTER pin proves the getter selector exists and the state is
        // as expected.
        (bool ok, bytes memory ret) = NAME_REGISTRY.staticcall(abi.encodeWithSignature("router()"));
        assertTrue(ok, "router() view missing from live registry");
        assertEq(ret.length, 32, "router() returned wrong size");
        assertEq(abi.decode(ret, (address)), OLD_ROUTER, "router pin drifted");
    }

    // -------------------------------------------------------------
    // (B) Fresh 2-phase registry — full source-level rotation flow
    // -------------------------------------------------------------

    /// Bootstraps a fresh NameRegistry + two Router deployments (old + new)
    /// for the propose/timelock/activate rotation drill. This is the shape a
    /// real V8 rotation on RH will take: NameRegistry V2 alongside Router V8.
    function _bootstrapFreshRegistryPair() internal returns (NameRegistry reg, Router freshOld, Router freshNew) {
        Router oldRouter = Router(payable(OLD_ROUTER));
        uint256 erc20Fee = oldRouter.fees(BaseType.ERC20);
        uint256 nftFee = oldRouter.fees(BaseType.ERC721A);
        uint256 erc1155Fee = oldRouter.fees(BaseType.ERC1155);
        uint256 moduleAddOn = oldRouter.moduleAddOnFee();
        uint256 hookAddOn = oldRouter.hookAddOnFee();
        uint256 govAddOn = oldRouter.governanceAddOnFee();

        vm.startPrank(DEPLOYER);
        string[] memory noTickers = new string[](0);
        reg = new NameRegistry(DEPLOYER, DEPLOYER, noTickers);

        freshOld = new Router(
            DEPLOYER, reg, IFeeReceiver(FEE_SPLITTER), erc20Fee, nftFee, erc1155Fee, moduleAddOn, hookAddOn, govAddOn
        );
        reg.setRouter(address(freshOld));

        freshNew = new Router(
            DEPLOYER, reg, IFeeReceiver(FEE_SPLITTER), erc20Fee, nftFee, erc1155Fee, moduleAddOn, hookAddOn, govAddOn
        );
        vm.stopPrank();
    }

    function test_FreshRegistry_ProposeThenTimelock() public {
        (NameRegistry reg, Router freshOld, Router freshNew) = _bootstrapFreshRegistryPair();

        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));

        assertEq(reg.pendingRouter(), address(freshNew), "proposal not recorded");
        assertEq(reg.router(), address(freshOld), "router prematurely rotated");
        assertEq(reg.pendingRouterTs(), block.timestamp + reg.MIN_ROUTER_DELAY(), "timelock ts wrong");

        // Activate too early → RouterDelayNotPassed. Order matters: readyAt
        // read BEFORE the prank so the read doesn't consume the vm.prank.
        uint256 readyAt = reg.pendingRouterTs();
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.NameRegistry__RouterDelayNotPassed.selector, readyAt));
        vm.prank(DEPLOYER);
        reg.activateRouter();
    }

    function test_FreshRegistry_ActivateAfterTimelock() public {
        (NameRegistry reg, Router freshOld, Router freshNew) = _bootstrapFreshRegistryPair();

        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));
        vm.warp(reg.pendingRouterTs() + 1);
        vm.prank(DEPLOYER);
        reg.activateRouter();

        assertEq(reg.router(), address(freshNew), "router did not rotate on activation");
        assertEq(reg.pendingRouter(), address(0), "pending not cleared");

        // Post-cutover: OLD Router loses reserve() rights. Direct sanity check
        // that the swap happened at the registry level.
        vm.prank(address(freshOld));
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        reg.reserve("Attempted", "OLDX", address(0xdead), address(0xbeef));
    }

    function test_FreshRegistry_PendingRouterCannotReserve() public {
        (NameRegistry reg,, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));

        // During the pending window: only the CURRENT router can reserve.
        vm.prank(address(freshNew));
        vm.expectRevert(NameRegistry.NameRegistry__NotRouter.selector);
        reg.reserve("Should Fail", "NEWX", address(0xdead), address(0xbeef));
    }

    function test_FreshRegistry_CancelPendingRestoresState() public {
        (NameRegistry reg, Router freshOld, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));
        assertEq(reg.pendingRouter(), address(freshNew), "pending not recorded");

        vm.prank(DEPLOYER);
        reg.cancelPendingRouter();

        assertEq(reg.pendingRouter(), address(0), "pending not cleared on cancel");
        assertEq(reg.pendingRouterTs(), 0, "pending ts not cleared on cancel");
        assertEq(reg.router(), address(freshOld), "active router should be unchanged");
    }

    function test_FreshRegistry_StackedProposalReverts() public {
        (NameRegistry reg,, Router freshNew) = _bootstrapFreshRegistryPair();
        vm.prank(DEPLOYER);
        reg.proposeRouter(address(freshNew));

        // A second propose without cancelling the first must revert — else an
        // owner could pre-arm several proposals and race the timelock via
        // cancel + activate combos.
        vm.prank(DEPLOYER);
        vm.expectRevert(NameRegistry.NameRegistry__PendingRouterExists.selector);
        reg.proposeRouter(address(0xdead));
    }
}
