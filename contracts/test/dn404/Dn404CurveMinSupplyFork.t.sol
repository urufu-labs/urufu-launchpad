// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Dn404LaunchFactory} from "../../src/dn404/Dn404LaunchFactory.sol";

interface IUruMin {
    function approve(
        address,
        uint256
    ) external returns (bool);
}

/// The DN404 create page blocks launches whose curve supply is below
/// max(defaultCurveSupply / 2, target * vToken * 1e4 / (vPair * (1e4 - margin)) + 1),
/// read live from the curve factory. This pins that boundary against the live
/// factories: just above it launches, just below it reverts, for both pairs.
///
/// Live URU-pair numbers (2026-10-09): min = 495,356,037.15 tokens, so with
/// 1000 NFTs, unit 495,357 launches and 495,356 reverts. ETH pair: min is
/// half of 800M = 400M, so 1000 x 400,000 launches and 1000 x 399,999 reverts.
///
/// Run: ROBINHOOD_RPC_URL=... forge test --match-contract Dn404CurveMinSupplyFork -vv
contract Dn404CurveMinSupplyFork is Test {
    Dn404LaunchFactory constant FACTORY = Dn404LaunchFactory(0x3026C71eB13C599BAd0e7a687689D20F8c37A64B);
    address constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;

    bool forked;
    address launcher;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        launcher = makeAddr("launcher");
        deal(URU, launcher, 1_000_000 ether);
        vm.deal(launcher, 1 ether);
        vm.prank(launcher);
        IUruMin(URU).approve(address(FACTORY), type(uint256).max);
    }

    function _params(
        uint256 unit,
        address pair
    ) internal view returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = "Boundary";
        p.ticker = "BND";
        p.baseURI = "ipfs://bafybeigfxtiyjpd5nzb3ch5cbtwace7as7ipsu5t5ipeygqrk4gfb7coym/";
        p.collectionSize = 1000;
        p.unit = unit;
        p.pairCurrency = pair;
        p.uruAmount = FACTORY.minUruFeeFor(launcher);
    }

    // Params are built before vm.prank: the fee quote inside _params is an
    // external call and would otherwise consume the prank.
    function test_uruPair_justAboveMinLaunches() public {
        if (!forked) return;
        Dn404LaunchFactory.LaunchParams memory p = _params(495_357, URU);
        vm.prank(launcher);
        FACTORY.launch(p);
    }

    function test_uruPair_justBelowMinReverts() public {
        if (!forked) return;
        Dn404LaunchFactory.LaunchParams memory p = _params(495_356, URU);
        vm.prank(launcher);
        vm.expectRevert();
        FACTORY.launch(p);
    }

    function test_ethPair_atMinLaunches() public {
        if (!forked) return;
        Dn404LaunchFactory.LaunchParams memory p = _params(400_000, address(0));
        vm.prank(launcher);
        FACTORY.launch(p);
    }

    function test_ethPair_belowMinReverts() public {
        if (!forked) return;
        Dn404LaunchFactory.LaunchParams memory p = _params(399_999, address(0));
        vm.prank(launcher);
        vm.expectRevert();
        FACTORY.launch(p);
    }
}
