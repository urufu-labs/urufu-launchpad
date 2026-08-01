// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

interface ILegacyCurve {
    function graduated() external view returns (bool);
    function ethReserve() external view returns (uint256);
    function tokenReserve() external view returns (uint256);
    function virtualEthReserve() external view returns (uint256);
    function virtualTokenReserve() external view returns (uint256);
    function tradeFeeBps() external view returns (uint16);
    function graduationTargetEth() external view returns (uint256);
    function sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) external returns (uint256 ethOut);
}

/// @title  OrphanRecoveryFork
/// @notice Proves the recovery UI's on-chain flow works for real orphaned
///         curves — the mid-bonding, non-graduated curves whose CFs are no
///         longer wired to the launchpad frontend. Users still have their
///         tokens; ETH is still in the curve; sell() still works.
///
///         Each test picks a REAL holder from mainnet history and impersonates
///         them via vm.prank, approves the curve, and calls sell. Passing
///         means: any holder of this token can execute the exact same 2 txs
///         from their own wallet and get ETH back.
///
///         Sweep of orphans as of 2026-07-31 (block 24245385):
///           - iloveuru (WOWURU)  0.33 ETH  curve 0xef68...  cf 0x4631
///           - URUFU (URAFU)      1.30 ETH  curve 0x522c...  cf 0xFfda
///           - spoobs (SPOOBS)    0.61 ETH  curve 0x0849...  cf 0xFfda
///           - TEST (URUFU)       0.23 ETH  curve 0xcba3...  cf 0xFfda
contract OrphanRecoveryForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
    }

    // Real URUFU holder from mainnet Transfer logs — this address bought URUFU
    // through the curve multiple times. Impersonated to prove the recovery
    // flow works end to end.
    address internal constant URUFU_HOLDER = 0xff242ed10308a95d644b061fE027419e2c7F6391;
    address internal constant URUFU_TOKEN = 0x193EA86260519589cF67ED9E45fCCC5509d11842;
    address internal constant URUFU_CURVE = 0x522c5B368E5cc8149dBEfd2Da99284A601Ab8505;

    function test_Orphan_URUFU_HolderCanSellForETH() public {
        IERC20V token = IERC20V(URUFU_TOKEN);
        ILegacyCurve curve = ILegacyCurve(URUFU_CURVE);

        uint256 holderBal = token.balanceOf(URUFU_HOLDER);
        console2.log("holder token balance:", holderBal);
        console2.log("holder token name   :", token.name());
        console2.log("holder token symbol :", token.symbol());
        // Fork test assumes a specific historical URUFU holder still holds
        // tokens. If the holder rebalanced on live between when this test
        // was written and now, skip cleanly rather than fail loud — this
        // test's job is to exercise the sell path IF a real holder exists,
        // not to gate the suite on some third party's wallet composition.
        if (holderBal == 0) {
            vm.skip(true);
            return;
        }

        assertFalse(curve.graduated(), "curve already graduated");
        uint256 curveEthBefore = URUFU_CURVE.balance;
        uint256 curveTokenBefore = curve.tokenReserve();
        console2.log("curve ETH before    :", curveEthBefore);
        console2.log("curve token reserve :", curveTokenBefore);
        assertGt(curveEthBefore, 0, "curve has no ETH to recover");

        // Sell half the holder's balance so we don't crush the pool but do
        // meaningfully drain it.
        uint256 tokensToSell = holderBal / 2;
        assertGt(tokensToSell, 0, "half of balance == 0");

        uint256 holderEthBefore = URUFU_HOLDER.balance;

        // Approve + sell — the EXACT two txs a real user would send.
        vm.startPrank(URUFU_HOLDER);
        token.approve(URUFU_CURVE, tokensToSell);
        uint256 ethOut = curve.sell(tokensToSell, 0); // minEthOut=0 to isolate math
        vm.stopPrank();

        uint256 holderEthAfter = URUFU_HOLDER.balance;
        uint256 curveEthAfter = URUFU_CURVE.balance;

        console2.log("ethOut returned     :", ethOut);
        console2.log("holder ETH delta    :", holderEthAfter - holderEthBefore);
        console2.log("curve ETH after     :", curveEthAfter);

        assertGt(ethOut, 0, "sell returned 0 ETH");
        assertEq(holderEthAfter - holderEthBefore, ethOut, "holder ETH balance did not grow by ethOut");
        assertLt(curveEthAfter, curveEthBefore, "curve ETH did not drop");
        assertEq(token.balanceOf(URUFU_HOLDER), holderBal - tokensToSell, "tokens not consumed");
    }

    /// Sanity: all 4 known orphan curves are still non-graduated, still hold
    /// ETH, and still expose a callable sell() function. If any of these
    /// invariants breaks, the recovery UI needs to know so it can display
    /// the token as "already recovered" instead of a stuck error path.
    function test_Orphan_AllKnownCurvesStillRecoverable() public view {
        address[4] memory curves = [
            0xef68EF6927E9896ad8808f4B0E4c1d63dEF888CC, // iloveuru
            0x522c5B368E5cc8149dBEfd2Da99284A601Ab8505, // URUFU
            0x0849A5305CDCc4e32420506dE92990471a028e7a, // spoobs
            0xCBA3Ad3ACEFEA65f4cD4FBfB2b547b5C7E38A79e // TEST
        ];
        string[4] memory names = ["iloveuru", "URUFU", "spoobs", "TEST"];

        for (uint256 i = 0; i < curves.length; i++) {
            ILegacyCurve c = ILegacyCurve(curves[i]);
            assertFalse(c.graduated(), string.concat("[", names[i], "] already graduated"));
            assertGt(curves[i].balance, 0, string.concat("[", names[i], "] no ETH"));
            assertGt(c.ethReserve(), 0, string.concat("[", names[i], "] ethReserve zero"));
            console2.log(names[i], "curve ETH:", curves[i].balance);
        }
    }
}
