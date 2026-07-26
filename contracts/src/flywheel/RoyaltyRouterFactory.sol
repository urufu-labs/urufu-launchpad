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
/// @dev Minimum ownership shape we probe to authorize a deploy against the true
///      collection owner. Solady + OZ Ownable both expose this getter; tokens that
///      lack it fall through to the trustedDeployer path.
interface IOwnableLike {
    function owner() external view returns (address);
}

contract RoyaltyRouterFactory is Ownable {
    error RoyaltyRouterFactory__ZeroAddress();
    error RoyaltyRouterFactory__BadBps(uint256 bps);
    error RoyaltyRouterFactory__AlreadyDeployed(address clone);
    /// Caller isn't authorized to deploy for `collection`. Prevents the front-run
    /// attack where anyone raced to `deployFor(X, self)` before the true launcher
    /// and became the permanent recipient of collection X's royalties.
    error RoyaltyRouterFactory__Unauthorized(address caller, address collection);

    event PlatformSinkUpdated(address indexed oldSink, address indexed newSink);
    event TrustedDeployerSet(address indexed deployer, bool trusted);
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

    /// Owner-maintained allowlist of contracts (typically the Router) that may
    /// deploy royalty clones on behalf of any collection - used by the launch
    /// pipeline to atomically deploy the clone as part of a launch tx, before
    /// anyone else can race the mempool.
    mapping(address => bool) public trustedDeployer;

    constructor(
        address initialOwner,
        address impl_,
        address platformSink_,
        uint16 platformBps_
    ) {
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
    function setPlatformSink(
        address newSink
    ) external onlyOwner {
        if (newSink == address(0)) revert RoyaltyRouterFactory__ZeroAddress();
        emit PlatformSinkUpdated(platformSink, newSink);
        platformSink = newSink;
    }

    /// @notice Deploy the per-collection clone. Authorization: EITHER caller ==
    ///         collection.owner() (the natural launcher path, works pre-renounce),
    ///         OR caller is on `trustedDeployer` (the atomic-launch path where our
    ///         Router deploys the clone in the same tx as the collection). This
    ///         closes the front-run window where any address could race
    ///         `deployFor(X, self)` and install itself as the perpetual receiver
    ///         of collection X's royalties.
    /// @return clone Deterministic address of the deployed royalty router.
    function deployFor(
        address collection,
        address launcherPayout
    ) external returns (address clone) {
        if (collection == address(0) || launcherPayout == address(0)) revert RoyaltyRouterFactory__ZeroAddress();
        _authorizeDeploy(collection);
        bytes32 salt = _saltOf(collection);
        address predicted = LibClone.predictDeterministicAddress(IMPLEMENTATION, salt, address(this));
        if (predicted.code.length != 0) revert RoyaltyRouterFactory__AlreadyDeployed(predicted);

        clone = LibClone.cloneDeterministic(IMPLEMENTATION, salt);
        uint16 launcherBps_ = 10_000 - PLATFORM_BPS;
        RoyaltyRouterImpl(payable(clone)).initialize(launcherPayout, launcherBps_, platformSink, PLATFORM_BPS);

        emit RoyaltyRouterDeployed(collection, clone, launcherPayout, launcherBps_, PLATFORM_BPS);
    }

    /// @notice Owner adds/removes an allowlisted deployer (typically the launch
    ///         Router). Trusted deployers may deploy a clone for ANY collection,
    ///         bypassing the owner() check - relied on for atomic launch flows.
    function setTrustedDeployer(
        address deployer,
        bool trusted
    ) external onlyOwner {
        trustedDeployer[deployer] = trusted;
        emit TrustedDeployerSet(deployer, trusted);
    }

    /// Authorization gate for `deployFor`. Passes if caller is on the trusted
    /// list, or if caller matches the collection's current owner. Uses a
    /// low-level staticcall so tokens without an owner() getter (EOAs during
    /// tests, non-Ownable collections) fail cleanly rather than reverting on
    /// abi.decode of empty returndata (which try/catch doesn't handle).
    function _authorizeDeploy(
        address collection
    ) internal view {
        if (trustedDeployer[msg.sender]) return;
        (bool ok, bytes memory data) = collection.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && data.length >= 32) {
            address collectionOwner = abi.decode(data, (address));
            if (collectionOwner != address(0) && collectionOwner == msg.sender) return;
        }
        revert RoyaltyRouterFactory__Unauthorized(msg.sender, collection);
    }

    /// @notice Predict a collection's royalty router clone address BEFORE the clone is
    ///         deployed. Use this to pass as the ERC-2981 receiver at collection launch.
    function predictFor(
        address collection
    ) external view returns (address) {
        return LibClone.predictDeterministicAddress(IMPLEMENTATION, _saltOf(collection), address(this));
    }

    function _saltOf(
        address collection
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(collection));
    }
}
