// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404CurveFactory} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404TaxTemplate} from "src/dn404/Dn404TaxTemplate.sol";

interface IErc20 {
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

interface IDn404Skip {
    function setSkipNFT(
        bool
    ) external returns (bool);
}

interface IV10Curve {
    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256);
    function graduationTargetEth() external view returns (uint256);
}

/// @title  Dn404TaxedGraduationForkTest — records the V1 tax-template bug
/// @notice Found 2026-10-01. With the ORIGINAL Dn404TaxTemplate (V1), a taxed
///         DN404 can never graduate, in any tax mode including BurnDead:
///         the graduator -> PoolManager settle transfer is taxed (neither side
///         is exempt), the pool receives less than the graduator settled, and
///         the graduating buy reverts `CurrencyNotSettled()`. The curve then
///         stalls just under its target forever.
///
///         Fixed by Dn404TaxTemplateV2 (system exemptions for graduators,
///         hooks, keeper) — see Dn404TaxTemplateV2Fork.t.sol. These tests pin
///         the V1 impl explicitly so they keep documenting V1 after the live
///         factory moves to V2.
contract Dn404TaxedGraduationForkTest is Test {
    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;
    address internal constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    /// V1 Dn404TaxTemplate impl the live factory was deployed with (2026-09-15).
    address internal constant V1_TAX_IMPL = 0x5B7254696E82332994aa1dE54d32e08cb1aC85D6;
    bytes4 internal constant CURRENCY_NOT_SETTLED = bytes4(keccak256("CurrencyNotSettled()"));

    Dn404LaunchFactory internal lf;
    Dn404CurveFactory internal dn404Cf;
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
        }
        if (block.chainid != 4663) vm.skip(true);

        string memory j = vm.readFile("deployment-dn404.4663.json");
        lf = Dn404LaunchFactory(vm.parseJsonAddress(j, ".Dn404LaunchFactory"));
        dn404Cf = Dn404CurveFactory(vm.parseJsonAddress(j, ".Dn404CurveFactory"));
        buyer = makeAddr("taxed-grad-buyer");

        // Pin V1 regardless of what the live factory points at.
        vm.prank(DEPLOYER);
        lf.setBaseTaxImpl(V1_TAX_IMPL, keccak256(V1_TAX_IMPL.code));
    }

    function _launch(
        string memory name,
        address pair,
        uint8 mode
    ) internal returns (address base, address curve) {
        uint256 fee = lf.minUruFeeFor(DEPLOYER);
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = name;
        p.ticker = "TAX";
        p.baseURI = "ipfs://tax/";
        p.contractURI = "ipfs://tax/collection.json";
        p.collectionSize = 8000;
        p.unit = 100_000;
        p.pairCurrency = pair;
        p.taxMode = mode;
        p.taxBps = 100;
        p.uruAmount = fee;
        vm.startPrank(DEPLOYER);
        IErc20(URU).approve(address(lf), fee);
        (base,, curve) = lf.launch(p);
        vm.stopPrank();
    }

    function test_V1_Taxed_EthPair_BurnDead_RevertsAtGraduation() public {
        (address base, address curve) = _launch("V1 Taxed ETH", address(0), uint8(Dn404TaxTemplate.TaxMode.BurnDead));
        IV10Curve c = IV10Curve(curve);
        uint256 target = c.graduationTargetEth();
        vm.deal(buyer, target * 2);
        vm.startPrank(buyer);
        IDn404Skip(base).setSkipNFT(true);
        vm.expectRevert(CURRENCY_NOT_SETTLED);
        c.buy{value: (target * 125) / 100}(0);
        vm.stopPrank();
    }

    function test_V1_Taxed_UruPair_BuybackUru_RevertsAtGraduation() public {
        uint256 supply = dn404Cf.defaultCurveSupply();
        uint256 virtTok = dn404Cf.defaultVirtualTokenReserve();
        uint16 feeBps = dn404Cf.defaultTradeFeeBps();
        vm.prank(DEPLOYER);
        dn404Cf.setDefaults(supply, virtTok, 5000e18, 4000e18, feeBps);

        (address base, address curve) = _launch("V1 Taxed URU", URU, uint8(Dn404TaxTemplate.TaxMode.BuybackURU));
        Dn404BondingCurve c = Dn404BondingCurve(curve);
        uint256 amt = (c.graduationTargetEth() * 125) / 100;
        vm.prank(DEPLOYER);
        IErc20(URU).transfer(buyer, amt);
        vm.startPrank(buyer);
        IDn404Skip(base).setSkipNFT(true);
        IErc20(URU).approve(curve, amt);
        vm.expectRevert(CURRENCY_NOT_SETTLED);
        c.buy(amt, 0);
        vm.stopPrank();
    }
}
