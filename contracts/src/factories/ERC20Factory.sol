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

    // ============================================================
    // State
    // ============================================================

    address public router;
    address public registrar;

    mapping(bytes32 => address) public impls;
    mapping(bytes32 => uint256) public usageCount;

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

        impls[configHash] = impl;
        emit ImplRegistered(configHash, impl, msg.sender);
    }

    /// @notice Rotate an already-registered impl in place. Owner-only. Emits the
    ///         swap for auditability. Existing tokens don't move — they were
    ///         immutable-cloned from whichever impl was set at their launch time.
    ///         Only NEW launches through this configHash pick up the new bytecode.
    ///
    /// @dev    Introduced so V2 reserve-backed template refactors could roll out
    ///         without minting a new configHash (and forcing frontend churn). The
    ///         function is intentionally scoped to "same configHash, new impl" —
    ///         it does NOT let the owner assign an arbitrary impl to any hash from
    ///         scratch (that's registerImpl's job, which is one-shot per hash).
    function updateImpl(
        bytes32 configHash,
        address newImpl
    ) external {
        if (msg.sender != owner()) revert ERC20Factory__NotOwner();
        address oldImpl = impls[configHash];
        if (oldImpl == address(0)) revert ERC20Factory__UnknownConfig(configHash);
        if (newImpl == address(0)) revert ERC20Factory__ZeroAddress();
        if (newImpl.code.length == 0) revert ERC20Factory__NotAContract();

        impls[configHash] = newImpl;
        emit ImplUpdated(configHash, oldImpl, newImpl);
    }

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
