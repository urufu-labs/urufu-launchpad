// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

// Core
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {V4SwapRouter} from "src/router/V4SwapRouter.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {BaseType} from "src/types/VMTypes.sol";

// Factories + base templates
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";

// Composed ERC20 impls — the 12 canonical live-manifest entries. Only these
// need registerImpl on the ERC20Factory for the manifest-seed pass to succeed.
// The manifest can extend beyond 12 as new modules land; add both entries
// there and impl-deploys here in the same commit.
import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {ERC20WithPermitGen} from "src/templates/composed/ERC20WithPermitGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {ERC20WithPausableGen} from "src/templates/composed/ERC20WithPausableGen.sol";
import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";

// Curve + graduation
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {GraduatorV2} from "src/curve/GraduatorV2.sol";

// Hooks
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {HookMiner} from "src/hooks/HookMiner.sol";

// Flywheel
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftRevenueVault} from "src/flywheel/NftRevenueVault.sol";
import {UruBuybackVault} from "src/flywheel/UruBuybackVault.sol";
import {RoyaltyRouterFactory} from "src/flywheel/RoyaltyRouterFactory.sol";
import {RoyaltyRouterImpl} from "src/flywheel/RoyaltyRouterImpl.sol";

// Uniswap v4
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

// Config manifest
import {RhConfigManifest} from "./manifest/RhConfigManifest.sol";

/// @title  DeployFreshLocal
/// @notice CANONICAL production deployment script — deploys the ENTIRE launchpad
///         stack from cold to fresh addresses, wired end-to-end against a real
///         Uniswap v4 PoolManager. Broadcasts one orchestrated deployment:
///           - Infra:     NameRegistry, Router, 3 factories, base + 11 composed
///                        template impls, BondingCurve impl, CurveFactory,
///                        MultiHookHost (CREATE2), Graduator, V4SwapRouter.
///           - Flywheel:  NftRevenueVault, UruBuybackVault, FeeSplitter (used as
///                        Router's fee receiver), LoyaltyOracle, RoyaltyRouterImpl,
///                        RoyaltyRouterFactory, UruDepositSink.
///           - Wiring:    every setter that must land before launches work —
///                        registry.setRouter, factory.setRouter x3,
///                        curveFactory.setTrustedRouter + setGraduator,
///                        mhh.setInitializer, router.setFactory x3 +
///                        setCurveFactory + setLoyaltyOracle + setUruConfig +
///                        setMinUruFee, plus the full 12-hash manifest seed.
///           - Assert:    post-broadcast assertion pass verifies every slot on
///                        the freshly-deployed Router matches what we wrote,
///                        every manifest hash reports moduleCountConfigured +
///                        flagsConfigured true with matching values, and the
///                        core cross-wires (curveFactory.graduator,
///                        graduator.defaultHook, mhh.initializer) all agree.
///
///         Historical name (kept for filename stability + LocalE2E integration):
///         the original DeployFreshLocal.s.sol was a minimal bare-ERC20 anvil
///         harness. August 2026 audit HIGH #3 required a production-grade
///         version — this file is that upgrade, replacing the minimal one in
///         place. Runs identically against a local anvil fork or against
///         Robinhood mainnet directly.
///
///         AUDIT FIX-CLOSE:
///           Addresses the August 2026 auditor's HIGH #3 ("no production-grade
///           clean relaunch script") and reinforces blockers #1 (manifest seed
///           at deploy time) and #2 (nonzero minUruFee at deploy time).
///
///         REQUIRED env:
///           V4_POOL_MANAGER              v4 PoolManager on the target chain
///           URU_TOKEN_ADDRESS            URU ERC-20 to accept as fee token
///           GEMU_NFT_ADDRESS             urufu gemu ERC-721 (LoyaltyOracle input)
///           MIN_URU_FEE                  URU spam-gate floor, 18 decimals, MUST be > 0
///
///         OPTIONAL env (all default to broadcaster / sensible values):
///           ADMIN                        owner of every ownable slot (default msg.sender)
///           TREASURY                     FeeSplitter treasury sink (default msg.sender)
///           URU_THRESHOLD                LoyaltyOracle URU-holder tier threshold
///                                        (default 100000e18 = 100k URU)
///           NFT_HOLDER_BPS               LoyaltyOracle discount for NFT holders (default 2000)
///           URU_HOLDER_BPS               LoyaltyOracle discount for URU holders (default 4000)
///           BOTH_BPS                     LoyaltyOracle discount for both (default 5000)
///           MAX_DISCOUNT_BPS             LoyaltyOracle hard cap (default 5000)
///           SPLITTER_CONFIG_DELAY        FeeSplitter timelock (default 2 days)
///           SPLITTER_BPS_URU             FeeSplitter URU-buyback share (default 4000)
///           SPLITTER_BPS_NFT             FeeSplitter NFT-revenue share (default 3500)
///           SPLITTER_BPS_TREASURY        FeeSplitter treasury share (default 2500)
///           PLATFORM_BPS                 MultiHookHost platform slice (default 100)
///           CREATOR_BPS                  MultiHookHost creator slice (default 100)
///           ROYALTY_PLATFORM_BPS         RoyaltyRouterFactory platform slice (default 500)
///
///         Run against a local anvil fork:
///           anvil --fork-url $ROBINHOOD_RPC_URL --chain-id 4663
///           forge script script/DeployFreshLocal.s.sol:DeployFreshLocal \
///             --broadcast --rpc-url http://127.0.0.1:8545 --private-key $DEV_PRIVATE_KEY
///
///         Or run directly against Robinhood mainnet (production deploy):
///           forge script script/DeployFreshLocal.s.sol:DeployFreshLocal \
///             --broadcast --rpc-url $ROBINHOOD_RPC_URL --private-key $DEV_PRIVATE_KEY
contract DeployFreshLocal is Script {
    /// Canonical Foundry CREATE2 deployer, present on every EVM chain we support.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// Pool params hardcoded elsewhere in the stack (indexer poolId derivation,
    /// frontend v4 reads). Do not change without updating those.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // Errors — every fail case has a distinct selector so operator diagnostics
    // don't require reading the revert message.
    error DeployFresh__ZeroMinUruFee();
    error DeployFresh__PoolManagerNoCode();
    error DeployFresh__PostStateMismatch(string what);
    error DeployFresh__ManifestSeedFailed(bytes32 configHash, string what);
    /// Post-state assertion tripped — a retired Airdrop configHash is not banned
    /// on the freshly-deployed Router. Refuses to write the address book.
    error DeployFresh__RetiredHashNotBanned(bytes32 configHash);
    error DeployFresh__MhhSaltMiningFailed();
    /// ADMIN env must equal the broadcaster. Every owner-only setter and
    /// registrar call in this script runs under msg.sender — if ADMIN is a
    /// different address (e.g. a multisig), those setters revert silently
    /// under Unauthorized (audit round 2 medium #5). Correct multisig
    /// handoff pattern: run this script with ADMIN=broadcaster, then run
    /// `HandoffOwnership.s.sol` from the multisig context after deploy.
    error DeployFresh__AdminMustEqualBroadcaster(address admin, address broadcaster);

    /// Test-context flag flipped by runForTest(). vm.startBroadcast can't be
    /// used inside a forge test — the setter calls between constructor + owner
    /// would originate from the script contract, not the pranked deployer, and
    /// every onlyOwner setter would revert Unauthorized. runForTest swaps to a
    /// pure vm.prank-friendly flow so DeployPathRhForkTest can exercise the
    /// entire production deploy sequence against a real Robinhood fork.
    bool internal _isTestContext;

    /// Every address written by this deploy in one struct — surface for tests,
    /// operators, and the address-book writer. Field order matches JSON key
    /// order the writer emits, and includes the legacy keys LocalE2E consumes.
    struct Stack {
        // core
        address nameRegistry;
        address feeReceiver; // FeeSplitter; kept named `feeReceiver` for LocalE2E compat
        address router;
        // factories + base impls
        address erc20Factory;
        address erc721AFactory;
        address erc1155Factory;
        address erc20Impl;
        // composed impls (10 canonical entries the manifest currently registers).
        // See RhConfigManifest for the intentional exclusions (retired Airdrop
        // combos). Two-module combos beyond Permit+Staking (e.g. AntiBot+Permit)
        // exist as composed templates in the repo but were never registered on
        // the live ERC20Factory — do not add to the fresh deploy until they
        // land in the compile-service matrix AND get a canonical hash entry.
        address implBare;
        address implPermit;
        address implVesting;
        address implStaking;
        address implVotes;
        address implAntiBot;
        address implAntiWhale;
        address implFot;
        address implPausable;
        address implPermitStaking;
        // curve
        address bondingCurveImpl;
        address curveFactory;
        // hooks + graduation
        address multiHookHost;
        address graduator;
        address v4SwapRouter;
        // flywheel
        address loyaltyOracle;
        address nftRevenueVault;
        address uruBuybackVault;
        address uruDepositSink;
        address royaltyRouterImpl;
        address royaltyRouterFactory;
        // external references (echoed for the address-book writer)
        address poolManager;
        address uruToken;
        address gemuNft;
    }

    function run() external returns (Stack memory s) {
        return _runInner();
    }

    /// Test-mode entrypoint — skips vm.startBroadcast so a forge test can
    /// prank as the deployer + drive the whole deploy in-process. See
    /// `test/audit/DeployPathRhFork.t.sol` for the exercise.
    function runForTest() external returns (Stack memory s) {
        _isTestContext = true;
        return _runInner();
    }

    /// Stored so the broadcast/prank helpers can re-prank between phases. Set
    /// at the top of _runInner.
    address internal _adminForPrank;

    function _startBroadcastOrPrank() internal {
        if (_isTestContext) vm.startPrank(_adminForPrank);
        else vm.startBroadcast();
    }

    function _stopBroadcastOrPrank() internal {
        if (_isTestContext) vm.stopPrank();
        else vm.stopBroadcast();
    }

    function _runInner() internal returns (Stack memory s) {
        // ---------------- env ----------------
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address uruToken = vm.envAddress("URU_TOKEN_ADDRESS");
        address gemuNft = vm.envAddress("GEMU_NFT_ADDRESS");
        uint256 minUruFee = vm.envOr("MIN_URU_FEE", uint256(0));
        if (minUruFee == 0) revert DeployFresh__ZeroMinUruFee();
        if (poolManager.code.length == 0) revert DeployFresh__PoolManagerNoCode();

        address admin = vm.envOr("ADMIN", msg.sender);
        address treasury = vm.envOr("TREASURY", msg.sender);
        // Enforce ADMIN == broadcaster (audit round 2 medium #5). All
        // owner-only setter and registrar calls below run under msg.sender;
        // any mismatch reverts silently. If a multisig should own the stack,
        // deploy under a temporary EOA with ADMIN=broadcaster and use
        // HandoffOwnership.s.sol post-deploy to transfer ownership.
        if (admin != msg.sender) revert DeployFresh__AdminMustEqualBroadcaster(admin, msg.sender);
        _adminForPrank = admin;
        uint256 uruThreshold = vm.envOr("URU_THRESHOLD", uint256(100_000e18));
        uint16 nftHolderBps = uint16(vm.envOr("NFT_HOLDER_BPS", uint256(2000)));
        uint16 uruHolderBps = uint16(vm.envOr("URU_HOLDER_BPS", uint256(4000)));
        uint16 bothBps = uint16(vm.envOr("BOTH_BPS", uint256(5000)));
        uint16 maxDiscountBps = uint16(vm.envOr("MAX_DISCOUNT_BPS", uint256(5000)));
        uint256 splitterDelay = vm.envOr("SPLITTER_CONFIG_DELAY", uint256(2 days));
        uint16 platformBps = uint16(vm.envOr("PLATFORM_BPS", uint256(100)));
        uint16 creatorBps = uint16(vm.envOr("CREATOR_BPS", uint256(100)));
        uint256 royaltyPlatformBps = vm.envOr("ROYALTY_PLATFORM_BPS", uint256(500));

        s.poolManager = poolManager;
        s.uruToken = uruToken;
        s.gemuNft = gemuNft;

        console2.log("==== DeployFreshLocal (canonical prod stack) ====");
        console2.log("  chainid     :", block.chainid);
        console2.log("  deployer    :", admin);
        console2.log("  treasury    :", treasury);
        console2.log("  PoolManager :", poolManager);
        console2.log("  URU token   :", uruToken);
        console2.log("  gemu NFT    :", gemuNft);
        console2.log("  minUruFee   :", minUruFee);

        // ---------------- Phase 1: flywheel infra (deploy order matters, chicken/egg) --
        _startBroadcastOrPrank();

        NftRevenueVault nftVault = new NftRevenueVault(admin);
        s.nftRevenueVault = address(nftVault);

        UruBuybackVault buybackVault = new UruBuybackVault(admin, uruToken, address(nftVault), splitterDelay);
        s.uruBuybackVault = address(buybackVault);

        FeeSplitter splitter = new FeeSplitter(admin, treasury, splitterDelay);
        s.feeReceiver = address(splitter);
        // FeeSplitter.setConfig is timelock-gated (splitterDelay from deploy).
        // Operator must run a follow-up setConfig broadcast after splitterDelay
        // elapses — documented in the Next Steps log at the bottom.

        // LoyaltyOracle wires URU/GEMU + threshold in the constructor; discount
        // bps then get set via setConfig (constructor only initializes the
        // token/nft/threshold triple). Two-step deploy keeps a bad bps config
        // from stranding the contract.
        LoyaltyOracle loyaltyOracle = new LoyaltyOracle(admin, uruToken, gemuNft, uruThreshold);
        loyaltyOracle.setConfig(uruToken, gemuNft, uruThreshold, nftHolderBps, uruHolderBps, bothBps, maxDiscountBps);
        s.loyaltyOracle = address(loyaltyOracle);

        // Royalty router — LibClone-style factory + impl. Deployed even though
        // Router doesn't call the factory today (per auditor note), so the
        // stack is complete for future NFT-flow activation. Platform sink is
        // FeeSplitter so any accrued platform-share royalty ETH lands in the
        // same 40/35/25 flow as launch fees.
        RoyaltyRouterImpl royaltyImpl = new RoyaltyRouterImpl();
        s.royaltyRouterImpl = address(royaltyImpl);
        RoyaltyRouterFactory royaltyFactory =
            new RoyaltyRouterFactory(admin, address(royaltyImpl), address(splitter), uint16(royaltyPlatformBps));
        s.royaltyRouterFactory = address(royaltyFactory);

        // ---------------- Phase 2: core ----------------
        // Seed the canonical reserved-ticker list at construction time. Without
        // this, the fresh registry lets the first user launch official-looking
        // symbols (ETH, WETH, USDC, etc.). Audit round 2 medium #6. Matches
        // the DeployNameRegistry canonical list plus ecosystem tokens URU,
        // CHIBI, GEMU.
        NameRegistry registry = new NameRegistry(admin, treasury, _reservedTickers());
        s.nameRegistry = address(registry);

        // Router uses FeeSplitter directly as its feeReceiver — no intermediate
        // FeeReceiver contract. All ETH launch fees land in FeeSplitter which
        // then splits per the 40/35/25 config.
        Router router = new Router(
            admin,
            registry,
            IFeeReceiver(address(splitter)),
            0.05 ether, // ERC20 launch fee
            0.05 ether, // ERC721A launch fee
            0.05 ether, // ERC1155 launch fee
            0.01 ether, // module add-on
            0.01 ether, // hook add-on
            0.01 ether // governance add-on
        );
        s.router = address(router);

        registry.setRouter(address(router));

        // ---------------- Phase 3: template impls ----------------
        // Base ERC20 template (used as the "bare" registered impl).
        s.implBare = address(new ERC20Template());
        s.erc20Impl = s.implBare;

        // 9 canonical composed impls the compile-service currently produces on top
        // of the bare template. Order + set matches RhConfigManifest.all().
        s.implPermit = address(new ERC20WithPermitGen());
        s.implVesting = address(new ERC20WithVestingGen());
        s.implStaking = address(new ERC20WithStakingGen());
        s.implVotes = address(new ERC20WithVotesGen());
        s.implAntiBot = address(new ERC20WithAntiBotGen());
        s.implAntiWhale = address(new ERC20WithAntiWhaleGen());
        s.implFot = address(new ERC20WithFeeOnTransferGen());
        s.implPausable = address(new ERC20WithPausableGen());
        s.implPermitStaking = address(new ERC20WithPermitStakingGen());

        // ---------------- Phase 4: factories ----------------
        ERC20Factory erc20Factory = new ERC20Factory(admin, address(router), admin);
        s.erc20Factory = address(erc20Factory);

        ERC721AFactory erc721AFactory = new ERC721AFactory(admin, address(router), admin);
        s.erc721AFactory = address(erc721AFactory);

        ERC1155Factory erc1155Factory = new ERC1155Factory(admin, address(router), admin);
        s.erc1155Factory = address(erc1155Factory);

        // Register each canonical impl at its manifest configHash. Order
        // matches RhConfigManifest.all() index order — do not reshuffle.
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        address[10] memory impls = [
            s.implPermit,
            s.implVesting,
            s.implStaking,
            s.implVotes,
            s.implBare,
            s.implAntiBot,
            s.implAntiWhale,
            s.implFot,
            s.implPausable,
            s.implPermitStaking
        ];
        for (uint256 i = 0; i < entries.length; i++) {
            erc20Factory.registerImpl(entries[i].configHash, impls[i]);
        }

        router.setFactory(BaseType.ERC20, address(erc20Factory));
        router.setFactory(BaseType.ERC721A, address(erc721AFactory));
        router.setFactory(BaseType.ERC1155, address(erc1155Factory));

        // ---------------- Phase 5: seed Router sentinels ----------------
        (bytes32[] memory hashes, uint256[] memory counts) = RhConfigManifest.hashesAndCounts();
        (, uint256[] memory flags) = RhConfigManifest.hashesAndFlags();
        router.setModuleCountForConfigBatch(hashes, counts);
        router.setFlagsForConfigBatch(hashes, flags);

        // ---------------- Phase 5b: ban retired Airdrop hashes ----------
        // Fresh stack must also ban these — the retired impls aren't on this
        // greenfield ERC20Factory today, but the ban is a
        // safe-by-construction gate so no code path can produce a Router
        // that accepts a retired hash if someone later registerImpl's one
        // by mistake. Post-state assertion in _assertRouterState enforces
        // it landed.
        {
            bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
            for (uint256 i = 0; i < retired.length; i++) {
                router.setConfigHashBanned(retired[i], true);
            }
        }

        // ---------------- Phase 6: bonding curve + graduator ------------
        BondingCurve curveImpl = new BondingCurve();
        s.bondingCurveImpl = address(curveImpl);

        CurveFactory curveFactory = new CurveFactory(admin, address(splitter), address(curveImpl));
        s.curveFactory = address(curveFactory);
        curveFactory.setTrustedRouter(address(router), true);
        router.setCurveFactory(address(curveFactory));

        _stopBroadcastOrPrank();

        // ---------------- Phase 7: mine + deploy MultiHookHost ----------
        // v4 encodes hook permissions in the low bits of the hook address, so
        // MHH can only live at an address whose bits match the required flags.
        // Mining is pure off-chain compute — done between broadcasts.
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        bytes memory creation = type(MultiHookHost).creationCode;
        bytes memory args =
            abi.encode(IPoolManager(poolManager), address(splitter), admin, platformBps, creatorBps, admin);

        uint256 startSalt = 0;
        uint256 salt;
        address predictedMhh;
        for (uint256 attempt = 0; attempt < 10; ++attempt) {
            (salt, predictedMhh) =
                HookMiner.findFrom(CREATE2_DEPLOYER, requiredFlags, creation, args, 500_000, startSalt);
            if (predictedMhh.code.length == 0) break;
            startSalt = salt + 1;
        }
        if (predictedMhh.code.length != 0) revert DeployFresh__MhhSaltMiningFailed();

        _startBroadcastOrPrank();

        MultiHookHost mhh = _deployMhhViaCreate2(salt, creation, args, predictedMhh);
        s.multiHookHost = address(mhh);

        GraduatorV2 graduator = new GraduatorV2(
            IPoolManager(poolManager), IHooks(address(mhh)), FEE, TICK_SPACING, address(curveFactory), admin
        );
        s.graduator = address(graduator);

        // One-shot lock, same broadcast — closes the front-run window.
        mhh.setInitializer(address(graduator));
        curveFactory.setGraduator(address(graduator));

        // ---------------- Phase 8: swap router --------------------------
        V4SwapRouter swapRouter = new V4SwapRouter(IPoolManager(poolManager));
        s.v4SwapRouter = address(swapRouter);

        // ---------------- Phase 9: URU pay ------------------------------
        UruDepositSink sink = new UruDepositSink(admin, uruToken, address(splitter), splitterDelay);
        s.uruDepositSink = address(sink);

        // Router.setUruConfig now validates sink code + sink.uru() == uru per
        // the August audit's medium #4. Deployed sink + matching token → pass.
        router.setUruConfig(uruToken, address(sink));
        // URU spam-gate floor, auditor blocker #2.
        router.setMinUruFee(minUruFee);
        // Loyalty discount, requires LoyaltyOracle wire.
        router.setLoyaltyOracle(address(loyaltyOracle));

        _stopBroadcastOrPrank();

        // ---------------- Phase 10: post-broadcast assertions -----------
        _assertRouterState(router, s, uruToken, minUruFee);
        _assertManifestSeeded(router);
        _assertCrossWires(s);

        _report(s);
        _write(s);

        _nextSteps(splitterDelay, address(splitter), address(buybackVault), address(nftVault), treasury);
    }

    /// Reserved tickers baked into every fresh NameRegistry. Blocks first-
    /// user squatting on well-known symbols. Keep this list in sync with
    /// `DeployNameRegistry._initialReservedTickers()`; when a new symbol
    /// gets protected in one place, update the other in the same PR.
    /// The last 3 entries (URU, CHIBI, GEMU) are ecosystem-specific.
    function _reservedTickers() internal pure returns (string[] memory list) {
        list = new string[](29);
        list[0] = "ETH";
        list[1] = "WETH";
        list[2] = "USDC";
        list[3] = "USDT";
        list[4] = "DAI";
        list[5] = "WBTC";
        list[6] = "MATIC";
        list[7] = "LINK";
        list[8] = "UNI";
        list[9] = "AAVE";
        list[10] = "COMP";
        list[11] = "MKR";
        list[12] = "SUSHI";
        list[13] = "CRV";
        list[14] = "LDO";
        list[15] = "PEPE";
        list[16] = "SHIB";
        list[17] = "DOGE";
        list[18] = "BASE";
        list[19] = "OP";
        list[20] = "ARB";
        list[21] = "SOL";
        list[22] = "BNB";
        list[23] = "AVAX";
        list[24] = "NEAR";
        list[25] = "ATOM";
        list[26] = "URU";
        list[27] = "CHIBI";
        list[28] = "GEMU";
    }

    /// Deploy MultiHookHost via the canonical CREATE2 singleton at
    /// `CREATE2_DEPLOYER`. Explicit call rather than `new X{salt}` sugar so
    /// the deploy path is identical between forge-script broadcast (where
    /// Solidity's sugar is routed through the singleton by Foundry) and
    /// forge-test (where the sugar uses the current call frame's address as
    /// deployer, mismatching the mined prediction). Extracted from _runInner
    /// to avoid a Yul stack-too-deep in that already-large function.
    function _deployMhhViaCreate2(
        uint256 salt,
        bytes memory creation,
        bytes memory args,
        address predictedMhh
    ) internal returns (MultiHookHost mhh) {
        bytes memory init = bytes.concat(creation, args);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(bytes32(salt), init));
        require(ok, "CREATE2 MHH deploy call failed");
        require(predictedMhh.code.length > 0, "MHH salt drift: no code at predicted");
        mhh = MultiHookHost(payable(predictedMhh));
    }

    // ================================================================
    // Post-broadcast assertion helpers. Belt-and-braces — any revert
    // from the setters above would have already surfaced, but re-reading
    // slots catches silent RPC / nonce anomalies before the address book
    // is presented as "deployed".
    // ================================================================

    function _assertRouterState(
        Router router,
        Stack memory s,
        address expectedUru,
        uint256 expectedMinUruFee
    ) internal view {
        if (address(router.uru()) != expectedUru) revert DeployFresh__PostStateMismatch("router.uru");
        if (address(router.uruSink()) != s.uruDepositSink) revert DeployFresh__PostStateMismatch("router.uruSink");
        if (router.minUruFee() != expectedMinUruFee) revert DeployFresh__PostStateMismatch("router.minUruFee");
        if (router.loyaltyOracle() != s.loyaltyOracle) revert DeployFresh__PostStateMismatch("router.loyaltyOracle");
        if (router.curveFactory() != s.curveFactory) revert DeployFresh__PostStateMismatch("router.curveFactory");
        if (address(router.registry()) != s.nameRegistry) {
            revert DeployFresh__PostStateMismatch("router.registry");
        }
        if (address(router.feeReceiver()) != s.feeReceiver) {
            revert DeployFresh__PostStateMismatch("router.feeReceiver");
        }
        if (router.factories(BaseType.ERC20) != s.erc20Factory) {
            revert DeployFresh__PostStateMismatch("router.factories[ERC20]");
        }
        if (router.factories(BaseType.ERC721A) != s.erc721AFactory) {
            revert DeployFresh__PostStateMismatch("router.factories[ERC721A]");
        }
        if (router.factories(BaseType.ERC1155) != s.erc1155Factory) {
            revert DeployFresh__PostStateMismatch("router.factories[ERC1155]");
        }
    }

    function _assertManifestSeeded(
        Router router
    ) internal view {
        RhConfigManifest.Entry[] memory entries = RhConfigManifest.all();
        for (uint256 i = 0; i < entries.length; i++) {
            RhConfigManifest.Entry memory e = entries[i];
            if (!router.moduleCountConfigured(e.configHash)) {
                revert DeployFresh__ManifestSeedFailed(e.configHash, "moduleCountConfigured");
            }
            if (!router.flagsConfigured(e.configHash)) {
                revert DeployFresh__ManifestSeedFailed(e.configHash, "flagsConfigured");
            }
            if (router.moduleCountForConfig(e.configHash) != e.moduleCount) {
                revert DeployFresh__ManifestSeedFailed(e.configHash, "moduleCount");
            }
            if (router.flagsForConfig(e.configHash) != e.flags) {
                revert DeployFresh__ManifestSeedFailed(e.configHash, "flags");
            }
        }
        // Retired-hash bans — refuse to ship a Router that isn't
        // safe-by-construction against the retired Airdrop attack vector.
        bytes32[] memory retired = RhConfigManifest.retiredAirdropHashes();
        for (uint256 i = 0; i < retired.length; i++) {
            if (!router.bannedConfigHash(retired[i])) {
                revert DeployFresh__RetiredHashNotBanned(retired[i]);
            }
        }
    }

    function _assertCrossWires(
        Stack memory s
    ) internal view {
        if (CurveFactory(s.curveFactory).graduator() != s.graduator) {
            revert DeployFresh__PostStateMismatch("curveFactory.graduator");
        }
        if (!CurveFactory(s.curveFactory).trustedRouters(s.router)) {
            revert DeployFresh__PostStateMismatch("curveFactory.trustedRouters[router]");
        }
        if (address(GraduatorV2(payable(s.graduator)).defaultHook()) != s.multiHookHost) {
            revert DeployFresh__PostStateMismatch("graduator.defaultHook");
        }
        if (address(GraduatorV2(payable(s.graduator)).curveFactory()) != s.curveFactory) {
            revert DeployFresh__PostStateMismatch("graduator.curveFactory");
        }
        if (MultiHookHost(payable(s.multiHookHost)).initializer() != s.graduator) {
            revert DeployFresh__PostStateMismatch("mhh.initializer");
        }
        if (NameRegistry(s.nameRegistry).router() != s.router) {
            revert DeployFresh__PostStateMismatch("nameRegistry.router");
        }
    }

    // ================================================================
    // Reporting
    // ================================================================

    function _report(
        Stack memory s
    ) internal pure {
        console2.log("---- deployed (fresh full production stack) ----");
        console2.log("  NameRegistry        :", s.nameRegistry);
        console2.log("  Router              :", s.router);
        console2.log("  FeeSplitter         :", s.feeReceiver);
        console2.log("  ERC20Factory        :", s.erc20Factory);
        console2.log("  ERC721AFactory      :", s.erc721AFactory);
        console2.log("  ERC1155Factory      :", s.erc1155Factory);
        console2.log("  CurveFactory        :", s.curveFactory);
        console2.log("  BondingCurveImpl    :", s.bondingCurveImpl);
        console2.log("  MultiHookHost       :", s.multiHookHost);
        console2.log("  Graduator           :", s.graduator);
        console2.log("  V4SwapRouter        :", s.v4SwapRouter);
        console2.log("  UruDepositSink      :", s.uruDepositSink);
        console2.log("  LoyaltyOracle       :", s.loyaltyOracle);
        console2.log("  NftRevenueVault     :", s.nftRevenueVault);
        console2.log("  UruBuybackVault     :", s.uruBuybackVault);
        console2.log("  RoyaltyRouterFactory:", s.royaltyRouterFactory);
    }

    /// Writes FOUR address-book files so every downstream tool (ConfigureFlywheel,
    /// HandoffOwnership, LocalE2E, frontend/indexer generators) can consume the
    /// fresh deployment without any format-adapter step. Audit round 2 HIGH #4
    /// closed by this fan-out.
    ///
    ///   deployment-fresh.<chainId>.json     — full 20-field dump for humans
    ///                                          and the LocalE2E path (which reads
    ///                                          .router, .curveFactory,
    ///                                          .multiHookHost, .v4SwapRouter,
    ///                                          .poolManager keys unchanged).
    ///   deployment.<chainId>.json           — legacy Phase 1 shape consumed by
    ///                                          HandoffOwnership: PascalCase keys
    ///                                          NameRegistry, FeeReceiver, Router,
    ///                                          ERC20Factory, ERC721AFactory,
    ///                                          ERC1155Factory, CurveFactory.
    ///   deployment-flywheel.<chainId>.json  — legacy flywheel shape consumed by
    ///                                          ConfigureFlywheel + HandoffOwnership:
    ///                                          FeeSplitter, LoyaltyOracle,
    ///                                          NftRevenueVault, UruBuybackVault,
    ///                                          RoyaltyRouterFactory.
    ///   deployment-routerv2.<chainId>.json  — legacy Router-rotation shape
    ///                                          consumed by the frontend sync
    ///                                          path: RouterV2, UruDepositSink,
    ///                                          FeeSplitter, status=ACTIVE.
    function _write(
        Stack memory s
    ) internal {
        _writeFresh(s);
        _writeLegacyPhase1(s);
        _writeLegacyFlywheel(s);
        _writeLegacyRouterV2(s);
    }

    function _writeFresh(
        Stack memory s
    ) internal {
        string memory o = "fresh";
        vm.serializeAddress(o, "nameRegistry", s.nameRegistry);
        vm.serializeAddress(o, "feeReceiver", s.feeReceiver);
        vm.serializeAddress(o, "router", s.router);
        vm.serializeAddress(o, "erc20Factory", s.erc20Factory);
        vm.serializeAddress(o, "erc721AFactory", s.erc721AFactory);
        vm.serializeAddress(o, "erc1155Factory", s.erc1155Factory);
        vm.serializeAddress(o, "erc20Impl", s.erc20Impl);
        vm.serializeAddress(o, "bondingCurveImpl", s.bondingCurveImpl);
        vm.serializeAddress(o, "curveFactory", s.curveFactory);
        vm.serializeAddress(o, "multiHookHost", s.multiHookHost);
        vm.serializeAddress(o, "graduator", s.graduator);
        vm.serializeAddress(o, "v4SwapRouter", s.v4SwapRouter);
        vm.serializeAddress(o, "uruDepositSink", s.uruDepositSink);
        vm.serializeAddress(o, "loyaltyOracle", s.loyaltyOracle);
        vm.serializeAddress(o, "nftRevenueVault", s.nftRevenueVault);
        vm.serializeAddress(o, "uruBuybackVault", s.uruBuybackVault);
        vm.serializeAddress(o, "royaltyRouterFactory", s.royaltyRouterFactory);
        vm.serializeAddress(o, "royaltyRouterImpl", s.royaltyRouterImpl);
        vm.serializeAddress(o, "poolManager", s.poolManager);
        vm.serializeAddress(o, "uruToken", s.uruToken);
        string memory json = vm.serializeAddress(o, "gemuNft", s.gemuNft);
        vm.writeJson(json, string.concat("./deployment-fresh.", vm.toString(block.chainid), ".json"));
    }

    function _writeLegacyPhase1(
        Stack memory s
    ) internal {
        string memory o = "phase1";
        vm.serializeAddress(o, "NameRegistry", s.nameRegistry);
        // Router uses FeeSplitter directly as the feeReceiver in the fresh
        // deploy — the legacy "FeeReceiver" key must point at it so
        // HandoffOwnership hands off the right contract.
        vm.serializeAddress(o, "FeeReceiver", s.feeReceiver);
        vm.serializeAddress(o, "Router", s.router);
        vm.serializeAddress(o, "ERC20Factory", s.erc20Factory);
        vm.serializeAddress(o, "ERC721AFactory", s.erc721AFactory);
        vm.serializeAddress(o, "ERC1155Factory", s.erc1155Factory);
        string memory json = vm.serializeAddress(o, "CurveFactory", s.curveFactory);
        vm.writeJson(json, string.concat("./deployment.", vm.toString(block.chainid), ".json"));
    }

    function _writeLegacyFlywheel(
        Stack memory s
    ) internal {
        string memory o = "fly";
        vm.serializeAddress(o, "FeeSplitter", s.feeReceiver);
        vm.serializeAddress(o, "LoyaltyOracle", s.loyaltyOracle);
        vm.serializeAddress(o, "NftRevenueVault", s.nftRevenueVault);
        vm.serializeAddress(o, "UruBuybackVault", s.uruBuybackVault);
        vm.serializeAddress(o, "RoyaltyRouterFactory", s.royaltyRouterFactory);
        string memory json = vm.serializeAddress(o, "RoyaltyRouterImpl", s.royaltyRouterImpl);
        vm.writeJson(json, string.concat("./deployment-flywheel.", vm.toString(block.chainid), ".json"));
    }

    function _writeLegacyRouterV2(
        Stack memory s
    ) internal {
        string memory o = "rv2";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "RouterV2", s.router);
        vm.serializeAddress(o, "UruDepositSink", s.uruDepositSink);
        vm.serializeAddress(o, "FeeSplitter", s.feeReceiver);
        // Fresh deploy = fresh NameRegistry with router set in-broadcast via
        // setRouter, so we're ACTIVE. (Router rotations that go through
        // proposeRouter/activateRouter emit PENDING_ACTIVATION via
        // DeployRouter.s.sol instead.)
        string memory json = vm.serializeString(o, "status", "ACTIVE");
        vm.writeJson(json, string.concat("./deployment-routerv2.", vm.toString(block.chainid), ".json"));
    }

    function _nextSteps(
        uint256 splitterDelay,
        address splitter,
        address buybackVault,
        address nftVault,
        address treasury
    ) internal pure {
        console2.log("---- next steps (timelock-gated + off-chain) ----");
        console2.log("  1. Wait for splitterDelay past deploy (seconds):", splitterDelay);
        console2.log("     then run FeeSplitter.setConfig from admin:");
        console2.log("       splitter:      ", splitter);
        console2.log("       uruBuybackSink:", buybackVault);
        console2.log("       nftRevenueSink:", nftVault);
        console2.log("       treasury      :", treasury);
        console2.log("       bps           : 4000 / 3500 / 2500");
        console2.log("  2. Set keeper on UruBuybackVault + UruDepositSink");
        console2.log("     (ConfigureFlywheel script covers this in one broadcast)");
        console2.log("  3. Publish first Merkle epoch when NFT holders exist");
        console2.log("     (PublishFirstEpoch script)");
        console2.log("  4. If atomic royalty-router materialization is added to Router,");
        console2.log("     also call RoyaltyRouterFactory.setTrustedDeployer(router, true).");
    }
}
