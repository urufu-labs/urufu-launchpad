// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The three token bases supported by the launchpad.
enum BaseType {
    ERC20,
    ERC721A,
    ERC1155
}

/// @notice How the launcher wants ownership of the deployed token handled after launch.
enum OwnershipMode {
    Renounce,
    TransferToMultisig,
    KeepEOA
}

/// @notice Parameters passed to Router.launch() and forwarded to the base-type factory.
/// @dev    `antiSniperBlocks` + `buybackBurnBps` only take effect when `installBondingCurve`
///         is true — Router forwards them into CurveFactory.createCurveWithConfig, which
///         stores them on the BondingCurve until graduation. On graduation the Graduator
///         writes them to MultiHookHost.setPoolConfig for the resulting v4 pool. Both zero
///         = same behavior as before (no anti-sniper window, no buyback burn).
struct LaunchParams {
    BaseType base;
    string name;
    string ticker;
    bytes32 configHash;
    bytes initData;
    uint256 moduleCount;
    bool installHook;
    bool installGovernance;
    bool installBondingCurve;
    OwnershipMode ownership;
    address ownerTargetIfMultisig;
    uint32 antiSniperBlocks;
    uint16 buybackBurnBps;
}
