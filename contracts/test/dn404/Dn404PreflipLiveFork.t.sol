// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404TaxTemplateV2} from "src/dn404/Dn404TaxTemplateV2.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20P {
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

interface IDn404BaseP is IErc20P {
    function mirrorERC721() external view returns (address);
    function setSkipNFT(
        bool
    ) external returns (bool);
}

interface IV10CurveP {
    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256);
    function sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) external returns (uint256);
    function graduated() external view returns (bool);
    function graduationTargetEth() external view returns (uint256);
}

/// @title  Dn404PreflipLiveForkTest
/// @notice Pre-flip check (2026-10-02) of the DN404 lane exactly as a real
///         user would hit it on the LIVE stack: a fresh launcher (not the
///         deployer, not fee-exempt in any way) pays the real URU launch fee,
///         which must land at the live UruDepositSink; buyers mint and burn
///         mirror NFTs by crossing whole units; an ETH-paired launch graduates
///         onto the ERC-20 lane host and trades both ways after graduation.
///         All addresses are read from the live factory on the fork, so no
///         gitignored address book is needed (runs in CI too).
contract Dn404PreflipLiveForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant LF_ADDR = 0x3026C71eB13C599BAd0e7a687689D20F8c37A64B;
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ERC20_HOST = 0x83d6fa59BEF503112887b16277CF559fDC93E0C4;
    address internal constant V4_ROUTER = 0xDb3D1C43225faEe04551b663E5aA0969937beEa4;

    Dn404LaunchFactory internal lf;
    address internal uru;
    address internal sink;
    address internal launcher;
    address internal buyer;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
            return;
        }
        if (block.chainid != 4663 || LF_ADDR.code.length == 0) {
            vm.skip(true);
            return;
        }
        lf = Dn404LaunchFactory(LF_ADDR);
        uru = address(lf.uru());
        sink = lf.uruSink();
        launcher = makeAddr("preflip-fresh-launcher");
        buyer = makeAddr("preflip-buyer");
        // Fund the fresh launcher with real URU from the deployer (deal() can't
        // write URU's storage layout).
        vm.prank(DEPLOYER);
        IErc20P(uru).transfer(launcher, 30_000e18);
        vm.deal(launcher, 1 ether);
    }

    function _params(
        string memory name,
        address pair,
        uint8 mode,
        uint256 fee
    ) internal pure returns (Dn404LaunchFactory.LaunchParams memory p) {
        p.name = name;
        p.ticker = "PFL";
        p.baseURI = "ipfs://pfl/";
        p.contractURI = "ipfs://pfl/collection.json";
        p.collectionSize = 8000; // within the web's 10,000 cap
        p.unit = 100_000; // 800M supply
        p.pairCurrency = pair;
        p.taxMode = mode;
        p.taxBps = mode == 0 ? 0 : 100;
        p.uruAmount = fee;
    }

    function _launch(
        Dn404LaunchFactory.LaunchParams memory p
    ) internal returns (address base, address curve) {
        uint256 sinkBefore = IErc20P(uru).balanceOf(sink);
        uint256 fee = p.uruAmount;
        vm.startPrank(launcher);
        IErc20P(uru).approve(LF_ADDR, fee);
        (base,, curve) = lf.launch(p);
        vm.stopPrank();
        assertEq(IErc20P(uru).balanceOf(sink) - sinkBefore, fee, "URU launch fee did not land at the live sink");
    }

    /// Unit rule: mirror NFT count == floor(token balance / unit).
    function _assertUnitRule(
        address base,
        address who
    ) internal view {
        address mirror = IDn404BaseP(base).mirrorERC721();
        assertEq(
            IErc20P(mirror).balanceOf(who),
            IErc20P(base).balanceOf(who) / (100_000 * 1e18),
            "mirror NFT count != whole units held"
        );
    }

    function test_FreshLauncher_EthPairUntaxed_FeeMintBurnGraduateTrade() public {
        uint256 fee = lf.minUruFeeFor(launcher);
        assertGt(fee, 0, "live URU fee unexpectedly zero");
        (address base, address curve) = _launch(_params("Preflip ETH", address(0), 0, fee));

        // Small buy mints NFTs (well under the 2,000-per-tx web guard).
        IV10CurveP c = IV10CurveP(curve);
        vm.deal(buyer, 50 ether);
        vm.prank(buyer);
        c.buy{value: 0.05 ether}(0);
        uint256 nftsAfterBuy = IErc20P(IDn404BaseP(base).mirrorERC721()).balanceOf(buyer);
        assertGt(nftsAfterBuy, 0, "buy minted no NFTs");
        assertLt(nftsAfterBuy, 2000, "test buy exceeded the per-tx NFT guard");
        _assertUnitRule(base, buyer);

        // Sell half: NFTs burn by the unit rule, ETH comes back.
        uint256 half = IErc20P(base).balanceOf(buyer) / 2;
        uint256 ethBefore = buyer.balance;
        vm.startPrank(buyer);
        IErc20P(base).approve(curve, half);
        c.sell(half, 0);
        vm.stopPrank();
        assertGt(buyer.balance, ethBefore, "curve sell paid no ETH");
        assertLt(IErc20P(IDn404BaseP(base).mirrorERC721()).balanceOf(buyer), nftsAfterBuy, "sell burned no NFTs");
        _assertUnitRule(base, buyer);

        // Graduate with a whale that opts out of NFTs (the 32M gas cap).
        address whale = makeAddr("preflip-whale");
        vm.deal(whale, 100 ether);
        vm.startPrank(whale);
        IDn404BaseP(base).setSkipNFT(true);
        c.buy{value: (c.graduationTargetEth() * 125) / 100}(0);
        vm.stopPrank();
        assertTrue(c.graduated(), "ETH-paired DN404 did not graduate");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(base),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(ERC20_HOST)
        });
        (uint160 sq,,,) = IPoolManager(PM).getSlot0(key.toId());
        assertGt(sq, 0, "pool not on the ERC-20 lane host");
        assertGt(IPoolManager(PM).getLiquidity(key.toId()), 0, "pool has no liquidity");

        // Post-graduation buy + sell through the site's V4SwapRouter (untaxed).
        V4SwapRouter r = V4SwapRouter(payable(V4_ROUTER));
        uint256 tokBefore = IErc20P(base).balanceOf(buyer);
        vm.prank(buyer);
        r.swapExactETHForToken{value: 0.01 ether}(key, 0, buyer, block.timestamp + 60);
        assertGt(IErc20P(base).balanceOf(buyer), tokBefore, "post-grad buy delivered nothing");
        _assertUnitRule(base, buyer);
        uint256 sellAmt = IErc20P(base).balanceOf(buyer) / 4;
        ethBefore = buyer.balance;
        vm.startPrank(buyer);
        IErc20P(base).approve(V4_ROUTER, sellAmt);
        r.swapExactTokenForETH(key, sellAmt, 0, buyer, block.timestamp + 60);
        vm.stopPrank();
        assertGt(buyer.balance, ethBefore, "post-grad sell paid nothing");
        _assertUnitRule(base, buyer);
    }

    function test_FreshLauncher_UruPairTaxed_FeeTemplateWiringAndCurveTrade() public {
        uint256 fee = lf.minUruFeeFor(launcher);
        (address base, address curve) = _launch(_params("Preflip URU", uru, 6, fee)); // MirrorFloorSupport

        // Fresh taxed launch is a V2 clone wired to the live keeper + treasury.
        Dn404TaxTemplateV2 t = Dn404TaxTemplateV2(payable(base));
        assertEq(uint8(t.taxMode()), 6, "taxMode");
        assertEq(t.taxBps(), 100, "taxBps");
        assertEq(t.keeper(), lf.taxKeeper(), "keeper != LF.taxKeeper");
        assertEq(t.keeperTreasury(), lf.taxKeeperTreasury(), "treasury != LF.taxKeeperTreasury");

        // URU-paired curve buy/sell (curve is tax-exempt) with NFT mint/burn.
        Dn404BondingCurve c = Dn404BondingCurve(curve);
        assertEq(c.pairCurrency(), uru, "curve pair != URU");
        vm.prank(DEPLOYER);
        IErc20P(uru).transfer(buyer, 2000e18);
        vm.startPrank(buyer);
        IErc20P(uru).approve(curve, 1000e18);
        c.buy(1000e18, 0);
        vm.stopPrank();
        assertGt(IErc20P(IDn404BaseP(base).mirrorERC721()).balanceOf(buyer), 0, "URU buy minted no NFTs");
        _assertUnitRule(base, buyer);

        // Wallet-to-wallet transfer is taxed and accumulates for the keeper.
        address friend = makeAddr("preflip-friend");
        uint256 accBefore = t.accumulatedTax();
        uint256 amt = IErc20P(base).balanceOf(buyer) / 2;
        vm.prank(buyer);
        IErc20P(base).transfer(friend, amt);
        assertEq(t.accumulatedTax() - accBefore, (amt * 100) / 10_000, "1% tax not accumulated");
        _assertUnitRule(base, buyer);
        _assertUnitRule(base, friend);
    }
}
