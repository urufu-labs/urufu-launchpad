// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {Dn404Template} from "src/dn404/Dn404Template.sol";
import {Dn404MirrorTemplate} from "src/dn404/Dn404MirrorTemplate.sol";
import {Dn404TaxTemplate} from "src/dn404/Dn404TaxTemplate.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404CurveFactory, IDn404PairCurrencyAllowlist} from "src/dn404/Dn404CurveFactory.sol";
import {Dn404Graduator} from "src/dn404/Dn404Graduator.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {Dn404TaxAllowlist} from "src/dn404/Dn404TaxAllowlist.sol";
import {
    Dn404LaunchFactory,
    IERC20 as FactoryIERC20,
    ILoyaltyOracleLike,
    ICurveFactoryLike,
    IDn404CurveFactoryLike
} from "src/dn404/Dn404LaunchFactory.sol";

/// Minimal V10 CurveFactory admin surface — used to check ownership and,
/// where possible, whitelist the fresh Dn404LaunchFactory as a trusted
/// router in the same broadcast. Kept behind an interface rather than
/// importing the V10 CurveFactory type so this script never links against
/// the frozen ERC-20 curve stack (see feedback_dn404_no_erc20_touch.md).
interface IV10CurveFactoryAdmin {
    function owner() external view returns (address);
    function trustedRouters(
        address router
    ) external view returns (bool);
    function setTrustedRouter(
        address router,
        bool trusted
    ) external;
}

/// @title  DeployDn404Lane
/// @notice One broadcast that stands up the entire DN404 lane on top of
///         the existing V10 stack. Deploys every DN404-scoped contract,
///         wires them together, and (where authority permits) trusts the
///         fresh launch factory on the V10 CurveFactory so ETH-paired
///         launches route through the shared curve stack.
///
///         Deploy order (all-or-nothing):
///           1. Dn404PairCurrencyAllowlist  (governance registry)
///           2. Dn404TaxAllowlist           (BuyAllowedToken destinations)
///           3. Dn404Template               (base impl, tax-off launches)
///           4. Dn404MirrorTemplate         (mirror impl, every launch)
///           5. Dn404TaxTemplate            (base impl, tax-on launches)
///           6. Dn404BondingCurve           (curve impl, cloned per launch)
///           7. Dn404CurveFactory           (owner + curve impl + allowlist)
///           8. Dn404Graduator              (pool manager + hook + CF ref)
///           9. Dn404LaunchFactory          (owner + nftFactory for URU floor)
///
///         Wiring (same broadcast):
///           a. Dn404CurveFactory.setGraduator(Dn404Graduator)
///           b. Dn404CurveFactory.setTrustedRouter(Dn404LaunchFactory, true)
///           c. Dn404LaunchFactory.setExpectedCodeHashes(baseHash, mirrorHash)
///           d. Dn404LaunchFactory.setImpls(base, mirror)
///           e. Dn404LaunchFactory.setBaseTaxImpl(taxImpl, taxHash)
///           f. Dn404LaunchFactory.setUruConfig(uru, uruSink, minFee, oracle)
///           g. Dn404LaunchFactory.setFeeSplitter(feeSplitter)
///           h. Dn404LaunchFactory.setCurveFactory(V10 CurveFactory)
///           i. Dn404LaunchFactory.setDn404CurveFactory(Dn404 CurveFactory)
///           j. Dn404LaunchFactory.setTaxWiring(keeper, treasury, taxAllowlist)
///
///         Optional (same broadcast, only if `msg.sender == V10 CF owner`):
///           k. V10 CurveFactory.setTrustedRouter(Dn404LaunchFactory, true)
///
///         If the deployer does NOT own the V10 CurveFactory, step (k) is
///         skipped and the script logs the exact call the V10 CF owner must
///         make separately before any ETH-paired DN404 launch can succeed.
///
///         Env vars (all optional except URU_TOKEN_ADDRESS + tax wiring):
///           ADMIN                  — owner of every new contract (default: msg.sender)
///           URU_TOKEN_ADDRESS      — URU ERC-20
///           DN404_TAX_KEEPER       — keeper wallet (governance-run)
///           DN404_TAX_TREASURY     — 5% keeper-fee recipient
///           DN404_GRAD_HOOK        — v4 hook for graduated pools (default: 0x0 = hookless)
///           DN404_GRAD_FEE         — v4 pool fee tier   (default 3000 = 30 bps)
///           DN404_GRAD_TICKSPACING — v4 tick spacing    (default 60)
///
///         Reads (chain-scoped):
///           deployment-live-rh.<chainid>.json  — V10 CurveFactory, PoolManager,
///                                                FeeReceiver (curve fee sink)
///           deployment-flywheel.<chainid>.json — FeeSplitter, LoyaltyOracle
///           deployment.<chainid>.json          — UruDepositSink
///           deployment-nft.<chainid>.json      — NftLaunchFactory (URU fee ref)
///
///         Usage (dry-run):
///           forge script script/DeployDn404Lane.s.sol --rpc-url $ROBINHOOD_RPC_URL
///         Usage (broadcast):
///           forge script script/DeployDn404Lane.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///             --broadcast --private-key $DEV_PRIVATE_KEY
contract DeployDn404Lane is Script {
    // ============================================================
    // Errors — every gate that would leave the lane half-wired.
    // ============================================================
    error DeployDn404Lane__NoLiveBook();
    error DeployDn404Lane__NoFlywheelBook();
    error DeployDn404Lane__NoRouterBook();
    error DeployDn404Lane__NoNftBook();
    error DeployDn404Lane__ZeroUru();
    error DeployDn404Lane__ZeroKeeper();
    error DeployDn404Lane__ZeroTreasury();

    // ============================================================
    // Defaults — every DN404 v4 pool uses the same fee tier + tick
    // spacing as the V10 stack unless overridden via env vars so pool
    // ids line up cleanly in the indexer.
    // ============================================================
    uint24 internal constant DEFAULT_GRAD_FEE = 3000;
    int24 internal constant DEFAULT_GRAD_TICK_SPACING = 60;

    struct Inputs {
        address admin;
        address uru;
        address uruSink;
        address feeSplitter;
        address loyaltyOracle;
        address v10CurveFactory;
        address poolManager;
        address nftFactory;
        address taxKeeper;
        address taxKeeperTreasury;
        address gradHook;
        uint24 gradFee;
        int24 gradTickSpacing;
    }

    struct Deployed {
        address pairCurrencyAllowlist;
        address taxAllowlist;
        address baseImpl;
        address mirrorImpl;
        address taxImpl;
        address bondingCurveImpl;
        address curveFactory;
        address graduator;
        address launchFactory;
        bool v10Trusted;
    }

    function run() external returns (Deployed memory out) {
        Inputs memory i = _readInputs();

        vm.startBroadcast();

        // -- 1..2: registries. Constructed empty; governance populates via
        //         setAllowedBatch post-deploy. Keeps this script authority-
        //         scoped to code, not policy.
        out.pairCurrencyAllowlist = address(
            new Dn404PairCurrencyAllowlist(i.admin, new address[](0), new string[](0))
        );
        out.taxAllowlist = address(
            new Dn404TaxAllowlist(i.admin, new address[](0), new string[](0))
        );

        // -- 3..6: cloneable impls + curve impl. Their runtime code hashes
        //         pin the launch factory in step (c), so read via .code.
        out.baseImpl = address(new Dn404Template());
        out.mirrorImpl = address(new Dn404MirrorTemplate());
        out.taxImpl = address(new Dn404TaxTemplate());
        out.bondingCurveImpl = address(new Dn404BondingCurve());

        // -- 7: DN404 curve factory. Owner = admin (governance can rotate
        //       defaults / allowlist / trusted routers later). feeReceiver
        //       piggybacks on the V10 FeeReceiver so per-trade fees stream
        //       into the same sink the ERC-20 lane already uses.
        Dn404CurveFactory dn404Cf = new Dn404CurveFactory(
            i.admin,
            i.feeSplitter,
            out.bondingCurveImpl,
            IDn404PairCurrencyAllowlist(out.pairCurrencyAllowlist)
        );
        out.curveFactory = address(dn404Cf);

        // -- 8: Graduator wired to the same PoolManager as the ERC-20 lane
        //       so a graduated DN404 pair lives alongside every other RH
        //       pool. Hook defaults to zero (no MHH) — v1 policy; if the
        //       operator wants a hook, DN404_GRAD_HOOK env supplies it.
        Dn404Graduator grad = new Dn404Graduator(
            IPoolManager(i.poolManager),
            IHooks(i.gradHook),
            i.gradFee,
            i.gradTickSpacing,
            address(dn404Cf),
            i.admin
        );
        out.graduator = address(grad);

        // -- 9: LaunchFactory. Constructor reads NftLaunchFactory.minUruFee
        //       and seeds our URU floor at 2× that value (SPEC decision #2).
        //       nftFactory==0 leaves the floor unset and requires a later
        //       setUruConfig — supported but not the intended path.
        Dn404LaunchFactory lf = new Dn404LaunchFactory(i.admin, i.nftFactory);
        out.launchFactory = address(lf);

        // -- a: point DN404 curve factory at the graduator we just deployed.
        dn404Cf.setGraduator(address(grad));
        // -- b: trust the launch factory on the DN404 curve factory — every
        //       non-ETH launch routes through this trust bit.
        dn404Cf.setTrustedRouter(address(lf), true);

        // -- c..d: pin base + mirror impl hashes, then bind the impls. Both
        //         are URU-A08 one-shot on this factory; a future rev needs
        //         a fresh Dn404LaunchFactory deploy.
        lf.setExpectedCodeHashes(keccak256(out.baseImpl.code), keccak256(out.mirrorImpl.code));
        lf.setImpls(out.baseImpl, out.mirrorImpl);

        // -- e: bind the tax-enabled impl (rotatable slot, code-hash pinned
        //       per rotation). Existing launches keep whatever impl they
        //       cloned at launch time; only new tax-on launches see rotations.
        lf.setBaseTaxImpl(out.taxImpl, keccak256(out.taxImpl.code));

        // -- f..g: URU fee + fee splitter wiring. minUruFee from the
        //         constructor's 2× read is preserved — passing minUruFee()
        //         back in keeps it unchanged.
        lf.setUruConfig(
            FactoryIERC20(i.uru),
            i.uruSink,
            lf.minUruFee(),
            ILoyaltyOracleLike(i.loyaltyOracle)
        );
        lf.setFeeSplitter(i.feeSplitter);

        // -- h..i: both curve factory routes. h wires the ETH path (V10),
        //         i wires the pair-currency path (freshly deployed above).
        lf.setCurveFactory(ICurveFactoryLike(i.v10CurveFactory));
        lf.setDn404CurveFactory(IDn404CurveFactoryLike(address(dn404Cf)));

        // -- j: tax keeper wiring. Required at deploy so the very first
        //       tax-enabled launch has a valid keeper address baked in.
        lf.setTaxWiring(i.taxKeeper, i.taxKeeperTreasury, out.taxAllowlist);

        // -- k (best-effort): trust the launch factory on V10 CF too. Skipped
        //     silently when authority is elsewhere — script logs the exact
        //     follow-up call the V10 CF owner must make.
        IV10CurveFactoryAdmin v10 = IV10CurveFactoryAdmin(i.v10CurveFactory);
        if (v10.trustedRouters(address(lf))) {
            out.v10Trusted = true;
        } else if (v10.owner() == msg.sender) {
            v10.setTrustedRouter(address(lf), true);
            out.v10Trusted = true;
        } else {
            out.v10Trusted = false;
        }

        vm.stopBroadcast();

        _writeBook(vm.toString(block.chainid), out, i);
        _logSummary(out, i);
    }

    // ============================================================
    // Inputs
    // ============================================================

    function _readInputs() internal view returns (Inputs memory i) {
        string memory chainId = vm.toString(block.chainid);

        string memory livePath = string.concat("deployment-live-rh.", chainId, ".json");
        string memory flywheelPath = string.concat("deployment-flywheel.", chainId, ".json");
        string memory routerPath = string.concat("deployment.", chainId, ".json");
        string memory nftPath = string.concat("deployment-nft.", chainId, ".json");
        if (!vm.exists(livePath)) revert DeployDn404Lane__NoLiveBook();
        if (!vm.exists(flywheelPath)) revert DeployDn404Lane__NoFlywheelBook();
        if (!vm.exists(routerPath)) revert DeployDn404Lane__NoRouterBook();
        if (!vm.exists(nftPath)) revert DeployDn404Lane__NoNftBook();

        string memory liveJson = vm.readFile(livePath);
        string memory flywheelJson = vm.readFile(flywheelPath);
        string memory routerJson = vm.readFile(routerPath);
        string memory nftJson = vm.readFile(nftPath);

        i.admin = vm.envOr("ADMIN", msg.sender);
        i.uru = vm.envAddress("URU_TOKEN_ADDRESS");
        if (i.uru == address(0)) revert DeployDn404Lane__ZeroUru();
        i.taxKeeper = vm.envAddress("DN404_TAX_KEEPER");
        if (i.taxKeeper == address(0)) revert DeployDn404Lane__ZeroKeeper();
        i.taxKeeperTreasury = vm.envAddress("DN404_TAX_TREASURY");
        if (i.taxKeeperTreasury == address(0)) revert DeployDn404Lane__ZeroTreasury();

        i.gradHook = vm.envOr("DN404_GRAD_HOOK", address(0));
        i.gradFee = uint24(vm.envOr("DN404_GRAD_FEE", uint256(DEFAULT_GRAD_FEE)));
        i.gradTickSpacing =
            int24(int256(vm.envOr("DN404_GRAD_TICKSPACING", uint256(uint24(DEFAULT_GRAD_TICK_SPACING)))));

        i.v10CurveFactory = vm.parseJsonAddress(liveJson, ".curveFactory");
        i.poolManager = vm.parseJsonAddress(liveJson, ".poolManager");
        i.feeSplitter = vm.parseJsonAddress(flywheelJson, ".FeeSplitter");
        i.loyaltyOracle = vm.parseJsonAddress(flywheelJson, ".LoyaltyOracle");
        i.uruSink = vm.parseJsonAddress(routerJson, ".UruDepositSink");
        i.nftFactory = vm.parseJsonAddress(nftJson, ".NftLaunchFactory");
    }

    // ============================================================
    // Address book
    // ============================================================

    function _writeBook(
        string memory chainId,
        Deployed memory d,
        Inputs memory i
    ) internal {
        string memory obj = "dn404Deploy";
        vm.serializeAddress(obj, "Dn404PairCurrencyAllowlist", d.pairCurrencyAllowlist);
        vm.serializeAddress(obj, "Dn404TaxAllowlist", d.taxAllowlist);
        vm.serializeAddress(obj, "Dn404Template", d.baseImpl);
        vm.serializeAddress(obj, "Dn404MirrorTemplate", d.mirrorImpl);
        vm.serializeAddress(obj, "Dn404TaxTemplate", d.taxImpl);
        vm.serializeAddress(obj, "Dn404BondingCurveImpl", d.bondingCurveImpl);
        vm.serializeAddress(obj, "Dn404CurveFactory", d.curveFactory);
        vm.serializeAddress(obj, "Dn404Graduator", d.graduator);
        vm.serializeAddress(obj, "Dn404LaunchFactory", d.launchFactory);
        // Cross-refs to the V10 stack this lane wires against; captured
        // so a future full-circle audit can diff against live state.
        vm.serializeAddress(obj, "V10CurveFactory", i.v10CurveFactory);
        vm.serializeAddress(obj, "PoolManager", i.poolManager);
        vm.serializeAddress(obj, "FeeSplitter", i.feeSplitter);
        vm.serializeAddress(obj, "LoyaltyOracle", i.loyaltyOracle);
        vm.serializeAddress(obj, "URU", i.uru);
        vm.serializeAddress(obj, "UruDepositSink", i.uruSink);
        vm.serializeAddress(obj, "NftLaunchFactory", i.nftFactory);
        vm.serializeAddress(obj, "TaxKeeper", i.taxKeeper);
        vm.serializeAddress(obj, "TaxKeeperTreasury", i.taxKeeperTreasury);
        vm.serializeAddress(obj, "GradHook", i.gradHook);
        vm.serializeUint(obj, "GradFee", uint256(i.gradFee));
        vm.serializeInt(obj, "GradTickSpacing", int256(i.gradTickSpacing));
        string memory finalJson = vm.serializeBool(obj, "V10TrustedRouterSet", d.v10Trusted);

        string memory path = string.concat("deployment-dn404.", chainId, ".json");
        vm.writeFile(path, finalJson);
        console2.log("wrote", path);
    }

    function _logSummary(
        Deployed memory d,
        Inputs memory i
    ) internal pure {
        console2.log("=== DN404 Lane Deployed ===");
        console2.log("pairCurrencyAllowlist", d.pairCurrencyAllowlist);
        console2.log("taxAllowlist         ", d.taxAllowlist);
        console2.log("baseImpl             ", d.baseImpl);
        console2.log("mirrorImpl           ", d.mirrorImpl);
        console2.log("taxImpl              ", d.taxImpl);
        console2.log("bondingCurveImpl     ", d.bondingCurveImpl);
        console2.log("dn404CurveFactory    ", d.curveFactory);
        console2.log("dn404Graduator       ", d.graduator);
        console2.log("dn404LaunchFactory   ", d.launchFactory);
        console2.log("---");
        console2.log("v10CurveFactory      ", i.v10CurveFactory);
        console2.log("v10TrustedRouterSet  ", d.v10Trusted);
        if (!d.v10Trusted) {
            console2.log("---");
            console2.log("FOLLOW-UP REQUIRED (V10 CurveFactory owner):");
            console2.log("  CurveFactory(v10).setTrustedRouter(dn404LaunchFactory, true)");
            console2.log("  before any ETH-paired DN404 launch will succeed.");
        }
        console2.log("---");
        console2.log("NEXT STEPS (governance):");
        console2.log("  Dn404PairCurrencyAllowlist.setAllowedBatch(tokens, labels)");
        console2.log("     seed: URU, WETH (if paired), plus RH stock tokens");
        console2.log("  Dn404TaxAllowlist.setAllowedBatch(tokens, labels)");
        console2.log("     seed: URU + any BuyAllowedToken destinations");
    }
}
