// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/PoolManager.sol";

import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {IFairLaunchFactoryView, SwarmVault} from "src/swarm/SwarmVault.sol";
import {SwarmVaultFactory} from "src/swarm/SwarmVaultFactory.sol";

import {FairTestBase, IERC20Min} from "../fair/FairTestBase.sol";

interface ISwarmLauncher {
    function launchForSwarm(
        SwarmVault v
    ) external returns (address token, OpeningBatch batch);
}

/// Drives one swarm through random member actions, then (once) the launch, the batch
/// and the payouts. Tracks what members put in and took out.
contract SwarmHandler is Test {
    SwarmVault public vault;
    ISwarmLauncher internal base;
    address[] internal members;

    uint256 public ghostIn; // ETH members put in
    uint256 public ghostLeft; // ETH members took back by leaving
    uint256 public ghostPaidEth; // ETH paid out by withdrawShare
    uint256 public ghostPaidTok; // tokens paid out by withdrawShare
    mapping(address => uint256) public ghostDeposit;
    mapping(address => bool) public ghostYes;

    bool public launched;
    OpeningBatch public batch;
    address public token;

    constructor(
        SwarmVault v,
        ISwarmLauncher b
    ) {
        vault = v;
        base = b;
        for (uint256 i; i < 8; i++) {
            members.push(address(uint160(0xB0000 + i)));
        }
    }

    function _m(
        uint256 seed
    ) internal view returns (address) {
        return members[seed % members.length];
    }

    function join(
        uint256 seed,
        uint256 amount
    ) external {
        if (vault.joined() || block.timestamp >= vault.joinDeadline()) return;
        amount = bound(amount, vault.minDeposit(), 3 ether);
        address m = _m(seed);
        vm.deal(m, m.balance + amount);
        vm.prank(m);
        vault.join{value: amount}();
        ghostIn += amount;
        ghostDeposit[m] += amount;
    }

    function leave(
        uint256 seed
    ) external {
        address m = _m(seed);
        if (vault.joined() || ghostDeposit[m] == 0) return;
        uint256 before = m.balance;
        vm.prank(m);
        vault.leave();
        assertEq(m.balance - before, ghostDeposit[m], "leave pays exactly the deposit");
        ghostLeft += ghostDeposit[m];
        ghostDeposit[m] = 0;
        ghostYes[m] = false;
    }

    function vote(
        uint256 seed,
        bool yes
    ) external {
        address m = _m(seed);
        if (block.timestamp >= vault.joinDeadline() || ghostDeposit[m] == 0 || ghostYes[m] == yes) return;
        vm.prank(m);
        if (yes) vault.approve();
        else vault.unapprove();
        ghostYes[m] = yes;
    }

    function warp(
        uint256 secs
    ) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }

    /// The whole launch path, once: past the vote, the creator launches, the pool joins if
    /// the vote passed, an outsider deposits, the window closes, the vault claims.
    function launchAndClaim(
        uint256 outsiderEth
    ) external {
        if (launched) return;
        launched = true;
        if (block.timestamp < vault.joinDeadline()) vm.warp(vault.joinDeadline());
        if (block.timestamp >= vault.launchDeadline()) return;
        (token, batch) = base.launchForSwarm(vault);
        if (!vault.passed()) return;
        vault.joinBatch();
        outsiderEth = bound(outsiderEth, 0, 300 ether);
        if (outsiderEth > 0) {
            address o = address(0xC0FFEE);
            vm.deal(o, outsiderEth);
            vm.prank(o);
            batch.deposit{value: outsiderEth}();
        }
        vm.warp(uint256(batch.closeTs()) + 1);
        vault.claimFromBatch();
    }

    function withdraw(
        uint256 seed
    ) external {
        address m = _m(seed);
        if (!vault.batchClaimed() || ghostDeposit[m] == 0 || vault.withdrawn(m)) return;
        uint256 eb = m.balance;
        uint256 tb = IERC20Min(token).balanceOf(m);
        vm.prank(m);
        vault.withdrawShare();
        ghostPaidEth += m.balance - eb;
        ghostPaidTok += IERC20Min(token).balanceOf(m) - tb;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function memberAt(
        uint256 i
    ) external view returns (address) {
        return members[i];
    }
}

/// @notice SwarmVault invariants over random join / leave / vote / warp sequences and one
///         launch: the pool is always backed, vote weight always matches yes-voters'
///         ETH, and payouts plus what the vault still holds always equal what it received.
contract SwarmVaultInvariantTest is FairTestBase {
    SwarmVaultFactory internal swarms;
    SwarmVault internal vault;
    SwarmHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
        swarms = new SwarmVaultFactory(IFairLaunchFactoryView(address(factory)));
        vault = SwarmVault(
            payable(swarms.createSwarm(
                    SwarmVaultFactory.Params({
                        creator: creator,
                        name: "Invariant Swarm",
                        ticker: "INVS",
                        joinSeconds: 6 hours,
                        launchSeconds: 6 hours,
                        quorumBps: 6000,
                        minPool: 0.1 ether,
                        maxPool: 0,
                        minDeposit: 0.001 ether,
                        metadataURI: ""
                    })
                ))
        );
        handler = new SwarmHandler(vault, ISwarmLauncher(address(this)));
        targetContract(address(handler));
    }

    /// Called by the handler: the named creator launches the swarm's coin.
    function launchForSwarm(
        SwarmVault v
    ) external returns (address token, OpeningBatch batch) {
        uint256 fee = factory.ethFeeFor(creator);
        vm.deal(creator, fee);
        vm.prank(creator);
        (address t,, address b) = factory.launch{value: fee}(v.name(), v.ticker());
        return (t, OpeningBatch(payable(b)));
    }

    /// Pool == sum of member deposits == ETH in, minus ETH taken back.
    function invariant_PoolMatchesDeposits() public view {
        uint256 sum;
        uint256 yes;
        for (uint256 i; i < handler.memberCount(); i++) {
            address m = handler.memberAt(i);
            uint256 d = vault.deposits(m);
            assertEq(d, handler.ghostDeposit(m), "deposit tracked");
            sum += d;
            if (vault.approved(m)) yes += d;
        }
        if (!vault.joined()) {
            assertEq(vault.pool(), sum, "pool == sum of deposits");
            assertEq(vault.pool(), handler.ghostIn() - handler.ghostLeft(), "pool == in - left");
            assertEq(vault.approvedEth(), yes, "yes weight == yes-voters' ETH");
            assertGe(address(vault).balance, vault.pool(), "pool fully backed by ETH");
        } else {
            assertEq(vault.poolAtJoin(), sum, "split base == members' deposits");
        }
    }

    /// After the claim: paid out + still held == received, and nobody got more than their share.
    function invariant_PayoutsNeverExceedReceipts() public view {
        if (!vault.batchClaimed()) return;
        assertEq(handler.ghostPaidEth() + address(vault).balance, vault.ethReceived(), "eth: paid + held == received");
        assertEq(
            handler.ghostPaidTok() + IERC20Min(vault.token()).balanceOf(address(vault)),
            vault.tokensReceived(),
            "tokens: paid + held == received"
        );
    }
}
