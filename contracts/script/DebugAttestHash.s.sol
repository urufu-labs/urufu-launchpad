// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Compute the attestation hash the fixed NftMintModule expects, so
///         we can compare it to what cast is signing off-chain.
contract DebugAttestHash is Script {
    function run() external view {
        address wallet = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
        address ourCollection = 0x6666906033bE027d3820305B7f4e85f4613edA48; // ERC-721 clone
        address targetCollection = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17; // gemu
        uint256 targetChainId = 4663;
        uint256 tierId = 0;
        uint256 count = 2;
        uint256 expiry = 9999999999;

        bytes32 hash = keccak256(
            abi.encode(
                "URU_NFT_DISCOUNT_V1",
                block.chainid,
                wallet,
                ourCollection,
                targetCollection,
                targetChainId,
                tierId,
                count,
                expiry
            )
        );
        console2.log("attest hash:");
        console2.logBytes32(hash);
    }
}
