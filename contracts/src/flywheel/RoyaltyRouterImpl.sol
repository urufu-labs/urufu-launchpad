// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title  RoyaltyRouterImpl
/// @notice EIP-1167 clone implementation. One instance per NFT collection. The collection's
///         ERC-2981 `royaltyInfo` returns this clone's address, so marketplaces that honor
///         2981 send secondary-sale royalties here. On `receive()`, the clone splits the
///         incoming ETH between the launcher's payout address and the platform fee sink.
///
///         Set at NFT-launch time via `RoyaltyRouterFactory.deployFor`. Cloneable so the
///         per-launch deploy cost stays under ~40k gas.
///
/// @dev    Percentages are basis points (10 000 = 100%). `launcherBps + platformBps` must
///         equal 10 000; enforced at initialize. Neither address may be zero. `Ownable` is
///         wired to the launcher so they can rotate their own payout wallet post-launch
///         (they cannot change the platform sink or the bps split).
contract RoyaltyRouterImpl is Ownable {
    error RoyaltyRouterImpl__AlreadyInitialized();
    error RoyaltyRouterImpl__ZeroAddress();
    error RoyaltyRouterImpl__BadSum(uint256 total);
    error RoyaltyRouterImpl__ZeroBalance();

    event Initialized(address indexed launcher, uint16 launcherBps, address indexed platformSink, uint16 platformBps);
    event LauncherPayoutUpdated(address indexed oldPayout, address indexed newPayout);
    event Distributed(uint256 total, uint256 toLauncher, uint256 toPlatform);
    event Swept(address indexed to, uint256 amount);

    // Storage layout — read from clone state, NOT immutables (clones can't have immutables).
    bool public initialized;
    address public launcherPayout;
    address public platformSink;
    uint16 public launcherBps;
    uint16 public platformBps;

    /// @notice Wire the clone. Called exactly once by the factory in the same tx as
    ///         `LibClone.cloneDeterministic`. Any subsequent call reverts.
    function initialize(
        address launcherPayout_,
        uint16 launcherBps_,
        address platformSink_,
        uint16 platformBps_
    ) external {
        if (initialized) revert RoyaltyRouterImpl__AlreadyInitialized();
        if (launcherPayout_ == address(0) || platformSink_ == address(0)) revert RoyaltyRouterImpl__ZeroAddress();
        uint256 sum = uint256(launcherBps_) + uint256(platformBps_);
        if (sum != 10_000) revert RoyaltyRouterImpl__BadSum(sum);

        initialized = true;
        _initializeOwner(launcherPayout_);
        launcherPayout = launcherPayout_;
        platformSink = platformSink_;
        launcherBps = launcherBps_;
        platformBps = platformBps_;

        emit Initialized(launcherPayout_, launcherBps_, platformSink_, platformBps_);
    }

    /// @notice Marketplaces (or anyone) send ETH here. Split immediately per bps and forward.
    receive() external payable {
        if (msg.value == 0) return;
        _distribute(msg.value);
    }

    /// @notice Launcher can rotate their payout address (Ownable-gated). Cannot rotate the
    ///         platform sink or the split — those are frozen at initialize.
    function setLauncherPayout(
        address newPayout
    ) external onlyOwner {
        if (newPayout == address(0)) revert RoyaltyRouterImpl__ZeroAddress();
        emit LauncherPayoutUpdated(launcherPayout, newPayout);
        launcherPayout = newPayout;
    }

    /// @notice Safety valve for ETH that landed pre-init (deterministic clone address can
    ///         receive ETH before the factory materializes it). Owner-only. Splits per the
    ///         active configuration; if uninitialized, reverts. Also useful if a distribution
    ///         reverts and leaves residue.
    function distributeStuck() external {
        uint256 bal = address(this).balance;
        if (bal == 0) revert RoyaltyRouterImpl__ZeroBalance();
        _distribute(bal);
    }

    /// @notice Emergency drain (Ownable-only). Sweeps everything to `to`, bypassing the split.
    ///         Only useful if a sink is compromised — otherwise use `distributeStuck`.
    function sweep(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert RoyaltyRouterImpl__ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) revert RoyaltyRouterImpl__ZeroBalance();
        SafeTransferLib.safeTransferETH(to, bal);
        emit Swept(to, bal);
    }

    function _distribute(
        uint256 amount
    ) internal {
        uint256 toPlatform = (amount * platformBps) / 10_000;
        uint256 toLauncher = amount - toPlatform;

        if (toLauncher > 0) SafeTransferLib.safeTransferETH(launcherPayout, toLauncher);
        if (toPlatform > 0) SafeTransferLib.safeTransferETH(platformSink, toPlatform);

        emit Distributed(amount, toLauncher, toPlatform);
    }
}
