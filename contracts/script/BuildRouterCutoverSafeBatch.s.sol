// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Router} from "src/router/Router.sol";
import {RhConfigManifest} from "./manifest/RhConfigManifest.sol";

interface ISafeMultiSendCallOnly {
    function multiSend(
        bytes memory transactions
    ) external payable;
}

interface IRegistryCutover {
    function pendingRouter() external view returns (address);
    function pendingRouterTs() external view returns (uint256);
    function owner() external view returns (address);
    function activateRouter() external;
}

interface IFactoryCutover {
    function owner() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
}

interface ICurveFactoryCutover {
    function owner() external view returns (address);
    function trustedRouters(
        address router
    ) external view returns (bool);
    function setTrustedRouter(
        address router,
        bool trusted
    ) external;
}

/// @title  BuildRouterCutoverSafeBatch
/// @notice URU-P1-B02: produces, but never broadcasts, the one Safe
///         MultiSendCallOnly transaction required for an atomic Router
///         cutover. `ActivateRouter.s.sol` was the old direct-broadcast
///         script; `forge script --broadcast` emits one on-chain tx per
///         external call and cannot roll back on a mid-batch revert, so the
///         cutover has been reshaped into a single Safe delegatecall that IS
///         atomic (either every subcall lands or none do).
///
/// Safe transaction fields written to `router-cutover-safe.<chainId>.json`:
///   to        = SAFE_MULTISEND_CALL_ONLY
///   value     = 0
///   data      = multiSend(encodedCalls)
///   operation = 1 (DELEGATECALL — required by MultiSendCallOnly)
///
/// All contracts mutated by the batch must already be owned by SAFE_ADDRESS
/// before this script runs. The preflight enforces that and refuses to emit
/// a payload otherwise: an EOA-owned target would drop its subcall on the
/// floor, poisoning the multisend semantics without any obvious signal.
///
/// Env vars (production `run()`):
///   SAFE_ADDRESS                      the multisig owner of every target
///   SAFE_MULTISEND_CALL_ONLY          canonical Safe MultiSendCallOnly addr
///   ROBINHOOD_NAME_REGISTRY_ADDRESS   pending must match new router + ready
///   ROBINHOOD_ROUTER_ADDRESS          new (pending) router
///   ROBINHOOD_OLD_ROUTER_ADDRESS      old router (paused unless skipped)
///   ROBINHOOD_ERC20_FACTORY_ADDRESS   per-base factory to rewire
///   ROBINHOOD_ERC721A_FACTORY_ADDRESS per-base factory to rewire
///   ROBINHOOD_ERC1155_FACTORY_ADDRESS per-base factory to rewire
///   ROBINHOOD_CURVE_FACTORY_ADDRESS   trust flipped: old off (new was on)
///   SKIP_PAUSE_OLD_ROUTER             "1" to omit setPaused(true) subcall
contract BuildRouterCutoverSafeBatch is Script {
    error Cutover__NoCode(address target);
    error Cutover__NoPendingRouter(address registry);
    error Cutover__PendingMismatch(address expected, address actual);
    error Cutover__TimelockNotPassed(uint256 readyAt);
    error Cutover__NotSafeOwned(address target, address expectedSafe, address actualOwner);
    error Cutover__ManifestNotSeeded(bytes32 configHash, string what);
    error Cutover__RetiredHashNotBanned(bytes32 configHash);
    error Cutover__NewRouterNotTrusted(address router);

    struct Inputs {
        address safe;
        address multiSendCallOnly;
        address registry;
        address newRouter;
        address oldRouter;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        bool skipPauseOld;
    }

    /// Test-only overrides for `runForTest`. Every env-sourced address the
    /// production `run()` reads has a slot here so a forge fork test can drive
    /// the full batch build against live contracts without touching env.
    /// Structurally identical to `Inputs` — kept as a separate type so tests
    /// can distinguish "supplied by test" from "resolved from env".
    struct TestArgs {
        address safe;
        address multiSendCallOnly;
        address registry;
        address newRouter;
        address oldRouter;
        address erc20Factory;
        address erc721Factory;
        address erc1155Factory;
        address curveFactory;
        bool skipPauseOld;
    }

    /// Production entrypoint. Reads env, runs preflight, builds+wraps the
    /// MultiSend payload, writes it to disk, logs the tuple. Never broadcasts.
    function run() external returns (address to, uint256 value, bytes memory data, uint8 operation) {
        Inputs memory i = Inputs({
            safe: vm.envAddress("SAFE_ADDRESS"),
            multiSendCallOnly: vm.envAddress("SAFE_MULTISEND_CALL_ONLY"),
            registry: vm.envAddress("ROBINHOOD_NAME_REGISTRY_ADDRESS"),
            newRouter: vm.envAddress("ROBINHOOD_ROUTER_ADDRESS"),
            oldRouter: vm.envAddress("ROBINHOOD_OLD_ROUTER_ADDRESS"),
            erc20Factory: vm.envAddress("ROBINHOOD_ERC20_FACTORY_ADDRESS"),
            erc721Factory: vm.envAddress("ROBINHOOD_ERC721A_FACTORY_ADDRESS"),
            erc1155Factory: vm.envAddress("ROBINHOOD_ERC1155_FACTORY_ADDRESS"),
            curveFactory: vm.envAddress("ROBINHOOD_CURVE_FACTORY_ADDRESS"),
            skipPauseOld: vm.envOr("SKIP_PAUSE_OLD_ROUTER", uint256(0)) == 1
        });

        bytes memory transactions;
        (to, value, data, operation, transactions) = _buildBatch(i);

        _write(i, to, data, operation, transactions);

        console2.log("Safe Router cutover batch generated.");
        console2.log("  Safe       :", i.safe);
        console2.log("  to         :", to);
        console2.log("  operation  :", operation);
        console2.logBytes(data);
        console2.log("Submit exactly one Safe transaction. Do not broadcast ActivateRouter.s.sol.");
    }

    /// Test-mode entrypoint. Runs the same preflight + build path against
    /// caller-supplied addresses, but returns the batch AND raw transactions
    /// bytes WITHOUT writing anything to disk. Intended for
    /// `test/audit/RhRotationRehearsalFork.t.sol` — feeds the returned
    /// `(to, data)` into a MockSafe.delegatecall(mockMultiSendCallOnly, data)
    /// to exercise MultiSendCallOnly's atomic semantics against a live fork.
    function runForTest(
        TestArgs memory a
    ) external view returns (address to, uint256 value, bytes memory data, uint8 operation, bytes memory transactions) {
        Inputs memory i = Inputs({
            safe: a.safe,
            multiSendCallOnly: a.multiSendCallOnly,
            registry: a.registry,
            newRouter: a.newRouter,
            oldRouter: a.oldRouter,
            erc20Factory: a.erc20Factory,
            erc721Factory: a.erc721Factory,
            erc1155Factory: a.erc1155Factory,
            curveFactory: a.curveFactory,
            skipPauseOld: a.skipPauseOld
        });
        return _buildBatch(i);
    }

    /// Public so tests can build modified payloads (e.g. forced-final-revert
    /// atomicity rehearsals) using the SAME Safe MultiSend encoding as
    /// production. Format per Safe MultiSendCallOnly:
    ///   operation (1) | to (20) | value (32) | data length (32) | data (N)
    /// Only operation == 0 (CALL) is emitted; MultiSendCallOnly rejects
    /// DELEGATECALL subcalls unconditionally.
    function encodeSubCall(
        address target,
        bytes memory callData
    ) public pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), target, uint256(0), uint256(callData.length), callData);
    }

    // -------------------------------------------------------------
    // Internals — preflight + build
    // -------------------------------------------------------------

    function _buildBatch(
        Inputs memory i
    ) internal view returns (address to, uint256 value, bytes memory data, uint8 operation, bytes memory transactions) {
        _preflight(i);

        transactions = bytes.concat(
            encodeSubCall(i.erc20Factory, abi.encodeCall(IFactoryCutover.setRouter, (i.newRouter))),
            encodeSubCall(i.erc721Factory, abi.encodeCall(IFactoryCutover.setRouter, (i.newRouter))),
            encodeSubCall(i.erc1155Factory, abi.encodeCall(IFactoryCutover.setRouter, (i.newRouter))),
            encodeSubCall(i.curveFactory, abi.encodeCall(ICurveFactoryCutover.setTrustedRouter, (i.oldRouter, false))),
            encodeSubCall(i.registry, abi.encodeCall(IRegistryCutover.activateRouter, ()))
        );
        if (!i.skipPauseOld) {
            transactions =
                bytes.concat(transactions, encodeSubCall(i.oldRouter, abi.encodeCall(Router.setPaused, (true))));
        }

        to = i.multiSendCallOnly;
        value = 0;
        data = abi.encodeCall(ISafeMultiSendCallOnly.multiSend, (transactions));
        operation = 1; // Safe DELEGATECALL — MultiSendCallOnly must delegatecall.
    }

    function _preflight(
        Inputs memory i
    ) internal view {
        address[9] memory contractsToCheck = [
            i.safe,
            i.multiSendCallOnly,
            i.registry,
            i.newRouter,
            i.oldRouter,
            i.erc20Factory,
            i.erc721Factory,
            i.erc1155Factory,
            i.curveFactory
        ];
        for (uint256 n = 0; n < contractsToCheck.length; n++) {
            if (contractsToCheck[n].code.length == 0) revert Cutover__NoCode(contractsToCheck[n]);
        }

        IRegistryCutover registry = IRegistryCutover(i.registry);
        address pending = registry.pendingRouter();
        if (pending == address(0)) revert Cutover__NoPendingRouter(i.registry);
        if (pending != i.newRouter) revert Cutover__PendingMismatch(i.newRouter, pending);
        uint256 readyAt = registry.pendingRouterTs();
        if (block.timestamp < readyAt) revert Cutover__TimelockNotPassed(readyAt);

        _requireOwner(i.registry, i.safe);
        _requireOwner(i.newRouter, i.safe);
        _requireOwner(i.erc20Factory, i.safe);
        _requireOwner(i.erc721Factory, i.safe);
        _requireOwner(i.erc1155Factory, i.safe);
        _requireOwner(i.curveFactory, i.safe);
        if (!i.skipPauseOld) _requireOwner(i.oldRouter, i.safe);

        Router newRouter = Router(payable(i.newRouter));
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 n = 0; n < entries.length; n++) {
            RhConfigManifest.Entry memory e = entries[n];
            if (!newRouter.moduleCountConfigured(e.configHash)) {
                revert Cutover__ManifestNotSeeded(e.configHash, "moduleCountConfigured");
            }
            if (!newRouter.flagsConfigured(e.configHash)) {
                revert Cutover__ManifestNotSeeded(e.configHash, "flagsConfigured");
            }
            if (newRouter.moduleCountForConfig(e.configHash) != e.moduleCount) {
                revert Cutover__ManifestNotSeeded(e.configHash, "moduleCount");
            }
            if (newRouter.flagsForConfig(e.configHash) != e.flags) {
                revert Cutover__ManifestNotSeeded(e.configHash, "flags");
            }
        }

        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 n = 0; n < retired.length; n++) {
            if (!newRouter.bannedConfigHash(retired[n])) {
                revert Cutover__RetiredHashNotBanned(retired[n]);
            }
        }

        if (!ICurveFactoryCutover(i.curveFactory).trustedRouters(i.newRouter)) {
            revert Cutover__NewRouterNotTrusted(i.newRouter);
        }
    }

    function _requireOwner(
        address target,
        address safe
    ) internal view {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("owner()"));
        address actual = ok && ret.length >= 32 ? abi.decode(ret, (address)) : address(0);
        if (actual != safe) revert Cutover__NotSafeOwned(target, safe, actual);
    }

    function _write(
        Inputs memory i,
        address to,
        bytes memory data,
        uint8 operation,
        bytes memory transactions
    ) internal {
        string memory obj = "router-cutover-safe";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "safe", i.safe);
        vm.serializeAddress(obj, "to", to);
        vm.serializeUint(obj, "value", 0);
        vm.serializeUint(obj, "operation", operation);
        vm.serializeAddress(obj, "newRouter", i.newRouter);
        vm.serializeAddress(obj, "oldRouter", i.oldRouter);
        vm.serializeBytes32(obj, "batchHash", keccak256(transactions));
        vm.serializeBytes(obj, "transactions", transactions);
        vm.serializeBytes(obj, "data", data);
        string memory json = vm.serializeString(obj, "status", "READY_FOR_SAFE_EXECUTION");
        vm.writeJson(json, string.concat("./router-cutover-safe.", vm.toString(block.chainid), ".json"));
    }
}
