// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {LPLockedHook} from "src/hooks/LPLockedHook.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

/// @notice Fork test that exercises LPLockedHook against a *real* Uniswap v4 PoolManager on
///         Sepolia. Forks Sepolia at latest, mines a CREATE2 salt so the hook lands at an
///         address whose low bits set BEFORE_REMOVE_LIQUIDITY_FLAG, deploys the hook via the
///         canonical Foundry CREATE2 deployer, and initializes a real pool with the hook.
///         Then verifies:
///           1. Pool initialization succeeds (hook address bits validated by PoolManager).
///           2. The hook's `beforeRemoveLiquidity` callback is unreachable except through
///              PoolManager (the direct-call revert test lives in LPLockedHook.t.sol —
///              this test proves the hook is wired into a live v4 deploy).
///
/// @dev    Skipped when SEPOLIA_RPC_URL isn't set (no fork available). Direct-invoke tests
///         cover the revert behavior; this test covers deployability + PoolManager acceptance.
///
///         Sepolia PoolManager address is the canonical v4 deployment. If the address moves
///         (redeploy), update SEPOLIA_POOL_MANAGER below.
contract LPLockedHookForkTest is Test {
    // Canonical Sepolia v4 PoolManager. Update if v4 redeploys.
    address internal constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager internal manager;

    function setUp() public {
        // Skip cleanly when SEPOLIA_RPC_URL isn't set — no fork available.
        try vm.envString("SEPOLIA_RPC_URL") returns (string memory rpc) {
            if (bytes(rpc).length == 0) vm.skip(true);
            vm.createSelectFork(rpc);
        } catch {
            vm.skip(true);
        }
        // The PoolManager must exist on the fork. If bytecode is empty, v4 isn't deployed
        // to whatever fork block we landed on; skip rather than fail.
        if (SEPOLIA_POOL_MANAGER.code.length == 0) vm.skip(true);
        manager = IPoolManager(SEPOLIA_POOL_MANAGER);
    }

    function test_Fork_LPLockedHook_DeployAtMinedAddress() public {
        uint160 requiredFlags = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(manager);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);

        // Deploy via the canonical CREATE2 deployer to match production deploy shape.
        vm.prank(CREATE2_DEPLOYER);
        address deployed;
        assembly {
            let ptr := mload(0x40)
            let creationLen := mload(creation)
            let argsLen := mload(args)
            // creation || args
            let dst := ptr
            let src := add(creation, 0x20)
            for { let i := 0 } lt(i, creationLen) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            src := add(args, 0x20)
            for { let i := 0 } lt(i, argsLen) { i := add(i, 0x20) } {
                mstore(add(add(dst, creationLen), i), mload(add(src, i)))
            }
            deployed := create2(0, ptr, add(creationLen, argsLen), salt)
        }
        assertTrue(deployed != address(0), "CREATE2 deploy failed");
        assertEq(deployed, predicted, "predicted != deployed");
        // Permission bits are baked into the address.
        assertEq(uint160(deployed) & 0x3FFF, requiredFlags & 0x3FFF, "flag bits missing");
    }

    function test_Fork_LPLockedHook_PoolInitAccepted() public {
        uint160 requiredFlags = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(manager);
        (uint256 salt, address predicted) = HookMiner.find(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000);

        vm.prank(CREATE2_DEPLOYER);
        address hookAddr;
        assembly {
            let ptr := mload(0x40)
            let creationLen := mload(creation)
            let argsLen := mload(args)
            let dst := ptr
            let src := add(creation, 0x20)
            for { let i := 0 } lt(i, creationLen) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            src := add(args, 0x20)
            for { let i := 0 } lt(i, argsLen) { i := add(i, 0x20) } {
                mstore(add(add(dst, creationLen), i), mload(add(src, i)))
            }
            hookAddr := create2(0, ptr, add(creationLen, argsLen), salt)
        }
        assertEq(hookAddr, predicted);

        // Compose a real PoolKey pointing at the mined hook. currency0 = native ETH (0x0),
        // currency1 = a placeholder ERC-20 (we don't actually need to interact with it just
        // to call initialize — the pool manager only checks currency0 < currency1 and hook
        // permissions).
        Currency c0 = Currency.wrap(address(0));
        Currency c1 = Currency.wrap(address(0x1234567890123456789012345678901234567890));
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddr)});

        // sqrt(1) in Q64.96 = 1 * 2^96
        uint160 sqrtPrice1_1 = 79_228_162_514_264_337_593_543_950_336;
        // Should not revert — the mined address's flag bits pass Hooks.validateHookPermissions.
        manager.initialize(key, sqrtPrice1_1);
    }
}
