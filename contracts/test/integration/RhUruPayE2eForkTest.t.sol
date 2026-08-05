// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2, Vm} from "forge-std/Test.sol";

import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

interface IFactoryOwned {
    function owner() external view returns (address);
    function setRouter(
        address newRouter
    ) external;
    function implFor(
        bytes32
    ) external view returns (address);
}

interface ICurveFactoryOwned {
    function owner() external view returns (address);
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external;
}

interface IERC20Metadata {
    function balanceOf(
        address
    ) external view returns (uint256);
    function owner() external view returns (address);
}

/// @notice URU-pay end-to-end fork test. Reuses the RH deploy-pipeline setup
///         (Flywheel + Router wired to FeeSplitter), then drives an actual
///         `launchWithURU` call against real RH factories + registry and asserts:
///           1. URU pulled into UruDepositSink
///           2. Token deployed by ERC20Factory
///           3. Name reservation recorded in NameRegistry
///           4. Ownership dispatched to the launcher (KeepEOA path)
///           5. LaunchedInURU event emitted
///         Also validates the flywheel distribution end (ETH arriving at FeeSplitter
///         → 40/35/25 split lands correctly) — this stands in for the keeper's
///         URU→ETH conversion, which is a separate off-chain concern.
///
///         Skips if RH RPC unreachable, Phase1 missing, or ERC20Factory doesn't
///         have a bare-ERC20 impl registered (indicates a fresh Phase1 deploy
///         without templates).
contract RhUruPayE2eForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant OLD_ROUTER = 0x50200Eda4693f4b839d8c436D42568B5e92EADE3;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant CURVE_FACTORY = 0xFF0b02818B0d39Bd43019b2ceb2d952C29dD851c;

    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;
    address internal constant UNI_UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    /// Matches the frontend `configHashFor('ERC20', [])` — see web/src/lib/modules.ts:585.
    /// Bare-ERC20 launches use this configHash to look up the base template impl.
    bytes32 internal constant BARE_ERC20_CONFIG = keccak256(abi.encode("ERC20", ""));

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    FeeSplitter internal splitter;
    LoyaltyOracle internal oracle;
    NftRevenueVault internal nftVault;
    UruBuybackVault internal buybackVault;
    UruDepositSink internal uruSink;
    Router internal routerV2;

    /// Copied from RhDeployPipelineForkTest so this file can run independently. If
    /// this drifts, extract into a shared fixture contract.
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

        if (
            NAME_REGISTRY.code.length == 0 || OLD_ROUTER.code.length == 0 || ERC20_FACTORY.code.length == 0
                || CURVE_FACTORY.code.length == 0
        ) vm.skip(true);

        // Deploy flywheel. URU-A11: production configDelay = 2 days, but the
        // fork test uses 0 to skip the propose+wait dance for every setter —
        // the delay itself is exercised by unit + invariant tests.
        vm.startPrank(admin);
        splitter = new FeeSplitter(admin, treasury, 0);
        oracle = new LoyaltyOracle(admin, URU_TOKEN, GEMU_NFT, 100_000e18);
        nftVault = new NftRevenueVault(admin, 0);
        buybackVault = new UruBuybackVault(admin, URU_TOKEN, address(nftVault), 0);
        buybackVault.setKeeper(keeper, true);
        buybackVault.setSwapTarget(UNI_UR, true);
        splitter.setConfig(address(buybackVault), address(nftVault), treasury, 4000, 3500, 2500);

        // Deploy Router stack.
        uruSink = new UruDepositSink(admin, URU_TOKEN, address(splitter), 0);
        Router old = Router(payable(OLD_ROUTER));
        routerV2 = new Router(
            admin,
            NameRegistry(NAME_REGISTRY),
            IFeeReceiver(address(splitter)),
            old.fees(BaseType.ERC20),
            old.fees(BaseType.ERC721A),
            old.fees(BaseType.ERC1155),
            old.moduleAddOnFee(),
            old.hookAddOnFee(),
            old.governanceAddOnFee()
        );
        routerV2.setUruConfig(URU_TOKEN, address(uruSink));
        routerV2.setFactory(BaseType.ERC20, ERC20_FACTORY);
        routerV2.setFactory(BaseType.ERC721A, ERC721A_FACTORY);
        routerV2.setFactory(BaseType.ERC1155, ERC1155_FACTORY);
        routerV2.setCurveFactory(CURVE_FACTORY);
        routerV2.setLoyaltyOracle(address(oracle));

        // URU-A01 / URU-A10: Router now fails-closed on any launch whose
        // configHash isn't registered. Seed the bare-ERC20 metadata so the
        // launchWithURU tests can reach the URU-transfer path we're actually
        // testing. flags=0 (no BALANCE_MUTATING, no REQUIRES_OWNER).
        routerV2.registerConfigMetadata(BARE_ERC20_CONFIG, 0, 0);
        vm.stopPrank();

        // Authorize Router on each factory + NameRegistry by pranking as current owner.
        _authorizeOnFactory(ERC20_FACTORY);
        _authorizeOnFactory(ERC721A_FACTORY);
        _authorizeOnFactory(ERC1155_FACTORY);
        address cfOwner = ICurveFactoryOwned(CURVE_FACTORY).owner();
        vm.prank(cfOwner);
        ICurveFactoryOwned(CURVE_FACTORY).setTrustedRouter(address(routerV2), true);

        // NameRegistry.reserve is gated on msg.sender == router — repoint it so the
        // new Router can register launches. Same owner-only setter as the factories.
        address regOwner = _ownerOf(NAME_REGISTRY);
        vm.prank(regOwner);
        (bool ok,) = NAME_REGISTRY.call(abi.encodeWithSignature("setRouter(address)", address(routerV2)));
        require(ok, "NameRegistry.setRouter failed");
    }

    function _ownerOf(
        address c
    ) internal view returns (address) {
        (bool ok, bytes memory ret) = c.staticcall(abi.encodeWithSignature("owner()"));
        require(ok, "owner() failed");
        return abi.decode(ret, (address));
    }

    function _authorizeOnFactory(
        address factory
    ) internal {
        address own = IFactoryOwned(factory).owner();
        vm.prank(own);
        IFactoryOwned(factory).setRouter(address(routerV2));
    }

    function _bareParams(
        string memory tokenName,
        string memory ticker
    ) internal pure returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: tokenName,
            ticker: ticker,
            configHash: BARE_ERC20_CONFIG,
            // ERC20Factory.deploy expects client-side initData = (initialSupply, initialRecipient, moduleData).
            // The factory prepends router / name / symbol itself before calling template.initialize.
            initData: abi.encode(uint256(1_000_000e18), address(0), new bytes[](0)),
            moduleCount: 0,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    // =========================================================
    // launchWithURU — E2E happy path
    // =========================================================

    function test_LaunchWithURU_PullsURUAndDeploysToken() public {
        // Bail cleanly if the ERC20Factory doesn't have the bare template registered on
        // this fork (indicates Phase1 was deployed without templates wired).
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) {
            emit log("bare-ERC20 configHash not registered on RH factory; skipping");
            return;
        }

        uint256 uruAmount = 100e18;
        // Foundry cheat: force alice's URU balance without needing to bridge/swap.
        deal(URU_TOKEN, alice, 1000e18);

        vm.startPrank(alice);
        (bool ok,) = URU_TOKEN.call(abi.encodeWithSignature("approve(address,uint256)", address(routerV2), uruAmount));
        require(ok, "URU approve failed");

        LaunchParams memory p = _bareParams("Test URU Launch", "URUTEST");
        address token = routerV2.launchWithURU(p, uruAmount);
        vm.stopPrank();

        // 1. URU landed in sink.
        assertEq(IERC20Metadata(URU_TOKEN).balanceOf(address(uruSink)), uruAmount, "URU not in sink");
        assertEq(IERC20Metadata(URU_TOKEN).balanceOf(alice), 1000e18 - uruAmount, "URU not pulled from alice");

        // 2. Token deployed.
        assertGt(token.code.length, 0, "token has no code");

        // 3. Reservation recorded — check via tickerOwner (simple address return, no
        // struct-decode gymnastics needed).
        {
            bytes32 tickerHash = keccak256(bytes("URUTEST"));
            (bool tickerOk, bytes memory ret) =
                NAME_REGISTRY.staticcall(abi.encodeWithSignature("tickerOwner(bytes32)", tickerHash));
            require(tickerOk, "tickerOwner failed");
            assertEq(abi.decode(ret, (address)), token, "reservation not recorded");
        }

        // 4. Ownership dispatched to alice (KeepEOA).
        assertEq(IERC20Metadata(token).owner(), alice, "owner not launcher");

        // 5. No ETH went to splitter on the URU path.
        assertEq(address(splitter).balance, 0, "splitter got ETH on URU launch");
    }

    function test_LaunchWithURU_EmitsLaunchedInURU() public {
        if (IFactoryOwned(ERC20_FACTORY).implFor(BARE_ERC20_CONFIG) == address(0)) return;

        deal(URU_TOKEN, alice, 1000e18);
        vm.startPrank(alice);
        (bool ok,) = URU_TOKEN.call(abi.encodeWithSignature("approve(address,uint256)", address(routerV2), 100e18));
        require(ok);

        LaunchParams memory p = _bareParams("Event Check Token", "EVCHK");

        // vm.recordLogs (not expectEmit) — the launch fires several events before
        // LaunchedInURU (URU Transfer, factory Deployed, registry Reserved, Launched)
        // so expectEmit would match the first log, not the one we care about.
        vm.recordLogs();
        routerV2.launchWithURU(p, 100e18);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("LaunchedInURU(address,address,uint256)");
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(routerV2) && logs[i].topics.length >= 3 && logs[i].topics[0] == sig) {
                // topics[2] is the indexed launcher; data is the (uint256 uruPaid) tail.
                address emittedLauncher = address(uint160(uint256(logs[i].topics[2])));
                uint256 emittedAmount = abi.decode(logs[i].data, (uint256));
                assertEq(emittedLauncher, alice, "wrong launcher in event");
                assertEq(emittedAmount, 100e18, "wrong uruPaid in event");
                found = true;
                break;
            }
        }
        assertTrue(found, "LaunchedInURU not emitted");
    }

    // =========================================================
    // Flywheel distribution — validates the ETH-arrives side of the loop
    // =========================================================

    function test_FeeSplitter_DistributesOnEthReceive() public {
        // Simulates the keeper URU->ETH swap landing 1 ether at the splitter.
        uint256 treasuryBefore = treasury.balance;
        uint256 buybackBefore = address(buybackVault).balance;
        uint256 nftBefore = address(nftVault).balance;

        (bool ok,) = address(splitter).call{value: 1 ether}("");
        require(ok, "splitter receive failed");

        // 40/35/25 split, wei-exact (rounding residue up to 3 wei stays on splitter,
        // per FeeSplitter._distribute).
        assertEq(address(buybackVault).balance - buybackBefore, 0.4 ether, "buyback slice");
        assertEq(address(nftVault).balance - nftBefore, 0.35 ether, "nft slice");
        assertEq(treasury.balance - treasuryBefore, 0.25 ether, "treasury slice");
        assertLe(address(splitter).balance, 3, "splitter residue > 3 wei");
    }
}
