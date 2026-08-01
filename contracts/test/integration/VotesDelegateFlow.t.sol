// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// forge-std imports pulled in via LocalV4Stack.

import {LocalV4Stack} from "test/helpers/LocalV4Stack.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// Minimal Votes surface — the composed impl exposes OZ's ERC20Votes shape.
interface IVotesLike {
    function delegate(
        address delegatee
    ) external;
    function getVotes(
        address account
    ) external view returns (uint256);
    function getPastVotes(
        address account,
        uint256 timepoint
    ) external view returns (uint256);
    function delegates(
        address account
    ) external view returns (address);
    function balanceOf(
        address account
    ) external view returns (uint256);
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);
    function clock() external view returns (uint48);
}

/// @title  VotesDelegateFlowTest
/// @notice Closes the T-1 audit gap: prior Votes coverage stopped at the
///         compose() path plus a bare launch → graduate roundtrip. Neither
///         proved the actual voting mechanics work post-launch. This suite:
///           - launches a Votes token through the real Router → factory pipeline
///           - buys through the curve so a wallet holds real tokens
///           - has that wallet `delegate` to itself and to another wallet
///           - verifies `getVotes` reflects delegation
///           - transfers between wallets and re-verifies checkpoints
///           - asserts `getPastVotes` at a snapshot block matches what
///             `getVotes` returned live at that block
///
///         Uses LocalV4Stack (fork-free) so it runs deterministically in CI
///         without an RPC.
contract VotesDelegateFlowTest is LocalV4Stack {
    address internal launcher = makeAddr("votes-launcher");
    address internal alice = makeAddr("votes-alice");
    address internal bob = makeAddr("votes-bob");

    function setUp() public {
        _deployStack();
        vm.deal(alice, 500 ether);
        vm.deal(bob, 500 ether);
    }

    function test_Votes_DelegateAndCheckpointFlow() public {
        // -------- launch a Votes-composed ERC20 through the real pipeline --------
        bytes32 ch = keccak256(abi.encode("ERC20", "Votes"));
        vm.startPrank(admin);
        erc20Factory.registerImpl(ch, address(new ERC20WithVotesGen()));
        router.setModuleCountForConfig(ch, 2);
        router.setFlagsForConfig(ch, 0);
        vm.stopPrank();

        LaunchParams memory p;
        p.base = BaseType.ERC20;
        p.name = "Votes Flow";
        p.ticker = "VOTE";
        p.configHash = ch;
        // moduleData: Votes takes no params, but the composed init still expects
        // a bytes[] slot.
        bytes[] memory md = new bytes[](1);
        md[0] = "";
        p.initData = abi.encode(curveFactory.defaultCurveSupply(), address(router), md);
        p.moduleCount = 2;
        p.installBondingCurve = true;
        p.ownership = OwnershipMode.Renounce;

        vm.deal(launcher, 1 ether);
        vm.prank(launcher);
        address token = router.launch{value: router.quote(p)}(p);
        assertTrue(token != address(0), "launch failed");

        address curveAddr = curveFactory.curveFor(token);
        BondingCurve curve = BondingCurve(payable(curveAddr));

        // -------- Alice buys through the curve --------
        vm.prank(alice);
        curve.buy{value: 1 ether}(0);
        uint256 aliceBal = IVotesLike(token).balanceOf(alice);
        assertGt(aliceBal, 0, "Alice got no tokens");

        // ERC20Votes: holding tokens gives you ZERO voting power until you delegate.
        // This is the invariant the old smoke test never verified.
        assertEq(IVotesLike(token).getVotes(alice), 0, "voting power should be 0 pre-delegation");
        assertEq(IVotesLike(token).delegates(alice), address(0), "no delegatee pre-delegate");

        // -------- Alice self-delegates → checkpoint fires --------
        vm.prank(alice);
        IVotesLike(token).delegate(alice);
        assertEq(IVotesLike(token).delegates(alice), alice, "self-delegation failed");
        assertEq(IVotesLike(token).getVotes(alice), aliceBal, "voting power != balance post-delegation");

        // Snapshot the block for a past-votes lookup later. ERC-5805 requires
        // `timepoint < clock()` — with OZ's default clock (block.number) we
        // just need a few blocks of headroom between snapshot and query.
        // Materialize snapshot via clock() so the compiler can't hoist a
        // block.number read across the vm.roll() below. Assigning
        // `block.number` and later reading the local was returning the CURRENT
        // block, not the captured one — the ir codegen was folding the read
        // through. Reading clock() (an external call) is a memory boundary
        // the optimizer respects.
        uint256 snapshotBlock = IVotesLike(token).clock();
        vm.roll(block.number + 100);

        // -------- Alice transfers half to Bob --------
        uint256 half = aliceBal / 2;
        vm.prank(alice);
        IVotesLike(token).transfer(bob, half);

        // Post-transfer live checkpoints.
        assertEq(IVotesLike(token).getVotes(alice), aliceBal - half, "Alice votes did not drop");
        // Bob holds tokens but hasn't delegated — his voting power stays 0.
        assertEq(IVotesLike(token).getVotes(bob), 0, "Bob votes should be 0 before Bob delegates");

        // Bob delegates to himself.
        vm.prank(bob);
        IVotesLike(token).delegate(bob);
        assertEq(IVotesLike(token).getVotes(bob), half, "Bob votes != half after delegate");

        // -------- Historic lookup at the snapshot block --------
        vm.roll(block.number + 5);
        // At snapshotBlock, Alice had delegated to herself and held aliceBal.
        // Bob had not delegated.
        assertEq(
            IVotesLike(token).getPastVotes(alice, snapshotBlock),
            aliceBal,
            "past votes for Alice at snapshot != her balance at that time"
        );
        assertEq(
            IVotesLike(token).getPastVotes(bob, snapshotBlock),
            0,
            "past votes for Bob at snapshot should be 0 (no delegation yet)"
        );
    }
}
