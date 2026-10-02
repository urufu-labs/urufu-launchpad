// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory} from "src/nft/NftLaunchFactory.sol";

interface IErc20Live {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

/// @title  NftLiveFactoryForkTest — pre-flip check of the DEPLOYED NFT lane.
/// @notice NftStackRhFork deploys a fresh factory in-test; this suite instead
///         drives the LIVE NftLaunchFactory (and therefore its live V5 impls,
///         fee splitter, URU sink, loyalty oracle) exactly as the web will once
///         NFT_LAUNCHES_ENABLED flips. Fresh wallets only; URU is funded by
///         transferring from the deployer on the fork (deal() can't write URU).
///         Skips cleanly without a reachable RH RPC or without the deployer's URU.
contract NftLiveFactoryForkTest is Test {
    NftLaunchFactory internal constant LF = NftLaunchFactory(0x6B90670a3Af0EBc0D12e006Fe25C07160e3F9486);
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    address internal launcher = makeAddr("live-nft-launcher");
    address internal buyer = makeAddr("live-nft-buyer");
    address internal buyer2 = makeAddr("live-nft-buyer2");
    address internal outsider = makeAddr("live-nft-outsider");

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != 4663 || address(LF).code.length == 0) {
            vm.skip(true);
            return;
        }
        if (IErc20Live(URU).balanceOf(DEPLOYER) < 50_000e18) {
            vm.skip(true);
            return;
        }
        vm.startPrank(DEPLOYER);
        IErc20Live(URU).transfer(launcher, 20_000e18);
        IErc20Live(URU).transfer(buyer, 10_000e18);
        vm.stopPrank();
        vm.deal(launcher, 1 ether);
        vm.deal(buyer, 1 ether);
        vm.deal(buyer2, 1 ether);
        vm.deal(outsider, 1 ether);
    }

    function _params(
        string memory name,
        bool payWithUru,
        NftMintModule.MintMode mode,
        uint256 base,
        uint256 step,
        uint256 maxSupply,
        uint256 perWalletCap
    ) internal pure returns (NftLaunchFactory.LaunchParams memory p) {
        p.name = name;
        p.ticker = "LIVE";
        p.baseURI = "ipfs://live-check/";
        p.maxSupply = maxSupply;
        p.mintMode = mode;
        p.basePriceWei = base;
        p.priceStepWei = step;
        p.discountFloorBps = 1000;
        p.perWalletMintCap = perWalletCap;
        p.payWithUru = payWithUru;
        p.tiers = new NftMintModule.DiscountTier[](0);
        p.wlFlavor = NftWhitelistModule.Flavor.Off;
    }

    function _launch(
        NftLaunchFactory.LaunchParams memory p
    ) internal returns (address token, address module, address wl) {
        uint256 fee = LF.minUruFeeFor(launcher);
        p.uruAmount = fee;
        vm.startPrank(launcher);
        if (fee > 0) IErc20Live(URU).approve(address(LF), fee);
        (token, module, wl) = LF.launch(p);
        vm.stopPrank();
    }

    function _empty() internal pure returns (bytes32[] memory a, NftMintModule.TierProof[] memory t) {
        a = new bytes32[](0);
        t = new NftMintModule.TierProof[](0);
    }

    /// ETH, fixed price: launch fee in URU, two-role ownership, metadata URLs,
    /// 10% to the live fee splitter, per-wallet cap, max supply, withdraw.
    function test_LiveFactory_EthFixed_EndToEnd() public {
        uint256 launcherUru0 = IErc20Live(URU).balanceOf(launcher);
        (address token, address module,) =
            _launch(_params("Live Check ETH", false, NftMintModule.MintMode.Fixed, 0.01 ether, 0, 5, 2));
        assertGt(token.code.length, 0, "collection not deployed");
        assertEq(launcherUru0 - IErc20Live(URU).balanceOf(launcher), LF.minUruFeeFor(launcher), "launch fee");

        ERC721ATemplate nft = ERC721ATemplate(token);
        assertEq(nft.owner(), launcher, "owner != launcher (two-role model)");
        assertEq(nft.minter(), module, "minter != mint module");

        NftMintModule m = NftMintModule(module);
        (bytes32[] memory np, NftMintModule.TierProof[] memory nt) = _empty();
        address splitter = LF.feeSplitter();
        (bool okA, bytes memory a) = splitter.staticcall(abi.encodeWithSignature("uruBuybackSink()"));
        (bool okB, bytes memory b) = splitter.staticcall(abi.encodeWithSignature("nftRevenueSink()"));
        (bool okC, bytes memory c) = splitter.staticcall(abi.encodeWithSignature("treasurySink()"));
        require(okA && okB && okC, "splitter sink reads");
        address s1 = abi.decode(a, (address));
        address s2 = abi.decode(b, (address));
        address s3 = abi.decode(c, (address));
        uint256 before = splitter.balance + s1.balance + s2.balance + s3.balance;

        uint256 price2 = m.netPriceFor(2, 0);
        vm.prank(buyer);
        m.mint{value: price2}(2, np, 0, 0, "", nt);
        assertEq(nft.balanceOf(buyer), 2, "buyer did not get 2");
        assertEq(nft.tokenURI(1), "ipfs://live-check/1.json", "tokenURI shape");

        // The live splitter forwards in-tx; the 10% platform slice must land
        // across the splitter and its three sinks combined.
        uint256 afterBal = splitter.balance + s1.balance + s2.balance + s3.balance;
        assertEq(afterBal - before, (price2 * 1000) / 10_000, "10% did not reach the flywheel");

        // Per-wallet cap 2: a third mint by the same wallet reverts.
        uint256 price1 = m.netPriceFor(1, 0);
        vm.prank(buyer);
        vm.expectRevert();
        m.mint{value: price1}(1, np, 0, 0, "", nt);

        // Max supply 5: buyer2 takes 2 (cap), outsider takes 1 -> 5; next reverts.
        vm.prank(buyer2);
        m.mint{value: price2}(2, np, 0, 0, "", nt);
        vm.prank(outsider);
        m.mint{value: price1}(1, np, 0, 0, "", nt);
        assertEq(nft.totalSupply(), 5, "supply");
        address late = makeAddr("live-nft-late");
        vm.deal(late, 1 ether);
        vm.prank(late);
        vm.expectRevert();
        m.mint{value: price1}(1, np, 0, 0, "", nt);

        // Launcher withdraws the 90% share of 5 x 0.01 ETH.
        uint256 l0 = launcher.balance;
        vm.prank(launcher);
        uint256 got = m.withdraw();
        assertEq(launcher.balance - l0, got, "withdraw amount mismatch");
        assertEq(got, (5 * 0.01 ether * 9000) / 10_000, "launcher should get 90%");
    }

    /// URU, linear step: 10% to the live UruDepositSink, launcher withdrawUru,
    /// and overpay tolerance (>= net) from the round-2 DoS fix.
    function test_LiveFactory_UruLinear_EndToEnd() public {
        (address token, address module,) =
            _launch(_params("Live Check URU", true, NftMintModule.MintMode.LinearStep, 100e18, 10e18, 20, 0));
        NftMintModule m = NftMintModule(module);
        (bytes32[] memory np, NftMintModule.TierProof[] memory nt) = _empty();
        address sink = LF.uruSink();
        uint256 sink0 = IErc20Live(URU).balanceOf(sink);

        uint256 net = m.netPriceFor(3, 0);
        assertEq(net, 100e18 + 110e18 + 120e18, "linear step pricing");
        vm.startPrank(buyer);
        IErc20Live(URU).approve(module, net + 50e18);
        m.mintWithUru(3, net + 50e18, np, 0, 0, "", nt); // over-approve: must pull only net
        vm.stopPrank();
        assertEq(ERC721ATemplate(token).balanceOf(buyer), 3, "buyer did not get 3");
        assertEq(IErc20Live(URU).balanceOf(sink) - sink0, (net * 1000) / 10_000, "10% to URU sink");

        uint256 l0 = IErc20Live(URU).balanceOf(launcher);
        vm.prank(launcher);
        uint256 got = m.withdrawUru();
        assertEq(IErc20Live(URU).balanceOf(launcher) - l0, got, "withdrawUru mismatch");
        assertEq(got, net - (net * 1000) / 10_000, "launcher should get 90%");
    }

    /// Wallet-list whitelist window: listed wallet mints, unlisted reverts
    /// during the window.
    function test_LiveFactory_WalletListWindow() public {
        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(buyer))));
        bytes32 leafB = keccak256(bytes.concat(keccak256(abi.encode(buyer2))));
        (bytes32 lo, bytes32 hi) = leafA < leafB ? (leafA, leafB) : (leafB, leafA);
        bytes32 root = keccak256(abi.encodePacked(lo, hi));
        NftLaunchFactory.LaunchParams memory p =
            _params("Live Check WL", false, NftMintModule.MintMode.Fixed, 0.01 ether, 0, 10, 0);
        p.wlFlavor = NftWhitelistModule.Flavor.WalletList;
        p.wlWalletListRoot = root;
        p.wlWindowEnd = block.timestamp + 1 hours;
        (, address module,) = _launch(p);
        NftMintModule m = NftMintModule(module);
        (, NftMintModule.TierProof[] memory nt) = _empty();
        uint256 price = m.netPriceFor(1, 0);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        vm.prank(buyer);
        m.mint{value: price}(1, proofA, 0, 0, "", nt);

        bytes32[] memory none = new bytes32[](0);
        vm.prank(outsider);
        vm.expectRevert();
        m.mint{value: price}(1, none, 0, 0, "", nt);
    }
}
