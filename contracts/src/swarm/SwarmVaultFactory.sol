// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";

import {IFairLaunchFactoryView, SwarmVault} from "./SwarmVault.sol";

/// @title  SwarmVaultFactory
/// @notice Creates one SwarmVault clone per swarm (docs/PLAN-agents-and-swarms.md §4).
///         Isolated funds per swarm, no owner, no fee, no admin. Bounds below are the
///         plan's defaults (decisions A7, A8): a pool of at least 0.1 ETH, a quorum of
///         at least half the pooled ETH, a join + vote window of 1 hour to 7 days, and up
///         to 7 days after it for the creator to launch.
contract SwarmVaultFactory {
    error SwarmVaultFactory__ZeroAddress();
    error SwarmVaultFactory__BadName();
    error SwarmVaultFactory__AlreadyLaunched();
    error SwarmVaultFactory__BadWindow();
    error SwarmVaultFactory__BadPool();
    error SwarmVaultFactory__BadQuorum();
    error SwarmVaultFactory__BadMinDeposit();

    event SwarmCreated(
        address indexed vault,
        address indexed proposer,
        address indexed creator,
        address token,
        address batch,
        string name,
        string ticker,
        uint64 joinDeadline,
        uint64 launchDeadline,
        uint16 quorumBps,
        uint256 minPool,
        uint256 maxPool,
        uint256 minDeposit,
        string metadataURI
    );

    uint256 public constant MIN_POOL_FLOOR = 0.1 ether;
    uint256 public constant MIN_DEPOSIT_FLOOR = 0.001 ether;
    uint16 public constant MIN_QUORUM_BPS = 5_000;
    uint16 public constant MAX_QUORUM_BPS = 10_000;
    uint32 public constant MIN_JOIN_SECONDS = 1 hours;
    uint32 public constant MAX_JOIN_SECONDS = 7 days;
    uint32 public constant MIN_LAUNCH_SECONDS = 10 minutes;
    uint32 public constant MAX_LAUNCH_SECONDS = 7 days;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_TICKER_BYTES = 16;
    uint256 public constant MAX_URI_BYTES = 512;

    IFairLaunchFactoryView public immutable fairFactory;
    address public immutable vaultImpl;

    /// Every vault this factory made (for indexers and the site).
    mapping(address => bool) public isSwarm;

    struct Params {
        /// The wallet that will call FairLaunchFactory.launch (a person or an agent
        /// account). Named before anyone joins; it becomes the token's creator.
        address creator;
        string name;
        string ticker;
        uint32 joinSeconds;
        /// After the join + vote window: how long the creator has to launch.
        uint32 launchSeconds;
        uint16 quorumBps;
        uint256 minPool;
        uint256 maxPool;
        uint256 minDeposit;
        /// Token idea (art, description, links), shown by the site. Not used on chain.
        string metadataURI;
    }

    constructor(
        IFairLaunchFactoryView fairFactory_
    ) {
        if (address(fairFactory_) == address(0)) revert SwarmVaultFactory__ZeroAddress();
        fairFactory = fairFactory_;
        vaultImpl = address(new SwarmVault(address(this), fairFactory_));
    }

    function createSwarm(
        Params calldata p
    ) external returns (address vault) {
        if (p.creator == address(0)) revert SwarmVaultFactory__ZeroAddress();
        uint256 nl = bytes(p.name).length;
        uint256 tl = bytes(p.ticker).length;
        if (nl == 0 || nl > MAX_NAME_BYTES || tl == 0 || tl > MAX_TICKER_BYTES || bytes(p.metadataURI).length > MAX_URI_BYTES) {
            revert SwarmVaultFactory__BadName();
        }
        // The creator must not have launched this exact token already: the swarm is for
        // a launch that hasn't happened, so the batch window is still ahead.
        if (fairFactory.nameSaltTaken(keccak256(abi.encode(p.creator, p.name, p.ticker)))) {
            revert SwarmVaultFactory__AlreadyLaunched();
        }
        if (
            p.joinSeconds < MIN_JOIN_SECONDS || p.joinSeconds > MAX_JOIN_SECONDS || p.launchSeconds < MIN_LAUNCH_SECONDS
                || p.launchSeconds > MAX_LAUNCH_SECONDS
        ) revert SwarmVaultFactory__BadWindow();
        if (p.minPool < MIN_POOL_FLOOR || (p.maxPool != 0 && p.maxPool < p.minPool)) revert SwarmVaultFactory__BadPool();
        if (p.quorumBps < MIN_QUORUM_BPS || p.quorumBps > MAX_QUORUM_BPS) revert SwarmVaultFactory__BadQuorum();
        if (p.minDeposit < MIN_DEPOSIT_FLOOR || p.minDeposit > p.minPool) revert SwarmVaultFactory__BadMinDeposit();

        uint64 joinDeadline = uint64(block.timestamp) + p.joinSeconds;
        uint64 launchDeadline = joinDeadline + p.launchSeconds;
        vault = LibClone.clone(vaultImpl);
        isSwarm[vault] = true;
        SwarmVault(payable(vault)).initialize(
            SwarmVault.Config({
                creator: p.creator,
                name: p.name,
                ticker: p.ticker,
                joinDeadline: joinDeadline,
                launchDeadline: launchDeadline,
                quorumBps: p.quorumBps,
                minPool: p.minPool,
                maxPool: p.maxPool,
                minDeposit: p.minDeposit
            })
        );
        _emitCreated(vault, p, joinDeadline, launchDeadline);
    }

    function _emitCreated(
        address vault,
        Params calldata p,
        uint64 joinDeadline,
        uint64 launchDeadline
    ) private {
        SwarmVault v = SwarmVault(payable(vault));
        emit SwarmCreated(
            vault,
            msg.sender,
            p.creator,
            v.token(),
            v.batch(),
            p.name,
            p.ticker,
            joinDeadline,
            launchDeadline,
            p.quorumBps,
            p.minPool,
            p.maxPool,
            p.minDeposit,
            p.metadataURI
        );
    }
}
