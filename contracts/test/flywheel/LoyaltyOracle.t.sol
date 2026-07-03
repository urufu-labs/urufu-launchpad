// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";

contract MockUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockGemu is ERC721 {
    function name() public pure override returns (string memory) {
        return "GEMU";
    }

    function symbol() public pure override returns (string memory) {
        return "GEMU";
    }

    function tokenURI(
        uint256
    ) public pure override returns (string memory) {
        return "";
    }

    function mint(
        address to,
        uint256 id
    ) external {
        _mint(to, id);
    }
}

contract LoyaltyOracleTest is Test {
    LoyaltyOracle internal oracle;
    MockUru internal uru;
    MockGemu internal gemu;

    address internal owner = makeAddr("owner");
    address internal holder = makeAddr("holder");

    uint256 internal constant URU_THRESHOLD = 1000e18;

    function setUp() public {
        uru = new MockUru();
        gemu = new MockGemu();
        oracle = new LoyaltyOracle(owner, address(uru), address(gemu), URU_THRESHOLD);
    }

    function test_Discount_NonHolder_Zero() public view {
        assertEq(oracle.discountBpsFor(holder), 0);
    }

    function test_Discount_NftOnly_20() public {
        gemu.mint(holder, 1);
        assertEq(oracle.discountBpsFor(holder), 2000);
    }

    function test_Discount_UruOnly_40() public {
        uru.mint(holder, URU_THRESHOLD);
        assertEq(oracle.discountBpsFor(holder), 4000);
    }

    function test_Discount_UruBelowThreshold_Zero() public {
        uru.mint(holder, URU_THRESHOLD - 1);
        assertEq(oracle.discountBpsFor(holder), 0);
    }

    function test_Discount_Both_50() public {
        gemu.mint(holder, 1);
        uru.mint(holder, URU_THRESHOLD);
        assertEq(oracle.discountBpsFor(holder), 5000);
    }

    function test_Discount_ClampedAtMax() public {
        vm.prank(owner);
        oracle.setConfig(address(uru), address(gemu), URU_THRESHOLD, 7000, 7000, 8000, 6000);
        gemu.mint(holder, 1);
        uru.mint(holder, URU_THRESHOLD);
        // bothBps=8000 but maxDiscountBps=6000 → clamped
        assertEq(oracle.discountBpsFor(holder), 6000);
    }

    function test_SetConfig_RevertsIfBpsOverHardMax() public {
        vm.expectRevert(abi.encodeWithSelector(LoyaltyOracle.LoyaltyOracle__BadBps.selector, uint16(8000)));
        vm.prank(owner);
        oracle.setConfig(address(uru), address(gemu), URU_THRESHOLD, 9000, 4000, 5000, 5000);
    }

    function test_Discount_ZeroAddresses_Safe() public {
        vm.prank(owner);
        oracle.setConfig(address(0), address(0), URU_THRESHOLD, 2000, 4000, 5000, 5000);
        gemu.mint(holder, 1);
        // Even though holder has a gemu NFT, the oracle points at address(0) so no discount.
        assertEq(oracle.discountBpsFor(holder), 0);
    }
}
