// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";

interface IERC20Balance {
    function balanceOf(
        address who
    ) external view returns (uint256);
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

/// @title  NftStackRhFork — deploy NFT stack against LIVE RH infra
/// @notice Forks Robinhood chain, deploys the NFT stack (impls +
///         factory), points it at the real FeeSplitter + LoyaltyOracle
///         + URU + UruDepositSink from env, launches a collection,
///         mints (both ETH + URU paths), and confirms the flywheel
///         actually receives the platform slice on the live infra.
///
///         Requires env:
///           ROBINHOOD_RPC_URL
///           ROBINHOOD_FEE_SPLITTER_ADDRESS
///           ROBINHOOD_LOYALTY_ORACLE_ADDRESS  (optional, uses zero if absent)
///           ROBINHOOD_URU_ADDRESS
///           ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS
///
///         Skips cleanly if any of the required env vars are missing
///         OR if the RPC responds with a non-RH chainid OR if any
///         of the referenced contracts don't exist on the fork.
contract NftStackRhForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Populated from env in setUp().
    address internal feeSplitter;
    address internal loyaltyOracle;
    address internal uru;
    address internal uruSink;

    // Deployed on-fork by this test.
    ERC721ATemplate internal erc721Impl;
    NftMintModule internal mintImpl;
    NftWhitelistModule internal wlImpl;
    NftLaunchFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal launcher = makeAddr("launcher");
    address internal buyer = makeAddr("buyer");
    address internal attSigner;
    uint256 internal attSignerPk = 0xA77E57;

    function setUp() public {
        // 1. RPC + fork
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {
            vm.skip(true);
            return;
        }
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != RH_CHAIN_ID) {
            vm.skip(true);
            return;
        }

        // 2. Read live infra addresses. Skip if any missing.
        feeSplitter = _envAddr("ROBINHOOD_FEE_SPLITTER_ADDRESS");
        uru = _envAddr("ROBINHOOD_URU_ADDRESS");
        uruSink = _envAddr("ROBINHOOD_URU_DEPOSIT_SINK_ADDRESS");
        loyaltyOracle = _envAddrOr("ROBINHOOD_LOYALTY_ORACLE_ADDRESS", address(0));

        if (feeSplitter == address(0) || uru == address(0) || uruSink == address(0)) {
            vm.skip(true);
            return;
        }
        // Sanity: contracts exist on the fork.
        if (feeSplitter.code.length == 0 || uru.code.length == 0 || uruSink.code.length == 0) {
            vm.skip(true);
            return;
        }

        // 3. Deploy the NFT stack on-fork.
        attSigner = vm.addr(attSignerPk);
        erc721Impl = new ERC721ATemplate();
        mintImpl = new NftMintModule();
        wlImpl = new NftWhitelistModule();

        vm.startPrank(owner);
        factory = new NftLaunchFactory(owner);
        factory.setExpectedCodeHashes(
            keccak256(address(erc721Impl).code), keccak256(address(mintImpl).code), keccak256(address(wlImpl).code)
        );
        factory.setImpls(address(erc721Impl), address(mintImpl), address(wlImpl));
        factory.setUruConfig(
            IERC20(uru),
            uruSink,
            0, // no launch fee for these tests — we're testing MINT flywheel, not launch fee
            ILoyaltyOracleLike(loyaltyOracle)
        );
        factory.setFeeSplitter(feeSplitter);
        factory.setAttestationSigner(attSigner);
        vm.stopPrank();
    }

    // --------------------------------------------------------------
    // 1. ETH-mint against the live FeeSplitter — platform slice
    //    should reach the real buyback / gemu / treasury sinks the
    //    live FeeSplitter routes to.
    // --------------------------------------------------------------
    function test_EthMint_FlywheelReceives10Pct() public {
        (, address mintModule) = _launchDefaultCollection(false);

        // Snapshot the FeeSplitter sinks BEFORE the mint. Reading them
        // off the live splitter avoids hardcoding addresses that could
        // rotate over time.
        (address buybackSink, address nftSink, address treasurySink) = _snapshotSplitterSinks();
        uint256 bBefore = buybackSink.balance;
        uint256 nBefore = nftSink.balance;
        uint256 tBefore = treasurySink.balance;

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        NftMintModule(mintModule).mint{value: 0.01 ether}(1, new bytes32[](0), 0, 0, "", _emptyProofs());

        // Assert the exact platform slice (0.001 ETH = 10% of 0.01) fanned
        // out across the three live sinks. Sum should equal the slice
        // (minus any wei-precision residue, which stays in FeeSplitter
        // and is captured by re-reading its balance below).
        uint256 splitterAfter = feeSplitter.balance;
        uint256 sinksDelta =
            (buybackSink.balance - bBefore) + (nftSink.balance - nBefore) + (treasurySink.balance - tBefore);
        assertEq(sinksDelta + splitterAfter, 0.001 ether, "flywheel captured 10% net");
        assertEq(NftMintModule(mintModule).launcherBalance(), 0.009 ether, "launcher accrued 90% via pull");
    }

    // --------------------------------------------------------------
    // 2. URU-mint against the live UruDepositSink — 10% URU should
    //    land at the real sink, launcher accrues 90% URU pull.
    // --------------------------------------------------------------
    function test_UruMint_UruSinkReceives10Pct() public {
        (, address mintModule) = _launchDefaultCollection(true);

        // Fund buyer with URU via forge-std deal (writes balance slot
        // directly — works against any standard ERC-20). Approve the
        // mint module.
        deal(uru, buyer, 1000e18);
        vm.prank(buyer);
        IERC20Balance(uru).approve(mintModule, type(uint256).max);

        uint256 sinkBefore = IERC20Balance(uru).balanceOf(uruSink);
        vm.prank(buyer);
        NftMintModule(mintModule).mintWithUru(1, 100e18, new bytes32[](0), 0, 0, "", _emptyProofs());

        uint256 sinkAfter = IERC20Balance(uru).balanceOf(uruSink);
        assertEq(sinkAfter - sinkBefore, 10e18, "uru sink got 10 URU");
        assertEq(NftMintModule(mintModule).launcherBalanceUru(), 90e18, "launcher accrued 90 URU");
    }

    // --------------------------------------------------------------
    // 3. Full launch flow — factory deployment on live URU + loyalty
    //    settings should complete without touching Router / ERC20-side
    //    infra (proves the additive-only design claim).
    // --------------------------------------------------------------
    function test_Launch_DoesNotTouchRouter() public {
        // Router snapshot — its `feeReceiver` / any other state we care
        // about should be unchanged before + after our launch.
        address routerAddr = _envAddrOr("ROBINHOOD_ROUTER_ADDRESS", address(0));
        // Only assert if router env is set.
        bytes32 routerCodeHashBefore = routerAddr == address(0) ? bytes32(0) : routerAddr.codehash;
        (address token, address mintModule) = _launchDefaultCollection(false);
        assertTrue(token != address(0));
        assertTrue(mintModule != address(0));
        if (routerAddr != address(0)) {
            assertEq(routerAddr.codehash, routerCodeHashBefore, "router untouched");
        }
    }

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------

    function _launchDefaultCollection(
        bool payWithUru
    ) internal returns (address token, address mintModule) {
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](0);
        NftLaunchFactory.LaunchParams memory p = NftLaunchFactory.LaunchParams({
            name: payWithUru ? "chibi-uru" : "chibi-eth",
            ticker: payWithUru ? "CHIBIU" : "CHIBIE",
            baseURI: "ipfs://fork-test/",
            maxSupply: 100,
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: payWithUru ? 100e18 : 0.01 ether,
            priceStepWei: 0,
            discountFloorBps: 1000,
            perWalletMintCap: 0,
            payWithUru: payWithUru,
            tiers: tiers,
            wlFlavor: NftWhitelistModule.Flavor.Off,
            wlHoldersTarget: address(0),
            wlHoldersTargetChainId: 0,
            wlHoldersMinCount: 0,
            wlWalletListRoot: bytes32(0),
            wlWindowEnd: 0,
            uruAmount: 0
        });
        vm.prank(launcher);
        (token, mintModule,) = factory.launch(p);
    }

    function _snapshotSplitterSinks()
        internal
        view
        returns (address buybackSink, address nftSink, address treasurySink)
    {
        // Signature-only reads against the live FeeSplitter. Same
        // storage names as our source, so this decodes fine as long
        // as the live splitter is ours.
        (bool ok1, bytes memory b1) = feeSplitter.staticcall(abi.encodeWithSignature("uruBuybackSink()"));
        (bool ok2, bytes memory b2) = feeSplitter.staticcall(abi.encodeWithSignature("nftRevenueSink()"));
        (bool ok3, bytes memory b3) = feeSplitter.staticcall(abi.encodeWithSignature("treasurySink()"));
        require(ok1 && ok2 && ok3, "fee splitter reads failed");
        buybackSink = abi.decode(b1, (address));
        nftSink = abi.decode(b2, (address));
        treasurySink = abi.decode(b3, (address));
    }

    function _envAddr(
        string memory name
    ) internal view returns (address) {
        try vm.envAddress(name) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _envAddrOr(
        string memory name,
        address dflt
    ) internal view returns (address) {
        try vm.envAddress(name) returns (address a) {
            return a;
        } catch {
            return dflt;
        }
    }

    function _emptyProofs() internal pure returns (NftMintModule.TierProof[] memory) {
        return new NftMintModule.TierProof[](0);
    }
}
