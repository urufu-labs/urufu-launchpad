// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";

/// A token that silently returns `false` from `transfer` instead of reverting
/// or actually moving balance. The USDT-lineage pattern. Raw `x.transfer(...)`
/// swallows the false; `SafeTransferLib.safeTransfer` catches it and reverts.
contract MockBadUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "BAD";
    }

    function symbol() public pure override returns (string memory) {
        return "BAD";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    /// Non-standard: returns false without moving balance. Uncaught by raw
    /// callers; caught by SafeTransferLib's return-value guard.
    function transfer(
        address,
        uint256
    ) public pure override returns (bool) {
        return false;
    }
}

contract MockSwapRouterBad {
    MockBadUru public immutable uru;

    constructor(
        MockBadUru _uru
    ) {
        uru = _uru;
    }

    function swap(
        address to
    ) external payable {
        uru.mint(to, msg.value * 1000);
    }
}

/// @title  AuditA17SafeTransferLibGuardTest
/// @notice URU-A17 Low: prove the SafeTransferLib substitution in
///         `UruBuybackVault.executeBuyback` actually catches a non-standard
///         ERC-20 that returns `false` from `transfer`. Under the pre-fix code
///         (`uru.transfer(distributionSink, uruOut);`) this test would PASS
///         (the vault silently drops the credit); post-fix it MUST revert.
contract AuditA17SafeTransferLibGuardTest is Test {
    UruBuybackVault internal vault;
    MockBadUru internal badUru;
    MockSwapRouterBad internal swapRouter;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal distribution = makeAddr("distribution");

    function setUp() public {
        badUru = new MockBadUru();
        vault = new UruBuybackVault(owner, address(badUru), distribution, 0);
        swapRouter = new MockSwapRouterBad(badUru);
        vm.deal(address(this), 100 ether);

        vm.startPrank(owner);
        vault.setKeeper(keeper, true);
        vault.setSwapTarget(address(swapRouter), true);
        vm.stopPrank();
    }

    /// The post-fix code uses `SafeTransferLib.safeTransfer(address(uru), ...)`
    /// which reverts `TransferFailed` (0x90b8ec18) when the underlying token
    /// returns `false`. Pin the exact selector so a regression back to raw
    /// `uru.transfer(...)` breaks this test loud.
    function test_SafeTransferLib_CatchesNonStandardFalseReturn() public {
        (bool sent,) = address(vault).call{value: 2 ether}("");
        assertTrue(sent);

        bytes memory swapData = abi.encodeCall(MockSwapRouterBad.swap, (address(vault)));

        vm.prank(keeper);
        // 0x90b8ec18 = Solady SafeTransferLib.TransferFailed selector. If the
        // vault regressed to raw `.transfer()` this test would incorrectly
        // pass with the distribution credit silently lost.
        vm.expectRevert(bytes4(0x90b8ec18));
        vault.executeBuyback(address(swapRouter), 2 ether, swapData, 1000e18);

        // Sanity: distribution never received the false credit either way.
        assertEq(badUru.balanceOf(distribution), 0);
    }
}
