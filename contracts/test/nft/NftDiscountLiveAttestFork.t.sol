// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NftMintModule} from "../../src/nft/NftMintModule.sol";

interface IUruD {
    function approve(
        address,
        uint256
    ) external returns (bool);
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// Feeds a REAL attestation from the live compile-service into a live
/// collection's mintWithUru on a fork, as a real holder, and checks the
/// discounted price is what gets charged. Driven by env so a script can fetch
/// fresh signatures: ATTEST_TIER, ATTEST_WALLET, ATTEST_COUNT, ATTEST_EXPIRY,
/// ATTEST_SIG. Skips when ATTEST_SIG is unset.
contract NftDiscountLiveAttestFork is Test {
    NftMintModule constant MODULE = NftMintModule(payable(0x361db4eab1116E8B1AEeB8C38125dD956aB7e47A));
    IUruD constant URU = IUruD(0x9fbe210007dDd8389f98d0253018e65CC48b9D24);

    function test_liveAttestationGivesDiscount() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        bytes memory sig = vm.envOr("ATTEST_SIG", bytes(""));
        if (bytes(rpc).length == 0 || sig.length == 0) return;
        vm.createSelectFork(rpc);

        uint256 tierId = vm.envUint("ATTEST_TIER");
        address wallet = vm.envAddress("ATTEST_WALLET");
        uint256 count = vm.envUint("ATTEST_COUNT");
        uint256 expiry = vm.envUint("ATTEST_EXPIRY");

        NftMintModule.TierProof[] memory proofs = new NftMintModule.TierProof[](1);
        proofs[0] = NftMintModule.TierProof({
            tierId: tierId, merkleProof: new bytes32[](0), count: count, expiry: expiry, sig: sig
        });

        NftMintModule.DiscountTier memory t = MODULE.tierAt(tierId);
        uint256 counted = count < t.maxCountedNfts ? count : t.maxCountedNfts;
        uint256 bps = counted * t.percentPerNftBps;
        uint256 ceiling = MODULE.discountCeilingBps();
        if (bps > ceiling) bps = ceiling;
        uint256 expected = MODULE.netPriceFor(1, bps);
        assertLt(expected, MODULE.grossPriceFor(1), "no discount expected");

        deal(address(URU), wallet, 10_000_000 ether);
        vm.startPrank(wallet);
        URU.approve(address(MODULE), type(uint256).max);
        uint256 before = URU.balanceOf(wallet);
        MODULE.mintWithUru(1, MODULE.grossPriceFor(1), new bytes32[](0), 0, 0, "", proofs);
        vm.stopPrank();

        emit log_named_uint("gross", MODULE.grossPriceFor(1));
        emit log_named_uint("charged", before - URU.balanceOf(wallet));
        assertEq(before - URU.balanceOf(wallet), expected, "discount not applied");
    }
}
