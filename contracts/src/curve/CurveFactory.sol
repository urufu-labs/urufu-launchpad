// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondingCurve} from "./BondingCurve.sol";

/// @title  CurveFactory
/// @notice Deploys a `BondingCurve` clone for each launched token via EIP-1167. The caller
///         (usually the token owner, immediately after Router.launch) transfers `curveSupply`
///         tokens into the clone and starts trading. One curve per token — the factory tracks
///         the mapping so the trade page can look up the curve for any token address.
/// @dev    The curve template is pinned at deploy time; `setImpl` is intentionally omitted so
///         the on-chain topology is immutable-once-registered, matching the Phase 1 factory
///         pattern. Fee params (bps, graduation target, virtual reserves) come from the
///         factory owner via `setDefaults` — one shape for the whole platform, MVP-scope.
contract CurveFactory is Ownable {
    error CurveFactory__ZeroAddress();
    error CurveFactory__CurveExists(address token);
    error CurveFactory__NotEnoughSupply(uint256 requested, uint256 balance);
    /// createCurveWithConfigFor / createCurveWithConfigForWl were reachable by
    /// arbitrary callers, letting anyone install themselves as launcher / v4
    /// pool creator on a curveless token (siphoning post-graduation fees) or
    /// squat curveFor[token] to permanently block the intended curve. Gated
    /// to the trusted-router whitelist that already exists for the
    /// tx.origin-recording flow.
    error CurveFactory__UntrustedRouter(address caller);
    /// Reserve-backed modules (Airdrop / Vesting / Staking) combined took MORE
    /// than half of `defaultCurveSupply`, starving the curve. Enforced at
    /// _createCurve time: the balance Router hands us must be >= half of the
    /// intended supply. This is the on-chain backstop against the "launcher
    /// airdrops themselves 90% of supply" rug pattern — the frontend also caps
    /// combined module allocation at 200M, but a hand-crafted tx bypassing
    /// the UI is still blocked here.
    error CurveFactory__ModulesOverAllocated(uint256 supplyReceived, uint256 minRequired);
    /// setDefaults validation — one bad admin call would otherwise brick every
    /// future launch with under/overflow, division-by-zero, or an unreachable
    /// graduation target. Enforced at the mutable setter AND mirrored in
    /// BondingCurve._init as defense in depth.
    error CurveFactory__InvalidTradeFee(uint16 provided, uint16 max);
    error CurveFactory__InvalidCurveSupply();
    error CurveFactory__InvalidVirtualTokenReserve();
    error CurveFactory__InvalidVirtualEthReserve();
    error CurveFactory__InvalidGraduationTarget();
    /// `graduationTargetEth` must be strictly less than the maximum ETH the
    /// curve can accumulate before its token side exhausts. Otherwise buys
    /// exhaust the token reserve first and `_graduate` never fires — every
    /// buyer sits stuck in bonding phase with the curve fully drained of
    /// tokens but ETH short of the target.
    error CurveFactory__UnreachableGraduationTarget(uint256 target, uint256 maxReachable);
    /// URU-A05: bonding curve requires a live Graduator contract at creation time.
    /// address(0) would let the curve mark itself graduated but never move ETH to a
    /// v4 pool, permanently stranding funds. Blocked at both `setGraduator` and every
    /// curve-creation entrypoint.
    error CurveFactory__GraduatorUnset();
    error CurveFactory__GraduatorNotContract(address graduator);
    /// URU-A11 tangent: constrain the safety-margin setter so admin can't set 0 (no
    /// margin) or >= 5000 bps (target below half of reachable, making launches
    /// effectively impossible).
    error CurveFactory__BadSafetyMargin(uint16 bps);

    /// Hard cap on the per-trade fee. 30% is deep into "rug-shaped" territory
    /// already; anything above is almost certainly an admin typo. Kept as a
    /// constant for defense-in-depth mirroring in BondingCurve._init.
    uint16 public constant MAX_TRADE_FEE_BPS = 3000;

    event CurveCreated(address indexed token, address indexed curve, address indexed launcher);
    event DefaultsSet(
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps
    );
    event FeeReceiverSet(address feeReceiver);
    event GraduatorSet(address graduator);
    event TrustedRouterSet(address indexed router, bool trusted);

    address public immutable implementation;

    address public feeReceiver;
    address public graduator;
    uint256 public defaultCurveSupply;
    uint256 public defaultVirtualTokenReserve;
    uint256 public defaultVirtualEthReserve;
    uint256 public defaultGraduationTargetEth;
    uint16 public defaultTradeFeeBps;

    /// URU-A03: reachability check must leave a safety margin so an actual buy
    /// that crosses the target doesn't trip `BondingCurve__ExceedsSupply` at
    /// the graduation buy itself. Default 500 bps (5%) — target must be at
    /// least 5% below theoretical max. Owner-tunable via
    /// `setGraduationSafetyMarginBps`.
    uint16 public graduationSafetyMarginBps = 500;

    mapping(address token => address curve) public curveFor;

    /// Owner-maintained whitelist of trusted routers that are allowed to trigger
    /// the tx.origin launcher-recording fallback in `createCurveWithConfig`. A
    /// contract NOT on this list calling `createCurveWithConfig` gets recorded as
    /// the launcher itself (msg.sender) — preventing an arbitrary intermediate
    /// contract from spoofing tx.origin to smear a doxxed address as the
    /// launcher of a scam token.
    mapping(address router => bool trusted) public trustedRouters;

    constructor(
        address owner_,
        address feeReceiver_,
        address curveImpl
    ) {
        if (owner_ == address(0) || feeReceiver_ == address(0) || curveImpl == address(0)) {
            revert CurveFactory__ZeroAddress();
        }
        _initializeOwner(owner_);
        implementation = curveImpl;
        feeReceiver = feeReceiver_;

        // Sepolia-friendly defaults — mainnet deploy overrides via setDefaults. Constraint:
        // graduationTargetEth < curveSupply * virtualEth / virtualToken so the curve doesn't
        // exhaust before graduation. Here: 4 < 800M*5/800M = 5, ~89M tokens remain at grad.
        defaultCurveSupply = 800_000_000e18;
        defaultVirtualTokenReserve = 800_000_000e18;
        defaultVirtualEthReserve = 5 ether;
        defaultGraduationTargetEth = 4 ether;
        defaultTradeFeeBps = 100; // 1%
    }

    function setDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_
    ) external onlyOwner {
        _validateCurveDefaults(
            curveSupply_, virtualTokenReserve_, virtualEthReserve_, graduationTargetEth_, tradeFeeBps_
        );
        defaultCurveSupply = curveSupply_;
        defaultVirtualTokenReserve = virtualTokenReserve_;
        defaultVirtualEthReserve = virtualEthReserve_;
        defaultGraduationTargetEth = graduationTargetEth_;
        defaultTradeFeeBps = tradeFeeBps_;
        emit DefaultsSet(curveSupply_, virtualTokenReserve_, virtualEthReserve_, graduationTargetEth_, tradeFeeBps_);
    }

    /// Shared validation for both `setDefaults` and any future per-curve override
    /// path. Enforces: non-zero supply + reserves, fee within cap, and — the one
    /// that actually catches admin typos — that the graduation target is
    /// mathematically reachable given the virtual-reserve shape. Without the
    /// reachability check, `graduationTargetEth = 1_000_000 ether` with the
    /// current chunky defaults would let buyers drain the whole token side
    /// while ethReserve was still short of the target, stranding the curve
    /// forever.
    function _validateCurveDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_
    ) internal view {
        if (tradeFeeBps_ > MAX_TRADE_FEE_BPS) {
            revert CurveFactory__InvalidTradeFee(tradeFeeBps_, MAX_TRADE_FEE_BPS);
        }
        if (curveSupply_ == 0) revert CurveFactory__InvalidCurveSupply();
        if (virtualTokenReserve_ == 0) revert CurveFactory__InvalidVirtualTokenReserve();
        if (virtualEthReserve_ == 0) revert CurveFactory__InvalidVirtualEthReserve();
        if (graduationTargetEth_ == 0) revert CurveFactory__InvalidGraduationTarget();
        // Reachability: max ETH the curve can accumulate before its token side
        // fully drains is `curveSupply * virtualEth / virtualToken`. All values
        // are ~1e26 max in practice; the intermediate product stays well under
        // 2^256 (worst realistic case: 1e27 * 1e19 = 1e46, uint256 fits 1.16e77).
        //
        // URU-A03: apply a safety margin so the buy that CROSSES the target has
        // headroom against `tokenReserve - 1` (the new no-clamp floor in
        // BondingCurve.buy). Otherwise a target sitting at exactly the maximum
        // would revert BondingCurve__ExceedsSupply on the graduation buy itself.
        uint256 maxReachable = (curveSupply_ * virtualEthReserve_) / virtualTokenReserve_;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(graduationSafetyMarginBps))) / 10_000;
        if (graduationTargetEth_ >= safeReachable) {
            revert CurveFactory__UnreachableGraduationTarget(graduationTargetEth_, maxReachable);
        }
    }

    function setFeeReceiver(
        address feeReceiver_
    ) external onlyOwner {
        if (feeReceiver_ == address(0)) revert CurveFactory__ZeroAddress();
        feeReceiver = feeReceiver_;
        emit FeeReceiverSet(feeReceiver_);
    }

    function setGraduator(
        address graduator_
    ) external onlyOwner {
        // URU-A05: zero-graduator is NEVER a valid production state. A curve
        // deployed with graduator=0 marks itself graduated on target crossing
        // but skips the ETH → v4 pool transfer, stranding reserves. Rejected
        // here + at every curve-creation entrypoint via `_requireGraduator`.
        if (graduator_ == address(0)) revert CurveFactory__GraduatorUnset();
        if (graduator_.code.length == 0) revert CurveFactory__GraduatorNotContract(graduator_);
        graduator = graduator_;
        emit GraduatorSet(graduator_);
    }

    /// URU-A03: tune the reachability safety margin. Bounded (0, 5000) bps
    /// so admin cannot disable it (0) or make targets unreachable (>= 5000).
    /// Revalidates the current defaults so a tighter margin never leaves a
    /// live-invalid tuple in storage.
    function setGraduationSafetyMarginBps(
        uint16 bps
    ) external onlyOwner {
        if (bps == 0 || bps >= 5000) revert CurveFactory__BadSafetyMargin(bps);
        graduationSafetyMarginBps = bps;
        _validateCurveDefaults(
            defaultCurveSupply,
            defaultVirtualTokenReserve,
            defaultVirtualEthReserve,
            defaultGraduationTargetEth,
            defaultTradeFeeBps
        );
    }

    /// @notice Add or remove a router from the tx.origin-fallback whitelist.
    ///         Only whitelisted routers may cause `createCurveWithConfig` to
    ///         record `tx.origin` (rather than `msg.sender`) as the launcher.
    ///         Any non-whitelisted contract calling `createCurveWithConfig`
    ///         records itself as the launcher — safe by construction.
    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external onlyOwner {
        trustedRouters[router_] = trusted_;
        emit TrustedRouterSet(router_, trusted_);
    }

    /// @notice Deploy a curve for `token` with default (no-op) hook config. Convenience
    ///         wrapper for callers that don't care about anti-sniper / buyback-burn.
    ///         Launcher defaults to `msg.sender` — right for direct callers, wrong for
    ///         Router-mediated launches (Router should use `createCurveWithConfigFor`
    ///         to pass the actual user address).
    function createCurve(
        address token
    ) external returns (address curve) {
        return _createCurve(token, 0, 0, msg.sender);
    }

    /// @notice Deploy a curve for `token` with per-launch hook config. `antiSniperBlocks`
    ///         and `buybackBurnBps` are forwarded to the Graduator at graduation time and
    ///         from there into MultiHookHost.setPoolConfig for the resulting v4 pool.
    ///         Bounded server-side by MultiHookHost's MAX_BUYBACK_BPS (2000 = 20%).
    ///         Launcher defaults to `msg.sender` — Router callers must use
    ///         `createCurveWithConfigFor` instead so the actual EOA is recorded.
    function createCurveWithConfig(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps
    ) external returns (address curve) {
        // Router-compatibility fallback for the legacy 3-arg API. If the caller
        // is a contract on the trusted-routers whitelist, record `tx.origin`
        // (the real EOA that initiated the tx) as launcher — otherwise Router
        // itself would be stored, cascading into the V3 hook stamping Router as
        // per-pool creator at graduation and creator-share swap fees getting
        // stuck. WHITELIST-GATED so an arbitrary intermediate contract cannot
        // spoof tx.origin: a non-whitelisted contract calling us records itself
        // as launcher, harmless. NOT used for auth — only for creator recording.
        address launcher = trustedRouters[msg.sender] ? tx.origin : msg.sender;
        return _createCurve(token, antiSniperBlocks, buybackBurnBps, launcher);
    }

    /// @notice Router-facing variant that records an explicit launcher address rather
    ///         than the immediate `msg.sender`. Called by Router.launch so the launcher
    ///         is the actual end-user, not the Router contract itself. The recorded
    ///         launcher is passed to the Graduator at graduation and becomes the pool's
    ///         per-pool creator on the v4 hook.
    function createCurveWithConfigFor(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve) {
        // Explicit-launcher path is Router-only. Without this gate, any
        // caller could pass an arbitrary `launcher` address and steal
        // creator-fee attribution on curveless tokens (or squat the mapping).
        if (!trustedRouters[msg.sender]) revert CurveFactory__UntrustedRouter(msg.sender);
        return _createCurve(token, antiSniperBlocks, buybackBurnBps, launcher);
    }

    /// @notice Router-facing whitelist variant. Same as `createCurveWithConfigFor` but
    ///         initializes the curve with a Merkle-root whitelist + reserved slice.
    ///         Callers pass a `WhitelistInit` struct with the root, reserved-token
    ///         count, per-address cap, fallback timestamp, and source-project
    ///         transparency fields. See `BondingCurve.WhitelistInit` for the shape.
    function createCurveWithConfigForWl(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        BondingCurve.WhitelistInit calldata wl
    ) external returns (address curve) {
        // Same gating rationale as createCurveWithConfigFor above — this WL
        // variant also accepts an arbitrary `launcher` and cannot be
        // permissionless.
        if (!trustedRouters[msg.sender]) revert CurveFactory__UntrustedRouter(msg.sender);
        return _createCurveWl(token, antiSniperBlocks, buybackBurnBps, launcher, wl);
    }

    /// @notice Owner may reserve-carve future launches by adjusting `defaultCurveSupply`.
    ///         Existing curves are unaffected (each stores its own curveSupply on-chain).
    ///         URU-A03: previously this setter skipped `_validateCurveDefaults`,
    ///         allowing an admin to lower supply below the reachability threshold and
    ///         silently make every future launch unable to graduate. Now every mutation
    ///         validates the FULL tuple against the current defaults.
    function setDefaultCurveSupply(
        uint256 curveSupply_
    ) external onlyOwner {
        _validateCurveDefaults(
            curveSupply_,
            defaultVirtualTokenReserve,
            defaultVirtualEthReserve,
            defaultGraduationTargetEth,
            defaultTradeFeeBps
        );
        defaultCurveSupply = curveSupply_;
    }

    function _createCurve(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) internal returns (address curve) {
        if (token == address(0)) revert CurveFactory__ZeroAddress();
        if (curveFor[token] != address(0)) revert CurveFactory__CurveExists(token);

        // V2 reserve-backed modules (Airdrop / Vesting / Staking) carve their
        // allocation out of the token's initial supply during token.initialize(),
        // BEFORE the tokens reach the curve. That means Router's balance here is
        // (defaultCurveSupply - Σ module allocations), not the hardcoded default.
        // Pull whatever is actually there — the curve auto-adjusts to a smaller pool
        // with the same virtual reserves, so the initial curve price is
        // proportionally higher (fewer tokens available → each is worth more), which
        // is exactly what a launcher who carved out reserves is opting into.
        uint256 supply = IERC20(token).balanceOf(msg.sender);
        if (supply == 0) revert CurveFactory__NotEnoughSupply(defaultCurveSupply, 0);
        // Cap: combined reserve-backed-module allocations may not consume more
        // than half of the intended curve supply. Prevents a launcher from
        // airdropping/vesting/staking themselves 90%+ of supply and starving
        // the curve.
        uint256 minSupply = defaultCurveSupply / 2;
        if (supply < minSupply) revert CurveFactory__ModulesOverAllocated(supply, minSupply);
        // URU-A05: refuse to bind a curve to a Graduator that isn't a live contract.
        _requireGraduator();
        // URU-A03: previously reachability was validated against the CONFIGURED
        // `defaultCurveSupply`. Reserve-backed modules (Vesting, Staking) can
        // reduce the ACTUAL curve supply to as little as 50% of that. Validate
        // reachability using the ACTUAL balance received from the caller.
        _validateActualSupply(supply);

        // Deterministic clone address per (token, chainid) — same predictability as
        // Phase 1's ImplRegistry.
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);

        curveFor[token] = curve;

        // Pull tokens from caller into curve, then initialize.
        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);

        BondingCurve(payable(curve))
            .initialize(
                token,
                feeReceiver,
                supply,
                defaultVirtualTokenReserve,
                defaultVirtualEthReserve,
                defaultGraduationTargetEth,
                defaultTradeFeeBps,
                graduator,
                antiSniperBlocks,
                buybackBurnBps,
                launcher
            );

        emit CurveCreated(token, curve, launcher);
    }

    /// Mirror of `_createCurve` for whitelist-enabled launches. Same setup — clone,
    /// register, pull tokens — but calls `initializeWithWhitelist` on the clone so the
    /// whitelist storage is populated in the same tx as base curve init.
    function _createCurveWl(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        BondingCurve.WhitelistInit calldata wl
    ) internal returns (address curve) {
        if (token == address(0)) revert CurveFactory__ZeroAddress();
        if (curveFor[token] != address(0)) revert CurveFactory__CurveExists(token);

        uint256 supply = IERC20(token).balanceOf(msg.sender);
        if (supply == 0) revert CurveFactory__NotEnoughSupply(defaultCurveSupply, 0);
        // Same cap as _createCurve — see comment there for rationale.
        uint256 minSupply = defaultCurveSupply / 2;
        if (supply < minSupply) revert CurveFactory__ModulesOverAllocated(supply, minSupply);
        // URU-A05 + URU-A03: same live-graduator + actual-supply reachability
        // checks as the non-WL path.
        _requireGraduator();
        _validateActualSupply(supply);

        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);
        curveFor[token] = curve;

        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);

        BondingCurve(payable(curve))
            .initializeWithWhitelist(
                token,
                feeReceiver,
                supply,
                defaultVirtualTokenReserve,
                defaultVirtualEthReserve,
                defaultGraduationTargetEth,
                defaultTradeFeeBps,
                graduator,
                antiSniperBlocks,
                buybackBurnBps,
                launcher,
                wl
            );

        emit CurveCreated(token, curve, launcher);
    }

    function predictCurveAddress(
        address token
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// URU-A05: internal guard used at every curve-creation entrypoint. Every
    /// production curve MUST bind to a live Graduator contract at deploy time.
    function _requireGraduator() internal view {
        address g = graduator;
        if (g == address(0)) revert CurveFactory__GraduatorUnset();
        if (g.code.length == 0) revert CurveFactory__GraduatorNotContract(g);
    }

    /// URU-A03: validate reachability using the ACTUAL token balance received
    /// from the caller (post-reserve-carve), not the nominal `defaultCurveSupply`.
    /// Reserve-backed modules can reduce the curve's true starting balance to
    /// half of nominal; without this check a config that satisfied
    /// `_validateCurveDefaults` at admin-set time could still land a curve
    /// whose max reachable ETH is below `defaultGraduationTargetEth`.
    function _validateActualSupply(
        uint256 actualSupply
    ) internal view {
        uint256 maxReachable = (actualSupply * defaultVirtualEthReserve) / defaultVirtualTokenReserve;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(graduationSafetyMarginBps))) / 10_000;
        if (defaultGraduationTargetEth >= safeReachable) {
            revert CurveFactory__UnreachableGraduationTarget(defaultGraduationTargetEth, maxReachable);
        }
    }
}
