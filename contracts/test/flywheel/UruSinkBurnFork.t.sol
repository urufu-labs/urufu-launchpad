// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

interface ISinkLive {
    function owner() external view returns (address);
    function distributionSink() external view returns (address);
    function minEthPerUru() external view returns (uint256);
    function isKeeper(
        address
    ) external view returns (bool);
    function isSwapTarget(
        address
    ) external view returns (bool);
    function keeperChangeId(
        address,
        bool
    ) external pure returns (bytes32);
    function swapTargetChangeId(
        address,
        bool
    ) external pure returns (bytes32);
    function proposeAdminChange(
        bytes32
    ) external;
    function setKeeper(
        address,
        bool
    ) external;
    function setSwapTarget(
        address,
        bool
    ) external;
    function executeConversion(
        address swapTarget,
        uint256 uruIn,
        bytes calldata swapData,
        uint256 minEthOut
    ) external;
}

interface IUruLive {
    function balanceOf(
        address
    ) external view returns (uint256);
    function allowance(
        address,
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(
        address,
        uint256
    ) external returns (bool);
    function transferFrom(
        address,
        address,
        uint256
    ) external returns (bool);
}

/// Burn URU sitting in the live UruDepositSink with no new contracts: the
/// URU token itself is allowlisted as the sink's "swap target" and the keeper
/// passes `transfer(0xdEaD, amount)` as the swap calldata. The sink calls URU
/// from its own address, so its URU moves to the dead address; ETH out is 0,
/// which clears the 0 rate floor and forwards 0 ETH to distributionSink.
///
/// Run: ROBINHOOD_RPC_URL=... forge test --match-contract UruSinkBurnFork -vv
contract UruSinkBurnFork is Test {
    ISinkLive constant SINK = ISinkLive(0xeCD30ea7d0945A99b2032af4A6ad9d5bF345B8C8);
    IUruLive constant URU = IUruLive(0x9fbe210007dDd8389f98d0253018e65CC48b9D24);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // Live keeper wallet (also the sink owner and the buyback vault keeper).
    address constant KEEPER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    bool forked;
    address owner;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        owner = SINK.owner();
        // Same two owner txs + 2-day wait the real rollout uses.
        vm.startPrank(owner);
        SINK.proposeAdminChange(SINK.swapTargetChangeId(address(URU), true));
        SINK.proposeAdminChange(SINK.keeperChangeId(KEEPER, true));
        vm.stopPrank();
    }

    function _activate() internal {
        vm.warp(block.timestamp + 2 days + 1);
        vm.startPrank(owner);
        SINK.setSwapTarget(address(URU), true);
        SINK.setKeeper(KEEPER, true);
        vm.stopPrank();
    }

    function _burnData(
        uint256 amount
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(IUruLive.transfer, (DEAD, amount));
    }

    function test_cannotActivateBeforeDelay() public {
        if (!forked) return;
        vm.prank(owner);
        vm.expectRevert();
        SINK.setSwapTarget(address(URU), true);
    }

    function test_burnsWholeSinkBalance() public {
        if (!forked) return;
        _activate();
        uint256 bal = URU.balanceOf(address(SINK));
        assertGt(bal, 0, "sink empty");
        uint256 deadBefore = URU.balanceOf(DEAD);
        uint256 supplyBefore = URU.totalSupply();
        address dist = SINK.distributionSink();
        uint256 distEthBefore = dist.balance;

        vm.prank(KEEPER);
        SINK.executeConversion(address(URU), bal, _burnData(bal), 0);

        assertEq(URU.balanceOf(address(SINK)), 0, "sink not emptied");
        assertEq(URU.balanceOf(DEAD), deadBefore + bal, "dead did not receive");
        assertEq(URU.totalSupply(), supplyBefore, "supply changed unexpectedly");
        assertEq(URU.allowance(address(SINK), address(URU)), 0, "allowance left");
        assertEq(dist.balance, distEthBefore, "eth moved");
    }

    function test_partialBurnThenDepositsStillLand() public {
        if (!forked) return;
        _activate();
        uint256 bal = URU.balanceOf(address(SINK));
        vm.prank(KEEPER);
        SINK.executeConversion(address(URU), bal / 2, _burnData(bal / 2), 0);
        assertEq(URU.balanceOf(address(SINK)), bal - bal / 2);

        // New fees (NFT mints / DN404 launch fees) still arrive by plain transfer.
        address payer = makeAddr("payer");
        deal(address(URU), payer, 10_000 ether);
        vm.prank(payer);
        URU.transfer(address(SINK), 10_000 ether);
        assertEq(URU.balanceOf(address(SINK)), bal - bal / 2 + 10_000 ether);
    }

    function test_strangerCannotBurnOrMove() public {
        if (!forked) return;
        _activate();
        address stranger = makeAddr("stranger");
        bytes memory steal = abi.encodeCall(IUruLive.transfer, (stranger, 1 ether));
        vm.prank(stranger);
        vm.expectRevert();
        SINK.executeConversion(address(URU), 1 ether, steal, 0);
    }

    function test_unlistedTargetStillRejected() public {
        if (!forked) return;
        _activate();
        vm.prank(KEEPER);
        vm.expectRevert();
        SINK.executeConversion(makeAddr("router"), 1 ether, "", 0);
    }
}
