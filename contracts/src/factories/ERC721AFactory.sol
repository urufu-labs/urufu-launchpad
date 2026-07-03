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

/// @title  ERC721AFactory
/// @notice Per-config impl registry + CREATE2 clone deployer for ERC-721A launches.
///         Router calls `deploy(...)`; the factory looks up the impl for the config hash, clones
///         it, and initializes with Router as the temporary owner. Mirrors ERC20Factory but
///         hardcodes the ERC-721A `initialize(bytes)` decoding shape.
/// @dev    See docs/SPEC-factories.md.
contract ERC721AFactory is IVMFactory, Ownable {
    // ============================================================
    // Errors
    // ============================================================

    error ERC721AFactory__NotRouter();
    error ERC721AFactory__NotRegistrar();
    error ERC721AFactory__UnknownConfig(bytes32 configHash);
    error ERC721AFactory__AlreadyRegistered(bytes32 configHash);
    error ERC721AFactory__ZeroAddress();
    error ERC721AFactory__NotAContract();
    error ERC721AFactory__InitFailed();

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
        if (_router == address(0) || _registrar == address(0)) revert ERC721AFactory__ZeroAddress();
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
    /// @dev    `initData` is the client-supplied init payload: `abi.encode(baseURI, maxSupply, moduleData)`.
    ///         Factory prepends `router`, `name`, `ticker` when calling `initialize(bytes)` on the clone.
    function deploy(
        string calldata name,
        string calldata ticker,
        bytes32 configHash,
        bytes calldata initData,
        address launcher
    ) external returns (address token) {
        if (msg.sender != router) revert ERC721AFactory__NotRouter();
        address impl = impls[configHash];
        if (impl == address(0)) revert ERC721AFactory__UnknownConfig(configHash);

        bytes32 salt = _saltOf(launcher, name, ticker);
        token = LibClone.cloneDeterministic(impl, salt);

        // Unpack client params (defaults to empty baseURI + uncapped supply if initData empty).
        string memory baseURI;
        uint256 maxSupply;
        bytes[] memory moduleData;
        if (initData.length > 0) {
            (baseURI, maxSupply, moduleData) = abi.decode(initData, (string, uint256, bytes[]));
        }

        // Encode template init: owner=router so Router can dispatch to launcher's mode.
        bytes memory fullInitData = abi.encode(router, name, ticker, baseURI, maxSupply, moduleData);

        try IInitializable(token).initialize(fullInitData) {
        // ok
        }
        catch {
            revert ERC721AFactory__InitFailed();
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
        if (msg.sender != registrar) revert ERC721AFactory__NotRegistrar();
        if (impls[configHash] != address(0)) revert ERC721AFactory__AlreadyRegistered(configHash);
        if (impl == address(0)) revert ERC721AFactory__ZeroAddress();
        if (impl.code.length == 0) revert ERC721AFactory__NotAContract();

        impls[configHash] = impl;
        emit ImplRegistered(configHash, impl, msg.sender);
    }

    // ============================================================
    // Views
    // ============================================================

    function implFor(
        bytes32 configHash
    ) external view returns (address) {
        return impls[configHash];
    }

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
        if (newRegistrar == address(0)) revert ERC721AFactory__ZeroAddress();
        emit RegistrarSet(registrar, newRegistrar);
        registrar = newRegistrar;
    }

    function setRouter(
        address newRouter
    ) external onlyOwner {
        if (newRouter == address(0)) revert ERC721AFactory__ZeroAddress();
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
