// SPDX-License-Identifier: MIT
// VM_MODULE_ID: GovernorBundle
// VM_MODULE_VERSION: 1
// VM_MODULE_BASES: ERC20
// VM_MODULE_REQUIRES: Votes
// VM_MODULE_INCOMPATIBLE_WITH:
// VM_MODULE_FLAGGED:
//
// Deploys a stock OpenZeppelin `TimelockController` + `VMGovernor` at token init and wires
// them: Governor gets PROPOSER + CANCELLER roles on the Timelock, the token's own admin
// role is renounced, and the Timelock becomes the sole executor path. Requires `Votes` so
// the token exposes the `IVotes` interface Governor reads from.
//
// Voting delay/period are in the token's timepoint units (seconds under ERC-6372 timestamp
// mode, which Solady defaults to). Quorum is a numerator out of 100.
//
// Params: (uint48 votingDelay, uint32 votingPeriod, uint256 proposalThreshold,
//          uint256 quorumNumerator, uint256 timelockMinDelay)

// ============================================================
// SECTION: VM_INJECT_ERRORS
// ============================================================
error GovernorBundle__BadQuorum(uint256 numerator);

// ============================================================
// SECTION: VM_INJECT_EVENTS
// ============================================================
event GovernorBundleDeployed(address indexed governor, address indexed timelock);

// ============================================================
// SECTION: VM_INJECT_STATE
// ============================================================
address private _govGovernor;
address private _govTimelock;

// ============================================================
// SECTION: VM_INJECT_INIT
// ============================================================
{
    (
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumNumerator_,
        uint256 timelockMinDelay_
    ) = abi.decode(moduleData, (uint48, uint32, uint256, uint256, uint256));
    if (quorumNumerator_ == 0 || quorumNumerator_ > 100) revert GovernorBundle__BadQuorum(quorumNumerator_);

    address[] memory proposers = new address[](0);
    address[] memory executors = new address[](1);
    executors[0] = address(0); // anyone can execute after delay

    TimelockController tlc = new TimelockController(
        timelockMinDelay_,
        proposers,
        executors,
        address(this) // temp admin so we can grant roles to Governor
    );

    VMGovernor gov = new VMGovernor(
        IVotes(address(this)),
        tlc,
        votingDelay_,
        votingPeriod_,
        proposalThreshold_,
        quorumNumerator_
    );

    tlc.grantRole(tlc.PROPOSER_ROLE(), address(gov));
    tlc.grantRole(tlc.CANCELLER_ROLE(), address(gov));
    tlc.renounceRole(tlc.DEFAULT_ADMIN_ROLE(), address(this));

    _govGovernor = address(gov);
    _govTimelock = address(tlc);
    emit GovernorBundleDeployed(address(gov), address(tlc));
}

// ============================================================
// SECTION: VM_INJECT_EXTERNAL
// ============================================================
function governor() external view returns (address) {
    return _govGovernor;
}

function timelock() external view returns (address) {
    return _govTimelock;
}
