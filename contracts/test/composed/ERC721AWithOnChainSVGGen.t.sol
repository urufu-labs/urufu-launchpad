// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {Base64} from "solady/utils/Base64.sol";

import {ERC721AWithOnChainSVGGen} from "src/templates/composed/ERC721AWithOnChainSVGGen.sol";

contract ERC721AWithOnChainSVGGenTest is Test {
    ERC721AWithOnChainSVGGen internal impl;
    ERC721AWithOnChainSVGGen internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        impl = new ERC721AWithOnChainSVGGen();
        token = ERC721AWithOnChainSVGGen(LibClone.clone(address(impl)));

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = ""; // OnChainSVG takes no params

        bytes memory initData =
            abi.encode(owner, "Cosmic Cats", "COSMIC", string("ignored-by-onchain-svg"), uint256(1000), moduleData);
        token.initialize(initData);
    }

    function test_TokenURI_NonexistentReverts() public {
        vm.expectRevert();
        token.tokenURI(0);
    }

    function test_TokenURI_HappyPath_ReturnsBase64DataUri() public {
        vm.prank(owner);
        token.mintBatch(alice, 3);

        string memory uri = token.tokenURI(1);
        // Expected prefix.
        bytes memory uriBytes = bytes(uri);
        assertGt(uriBytes.length, 30, "uri should be non-trivial");
        assertEq(
            keccak256(_slice(uriBytes, 0, 29)),
            keccak256(bytes("data:application/json;base64,")),
            "uri should start with data:application/json;base64,"
        );
    }

    function test_TokenURI_JsonDecodesToValidStructure() public {
        vm.prank(owner);
        token.mintBatch(alice, 2);

        string memory uri = token.tokenURI(1);
        // Strip the prefix.
        bytes memory tail = _slice(bytes(uri), 29, bytes(uri).length - 29);
        // Base64-decode to get the JSON.
        string memory jsonStr = string(Base64.decode(string(tail)));
        // Should contain name (with #1), image data URI.
        assertTrue(_contains(jsonStr, '"name":"Cosmic Cats #1"'), "name should include token id");
        assertTrue(_contains(jsonStr, "data:image/svg+xml;base64,"), "should embed base64 SVG");
    }

    function test_TokenURI_DifferentIdsProduceDifferentSVGs() public {
        vm.prank(owner);
        token.mintBatch(alice, 3);

        string memory uri1 = token.tokenURI(1);
        string memory uri2 = token.tokenURI(2);
        assertNotEq(keccak256(bytes(uri1)), keccak256(bytes(uri2)));
    }

    // =========================================================
    // Helpers
    // =========================================================

    function _slice(
        bytes memory data,
        uint256 start,
        uint256 len
    ) internal pure returns (bytes memory) {
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = data[start + i];
        }
        return out;
    }

    function _contains(
        string memory haystack,
        string memory needle
    ) internal pure returns (bool) {
        bytes memory hb = bytes(haystack);
        bytes memory nb = bytes(needle);
        if (nb.length > hb.length) return false;
        for (uint256 i; i <= hb.length - nb.length; ++i) {
            bool match_ = true;
            for (uint256 j; j < nb.length; ++j) {
                if (hb[i + j] != nb[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}
