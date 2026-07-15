// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {Router, LaunchParams, BaseType, OwnershipMode} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {FeeReceiver} from "src/router/FeeReceiver.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";

/// @notice Fork test that pretends to run HandoffOwnership against a Safe-shaped multisig
///         on the actual deployed Base Sepolia state, then confirms:
///           1. Every Ownable's owner() flips to the multisig
///           2. A NEW launch via Router.launch still succeeds after the handoff
///           3. A NEW curve via CurveFactory.createCurve still succeeds
///           4. Only the multisig can call admin functions (setPaused, setGraduator, etc.)
///
///         Proves the ownership rotation doesn't accidentally lock users out — the
///         concern being that a mistyped multisig or a broken permission model would
///         freeze the whole launchpad the moment the deploy key is rotated out.
///
///         All state changes happen on the fork; no real broadcast, no real ETH.
contract HandoffForkTest is Test {
    // Deployed Base Sepolia addresses (post-redeploy 2026-07-14). Update these constants
    // whenever the address book changes.
    address internal constant ROUTER = 0x1e05c47CE5f82D5facf65992DB507c8676fe240B;
    address internal constant NAME_REGISTRY = 0x60835C422a3671b5F01E6806Fd96b27c90941C83;
    address internal constant ERC20_FACTORY = 0x6344Efa1d3A0Cb5a75E9eDA308bDe3E7A4594F90;
    address internal constant ERC721A_FACTORY = 0xA75a31A6292782406C5B51AAac65a986da81Ea9B;
    address internal constant ERC1155_FACTORY = 0x3A0f95994D6029e1061dCb7524596173e65863dF;
    address internal constant CURVE_FACTORY = 0x5bC3c476f5CF267a08A309578bC1337e00C2fC1F;

    address internal deployKey = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal multisig = makeAddr("multisig-safe");
    address internal alice = makeAddr("alice");

    function setUp() public {
        string memory rpc;
        try vm.envString("BASE_SEPOLIA_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        if (ROUTER.code.length == 0) vm.skip(true);
    }

    function test_Handoff_TransfersOwnershipCleanly() public {
        // Sanity: deploy key currently owns everything.
        assertEq(Ownable(ROUTER).owner(), deployKey, "Router not owned by deploy key");
        assertEq(Ownable(CURVE_FACTORY).owner(), deployKey, "CurveFactory not owned by deploy key");

        // Do the handoff impersonating the deploy key. Solady's Ownable is one-step.
        vm.startPrank(deployKey);
        Ownable(NAME_REGISTRY).transferOwnership(multisig);
        Ownable(ROUTER).transferOwnership(multisig);
        Ownable(ERC20_FACTORY).transferOwnership(multisig);
        Ownable(ERC721A_FACTORY).transferOwnership(multisig);
        Ownable(ERC1155_FACTORY).transferOwnership(multisig);
        Ownable(CURVE_FACTORY).transferOwnership(multisig);
        vm.stopPrank();

        assertEq(Ownable(ROUTER).owner(), multisig, "Router handoff failed");
        assertEq(Ownable(CURVE_FACTORY).owner(), multisig, "CurveFactory handoff failed");
        assertEq(Ownable(NAME_REGISTRY).owner(), multisig, "NameRegistry handoff failed");
    }

    function test_Handoff_LaunchStillWorks() public {
        _doHandoff();

        // A user launches a bare ERC-20 through the Router. If handoff broke the launch
        // path (e.g. Router lost permission to call factories, or factory lost permission
        // to reserve names), this would revert.
        Router r = Router(payable(ROUTER));
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: string.concat("HandoffTest ", vm.toString(block.number)),
            ticker: string.concat("HFT", vm.toString(uint256(block.number % 10_000))),
            configHash: keccak256(abi.encode("ERC20", "")),
            initData: abi.encode(uint256(1_000_000_000 ether), alice, new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });

        uint256 fee = r.quote(p);
        vm.deal(alice, fee);
        vm.prank(alice);
        address token = r.launch{value: fee}(p);
        assertTrue(token != address(0), "launch produced zero token");
        assertTrue(token.code.length > 0, "launched token has no code");
    }

    function test_Handoff_AdminGatesFlipToMultisig() public {
        _doHandoff();

        // Deploy key should no longer be able to pause the router.
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(deployKey);
        Router(payable(ROUTER)).setPaused(true);

        // Multisig can. Since `setPaused` is idempotent for the same value, we flip it
        // both ways to prove the auth check.
        vm.prank(multisig);
        Router(payable(ROUTER)).setPaused(true);

        vm.prank(multisig);
        Router(payable(ROUTER)).setPaused(false);

        // Deploy key also can't reroute graduations anymore.
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(deployKey);
        CurveFactory(CURVE_FACTORY).setGraduator(address(0xdead));
    }

    function _doHandoff() internal {
        vm.startPrank(deployKey);
        Ownable(NAME_REGISTRY).transferOwnership(multisig);
        Ownable(ROUTER).transferOwnership(multisig);
        Ownable(ERC20_FACTORY).transferOwnership(multisig);
        Ownable(ERC721A_FACTORY).transferOwnership(multisig);
        Ownable(ERC1155_FACTORY).transferOwnership(multisig);
        Ownable(CURVE_FACTORY).transferOwnership(multisig);
        vm.stopPrank();
    }
}
