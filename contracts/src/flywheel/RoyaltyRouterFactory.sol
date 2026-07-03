// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";

/// @title  RoyaltyRouterFactory
/// @notice Deploys per-collection `RoyaltyRouterImpl` clones. Each NFT collection gets its
///         own clone as its ERC-2981 receiver, so secondary-sale royalties auto-split
///         between launcher and platform without either side needing to trust the other.
///
///         Deploy-once model:
///           - Owner deploys one `RoyaltyRouterImpl` as the frozen implementation.
///           - Owner freezes the `platformSink` (typically `FeeSplitter`) and the platform
///             bps at construction. Neither can rotate; launchers get a deterministic quote.
///           - Any launcher can call `deployFor(collection, launcherPayout, launcherBps)`.
///             The clone is materialized at a CREATE2 address deterministic in `collection`.
///
/// @dev    The salt is `keccak256(collection)` — one clone per collection, address is
///         predictable pre-launch via `predictFor(collection)`. This lets the launcher UI
///         compute the future clone address BEFORE launching and pass it as the ERC-2981
///         receiver in the collection's init data (no post-launch rotation needed).
contract RoyaltyRouterFactory is Ownable {
    error RoyaltyRouterFactory__ZeroAddress();
    error RoyaltyRouterFactory__BadBps(uint256 bps);
    error RoyaltyRouterFactory__AlreadyDeployed(address clone);

    event PlatformSinkUpdated(address indexed oldSink, address indexed newSink);
    event RoyaltyRouterDeployed(
        address indexed collection,
        address indexed clone,
        address indexed launcherPayout,
        uint16 launcherBps,
        uint16 platformBps
    );

    address public immutable IMPLEMENTATION;
    uint16 public immutable PLATFORM_BPS;
    address public platformSink;

    constructor(address initialOwner, address impl_, address platformSink_, uint16 platformBps_) {
        if (initialOwner == address(0) || impl_ == address(0) || platformSink_ == address(0)) {
            revert RoyaltyRouterFactory__ZeroAddress();
        }
        if (platformBps_ == 0 || platformBps_ >= 10_000) revert RoyaltyRouterFactory__BadBps(platformBps_);
        _initializeOwner(initialOwner);
        IMPLEMENTATION = impl_;
        platformSink = platformSink_;
        PLATFORM_BPS = platformBps_;
    }

    /// @notice Rotate the platform sink (e.g. FeeSplitter address change). Owner-only.
    ///         Existing already-deployed clones do NOT retroactively rotate — their sink is
    ///         frozen at initialize. Only affects future deploys.
    function setPlatformSink(address newSink) external onlyOwner {
        if (newSink == address(0)) revert RoyaltyRouterFactory__ZeroAddress();
        emit PlatformSinkUpdated(platformSink, newSink);
        platformSink = newSink;
    }

    /// @notice Deploy the per-collection clone. Permissionless — anyone can trigger, but the
    ///         salt is fixed by `collection` so there's only ever one clone per collection.
    /// @return clone Deterministic address of the deployed royalty router.
    function deployFor(address collection, address launcherPayout) external returns (address clone) {
        if (collection == address(0) || launcherPayout == address(0)) revert RoyaltyRouterFactory__ZeroAddress();
        bytes32 salt = _saltOf(collection);
        address predicted = LibClone.predictDeterministicAddress(IMPLEMENTATION, salt, address(this));
        if (predicted.code.length != 0) revert RoyaltyRouterFactory__AlreadyDeployed(predicted);

        clone = LibClone.cloneDeterministic(IMPLEMENTATION, salt);
        uint16 launcherBps_ = 10_000 - PLATFORM_BPS;
        RoyaltyRouterImpl(payable(clone)).initialize(launcherPayout, launcherBps_, platformSink, PLATFORM_BPS);

        emit RoyaltyRouterDeployed(collection, clone, launcherPayout, launcherBps_, PLATFORM_BPS);
    }

    /// @notice Predict a collection's royalty router clone address BEFORE the clone is
    ///         deployed. Use this to pass as the ERC-2981 receiver at collection launch.
    function predictFor(address collection) external view returns (address) {
        return LibClone.predictDeterministicAddress(IMPLEMENTATION, _saltOf(collection), address(this));
    }

    function _saltOf(address collection) internal pure returns (bytes32) {
        return keccak256(abi.encode(collection));
    }
}
