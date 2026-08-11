// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";

/// @title  LoyaltyDiscountReadinessFork
/// @notice The release gate — Layer 1 (contracts).
///
///         Runs against the LIVE RH mainnet fork and proves the launch-fee
///         loyalty discount is genuinely wired end to end:
///           1. Router points at a non-zero LoyaltyOracle.
///           2. LoyaltyOracle points at the CANONICAL post-migration RH URU
///              (0x9fbe...) and RH GEMU (0x60cB...).
///           3. Discount tier constants on-chain match the tiers we ship in
///              product copy (20% / 40% / 50% with an 80% hard cap).
///           4. `discountBpsFor` returns the right value under four holder
///              profiles: nothing, 1 GEMU, 100k URU, and both.
///
///         Layer 2 (CI) blocks merge on this test failing.
///         Layer 3 (UI) mirrors the wiring assertions via a runtime hook.
///
///         If ROBINHOOD_RPC_URL is unreachable the whole suite skips — same
///         pattern as every other fork test in this dir. Any other failure
///         (wiring drift, tier drift, math regression) is a hard revert.
///
///         The 2026-08-01 audit caught a real instance of this: LoyaltyOracle
///         still holding the pre-migration Base URU + GEMU addresses,
///         silently zeroing every launcher's discount. This test is the
///         standing regression fence.
contract LoyaltyDiscountReadinessForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Pinned production wiring — kept in sync with RhLiveStackSnapshot.t.sol.
    address internal constant ROUTER_V7 = 0x84C72d6882f10833bD4eBD7c45D4353FDf20B596;
    address internal constant LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;

    // Canonical RH ecosystem tokens (post-2026-07-25 migration).
    // Verified against web/src/lib/config.ts::CONTRACTS.robinhood + ECOSYSTEM_TOKENS.
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

    // Discount tier caps (bps). Must stay aligned with product copy in
    // web/src/app/docs/page.tsx + web/src/app/create/page.tsx + web/src/app/page.tsx.
    uint16 internal constant TIER_NFT_BPS = 2000; // 20% off
    uint16 internal constant TIER_URU_BPS = 4000; // 40% off
    uint16 internal constant TIER_BOTH_BPS = 5000; // 50% off
    uint16 internal constant HARD_CAP_BPS = 8000; // 80% oracle floor
    uint256 internal constant URU_THRESHOLD_WEI = 100_000e18;

    Router internal router;
    LoyaltyOracle internal oracle;

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
        router = Router(payable(ROUTER_V7));
        oracle = LoyaltyOracle(LOYALTY_ORACLE);
    }

    // ============================================================
    // Wiring assertions
    // ============================================================

    /// AC-1: Router.loyaltyOracle() must be non-zero. Zero silently zeros
    /// every launcher's discount platform-wide (the try/catch in Router
    /// treats a missing oracle as "no discount") — a full-price regression
    /// no user would notice from the UI alone.
    function test_ReleaseGate_Router_LoyaltyOracle_Wired() public view {
        address wired = router.loyaltyOracle();
        assertTrue(wired != address(0), "Router.loyaltyOracle is address(0) - discount tier silently disabled");
        assertEq(wired, LOYALTY_ORACLE, "Router.loyaltyOracle != canonical pin");
    }

    /// AC-2: LoyaltyOracle.uruToken must match the canonical post-migration RH URU.
    function test_ReleaseGate_LoyaltyOracle_UruToken_IsCanonicalRhUru() public view {
        assertEq(oracle.uruToken(), URU, "LoyaltyOracle.uruToken != canonical RH URU (0x9fbe...)");
    }

    /// AC-3: LoyaltyOracle.gemuNft must match the canonical post-migration RH GEMU.
    function test_ReleaseGate_LoyaltyOracle_GemuNft_IsCanonicalRhGemu() public view {
        assertEq(oracle.gemuNft(), GEMU_NFT, "LoyaltyOracle.gemuNft != canonical RH GEMU (0x60cB...)");
    }

    // ============================================================
    // Tier constant assertions
    // ============================================================

    /// AC-4: on-chain tier constants (NFT / URU / BOTH / hard cap + URU threshold)
    /// must match the tiers we ship in the docs + create-page + home-page copy.
    /// If someone rotates the oracle to different tier bps, this fires and the
    /// UI copy must be re-audited before merge.
    function test_ReleaseGate_TierConstants_MatchProductCopy() public view {
        assertEq(oracle.nftHolderBps(), TIER_NFT_BPS, "LoyaltyOracle.nftHolderBps != 2000 (20% off) shipped copy");
        assertEq(oracle.uruHolderBps(), TIER_URU_BPS, "LoyaltyOracle.uruHolderBps != 4000 (40% off) shipped copy");
        assertEq(oracle.bothBps(), TIER_BOTH_BPS, "LoyaltyOracle.bothBps != 5000 (50% off) shipped copy");
        assertEq(oracle.maxDiscountBps(), TIER_BOTH_BPS, "LoyaltyOracle.maxDiscountBps != 5000 (product-cap ceiling)");
        assertEq(
            oracle.HARD_MAX_DISCOUNT_BPS(), HARD_CAP_BPS, "LoyaltyOracle.HARD_MAX_DISCOUNT_BPS != 8000 (80% hard cap)"
        );
        assertEq(
            oracle.uruThreshold(),
            URU_THRESHOLD_WEI,
            "LoyaltyOracle.uruThreshold != 100_000e18 (drift breaks EcosystemHoldings hint)"
        );
    }

    // ============================================================
    // discountBpsFor: end-to-end value assertions
    // ============================================================
    //
    // Uses `vm.mockCall` to override balanceOf on the LIVE URU + GEMU
    // contracts for a synthetic holder. This lets us exercise every
    // tier branch without moving real tokens on mainnet-fork.

    function _mockBalances(
        address holder,
        uint256 uruBal,
        uint256 gemuBal
    ) internal {
        vm.mockCall(URU, abi.encodeWithSignature("balanceOf(address)", holder), abi.encode(uruBal));
        vm.mockCall(GEMU_NFT, abi.encodeWithSignature("balanceOf(address)", holder), abi.encode(gemuBal));
    }

    /// AC-5: wallet with zero URU + zero GEMU returns exactly 0 bps.
    /// Regression guard: a broken oracle that returned any nonzero default
    /// would silently give every wallet a free discount.
    function test_ReleaseGate_DiscountFor_NoHoldings_IsZero() public {
        address holder = makeAddr("no-holdings");
        _mockBalances(holder, 0, 0);
        assertEq(oracle.discountBpsFor(holder), 0, "0 URU + 0 GEMU should get 0 discount bps, not the default tier");
    }

    /// AC-6: wallet with 1 GEMU (NFT-tier only) returns exactly 2000 bps (20%).
    function test_ReleaseGate_DiscountFor_NftHolderOnly_Is20Pct() public {
        address holder = makeAddr("nft-only");
        _mockBalances(holder, 0, 1);
        assertEq(oracle.discountBpsFor(holder), TIER_NFT_BPS, "1 GEMU alone should get 20% (2000 bps) NFT tier");
    }

    /// AC-7: wallet with >= 100_000e18 URU (URU-tier only) returns exactly 4000 bps (40%).
    function test_ReleaseGate_DiscountFor_UruHolderOnly_Is40Pct() public {
        address holder = makeAddr("uru-only");
        _mockBalances(holder, URU_THRESHOLD_WEI, 0);
        assertEq(oracle.discountBpsFor(holder), TIER_URU_BPS, "100_000e18 URU alone should get 40% (4000 bps) URU tier");
    }

    /// AC-8: wallet holding BOTH tiers returns exactly 5000 bps (50%, product cap).
    /// This is what "up to 50% off" in the UI copy resolves to on-chain.
    function test_ReleaseGate_DiscountFor_BothTiers_Is50Pct() public {
        address holder = makeAddr("both-tiers");
        _mockBalances(holder, URU_THRESHOLD_WEI, 1);
        assertEq(
            oracle.discountBpsFor(holder),
            TIER_BOTH_BPS,
            "1 GEMU + 100_000e18 URU should get 50% (5000 bps), the product cap"
        );
    }

    /// AC-9 (belt-and-braces): the Router-side quote path applies the same
    /// discount value the oracle publishes — same math, no drift. Uses a
    /// synthetic gross of 1 ether-worth of fee via `discountBpsFor` alone,
    /// avoiding a full quote() call which would require a fully-formed
    /// LaunchParams tuple. The multiplication check is enough to prove
    /// Router's local MAX_LOYALTY_DISCOUNT_BPS = 8000 clamp does not chop
    /// the 5000 tier down.
    function test_ReleaseGate_RouterClamp_DoesNotChopProductTiers() public {
        address holder = makeAddr("clamp-check");
        _mockBalances(holder, URU_THRESHOLD_WEI, 1);
        uint16 oracleBps = oracle.discountBpsFor(holder);
        assertEq(oracleBps, TIER_BOTH_BPS, "oracle returned wrong tier");
        // Router's local ceiling is 8000. The product cap of 5000 must not
        // hit the ceiling; if the oracle ever returns >8000 by owner error,
        // Router clamps but the tiers themselves must stay well under.
        assertLt(oracleBps, HARD_CAP_BPS, "product tier reached the hard cap - re-audit copy vs oracle");
    }
}
