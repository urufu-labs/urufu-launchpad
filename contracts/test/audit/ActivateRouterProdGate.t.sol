// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ActivateRouter} from "script/ActivateRouter.s.sol";

/// @title  ActivateRouterProdGateTest — URU-A17 F7
/// @notice The ONLY sanctioned Router cutover path is a Safe MultiSendCallOnly
///         batch (URU-P1-B02). `run()` reverts `UnsafeDirectBroadcastDisabled`
///         and `runForTest` — while designed for in-process fork rehearsals —
///         must ALSO refuse to touch RH prod chain 4663 unless an operator has
///         explicitly opted in with `ALLOW_UNSAFE_CUTOVER=1`. This suite locks
///         both gates.
contract ActivateRouterProdGateTest is Test {
    ActivateRouter internal script;
    uint256 internal constant RH_PROD = 4663;

    function setUp() public {
        script = new ActivateRouter();
        // Reset env to a known-clear state so ordering across tests can't leak.
        // vm.setEnv is a cheatcode call, not a Solidity op — no try/catch needed.
        vm.setEnv("ALLOW_UNSAFE_CUTOVER", "0");
    }

    /// AC #1: `run()` is unconditionally disabled.
    function test_Run_AlwaysReverts_DirectBroadcastDisabled() public {
        vm.expectRevert(ActivateRouter.ActivateRouter__UnsafeDirectBroadcastDisabled.selector);
        script.run();
    }

    /// AC #2: `runForTest` on the RH prod chain reverts specifically with
    /// ProductionChainUnsafe when the env override is absent. Selector +
    /// chain-id arg both pinned so a silent gate-removal fails loud.
    function test_RunForTest_OnProdChain_WithoutEnvOverride_Reverts() public {
        vm.chainId(RH_PROD);
        ActivateRouter.TestArgs memory a; // zeros — gate fires before any address is read
        vm.expectRevert(abi.encodeWithSelector(ActivateRouter.ActivateRouter__ProductionChainUnsafe.selector, RH_PROD));
        script.runForTest(a);
    }

    /// AC #3: `runForTest` on non-prod chains never fires the prod gate. Base
    /// chain (8453) reverts for the RIGHT reason (zero-address preflight),
    /// never ProductionChainUnsafe. Grabs the raw selector and pins the
    /// negative assertion.
    function test_RunForTest_OnNonProdChain_NeverHitsProdGate() public {
        vm.chainId(8453);
        ActivateRouter.TestArgs memory a;
        (bool ok, bytes memory ret) = address(script).call(abi.encodeCall(script.runForTest, (a)));
        assertFalse(ok, "runForTest with zero args must fail somewhere");
        if (ret.length >= 4) {
            bytes4 sel;
            assembly {
                sel := mload(add(ret, 0x20))
            }
            assertTrue(
                sel != ActivateRouter.ActivateRouter__ProductionChainUnsafe.selector, "prod gate fired off-chain"
            );
        }
    }
}
