// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NftMintModule} from "../../src/nft/NftMintModule.sol";

interface IUru {
    function approve(
        address,
        uint256
    ) external returns (bool);
    function balanceOf(
        address
    ) external view returns (uint256);
    function allowance(
        address,
        address
    ) external view returns (uint256);
}

/// The collection page approves URU once (max) instead of before every mint,
/// and passes up to 5% over the quote as `uruAmount` on linear-step
/// collections. Proves against a live URU-priced collection that a max
/// approval serves repeated mints and every mint is charged exactly its price.
///
/// Run: ROBINHOOD_RPC_URL=... forge test --match-contract NftUruApproveOnceFork -vv
contract NftUruApproveOnceFork is Test {
    // Live URU-priced collection's mint module (Visions of Lambro).
    NftMintModule constant MODULE = NftMintModule(payable(0x361db4eab1116E8B1AEeB8C38125dD956aB7e47A));
    IUru constant URU = IUru(0x9fbe210007dDd8389f98d0253018e65CC48b9D24);

    bool forked;
    address buyer;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        buyer = makeAddr("buyer");
        deal(address(URU), buyer, 10_000_000 ether);
    }

    function _mint(
        uint256 qty,
        uint256 maxPay
    ) internal {
        vm.prank(buyer);
        MODULE.mintWithUru(qty, maxPay, new bytes32[](0), 0, 0, "", new NftMintModule.TierProof[](0));
    }

    function test_oneApprovalCoversRepeatedMints_exactCharge() public {
        if (!forked) return;
        vm.prank(buyer);
        URU.approve(address(MODULE), type(uint256).max);

        for (uint256 i = 0; i < 3; i++) {
            uint256 qty = i + 1;
            uint256 price = MODULE.grossPriceFor(qty);
            uint256 before = URU.balanceOf(buyer);
            // Same ceiling the page sends on linear-step collections.
            _mint(qty, price + price / 20);
            assertEq(before - URU.balanceOf(buyer), price, "charged more than the price");
        }
    }

    function test_oneMintApprovalStillWorks() public {
        if (!forked) return;
        uint256 price = MODULE.grossPriceFor(1);
        vm.prank(buyer);
        URU.approve(address(MODULE), price);
        _mint(1, price);
        assertEq(URU.allowance(buyer, address(MODULE)), 0);
        // Second mint without a new approval fails, which is why the page
        // asks again in this mode.
        vm.expectRevert();
        _mint(1, price);
    }
}
