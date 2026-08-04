// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {IVMFactory} from "src/router/Router.sol";

interface IInitializable {
    function initialize(
        bytes calldata data
    ) external;
}

/// @title  ERC20Factory
/// @notice Per-config impl registry + CREATE2 clone deployer for ERC-20 launches.
///         Router calls `deploy(...)`; the factory looks up the impl for the config hash,
///         clones it via `LibClone.cloneDeterministic` with a launcher-mixed salt (front-mining
///         defeated), and initializes it with Router as the initial owner so Router can dispatch
///         to the launcher's chosen `OwnershipMode`. Impls are pre-registered by the compile
///         service after a successful compile + test pass. See docs/SPEC-factories.md.
/// @dev    Register once per config hash; entries are immutable — fixes ship as new config hashes
///         with bumped module versions. Existing clones keep running their original impl.
contract ERC20Factory is IVMFactory, Ownable {
    // ============================================================
    // Errors
    // ============================================================

    error ERC20Factory__NotRouter();
    error ERC20Factory__NotRegistrar();
    error ERC20Factory__NotOwner();
    error ERC20Factory__UnknownConfig(bytes32 configHash);
    error ERC20Factory__AlreadyRegistered(bytes32 configHash);
    error ERC20Factory__ZeroAddress();
    error ERC20Factory__NotAContract();
    error ERC20Factory__InitFailed();
    /// URU-A08 (round 3 follow-up): `registerImpl` requires the owner to have
    /// pinned the expected implementation codehash first via
    /// `setExpectedCodeHash`. Without a pin, `registerImpl` reverts — the
    /// registrar cannot bind an arbitrary impl to an audited configHash.
    error ERC20Factory__CodeHashNotPinned(bytes32 configHash);
    /// URU-A08: `registerImpl` received an impl whose `keccak256(runtime code)`
    /// does not match the owner-pinned expected value for this configHash.
    /// Prevents a rogue registrar from binding a compromised impl to a hash
    /// that was audited with a different bytecode.
    error ERC20Factory__ArtifactHashMismatch(bytes32 configHash, bytes32 expected, bytes32 actual);
    /// URU-A08: `setExpectedCodeHash` is one-shot per configHash — a pin cannot
    /// be rotated. Rotating a pin would defeat the audit binding.
    error ERC20Factory__CodeHashAlreadyPinned(bytes32 configHash);
    /// URU-A08: `setExpectedCodeHash` received a zero pin. Zero is reserved as
    /// the "unpinned" sentinel, so pinning zero is meaningless. Pinning the
    /// codehash of empty runtime code (which hashes to a nonzero value) is
    /// also blocked at `registerImpl` time by the `impl.code.length == 0`
    /// check.
    error ERC20Factory__ZeroCodeHash();

    // ============================================================
    // Events
    // ============================================================

    event Deployed(
        address indexed token,
        address indexed launcher,
        bytes32 indexed configHash,
        address impl,
        string name,
        string ticker
    );
    event ImplRegistered(bytes32 indexed configHash, address indexed impl, address registrar);
    /// Emitted when the owner rotates an already-registered impl to a new bytecode.
    /// Existing tokens are immutable clones pinned to whichever impl was set at their
    /// launch time — this only affects future launches through the same configHash.
    event ImplUpdated(bytes32 indexed configHash, address indexed oldImpl, address indexed newImpl);
    event RegistrarSet(address indexed oldRegistrar, address indexed newRegistrar);
    event RouterSet(address indexed oldRouter, address indexed newRouter);
    /// URU-A08: owner pinned the audited runtime codehash for a configHash.
    /// One-shot per config. `registerImpl` then MUST supply an impl whose
    /// `keccak256(runtime code)` matches this pin, or the register reverts.
    event ExpectedCodeHashPinned(bytes32 indexed configHash, bytes32 expectedCodeHash);

    // ============================================================
    // State
    // ============================================================

    address public router;
    address public registrar;

    mapping(bytes32 => address) public impls;
    mapping(bytes32 => uint256) public usageCount;
    /// URU-A08 (round 3 follow-up): owner-pinned expected runtime codehash per
    /// configHash. Zero means "unpinned"; `registerImpl` reverts on unpinned
    /// entries. Set via `setExpectedCodeHash`, one-shot per config. The pin
    /// value comes from the compile-service's `artifactHash` (returned in the
    /// compile response) or from `RhConfigManifest.artifactHashFor` for
    /// production manifests.
    mapping(bytes32 => bytes32) public expectedCodeHash;

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address initialOwner,
        address _router,
        address _registrar
    ) {
        if (_router == address(0) || _registrar == address(0)) revert ERC20Factory__ZeroAddress();
        _initializeOwner(initialOwner);
        router = _router;
        registrar = _registrar;
        emit RouterSet(address(0), _router);
        emit RegistrarSet(address(0), _registrar);
    }

    // ============================================================
    // Deploy — Router-only
    // ============================================================

    /// @notice Clone the impl registered for `configHash` and initialize it.
    /// @dev    `initData` is the client-supplied init payload: `abi.encode(initialSupply, initialRecipient,
    /// moduleData)`. Factory prepends `router`, `name`, `symbol` when calling `initialize(bytes)` on the clone.
    function deploy(
        string calldata name,
        string calldata ticker,
        bytes32 configHash,
        bytes calldata initData,
        address launcher
    ) external returns (address token) {
        if (msg.sender != router) revert ERC20Factory__NotRouter();
        address impl = impls[configHash];
        if (impl == address(0)) revert ERC20Factory__UnknownConfig(configHash);

        bytes32 salt = _saltOf(launcher, name, ticker);
        token = LibClone.cloneDeterministic(impl, salt);

        // Unpack client params (defaults to zero-supply if empty).
        uint256 initialSupply;
        address initialRecipient;
        bytes[] memory moduleData;
        if (initData.length > 0) {
            (initialSupply, initialRecipient, moduleData) = abi.decode(initData, (uint256, address, bytes[]));
        }

        // Encode template init: owner set to router so Router can dispatch to launcher's mode.
        bytes memory fullInitData = abi.encode(router, name, ticker, initialSupply, initialRecipient, moduleData);

        try IInitializable(token).initialize(fullInitData) {
        // ok
        }
        catch {
            revert ERC20Factory__InitFailed();
        }

        unchecked {
            usageCount[configHash] += 1;
        }
        emit Deployed(token, launcher, configHash, impl, name, ticker);
    }

    // ============================================================
    // Impl registry — registrar-only
    // ============================================================

    function registerImpl(
        bytes32 configHash,
        address impl
    ) external {
        if (msg.sender != registrar) revert ERC20Factory__NotRegistrar();
        if (impls[configHash] != address(0)) revert ERC20Factory__AlreadyRegistered(configHash);
        if (impl == address(0)) revert ERC20Factory__ZeroAddress();
        if (impl.code.length == 0) revert ERC20Factory__NotAContract();

        // URU-A08 (round 3): every configHash MUST have an owner-pinned code
        // hash BEFORE the registrar can bind an impl to it. This closes the
        // "rogue-registrar can bind compromised bytecode to an audited hash"
        // finding: the pin is set by the owner (multisig), the registrar can
        // only bind bytecode matching the pin, and the pin is one-shot so a
        // compromised owner can't rotate the binding either.
        bytes32 pinned = expectedCodeHash[configHash];
        if (pinned == bytes32(0)) revert ERC20Factory__CodeHashNotPinned(configHash);
        bytes32 actual = keccak256(impl.code);
        if (actual != pinned) revert ERC20Factory__ArtifactHashMismatch(configHash, pinned, actual);

        impls[configHash] = impl;
        emit ImplRegistered(configHash, impl, msg.sender);
    }

    /// @notice URU-A08 (round 3 follow-up): owner pins the audited runtime
    ///         codehash for a configHash BEFORE the registrar can register an
    ///         impl. One-shot per config — rotating a pin would defeat the
    ///         audit binding, so an already-pinned entry reverts.
    /// @dev    The pin value MUST be the DEPLOYED runtime codehash — i.e.
    ///         `keccak256(address(impl).code)` after the impl has been
    ///         deployed, which equals the compile service's
    ///         `runtimeCodeHash` response field (the legacy `artifactHash`
    ///         field is preserved as a backwards-compatible alias for the
    ///         same runtime hash). For canonical manifest entries, use
    ///         `RhConfigManifest.artifactHashFor(configHash)`. Pin, then
    ///         register, in that order.
    function setExpectedCodeHash(
        bytes32 configHash,
        bytes32 codeHash
    ) external onlyOwner {
        if (expectedCodeHash[configHash] != bytes32(0)) {
            revert ERC20Factory__CodeHashAlreadyPinned(configHash);
        }
        if (codeHash == bytes32(0)) revert ERC20Factory__ZeroCodeHash();
        expectedCodeHash[configHash] = codeHash;
        emit ExpectedCodeHashPinned(configHash, codeHash);
    }

    // updateImpl removed 2026-07-31: a configHash MUST commit to its bytecode
    // for the Router's fail-closed metadata sentinels (moduleCountConfigured /
    // flagsConfigured) to mean anything. Prior in-place rotation let the owner
    // swap the impl behind an existing hash while the Router's sentinels kept
    // reporting the ORIGINAL metadata, silently reopening the config-vs-impl
    // drift attack. New impl revisions require a fresh configHash + a fresh
    // registerImpl + a fresh setModuleCountForConfig + setFlagsForConfig set.
    // Frontend churn is a fair price for the security binding.

    // ============================================================
    // Views
    // ============================================================

    function implFor(
        bytes32 configHash
    ) external view returns (address) {
        return impls[configHash];
    }

    /// @notice Predict the deterministic clone address for a given tuple.
    /// @dev    Returns address(0) if the config isn't registered.
    function predictAddress(
        address launcher,
        string calldata name,
        string calldata ticker,
        bytes32 configHash
    ) external view returns (address) {
        address impl = impls[configHash];
        if (impl == address(0)) return address(0);
        return LibClone.predictDeterministicAddress(impl, _saltOf(launcher, name, ticker), address(this));
    }

    // ============================================================
    // Admin — onlyOwner
    // ============================================================

    function setRegistrar(
        address newRegistrar
    ) external onlyOwner {
        if (newRegistrar == address(0)) revert ERC20Factory__ZeroAddress();
        emit RegistrarSet(registrar, newRegistrar);
        registrar = newRegistrar;
    }

    /// @notice Rotate the Router. Should almost never fire — Router changes normally redeploy the factory.
    function setRouter(
        address newRouter
    ) external onlyOwner {
        if (newRouter == address(0)) revert ERC20Factory__ZeroAddress();
        emit RouterSet(router, newRouter);
        router = newRouter;
    }

    // ============================================================
    // Internal
    // ============================================================

    function _saltOf(
        address launcher,
        string calldata name,
        string calldata ticker
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(launcher, keccak256(bytes(name)), keccak256(bytes(ticker)), block.chainid));
    }
}
