// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";
import {LPLockedHook} from "src/hooks/LPLockedHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

/// External wrapper so `vm.expectRevert` can intercept the library revert.
contract MinerTarget {
    function find(
        address deployer,
        uint160 required,
        bytes memory creation,
        bytes memory args,
        uint256 max
    ) external pure returns (uint256, address) {
        return HookMiner.find(deployer, required, creation, args, max);
    }
}

contract HookMinerTest is Test {
    address internal deployer = makeAddr("deployer");
    address internal mockPM = makeAddr("poolManager");

    function test_Find_ProducesAddressWithRequiredBits() public view {
        uint160 required = 1 << 9; // BEFORE_REMOVE_LIQUIDITY_FLAG
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(mockPM));
        (uint256 salt, address predicted) = HookMiner.find(deployer, required, creation, args, 200_000);
        assertEq(uint160(predicted) & 0x3FFF, required & 0x3FFF);
        // Salt is deterministic given inputs — sanity check that it's inside the search window.
        assertLt(salt, 200_000);
    }

    function test_Find_ExhaustsAndReverts() public {
        MinerTarget target = new MinerTarget();
        // All 14 low bits required → probability of any single salt matching is ~1/16384.
        // With maxIterations=1 the loop reliably exhausts.
        uint160 required = 0x3FFF;
        bytes memory creation = type(LPLockedHook).creationCode;
        bytes memory args = abi.encode(IPoolManager(mockPM));
        vm.expectRevert(abi.encodeWithSelector(HookMiner.HookMiner__ExhaustedSearch.selector, uint256(1)));
        target.find(deployer, required, creation, args, 1);
    }
}
