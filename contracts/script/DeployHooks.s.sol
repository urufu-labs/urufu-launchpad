// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @title  DeployHooks (superseded)
/// @notice This script deployed a set of standalone v4 hooks
///         (`LPLockedHook`, `AntiSniperHook`, `MultiHookHost`, plus
///         `FeeRedirectHook` / `BuybackBurnHook` / `BuybackUruHook`).
///         The last three are gone — they either re-entered
///         `poolManager.unlock` inside `afterSwap` or returned an
///         afterSwap delta without settling it, bricking any pool
///         they attached to. They were never wired into the live
///         launchpad path (Graduator always uses `MultiHookHost` which
///         has the correct integrated settlement) but shipping them was
///         a live-code footgun.
///
///         `MultiHookHost` + `AntiSniperHook` + `LPLockedHook` are now
///         deployed atomically by `DeployMhhAndGraduatorV5.s.sol` (or its
///         V6 successor) alongside their matched Graduator so the
///         hook-initializer wiring is guaranteed correct.
contract DeployHooks is Script {
    function run() external pure {
        revert("superseded: use DeployMhhAndGraduatorV5.s.sol (or V6 successor)");
    }
}
