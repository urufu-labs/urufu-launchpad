// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";

contract ERC20WithVestingGenTest is Test {
    ERC20WithVestingGen internal impl;
    ERC20WithVestingGen internal token;

    address internal owner = makeAddr("owner");
    address internal beneficiary = makeAddr("beneficiary");

    uint256 internal constant TOTAL = 1000 ether;
    uint64 internal cliff;
    uint64 internal endTs;

    function setUp() public {
        cliff = uint64(block.timestamp + 30 days);
        endTs = uint64(block.timestamp + 400 days);

        impl = new ERC20WithVestingGen();
        token = ERC20WithVestingGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(beneficiary, TOTAL, cliff, endTs);
        bytes memory initData = abi.encode(owner, "Vest", "VEST", 500 ether, owner, moduleData);
        token.initialize(initData);
    }

    function test_Init_StoresSchedule() public view {
        assertEq(token.vestingBeneficiary(), beneficiary);
        assertEq(token.vestingTotal(), TOTAL);
        assertEq(token.vestingReleased(), 0);
        assertEq(token.vestingCliffTimestamp(), cliff);
        assertEq(token.vestingEndTimestamp(), endTs);
    }

    function test_Releasable_ZeroBeforeCliff() public {
        assertEq(token.vestingReleasable(), 0);
        vm.warp(cliff - 1);
        assertEq(token.vestingReleasable(), 0);
    }

    function test_Releasable_LinearBetweenCliffAndEnd() public {
        // Halfway.
        uint256 midpoint = (uint256(cliff) + uint256(endTs)) / 2;
        vm.warp(midpoint);
        uint256 releasable = token.vestingReleasable();
        // Allow 1 wei rounding tolerance.
        assertApproxEqAbs(releasable, TOTAL / 2, 1);
    }

    function test_Releasable_FullAfterEnd() public {
        vm.warp(endTs);
        assertEq(token.vestingReleasable(), TOTAL);
        vm.warp(endTs + 10 days);
        assertEq(token.vestingReleasable(), TOTAL);
    }

    function test_Release_MintsToBeneficiary() public {
        vm.warp(endTs);
        uint256 supplyBefore = token.totalSupply();
        token.vestingRelease();
        assertEq(token.balanceOf(beneficiary), TOTAL);
        assertEq(token.totalSupply(), supplyBefore + TOTAL);
        assertEq(token.vestingReleased(), TOTAL);
    }

    function test_Release_RevertsWhenNothingVested() public {
        vm.expectRevert(ERC20WithVestingGen.Vesting__NothingToRelease.selector);
        token.vestingRelease();
    }

    function test_Release_Incremental() public {
        uint256 mid = (uint256(cliff) + uint256(endTs)) / 2;
        vm.warp(mid);
        token.vestingRelease();
        uint256 midBal = token.balanceOf(beneficiary);
        assertApproxEqAbs(midBal, TOTAL / 2, 1);

        vm.warp(endTs);
        token.vestingRelease();
        assertEq(token.balanceOf(beneficiary), TOTAL);
    }

    function test_Init_RevertsOnZeroBeneficiary() public {
        ERC20WithVestingGen fresh = ERC20WithVestingGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(address(0), TOTAL, cliff, endTs);
        bytes memory initData = abi.encode(owner, "Vest", "VEST", 0, address(0), moduleData);
        vm.expectRevert(ERC20WithVestingGen.Vesting__ZeroBeneficiary.selector);
        fresh.initialize(initData);
    }

    function test_Init_RevertsOnBadSchedule() public {
        ERC20WithVestingGen fresh = ERC20WithVestingGen(LibClone.clone(address(impl)));
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(beneficiary, TOTAL, endTs, cliff); // swapped
        bytes memory initData = abi.encode(owner, "Vest", "VEST", 0, address(0), moduleData);
        vm.expectRevert(abi.encodeWithSelector(ERC20WithVestingGen.Vesting__BadSchedule.selector, endTs, cliff));
        fresh.initialize(initData);
    }
}
