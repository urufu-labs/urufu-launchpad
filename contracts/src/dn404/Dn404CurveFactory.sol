// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 curve factory
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    factory for the DN404 lane's ERC-20-pair bonding curves.  V10
 *    stays untouched and continues to serve every ETH-paired ERC-20
 *    launch through Router.launch.  this factory is the only path
 *    that reaches Dn404BondingCurve, and only Dn404LaunchFactory
 *    is a trusted router on it.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Dn404BondingCurve} from "./Dn404BondingCurve.sol";

interface IDn404PairCurrencyAllowlist {
    function isAllowed(address token) external view returns (bool);
}

/// @title  Dn404CurveFactory
/// @notice DN404-lane counterpart to `contracts/src/curve/CurveFactory.sol`
///         (V10). Same shape: clones a bonding-curve impl per token,
///         gates trusted-router entrypoints, tracks curveFor + supports
///         WL launches. Only difference: every entrypoint takes an
///         explicit `pairCurrency` argument, validated against
///         `Dn404PairCurrencyAllowlist` before curve creation.
///
/// @dev **Firewall (see feedback_dn404_no_erc20_touch.md):** this file
///      lives under `contracts/src/dn404/`, and V10 CurveFactory at
///      `contracts/src/curve/CurveFactory.sol` is never modified. The
///      two factories run in parallel — Router.launch(ERC-20) → V10;
///      Dn404LaunchFactory.launch(non-ETH pair) → this. They share no
///      storage, no state, no code path.
///
/// @dev Notable simplifications vs. V10:
///      - No `createCurve` (permissionless zero-config wrapper) — DN404
///        curves always flow through the trusted-router path so the
///        launcher on the curve is the actual EOA, not the factory
///      - No `createCurveWithConfig` (legacy 3-arg API + tx.origin
///        fallback) — DN404 factory always provides explicit launcher
///      - No `UnverifiedCurveCreated` event — all curves here are
///        canonical DN404 launches by construction
///
/// @dev Defaults (curveSupply / virtualTokenReserve / virtualPairReserve
///      / graduationTargetPair / tradeFeeBps) are owner-managed. Note
///      that the "pair" units differ across pair currencies — a USDG
///      pair's "4 pair units to graduate" is $4, whereas an NVDA pair's
///      "4 pair units" is worth ~$500. Governance rotates defaults per
///      pair-currency scale, OR the owner picks one middle-ground set
///      and each launcher accepts it. v1.1 may add per-launch reserve
///      overrides to Dn404LaunchFactory.LaunchParams.
contract Dn404CurveFactory is Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404CurveFactory__ZeroAddress();
    error Dn404CurveFactory__CurveExists(address token);
    error Dn404CurveFactory__NotEnoughSupply(uint256 requested, uint256 balance);
    error Dn404CurveFactory__UntrustedRouter(address caller);
    error Dn404CurveFactory__ModulesOverAllocated(uint256 supplyReceived, uint256 minRequired);
    error Dn404CurveFactory__InvalidTradeFee(uint16 provided, uint16 max);
    error Dn404CurveFactory__InvalidCurveSupply();
    error Dn404CurveFactory__InvalidVirtualTokenReserve();
    error Dn404CurveFactory__InvalidVirtualPairReserve();
    error Dn404CurveFactory__InvalidGraduationTarget();
    error Dn404CurveFactory__UnreachableGraduationTarget(uint256 target, uint256 maxReachable);
    error Dn404CurveFactory__GraduatorUnset();
    error Dn404CurveFactory__GraduatorNotContract(address graduator);
    error Dn404CurveFactory__BadSafetyMargin(uint16 bps);
    /// New vs. V10: pair currency must be non-zero and on the allowlist.
    error Dn404CurveFactory__PairCurrencyDisallowed(address pairCurrency);
    error Dn404CurveFactory__PairCurrencyAllowlistUnset();

    uint16 public constant MAX_TRADE_FEE_BPS = 3000;

    event Dn404CurveCreated(
        address indexed token,
        address indexed curve,
        address indexed launcher,
        address pairCurrency
    );
    event DefaultsSet(
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualPairReserve,
        uint256 graduationTargetPair,
        uint16 tradeFeeBps
    );
    event FeeReceiverSet(address feeReceiver);
    event GraduatorSet(address graduator);
    event TrustedRouterSet(address indexed router, bool trusted);
    event PairCurrencyAllowlistSet(address allowlist);

    address public immutable implementation;

    address public feeReceiver;
    address public graduator;
    uint256 public defaultCurveSupply;
    uint256 public defaultVirtualTokenReserve;
    /// Same role as V10's `defaultVirtualEthReserve` — held in pair
    /// currency units, name changed to make the pair-currency-generic
    /// intent obvious. Downstream `Dn404BondingCurve` keeps the V10
    /// storage name `virtualEthReserve` internally for diff clarity.
    uint256 public defaultVirtualPairReserve;
    /// Same role as V10's `defaultGraduationTargetEth` — pair currency
    /// units. See note on scale in the class docstring.
    uint256 public defaultGraduationTargetPair;
    uint16 public defaultTradeFeeBps;

    uint16 public graduationSafetyMarginBps = 500;

    mapping(address token => address curve) public curveFor;

    mapping(address router => bool trusted) public trustedRouters;

    /// The pair currency allowlist contract, owner-rotatable so new
    /// stock tokens can be added without a factory redeploy.
    IDn404PairCurrencyAllowlist public pairCurrencyAllowlist;

    constructor(
        address owner_,
        address feeReceiver_,
        address curveImpl,
        IDn404PairCurrencyAllowlist pairCurrencyAllowlist_
    ) {
        if (owner_ == address(0) || feeReceiver_ == address(0) || curveImpl == address(0)) {
            revert Dn404CurveFactory__ZeroAddress();
        }
        if (address(pairCurrencyAllowlist_) == address(0)) {
            revert Dn404CurveFactory__PairCurrencyAllowlistUnset();
        }
        _initializeOwner(owner_);
        implementation = curveImpl;
        feeReceiver = feeReceiver_;
        pairCurrencyAllowlist = pairCurrencyAllowlist_;

        // Middle-ground defaults intended for stablecoin-scale pair
        // currencies (USDG). Owner is expected to rotate via
        // `setDefaults` if the intended pair-currency scale differs
        // materially. Chosen so a USDG-paired launch graduates at
        // ~4000 USDG with 800M-token supply, matching V10's ETH
        // shape scaled ~1000x for USD terms.
        defaultCurveSupply = 800_000_000e18;
        defaultVirtualTokenReserve = 800_000_000e18;
        defaultVirtualPairReserve = 5_000e18;
        defaultGraduationTargetPair = 4_000e18;
        defaultTradeFeeBps = 100; // 1%

        emit PairCurrencyAllowlistSet(address(pairCurrencyAllowlist_));
    }

    // ============================================================
    // Owner config
    // ============================================================

    function setDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualPairReserve_,
        uint256 graduationTargetPair_,
        uint16 tradeFeeBps_
    ) external onlyOwner {
        _validateCurveDefaults(
            curveSupply_, virtualTokenReserve_, virtualPairReserve_, graduationTargetPair_, tradeFeeBps_
        );
        defaultCurveSupply = curveSupply_;
        defaultVirtualTokenReserve = virtualTokenReserve_;
        defaultVirtualPairReserve = virtualPairReserve_;
        defaultGraduationTargetPair = graduationTargetPair_;
        defaultTradeFeeBps = tradeFeeBps_;
        emit DefaultsSet(
            curveSupply_, virtualTokenReserve_, virtualPairReserve_, graduationTargetPair_, tradeFeeBps_
        );
    }

    function _validateCurveDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualPairReserve_,
        uint256 graduationTargetPair_,
        uint16 tradeFeeBps_
    ) internal view {
        if (tradeFeeBps_ > MAX_TRADE_FEE_BPS) {
            revert Dn404CurveFactory__InvalidTradeFee(tradeFeeBps_, MAX_TRADE_FEE_BPS);
        }
        if (curveSupply_ == 0) revert Dn404CurveFactory__InvalidCurveSupply();
        if (virtualTokenReserve_ == 0) revert Dn404CurveFactory__InvalidVirtualTokenReserve();
        if (virtualPairReserve_ == 0) revert Dn404CurveFactory__InvalidVirtualPairReserve();
        if (graduationTargetPair_ == 0) revert Dn404CurveFactory__InvalidGraduationTarget();
        uint256 maxReachable = (curveSupply_ * virtualPairReserve_) / virtualTokenReserve_;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(graduationSafetyMarginBps))) / 10_000;
        if (graduationTargetPair_ >= safeReachable) {
            revert Dn404CurveFactory__UnreachableGraduationTarget(graduationTargetPair_, maxReachable);
        }
    }

    function setFeeReceiver(
        address feeReceiver_
    ) external onlyOwner {
        if (feeReceiver_ == address(0)) revert Dn404CurveFactory__ZeroAddress();
        feeReceiver = feeReceiver_;
        emit FeeReceiverSet(feeReceiver_);
    }

    function setGraduator(
        address graduator_
    ) external onlyOwner {
        if (graduator_ == address(0)) revert Dn404CurveFactory__GraduatorUnset();
        if (graduator_.code.length == 0) revert Dn404CurveFactory__GraduatorNotContract(graduator_);
        graduator = graduator_;
        emit GraduatorSet(graduator_);
    }

    function setGraduationSafetyMarginBps(
        uint16 bps
    ) external onlyOwner {
        if (bps == 0 || bps >= 5000) revert Dn404CurveFactory__BadSafetyMargin(bps);
        graduationSafetyMarginBps = bps;
        _validateCurveDefaults(
            defaultCurveSupply,
            defaultVirtualTokenReserve,
            defaultVirtualPairReserve,
            defaultGraduationTargetPair,
            defaultTradeFeeBps
        );
    }

    function setTrustedRouter(
        address router_,
        bool trusted_
    ) external onlyOwner {
        trustedRouters[router_] = trusted_;
        emit TrustedRouterSet(router_, trusted_);
    }

    /// @notice Rotate the pair currency allowlist. Allows governance to
    ///         swap the allowlist contract itself (e.g. for a new
    ///         version with additional metadata fields) without a
    ///         factory redeploy. Existing curves are unaffected.
    function setPairCurrencyAllowlist(
        IDn404PairCurrencyAllowlist allowlist_
    ) external onlyOwner {
        if (address(allowlist_) == address(0)) revert Dn404CurveFactory__ZeroAddress();
        pairCurrencyAllowlist = allowlist_;
        emit PairCurrencyAllowlistSet(address(allowlist_));
    }

    // ============================================================
    // Curve creation — trusted-router only
    // ============================================================

    /// @notice Deploy a Dn404BondingCurve clone for `token` priced in
    ///         `pairCurrency`. Only callable by whitelisted routers
    ///         (Dn404LaunchFactory). Caller must have `token` balance
    ///         >= half of `defaultCurveSupply` and must have approved
    ///         this factory to pull it (safeTransferFrom).
    function createCurveWithConfigFor(
        address token,
        address pairCurrency,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external returns (address curve) {
        if (!trustedRouters[msg.sender]) revert Dn404CurveFactory__UntrustedRouter(msg.sender);
        _requirePairAllowed(pairCurrency);
        return _createCurve(token, pairCurrency, antiSniperBlocks, buybackBurnBps, launcher);
    }

    function createCurveWithConfigForWl(
        address token,
        address pairCurrency,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        Dn404BondingCurve.WhitelistInit calldata wl
    ) external returns (address curve) {
        if (!trustedRouters[msg.sender]) revert Dn404CurveFactory__UntrustedRouter(msg.sender);
        _requirePairAllowed(pairCurrency);
        return _createCurveWl(token, pairCurrency, antiSniperBlocks, buybackBurnBps, launcher, wl);
    }

    function setDefaultCurveSupply(
        uint256 curveSupply_
    ) external onlyOwner {
        _validateCurveDefaults(
            curveSupply_,
            defaultVirtualTokenReserve,
            defaultVirtualPairReserve,
            defaultGraduationTargetPair,
            defaultTradeFeeBps
        );
        defaultCurveSupply = curveSupply_;
    }

    // ============================================================
    // Internal
    // ============================================================

    function _createCurve(
        address token,
        address pairCurrency,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) internal returns (address curve) {
        if (token == address(0)) revert Dn404CurveFactory__ZeroAddress();
        if (curveFor[token] != address(0)) revert Dn404CurveFactory__CurveExists(token);

        uint256 supply = IERC20(token).balanceOf(msg.sender);
        if (supply == 0) revert Dn404CurveFactory__NotEnoughSupply(defaultCurveSupply, 0);
        uint256 minSupply = defaultCurveSupply / 2;
        if (supply < minSupply) revert Dn404CurveFactory__ModulesOverAllocated(supply, minSupply);
        _requireGraduator();
        _validateActualSupply(supply);

        // Salt keyed on (token, chainid) matches V10 for parallel-story
        // clarity — predictCurveAddress works the same way in both lanes.
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);

        curveFor[token] = curve;

        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);

        Dn404BondingCurve(curve).initialize(
            token,
            pairCurrency,
            feeReceiver,
            supply,
            defaultVirtualTokenReserve,
            defaultVirtualPairReserve,
            defaultGraduationTargetPair,
            defaultTradeFeeBps,
            graduator,
            antiSniperBlocks,
            buybackBurnBps,
            launcher
        );

        emit Dn404CurveCreated(token, curve, launcher, pairCurrency);
    }

    function _createCurveWl(
        address token,
        address pairCurrency,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        Dn404BondingCurve.WhitelistInit calldata wl
    ) internal returns (address curve) {
        if (token == address(0)) revert Dn404CurveFactory__ZeroAddress();
        if (curveFor[token] != address(0)) revert Dn404CurveFactory__CurveExists(token);

        uint256 supply = IERC20(token).balanceOf(msg.sender);
        if (supply == 0) revert Dn404CurveFactory__NotEnoughSupply(defaultCurveSupply, 0);
        uint256 minSupply = defaultCurveSupply / 2;
        if (supply < minSupply) revert Dn404CurveFactory__ModulesOverAllocated(supply, minSupply);
        _requireGraduator();
        _validateActualSupply(supply);

        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        curve = LibClone.cloneDeterministic(implementation, salt);
        curveFor[token] = curve;

        SafeTransferLib.safeTransferFrom(token, msg.sender, curve, supply);

        Dn404BondingCurve(curve).initializeWithWhitelist(
            token,
            pairCurrency,
            feeReceiver,
            supply,
            defaultVirtualTokenReserve,
            defaultVirtualPairReserve,
            defaultGraduationTargetPair,
            defaultTradeFeeBps,
            graduator,
            antiSniperBlocks,
            buybackBurnBps,
            launcher,
            wl
        );

        emit Dn404CurveCreated(token, curve, launcher, pairCurrency);
    }

    function predictCurveAddress(
        address token
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(token, block.chainid));
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }

    function _requireGraduator() internal view {
        address g = graduator;
        if (g == address(0)) revert Dn404CurveFactory__GraduatorUnset();
        if (g.code.length == 0) revert Dn404CurveFactory__GraduatorNotContract(g);
    }

    function _requirePairAllowed(
        address pairCurrency
    ) internal view {
        // Zero address is invalid for the DN404 curve stack — ETH-paired
        // DN404 launches route through V10 CurveFactory, not this one.
        // (Reject at the factory instead of relying on
        // Dn404BondingCurve.initialize to catch it — surfaces a
        // clearer error to the launcher.)
        if (pairCurrency == address(0)) revert Dn404CurveFactory__PairCurrencyDisallowed(address(0));
        if (!pairCurrencyAllowlist.isAllowed(pairCurrency)) {
            revert Dn404CurveFactory__PairCurrencyDisallowed(pairCurrency);
        }
    }

    function _validateActualSupply(
        uint256 actualSupply
    ) internal view {
        uint256 maxReachable = (actualSupply * defaultVirtualPairReserve) / defaultVirtualTokenReserve;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(graduationSafetyMarginBps))) / 10_000;
        if (defaultGraduationTargetPair >= safeReachable) {
            revert Dn404CurveFactory__UnreachableGraduationTarget(defaultGraduationTargetPair, maxReachable);
        }
    }
}
