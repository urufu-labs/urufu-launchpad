// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {LPLockedHook} from "src/hooks/LPLockedHook.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {Graduator} from "src/curve/Graduator.sol";

contract MockToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/// @notice Fork test that runs the entire "curve → graduate → v4 pool + LP locked" story
///         against the real Sepolia PoolManager. Deploys LPLockedHook at a mined CREATE2
///         address, deploys Graduator with it, spins up a BondingCurve, buys through the
///         curve until graduation triggers, then verifies:
///           1. A v4 pool at the expected PoolKey exists
///           2. It has non-zero liquidity (the graduation LP mint succeeded)
///           3. The pool's hook is LPLockedHook — LP is locked by design
///
/// @dev    Skips cleanly when SEPOLIA_RPC_URL isn't set.
contract GraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant SEPOLIA_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    IPoolManager internal manager;
    LPLockedHook internal hook;
    Graduator internal graduator;

    // Match the curve defaults for graduation-friendly reserves.
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    uint256 internal constant VIRTUAL_TOKEN = 800_000_000e18;
    uint256 internal constant VIRTUAL_ETH = 5 ether;
    uint256 internal constant GRAD_TARGET = 2 ether;

    address internal alice = makeAddr("alice");
    address internal feeReceiver = makeAddr("feeReceiver");

    function setUp() public {
        try vm.envString("SEPOLIA_RPC_URL") returns (string memory rpc) {
            if (bytes(rpc).length == 0) vm.skip(true);
            vm.createSelectFork(rpc);
        } catch {
            vm.skip(true);
        }
        if (SEPOLIA_POOL_MANAGER.code.length == 0) vm.skip(true);

        manager = IPoolManager(SEPOLIA_POOL_MANAGER);

        // Deploy LPLockedHook at a mined address so PoolManager accepts it.
        uint160 required = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(manager);
        (uint256 salt,) = HookMiner.find(CREATE2_DEPLOYER, required, creation, args, 500_000);

        vm.prank(CREATE2_DEPLOYER);
        address hookAddr;
        assembly {
            let ptr := mload(0x40)
            let cLen := mload(creation)
            let aLen := mload(args)
            for { let i := 0 } lt(i, cLen) { i := add(i, 0x20) } {
                mstore(add(ptr, i), mload(add(add(creation, 0x20), i)))
            }
            for { let i := 0 } lt(i, aLen) { i := add(i, 0x20) } {
                mstore(add(add(ptr, cLen), i), mload(add(add(args, 0x20), i)))
            }
            hookAddr := create2(0, ptr, add(cLen, aLen), salt)
        }
        hook = LPLockedHook(hookAddr);

        // Fee 3000 + tickSpacing 60 == common v4 tier.
        graduator = new Graduator(manager, IHooks(address(hook)), 3000, 60);
    }

    function test_Fork_Graduate_CreatesPoolAndLocksLP() public {
        MockToken token = new MockToken();
        BondingCurve impl = new BondingCurve();
        BondingCurve curve = BondingCurve(payable(LibClone.clone(address(impl))));
        token.mint(address(curve), CURVE_SUPPLY);

        curve.initialize(
            address(token), feeReceiver, CURVE_SUPPLY, VIRTUAL_TOKEN, VIRTUAL_ETH, GRAD_TARGET, 100, address(graduator), 0, 0
        );

        vm.deal(alice, 10 ether);

        // Buy through graduation. 3 ETH sent → after 1% fee 2.97 ETH into reserve, past 2 ETH target.
        vm.prank(alice);
        curve.buy{value: 3 ether}(0);

        // The curve should have graduated + the graduator should have deployed liquidity.
        assertTrue(curve.graduated(), "curve did not graduate");
        assertEq(curve.ethReserve(), 0, "eth not drained");
        assertEq(curve.tokenReserve(), 0, "token not drained");

        // Verify the v4 pool exists and has non-zero liquidity.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(poolId);
        assertTrue(sqrtPriceX96 > 0, "pool not initialized");
        uint128 liquidity = manager.getLiquidity(poolId);
        assertGt(liquidity, 0, "pool has zero liquidity");

        // Hook wiring: PoolKey.hooks matches LPLockedHook. LP is locked by construction
        // because the hook reverts every beforeRemoveLiquidity call — proven in
        // LPLockedHookForkTest + LPLockedHook.t.sol.
        assertEq(address(key.hooks), address(hook));
    }
}
