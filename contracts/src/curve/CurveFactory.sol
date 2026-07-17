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
        defaultCurveSupply = curveSupply_;
        defaultVirtualTokenReserve = virtualTokenReserve_;
        defaultVirtualEthReserve = virtualEthReserve_;
        defaultGraduationTargetEth = graduationTargetEth_;
        defaultTradeFeeBps = tradeFeeBps_;
        emit DefaultsSet(curveSupply_, virtualTokenReserve_, virtualEthReserve_, graduationTargetEth_, tradeFeeBps_);
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
        graduator = graduator_; // zero is allowed — disables v4 graduation
        emit GraduatorSet(graduator_);
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
        return _createCurve(token, antiSniperBlocks, buybackBurnBps, launcher);
    }

    /// @notice Owner may reserve-carve future launches by adjusting `defaultCurveSupply`.
    ///         Existing curves are unaffected (each stores its own curveSupply on-chain).
    function setDefaultCurveSupply(
        uint256 curveSupply_
    ) external onlyOwner {
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

    function predictCurveAddress(
        address token
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }
}
