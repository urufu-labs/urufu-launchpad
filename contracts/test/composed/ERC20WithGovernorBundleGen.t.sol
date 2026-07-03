// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ERC20WithGovernorBundleGen} from "src/templates/composed/ERC20WithGovernorBundleGen.sol";
import {VMGovernor} from "src/governance/VMGovernor.sol";

contract ERC20WithGovernorBundleGenTest is Test {
    ERC20WithGovernorBundleGen internal impl;
    ERC20WithGovernorBundleGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    uint48 internal constant VOTING_DELAY = 1 days;
    uint32 internal constant VOTING_PERIOD = 7 days;
    uint256 internal constant PROPOSAL_THRESHOLD = 1000 ether;
    uint256 internal constant QUORUM_NUMERATOR = 4;
    uint256 internal constant TIMELOCK_MIN_DELAY = 2 days;
    uint256 internal constant INITIAL = 100_000 ether;

    function setUp() public {
        impl = new ERC20WithGovernorBundleGen();
        token = ERC20WithGovernorBundleGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](2);
        // Modules are sorted alphabetically by the splicer: GovernorBundle < Votes.
        moduleData[0] =
            abi.encode(VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, QUORUM_NUMERATOR, TIMELOCK_MIN_DELAY);
        moduleData[1] = "";
        bytes memory initData = abi.encode(owner, "Gov", "GOV", INITIAL, alice, moduleData);
        token.initialize(initData);
    }

    function test_Init_DeploysBoth() public view {
        assertTrue(token.governor() != address(0));
        assertTrue(token.timelock() != address(0));
    }

    function test_Init_TimelockConfigured() public view {
        TimelockController tl = TimelockController(payable(token.timelock()));
        assertEq(tl.getMinDelay(), TIMELOCK_MIN_DELAY);
        // Governor has proposer + canceller.
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), token.governor()));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), token.governor()));
        // Token admin renounced.
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(token)));
    }

    function test_Init_GovernorPointsAtToken() public view {
        VMGovernor gov = VMGovernor(payable(token.governor()));
        assertEq(address(gov.token()), address(token));
        assertEq(gov.votingDelay(), VOTING_DELAY);
        assertEq(gov.votingPeriod(), VOTING_PERIOD);
        assertEq(gov.proposalThreshold(), PROPOSAL_THRESHOLD);
    }

    function test_Init_RevertsOnZeroQuorum() public {
        ERC20WithGovernorBundleGen fresh = ERC20WithGovernorBundleGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, uint256(0), TIMELOCK_MIN_DELAY);
        moduleData[1] = "";
        bytes memory initData = abi.encode(owner, "Gov", "GOV", 0, address(0), moduleData);
        vm.expectRevert(abi.encodeWithSelector(ERC20WithGovernorBundleGen.GovernorBundle__BadQuorum.selector, 0));
        fresh.initialize(initData);
    }

    function test_Init_RevertsOnQuorumOver100() public {
        ERC20WithGovernorBundleGen fresh = ERC20WithGovernorBundleGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](2);
        moduleData[0] = abi.encode(VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD, uint256(101), TIMELOCK_MIN_DELAY);
        moduleData[1] = "";
        bytes memory initData = abi.encode(owner, "Gov", "GOV", 0, address(0), moduleData);
        vm.expectRevert(abi.encodeWithSelector(ERC20WithGovernorBundleGen.GovernorBundle__BadQuorum.selector, 101));
        fresh.initialize(initData);
    }
}
