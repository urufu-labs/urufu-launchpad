// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Router, ICurveFactoryLike, IERC20Like, IVMFactory} from "src/router/Router.sol";
import {NameRegistry} from "src/registry/NameRegistry.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// Extension of ICurveFactoryLike with the whitelist-aware curve creation entry.
/// Declared here (not in Router.sol) so extending the base Router interface stays
/// scoped to the WL feature.
interface ICurveFactoryWlLike {
    function createCurveWithConfigForWl(
        address token,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher,
        BondingCurve.WhitelistInit calldata wl
    ) external returns (address curve);
}

/// @title  RouterV2
/// @notice Robinhood-only Router that adds a URU-pay entry alongside the inherited
///         ETH-pay `launch`. Users pick their fee currency:
///           - `launch(...)` payable in ETH → forwards to `feeReceiver` (FeeSplitter on RH)
///           - `launchWithURU(...)` pulls URU into `UruDepositSink` → keeper drains URU
///             → ETH → FeeSplitter out-of-band
///
///         Deploy fee pricing in URU is a FRONTEND concern. The contract does not
///         quote a URU price on-chain — it accepts whatever `uruAmount` the caller
///         supplies. This keeps the router simple and defers oracle-manipulation risk
///         to the frontend + a future price-gate upgrade if spam becomes an issue.
///         The frontend reads the URU/WETH v4 pool spot (via StateView) or a TWAP
///         library, converts the current ETH fee to URU-equivalent, and asks the user
///         to approve at least that much.
///
/// @dev    Everything else — factory dispatch, name registry reserve, bonding-curve
///         install, ownership dispatch — is identical to the parent Router.launch()
///         flow. Non-payable on purpose: users on the URU path who accidentally send
///         ETH revert instead of stranding it here.
contract RouterV2 is Router {
    // ============================================================
    // Errors
    // ============================================================
    error RouterV2__ZeroAddress();
    error RouterV2__ZeroURU();
    /// WL variants require `installBondingCurve = true` — there's no curve to
    /// whitelist otherwise. Callers that don't want a curve should use plain
    /// `launch` / `launchWithURU` and set `params.installBondingCurve = false`.
    error RouterV2__WlRequiresBondingCurve();

    // ============================================================
    // Events
    // ============================================================
    /// @dev Paired 1:1 with the standard `Launched` event; joins on `token`. `Launched.feePaid`
    ///      is 0 on URU launches — indexers should read `uruPaid` from here for those.
    event LaunchedInURU(address indexed token, address indexed launchedBy, uint256 uruPaid);

    /// Emitted alongside `Launched` when a whitelist-enabled curve is created. Same
    /// launch = same `token` topic across `Launched`, `LaunchedInURU` (if URU-paid),
    /// and `LaunchedWithWhitelist` (if WL-enabled). Indexers stitch on `token`.
    event LaunchedWithWhitelist(
        address indexed token,
        address indexed launchedBy,
        bytes32 whitelistRoot,
        uint256 reservedTokens,
        uint256 maxWlPerAddress,
        uint64 fallbackTs,
        address sourceTokenAddress,
        uint32 sourceChainId
    );

    // ============================================================
    // Immutables
    // ============================================================
    IERC20Like public immutable uru;
    UruDepositSink public immutable uruSink;

    constructor(
        address initialOwner,
        NameRegistry registry_,
        IFeeReceiver feeReceiver_,
        uint256 erc20Fee_,
        uint256 nftFee_,
        uint256 erc1155Fee_,
        uint256 moduleAddOn_,
        uint256 hookAddOn_,
        uint256 governanceAddOn_,
        address uru_,
        UruDepositSink uruSink_
    )
        Router(
            initialOwner,
            registry_,
            feeReceiver_,
            erc20Fee_,
            nftFee_,
            erc1155Fee_,
            moduleAddOn_,
            hookAddOn_,
            governanceAddOn_
        )
    {
        if (uru_ == address(0) || address(uruSink_) == address(0)) revert RouterV2__ZeroAddress();
        uru = IERC20Like(uru_);
        uruSink = uruSink_;
    }

    /// @notice Launch a new token by paying the deploy fee in URU. Caller must have
    ///         approved this Router for at least `uruAmount` of URU beforehand.
    ///         Non-payable — attach zero ETH.
    /// @dev    Ordering mirrors `launch`: pull fee → factory.deploy → registry.reserve →
    ///         curve install (optional) → ownership dispatch → emit. Reverts on any
    ///         failure and unwinds the whole tx. URU sits in the sink until the keeper
    ///         converts it to ETH → FeeSplitter.
    function launchWithURU(
        LaunchParams calldata params,
        uint256 uruAmount
    ) external nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (uruAmount == 0) revert RouterV2__ZeroURU();

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        // Interactions.
        // Pull URU from user directly into the sink — user must have approved THIS Router.
        // Any excess above the "quoted" ETH-equivalent stays in the sink; the flywheel just
        // gets slightly more. No per-user refund on the URU path.
        SafeTransferLib.safeTransferFrom(address(uru), msg.sender, address(uruSink), uruAmount);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // Same bonding-curve install as parent Router.launch. Router still holds the
        // curve-supply tokens (as initialRecipient) and can approve the factory.
        if (params.installBondingCurve) {
            if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
            if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
            uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
            IERC20Like(token).approve(curveFactory, supply);
            address curve = ICurveFactoryLike(curveFactory)
                .createCurveWithConfigFor(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender);
            emit CurveInstalled(token, curve);
        }

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        // Standard Launched event with feePaid = 0 (no ETH), plus paired URU event.
        emit Launched(
            token, msg.sender, params.base, nameHash, tickerHash, 0, params.installHook, params.installGovernance
        );
        emit LaunchedInURU(token, msg.sender, uruAmount);
    }

    /// @notice Launch a new token with a whitelisted bonding curve, paying the launch
    ///         fee in ETH. Same flow as `launch` but installs the curve via the
    ///         whitelist-aware factory entry, binding a Merkle root + reserved slice.
    /// @dev    Requires `params.installBondingCurve = true`. Curve deploy calls
    ///         `createCurveWithConfigForWl` which initializes the curve with the WL
    ///         payload in the same tx as base init.
    function launchWithWhitelist(
        LaunchParams calldata params,
        BondingCurve.WhitelistInit calldata wl
    ) external payable nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (!params.installBondingCurve) revert RouterV2__WlRequiresBondingCurve();

        uint256 fee = _quoteFor(params, msg.sender);
        if (msg.value < fee) revert Router__InsufficientFee(fee, msg.value);

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        feeReceiver.receiveFee{value: fee}(msg.sender, params.base);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        // WL curve install — the only structural difference from the standard launch flow.
        if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
        if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
        uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
        IERC20Like(token).approve(curveFactory, supply);
        address curve = ICurveFactoryWlLike(curveFactory)
            .createCurveWithConfigForWl(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender, wl);
        emit CurveInstalled(token, curve);

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        uint256 refund = msg.value - fee;
        if (refund > 0) SafeTransferLib.safeTransferETH(msg.sender, refund);

        emit Launched(
            token, msg.sender, params.base, nameHash, tickerHash, fee, params.installHook, params.installGovernance
        );
        emit LaunchedWithWhitelist(
            token,
            msg.sender,
            wl.root,
            wl.reservedTokens,
            wl.maxWlPerAddress,
            wl.fallbackTs,
            wl.sourceTokenAddress,
            wl.sourceChainId
        );
    }

    /// @notice URU-pay variant of `launchWithWhitelist`. Mirrors `launchWithURU`'s
    ///         non-payable + sink-pull semantics + emits `LaunchedInURU`, and installs
    ///         a whitelist-enabled bonding curve via the same factory entry.
    function launchWithURUAndWhitelist(
        LaunchParams calldata params,
        uint256 uruAmount,
        BondingCurve.WhitelistInit calldata wl
    ) external nonReentrant returns (address token) {
        if (paused) revert Router__Paused();
        if (uruAmount == 0) revert RouterV2__ZeroURU();
        if (!params.installBondingCurve) revert RouterV2__WlRequiresBondingCurve();

        address factory = factories[params.base];
        if (factory == address(0)) revert Router__FactoryUnset(params.base);
        if (bytes(params.name).length == 0) revert Router__EmptyName();
        if (bytes(params.ticker).length == 0) revert Router__EmptyTicker();
        if (params.ownership == OwnershipMode.TransferToMultisig && params.ownerTargetIfMultisig == address(0)) {
            revert Router__ZeroAddress();
        }

        SafeTransferLib.safeTransferFrom(address(uru), msg.sender, address(uruSink), uruAmount);

        token = IVMFactory(factory).deploy(params.name, params.ticker, params.configHash, params.initData, msg.sender);
        if (token == address(0)) revert Router__DeployFailed();

        (bytes32 nameHash, bytes32 tickerHash) = registry.reserve(params.name, params.ticker, token, msg.sender);

        if (curveFactory == address(0)) revert Router__CurveFactoryUnset();
        if (params.base != BaseType.ERC20) revert Router__CurveOnlyForERC20();
        uint256 supply = ICurveFactoryLike(curveFactory).defaultCurveSupply();
        IERC20Like(token).approve(curveFactory, supply);
        address curve = ICurveFactoryWlLike(curveFactory)
            .createCurveWithConfigForWl(token, params.antiSniperBlocks, params.buybackBurnBps, msg.sender, wl);
        emit CurveInstalled(token, curve);

        _dispatchOwnership(token, params.ownership, params.ownerTargetIfMultisig, msg.sender);

        emit Launched(
            token, msg.sender, params.base, nameHash, tickerHash, 0, params.installHook, params.installGovernance
        );
        emit LaunchedInURU(token, msg.sender, uruAmount);
        emit LaunchedWithWhitelist(
            token,
            msg.sender,
            wl.root,
            wl.reservedTokens,
            wl.maxWlPerAddress,
            wl.fallbackTs,
            wl.sourceTokenAddress,
            wl.sourceChainId
        );
    }
}
