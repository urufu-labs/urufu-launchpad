// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";

import {ERC1155WithSplitPayableGen} from "src/templates/composed/ERC1155WithSplitPayableGen.sol";

/// @dev Mock FeeSplitter — receives ETH via `receive()` and tracks the running total, so
///      we can assert on cumulative platform intake without wiring the real splitter here.
contract MockFeeSink {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

contract ERC1155WithSplitPayableGenTest is Test {
    ERC1155WithSplitPayableGen internal impl;
    ERC1155WithSplitPayableGen internal token;
    MockFeeSink internal splitter;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant PRICE = 0.01 ether;
    uint16 internal constant PLATFORM_BPS = 500; // 5%

    function setUp() public {
        splitter = new MockFeeSink();
        impl = new ERC1155WithSplitPayableGen();
        token = ERC1155WithSplitPayableGen(payable(LibClone.clone(address(impl))));

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;

        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(ids, prices, address(splitter), PLATFORM_BPS);
        bytes memory initData = abi.encode(owner, "Pay", "PAY", "ipfs://{id}.json", moduleData);
        token.initialize(initData);

        vm.deal(alice, 5 ether);
    }

    function test_Init_StoresConfig() public view {
        (uint256 price, bool mintable) = token.priceOf(1);
        assertEq(price, PRICE);
        assertTrue(mintable);
        (address rx, uint16 bps) = token.platformFee();
        assertEq(rx, address(splitter));
        assertEq(bps, PLATFORM_BPS);
    }

    function test_MintPayable_ForwardsPlatformCut() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE * 3}(1, 3);

        uint256 total = PRICE * 3;
        uint256 expectedPlatform = (total * PLATFORM_BPS) / 10_000;
        uint256 expectedLauncher = total - expectedPlatform;

        assertEq(token.balanceOf(alice, 1), 3);
        assertEq(splitter.received(), expectedPlatform, "platform received 5%");
        assertEq(address(token).balance, expectedLauncher, "launcher retained 95%");
    }

    function test_MintPayable_RevertsOnWrongPrice() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC1155WithSplitPayableGen.PayableMint1155Split__WrongPrice.selector, PRICE * 2, PRICE * 3
            )
        );
        vm.prank(alice);
        token.mintPayable{value: PRICE * 2}(1, 3);
    }

    function test_MintPayable_RevertsOnUnpricedId() public {
        vm.expectRevert(
            abi.encodeWithSelector(ERC1155WithSplitPayableGen.PayableMint1155Split__NotMintable.selector, 2)
        );
        vm.prank(alice);
        token.mintPayable{value: PRICE}(2, 1);
    }

    function test_MintPayable_RevertsOnZeroQty() public {
        vm.expectRevert(ERC1155WithSplitPayableGen.PayableMint1155Split__ZeroQty.selector);
        vm.prank(alice);
        token.mintPayable{value: 0}(1, 0);
    }

    function test_Withdraw_OwnerSweepsOnlyLauncherShare() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE * 5}(1, 5);
        uint256 launcherShare = (PRICE * 5) - ((PRICE * 5 * PLATFORM_BPS) / 10_000);

        vm.prank(owner);
        token.withdrawPayable(treasury);
        assertEq(treasury.balance, launcherShare);
        assertEq(address(token).balance, 0);
    }

    function test_Withdraw_OnlyOwner() public {
        vm.prank(alice);
        token.mintPayable{value: PRICE}(1, 1);
        vm.expectRevert();
        vm.prank(alice);
        token.withdrawPayable(alice);
    }

    function test_Init_RevertsOnZeroFeeReceiver() public {
        ERC1155WithSplitPayableGen bad = ERC1155WithSplitPayableGen(payable(LibClone.clone(address(impl))));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(ids, prices, address(0), PLATFORM_BPS);
        bytes memory initData = abi.encode(owner, "Pay", "PAY", "ipfs://{id}.json", moduleData);

        vm.expectRevert(ERC1155WithSplitPayableGen.PayableMint1155Split__ZeroAddress.selector);
        bad.initialize(initData);
    }

    function test_Init_RevertsOnBadPlatformBps() public {
        ERC1155WithSplitPayableGen bad = ERC1155WithSplitPayableGen(payable(LibClone.clone(address(impl))));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory prices = new uint256[](1);
        prices[0] = PRICE;
        bytes[] memory moduleData = new bytes[](1);
        moduleData[0] = abi.encode(ids, prices, address(splitter), uint16(10_000));
        bytes memory initData = abi.encode(owner, "Pay", "PAY", "ipfs://{id}.json", moduleData);

        vm.expectRevert(
            abi.encodeWithSelector(ERC1155WithSplitPayableGen.PayableMint1155Split__BadPlatformBps.selector, 10_000)
        );
        bad.initialize(initData);
    }
}
