// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {RouterV2} from "src/router/RouterV2.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType} from "src/types/VMTypes.sol";

interface IFactoryOwned {
    function owner() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function router() external view returns (address);
}

interface ICurveFactoryOwned {
    function owner() external view returns (address);
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
    function trustedRouters(
        address
    ) external view returns (bool);
}

/// @notice Fork test that runs the RH URU-pay deploy pipeline end-to-end against the
///         REAL deployed Robinhood chain state. Proves the deploy sequence
///           Flywheel → ConfigureFlywheel → DeployRouterV2 → factory rewires
///         actually wires up cleanly before we spend real RH gas.
///
///         What this test does NOT cover (tracked as separate tests):
///           - MultiHookHost redeploy via MigrateToV2Hook (CREATE2-hook mining)
///           - URU pay E2E (approve → launchWithURU → sink pull)
///           - Post-graduation swap fee flow into FeeSplitter
///
///         Skips cleanly if ROBINHOOD_RPC_URL isn't set, if Phase1 code isn't present at
///         the expected addresses, or if the current fork isn't chain 4663.
contract RhDeployPipelineForkTest is Test {
    // Robinhood chain id.
    uint256 internal constant RH_CHAIN_ID = 4663;

    // Phase1 addresses on RH — mirrored from web/src/lib/config.ts CONTRACTS.robinhood.
    // If Phase1 is re-broadcast on RH these must be updated (or read from the JSON book).
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant OLD_ROUTER = 0x50200Eda4693f4b839d8c436D42568B5e92EADE3;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant CURVE_FACTORY = 0xFF0b02818B0d39Bd43019b2ceb2d952C29dD851c;

    // Ecosystem addresses on RH (URU + urufu gemu nft) — from post-migration deploy.
    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

    // Uniswap UniversalRouter on RH (used as buyback swap target).
    address internal constant UNI_UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    // Deployed by the pipeline in setUp.
    FeeSplitter internal splitter;
    LoyaltyOracle internal oracle;
    NftRevenueVault internal nftVault;
    UruBuybackVault internal buybackVault;
    UruDepositSink internal uruSink;
    RouterV2 internal routerV2;

    function setUp() public {
        // Fork RH. Skip cleanly if RPC isn't configured — this keeps CI green when the env
        // isn't set instead of tripping "test failed" on machines that don't have RPC creds.
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) {
            // Fall back to the public endpoint — free, no key needed.
            rpc = "https://rpc.mainnet.chain.robinhood.com";
        }
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);

        // Bail if Phase1 isn't actually deployed on the forked chain.
        if (
            NAME_REGISTRY.code.length == 0 || OLD_ROUTER.code.length == 0 || ERC20_FACTORY.code.length == 0
                || CURVE_FACTORY.code.length == 0
        ) vm.skip(true);

        _runFlywheelDeploy();
        _runConfigureFlywheel();
        _runDeployRouterV2();
    }

    // -----------------------------------------------------------
    // Pipeline: mirror of DeployFlywheel.s.sol
    // -----------------------------------------------------------
    function _runFlywheelDeploy() internal {
        uint256 threshold = 100_000e18;
        uint256 configDelay = 2 days;

        vm.startPrank(admin);
        splitter = new FeeSplitter(admin, treasury, configDelay);
        oracle = new LoyaltyOracle(admin, URU_TOKEN, GEMU_NFT, threshold);
        nftVault = new NftRevenueVault(admin);
        buybackVault = new UruBuybackVault(admin, URU_TOKEN, address(nftVault), 2 days);
        vm.stopPrank();
    }

    // -----------------------------------------------------------
    // Pipeline: mirror of ConfigureFlywheel.s.sol (allowlists + split)
    // -----------------------------------------------------------
    function _runConfigureFlywheel() internal {
        vm.startPrank(admin);
        buybackVault.setKeeper(keeper, true);
        buybackVault.setSwapTarget(UNI_UR, true);

        // Warp past the FeeSplitter timelock so setConfig lands in one shot.
        vm.warp(block.timestamp + splitter.minConfigDelay() + 1);
        splitter.setConfig(address(buybackVault), address(nftVault), treasury, 4000, 3500, 2500);
        vm.stopPrank();
    }

    // -----------------------------------------------------------
    // Pipeline: mirror of DeployRouterV2.s.sol (sink + RouterV2 + factory rewire)
    // -----------------------------------------------------------
    function _runDeployRouterV2() internal {
        vm.startPrank(admin);
        uruSink = new UruDepositSink(admin, URU_TOKEN, address(splitter), 2 days);

        // Mirror the pre-existing Router fees so quotes stay consistent.
        Router old = Router(payable(OLD_ROUTER));

        routerV2 = new RouterV2(
            admin,
            NameRegistry(NAME_REGISTRY),
            IFeeReceiver(address(splitter)),
            old.fees(BaseType.ERC20),
            old.fees(BaseType.ERC721A),
            old.fees(BaseType.ERC1155),
            old.moduleAddOnFee(),
            old.hookAddOnFee(),
            old.governanceAddOnFee(),
            URU_TOKEN,
            uruSink
        );

        routerV2.setFactory(BaseType.ERC20, ERC20_FACTORY);
        routerV2.setFactory(BaseType.ERC721A, ERC721A_FACTORY);
        routerV2.setFactory(BaseType.ERC1155, ERC1155_FACTORY);
        routerV2.setCurveFactory(CURVE_FACTORY);
        routerV2.setLoyaltyOracle(address(oracle));
        vm.stopPrank();

        // Authorize RouterV2 on each factory by pranking as the current factory owner.
        // On mainnet this will be a multisig; the script warns + skips in that case, but
        // the fork test just impersonates so the wiring assertions still run.
        _authorizeOnFactory(ERC20_FACTORY, address(routerV2));
        _authorizeOnFactory(ERC721A_FACTORY, address(routerV2));
        _authorizeOnFactory(ERC1155_FACTORY, address(routerV2));

        address cfOwner = ICurveFactoryOwned(CURVE_FACTORY).owner();
        vm.prank(cfOwner);
        ICurveFactoryOwned(CURVE_FACTORY).setTrustedRouter(address(routerV2), true);
    }

    function _authorizeOnFactory(
        address factory,
        address newRouter
    ) internal {
        address own = IFactoryOwned(factory).owner();
        vm.prank(own);
        IFactoryOwned(factory).setRouter(newRouter);
    }

    // =========================================================
    // Assertions
    // =========================================================

    function test_Flywheel_ContractsExistAndOwned() public view {
        assertGt(address(splitter).code.length, 0, "FeeSplitter not deployed");
        assertGt(address(oracle).code.length, 0, "LoyaltyOracle not deployed");
        assertGt(address(nftVault).code.length, 0, "NftRevenueVault not deployed");
        assertGt(address(buybackVault).code.length, 0, "UruBuybackVault not deployed");
        assertEq(splitter.owner(), admin);
        assertEq(oracle.owner(), admin);
        assertEq(nftVault.owner(), admin);
        assertEq(buybackVault.owner(), admin);
    }

    function test_Flywheel_SplitConfigured() public view {
        assertEq(splitter.uruBuybackSink(), address(buybackVault), "buyback sink");
        assertEq(splitter.nftRevenueSink(), address(nftVault), "nft sink");
        assertEq(splitter.treasurySink(), treasury, "treasury sink");
        assertEq(splitter.uruBuybackBps(), 4000, "buyback bps");
        assertEq(splitter.nftRevenueBps(), 3500, "nft bps");
        assertEq(splitter.treasuryBps(), 2500, "treasury bps");
    }

    function test_Flywheel_BuybackVaultAllowlistsSet() public view {
        assertTrue(buybackVault.isKeeper(keeper), "keeper not allowlisted");
        assertTrue(buybackVault.isSwapTarget(UNI_UR), "UR not allowlisted");
    }

    function test_RouterV2_ImmutablesAndFees() public view {
        assertEq(address(routerV2.feeReceiver()), address(splitter), "feeReceiver should be FeeSplitter");
        assertEq(address(routerV2.uru()), URU_TOKEN, "URU addr");
        assertEq(address(routerV2.uruSink()), address(uruSink), "sink addr");
        // Fees mirrored from old Router.
        Router old = Router(payable(OLD_ROUTER));
        assertEq(routerV2.fees(BaseType.ERC20), old.fees(BaseType.ERC20));
        assertEq(routerV2.fees(BaseType.ERC721A), old.fees(BaseType.ERC721A));
        assertEq(routerV2.fees(BaseType.ERC1155), old.fees(BaseType.ERC1155));
    }

    function test_RouterV2_FactoryPointersWired() public view {
        assertEq(routerV2.factories(BaseType.ERC20), ERC20_FACTORY);
        assertEq(routerV2.factories(BaseType.ERC721A), ERC721A_FACTORY);
        assertEq(routerV2.factories(BaseType.ERC1155), ERC1155_FACTORY);
        assertEq(routerV2.curveFactory(), CURVE_FACTORY);
        assertEq(routerV2.loyaltyOracle(), address(oracle));
    }

    function test_Factories_AuthorizeRouterV2() public view {
        assertEq(IFactoryOwned(ERC20_FACTORY).router(), address(routerV2), "ERC20Factory.router");
        assertEq(IFactoryOwned(ERC721A_FACTORY).router(), address(routerV2), "ERC721AFactory.router");
        assertEq(IFactoryOwned(ERC1155_FACTORY).router(), address(routerV2), "ERC1155Factory.router");
        assertTrue(ICurveFactoryOwned(CURVE_FACTORY).trustedRouters(address(routerV2)), "CurveFactory.trustedRouters");
    }

    function test_UruSink_WiredToSplitter() public view {
        assertEq(uruSink.distributionSink(), address(splitter), "sink -> splitter");
        assertEq(address(uruSink.uru()), URU_TOKEN);
        assertEq(uruSink.owner(), admin);
    }
}
