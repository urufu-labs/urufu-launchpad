// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";

import {FairTestBase} from "./FairTestBase.sol";

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

contract MockOracle {
    uint16 public bps;
    bool public broken;

    function set(
        uint16 b,
        bool br
    ) external {
        bps = b;
        broken = br;
    }

    function discountBpsFor(
        address
    ) external view returns (uint16) {
        require(!broken, "oracle down");
        return bps;
    }
}

/// Deploy fee on the Fair lane (added 2026-10-20 to match the token lane): pay in ETH
/// with `launch` or in URU with `launchWithURU`, holder discount from the LoyaltyOracle.
/// forge-config: default.isolate = true
contract FairLaneDeployFeeTest is FairTestBase {
    MockUru internal uru;
    MockOracle internal oracle;
    address internal sink = makeAddr("uru-sink");

    uint256 internal constant ETH_FEE = 0.001 ether;
    uint256 internal constant URU_FLOOR = 1000e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        _deployFairStack(IPoolManager(address(new PoolManager(admin))), platform, feeReceiver);
        uru = new MockUru();
        oracle = new MockOracle();
        vm.startPrank(admin);
        factory.setEthLaunchFee(ETH_FEE);
        factory.setUruConfig(address(uru), sink, URU_FLOOR);
        factory.setLoyaltyOracle(address(oracle));
        vm.stopPrank();
    }

    // ================================================================ ETH

    function test_EthFee_GoesToFeeReceiver_RestIsDeposit() public {
        vm.deal(creator, 1 ether);
        uint256 fr0 = feeReceiver.balance;
        vm.expectEmit(false, false, true, false, address(factory));
        emit FairLaunchFactory.FairLaunched(
            address(0), address(0), creator, address(0), "", "", 0, 0, 0, 0.2 ether, ETH_FEE, false
        );
        vm.prank(creator);
        (,, address b) = factory.launch{value: 0.2 ether + ETH_FEE}("EthFee", "EF");
        assertEq(feeReceiver.balance - fr0, ETH_FEE, "fee not sent to the flywheel");
        assertEq(OpeningBatch(payable(b)).deposits(creator), 0.2 ether, "deposit should be value minus fee");
    }

    function test_EthFee_ExactFeeNoDeposit() public {
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (,, address b) = factory.launch{value: ETH_FEE}("FeeOnly", "FO");
        assertEq(OpeningBatch(payable(b)).deposits(creator), 0);
        assertEq(OpeningBatch(payable(b)).totalDeposited(), 0);
    }

    function test_EthFee_UnderpayReverts() public {
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                FairLaunchFactory.FairLaunchFactory__InsufficientEthFee.selector, ETH_FEE, ETH_FEE - 1
            )
        );
        factory.launch{value: ETH_FEE - 1}("Under", "U");
    }

    function test_HolderDiscount_AppliedAndClamped() public {
        oracle.set(5000, false);
        assertEq(factory.ethFeeFor(creator), ETH_FEE / 2);
        assertEq(factory.minUruFeeFor(creator), URU_FLOOR / 2);
        // A broken oracle answer (99.99%) is clamped to the Router's 80% cap.
        oracle.set(9999, false);
        assertEq(factory.ethFeeFor(creator), ETH_FEE / 5);
        // An oracle that reverts means no discount, never a stuck launch.
        oracle.set(0, true);
        assertEq(factory.ethFeeFor(creator), ETH_FEE);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        factory.launch{value: ETH_FEE}("OracleDown", "OD");

        oracle.set(5000, false);
        uint256 fr0 = feeReceiver.balance;
        vm.prank(creator);
        factory.launch{value: ETH_FEE / 2}("Half", "H");
        assertEq(feeReceiver.balance - fr0, ETH_FEE / 2);
    }

    // ================================================================ URU

    function test_UruFee_GoesToSink_AllEthIsDeposit() public {
        uru.mint(creator, 5000e18);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        uru.approve(address(factory), URU_FLOOR);
        uint256 fr0 = feeReceiver.balance;
        vm.prank(creator);
        (,, address b) = factory.launchWithURU{value: 0.3 ether}("UruFee", "UF", URU_FLOOR);
        assertEq(uru.balanceOf(sink), URU_FLOOR, "URU not sent to the sink");
        assertEq(OpeningBatch(payable(b)).deposits(creator), 0.3 ether, "all ETH should be deposit");
        assertEq(feeReceiver.balance, fr0, "no ETH fee on the URU path");
    }

    function test_UruFee_BelowFloorReverts_DiscountLowersFloor() public {
        uru.mint(creator, 5000e18);
        vm.prank(creator);
        uru.approve(address(factory), type(uint256).max);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                FairLaunchFactory.FairLaunchFactory__InsufficientUru.selector, URU_FLOOR, URU_FLOOR - 1
            )
        );
        factory.launchWithURU("Low", "L", URU_FLOOR - 1);
        oracle.set(5000, false);
        vm.prank(creator);
        factory.launchWithURU("Disc", "D", URU_FLOOR / 2);
        assertEq(uru.balanceOf(sink), URU_FLOOR / 2);
    }

    function test_UruFee_ZeroOrUnconfiguredReverts() public {
        vm.prank(creator);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__ZeroUru.selector);
        factory.launchWithURU("Zero", "Z", 0);
        vm.prank(admin);
        factory.setUruConfig(address(0), address(0), 0);
        vm.prank(creator);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__UruUnconfigured.selector);
        factory.launchWithURU("Off", "O", 1);
    }

    function test_UruPath_RespectsLaunchGate() public {
        vm.prank(admin);
        factory.setLaunchesOpen(false);
        vm.prank(creator);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__LaunchesClosed.selector);
        factory.launchWithURU("Closed", "C", URU_FLOOR);
    }

    // ================================================================ admin

    function test_FeeSetters_OwnerOnlyAndCapped() public {
        vm.prank(creator);
        vm.expectRevert();
        factory.setEthLaunchFee(0);
        vm.prank(creator);
        vm.expectRevert();
        factory.setUruConfig(address(uru), sink, 0);
        vm.prank(creator);
        vm.expectRevert();
        factory.setLoyaltyOracle(address(0));
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(FairLaunchFactory.FairLaunchFactory__EthFeeTooHigh.selector, 0.2 ether, 0.1 ether)
        );
        factory.setEthLaunchFee(0.2 ether);
        vm.prank(admin);
        vm.expectRevert(FairLaunchFactory.FairLaunchFactory__ZeroAddress.selector);
        factory.setUruConfig(address(uru), address(0), 1);
        // Owner can make the lane free again without a redeploy.
        vm.prank(admin);
        factory.setEthLaunchFee(0);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (,, address b) = factory.launch{value: 0.1 ether}("Free", "F");
        assertEq(OpeningBatch(payable(b)).deposits(creator), 0.1 ether);
    }
}
