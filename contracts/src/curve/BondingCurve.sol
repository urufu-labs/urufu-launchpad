// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

interface IGraduator {
    function execute(
        address token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external payable;
}

/// @title  BondingCurve
/// @notice pump.fun-style constant-product bonding curve, one per token launch. Uses virtual
///         reserves so early buys start at a well-defined non-zero price and price scales
///         predictably up to the graduation target. When accumulated ETH reserve reaches
///         `graduationTargetEth`, the curve is closed for new buys and `Graduated` fires —
///         a Phase-3 graduation router then pulls the ETH + remaining tokens into a Uniswap
///         v4 pool with the launcher's pre-selected hook.
/// @dev    Cloneable via LibClone or deployed straight from `CurveFactory`. Fees are skimmed
///         on both sides and forwarded to the platform `feeReceiver` (same address used by
///         the launch Router). Immutable-after-init: no admin knobs, no upgrades.
contract BondingCurve is ReentrancyGuard {
    // ============================================================
    // Errors
    // ============================================================
    error BondingCurve__AlreadyInitialized();
    error BondingCurve__ZeroAmount();
    error BondingCurve__Graduated();
    error BondingCurve__NotGraduated();
    error BondingCurve__Slippage(uint256 got, uint256 min);
    error BondingCurve__ExceedsSupply(uint256 requested, uint256 available);
    error BondingCurve__ZeroAddress();
    /// GH #8 (launchAndBuy): `buyFor` requires an explicit non-zero recipient.
    /// Distinct selector from the generic `ZeroAddress` so a caller who passed
    /// `recipient = address(0)` sees an unambiguous error at the trade layer.
    error BondingCurve__ZeroRecipient();
    // NOTE: parameter-sanity checks (fee cap, non-zero reserves, reachable
    // graduation target) live in CurveFactory.setDefaults / _validateCurveDefaults
    // only. Mirroring them in _init was tried on 2026-07-31 and broke legitimate
    // edge-case tests that intentionally construct curves with unreachable
    // targets to exercise the tokenReserve-exhaustion clamp in buy(). The
    // production path (Router → CurveFactory) still catches admin errors at
    // the factory boundary; a curve constructed directly with hostile params
    // could sit in an unsafe state, but the only way to reach that path is
    // to bypass the factory entirely, which is outside the trust model.
    /// Public `buy()` called during the whitelist-exclusive window. Only
    /// `buyWithProof` works before `fallbackTs`; after it, `buy()` opens to everyone.
    /// The revert carries the timestamp so the caller knows exactly when to retry.
    error BondingCurve__WlWindowActive(uint256 windowEndsAt);
    /// `buyWithProof` called but no whitelist is configured, or the reserved slice is
    /// already drained (fully sold or opened to public via fallback).
    error BondingCurve__WlNotActive();
    /// Merkle proof did not verify against `whitelistRoot` for `msg.sender`.
    error BondingCurve__WlProofInvalid();
    /// Buy would push `wlPurchased[msg.sender]` above `maxWlPerAddress`.
    error BondingCurve__WlPerAddressCapHit(uint256 requested, uint256 remainingCap);
    /// Buy would push `wlSold` past the total reserved slice.
    error BondingCurve__WlReservedExhausted(uint256 requested, uint256 reservedRemaining);
    error BondingCurve__WlNothingToClaim();
    /// Whitelist configured with `fallbackTs <= block.timestamp` — the WL window is
    /// dead-on-arrival (buyWithProof reverts as WlNotActive from block 0, buy()
    /// opens immediately with a WL that no one can use). Caller mistake guard.
    error BondingCurve__WlFallbackInPast();
    /// URU-A05: curve was initialized (or is about to graduate) with a zero /
    /// non-contract Graduator. Blocks the "graduate but no v4 pool" terminal
    /// state that would strand ETH + tokens permanently.
    error BondingCurve__GraduatorUnset();
    /// URU-A04: graduation attempted with `tokenReserve == 0`. Would leave
    /// the curve marked graduated but with no LP to seed the v4 pool. The
    /// no-clamp `tokensOut > tokenReserve - 1` check in `buy` /
    /// `buyWithProof` prevents this state from being reached during trading.
    error BondingCurve__GraduationReserveRequired();

    // ============================================================
    // Events — the trade UI streams these into an OHLC chart
    // ============================================================
    event CurveInitialized(
        address indexed token,
        address indexed feeReceiver,
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps
    );
    event Trade(
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );
    event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp);

    /// Emitted once at init if a whitelist is configured. Source token + chain ID
    /// give buyers the info they need to independently verify the Merkle root
    /// against the on-chain source (e.g. "these are holders of $ANSEM on Base at
    /// block N"). Holder count is deployer-declared; the pinned list off-chain is
    /// the authoritative source, this is just for surface transparency.
    event WhitelistConfigured(
        bytes32 root,
        uint256 reservedTokens,
        uint256 maxWlPerAddress,
        uint64 fallbackTs,
        address sourceTokenAddress,
        uint32 sourceChainId,
        uint32 declaredHolderCount
    );
    event WlBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 wlPurchasedAfter);
    event WlClaimed(address indexed buyer, uint256 amount);

    /// GH #8 (launchAndBuy): payer/recipient split emitted alongside the
    /// standard `Trade` event when tokens flow to an address that is not the
    /// caller. Router's `launchAndBuy` uses this path so indexers can
    /// distinguish "Router paid on behalf of launcher" from a self-buy. The
    /// standard `Trade` event still fires so OHLC pipelines are unchanged.
    event BoughtFor(address indexed payer, address indexed recipient, uint256 ethAmount, uint256 tokensOut);

    // ============================================================
    // Immutable-after-init state (LibClone friendly — no constructor args)
    // ============================================================
    address public token;
    address public feeReceiver;
    uint256 public curveSupply;
    uint256 public virtualTokenReserve;
    uint256 public virtualEthReserve;
    uint256 public graduationTargetEth;
    uint16 public tradeFeeBps;
    /// Optional graduation router — when set, `_graduate()` transfers reserves out and
    /// invokes the router to spin up a Uniswap v4 pool. When unset, `_graduate()` just
    /// flags the curve done and holds funds for a keeper to withdraw later.
    address public graduator;

    /// Per-launch anti-sniper + buyback-burn config, passed to the Graduator (and by it
    /// into MultiHookHost.setPoolConfig) at graduation time. Zero for either = feature
    /// disabled for the resulting v4 pool.
    uint32 public antiSniperBlocks;
    uint16 public buybackBurnBps;

    /// The wallet that launched this curve — Router forwards `msg.sender` from
    /// `Router.launch(...)` down through CurveFactory.createCurveWithConfigFor.
    /// At graduation, this address is passed to the Graduator and installed as the
    /// per-pool creator on the v4 hook, so post-graduation swap fees route the
    /// creator share to the actual launcher instead of a shared platform address.
    /// May be zero for legacy or direct-init curves that predate this field — in
    /// that case, the hook's constructor fallback creator receives the share.
    address public launcher;

    // ============================================================
    // Live state
    // ============================================================
    uint256 public ethReserve;
    uint256 public tokenReserve;
    bool public graduated;
    uint8 private _initialized;

    // ============================================================
    // Whitelist state (all zero when whitelist disabled — every gated code path
    // checks `whitelistRoot != 0` first so non-WL launches are unaffected)
    // ============================================================

    /// Merkle root of eligible whitelist addresses. Zero = whitelist disabled entirely.
    bytes32 public whitelistRoot;
    /// Fixed at init — hard cap on how many tokens whitelisted buyers can collectively
    /// drain during the WL-exclusive window. Anything unfilled by `fallbackTs` opens to
    /// public. `buyWithProof` reverts when this cap is hit; `buy` never draws from it
    /// (public is locked out entirely until the window ends).
    uint256 public reservedTokens;
    /// Running tallies of tokens sold via each path. Post-window design: `buy` only
    /// runs post-fallback so `publicSold` is "tokens sold post-window." `wlSold` is
    /// "tokens sold via buyWithProof during the window." Both for indexer visibility.
    uint256 public publicSold;
    uint256 public wlSold;
    /// Per-address token cap on WL buys. Prevents a single whitelisted whale from
    /// draining the entire reserved slice during the exclusive window.
    uint256 public maxWlPerAddress;
    /// End of the whitelist-exclusive window. Before this: only `buyWithProof` works;
    /// public `buy` reverts with `WlWindowActive`. After: `buy` opens to everyone and
    /// draws from the full remaining tokenReserve; `buyWithProof` reverts (window ended).
    /// Guarantees the curve never strands even if the WL doesn't fill the reserved slice.
    uint64 public fallbackTs;
    /// Transparency-only — source of the snapshot the Merkle tree was built from. Buyers
    /// can look up the on-chain holder set at `sourceChainId:sourceTokenAddress` and
    /// re-derive the tree to verify the root wasn't stuffed with deployer alts.
    address public sourceTokenAddress;
    uint32 public sourceChainId;
    /// Declared at init, emitted for transparency. Not enforced on-chain (the sorted
    /// holder list is off-chain); UI can surface this alongside the pinned list URL.
    uint32 public declaredHolderCount;
    /// WL purchases are held on the curve until graduation — user calls `claimWl()`
    /// post-graduation to withdraw. This is the structural lock-until-graduation:
    /// tokens simply aren't in the buyer's wallet during the lock period, so no
    /// transfer-hook / template modification is needed.
    mapping(address => uint256) public wlHeldForUser;
    /// Sum of `wlHeldForUser` values. Invariant: token balance on curve equals
    /// `tokenReserve + wlHeldTotal` (minus any accidentally-transferred-in tokens).
    /// Kept explicitly so `_graduate()` can send only `tokenReserve` to the LP mint
    /// and leave the WL-held slice on the curve for later claiming.
    uint256 public wlHeldTotal;

    /// Whitelist init payload — kept as a struct so the parameter list on
    /// `initializeWithWhitelist` stays readable. Set `root = bytes32(0)` to disable
    /// (though for that case the caller should use plain `initialize` instead —
    /// this variant reverts on zero root as a caller-mistake guard).
    struct WhitelistInit {
        bytes32 root;
        uint256 reservedTokens;
        uint256 maxWlPerAddress;
        uint64 fallbackTs;
        address sourceTokenAddress;
        uint32 sourceChainId;
        uint32 declaredHolderCount;
    }

    // ============================================================
    // Init — called once by the factory right after `cloneDeterministic`
    // ============================================================
    function initialize(
        address token_,
        address feeReceiver_,
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_,
        address graduator_,
        uint32 antiSniperBlocks_,
        uint16 buybackBurnBps_,
        address launcher_
    ) external {
        _init(
            token_,
            feeReceiver_,
            curveSupply_,
            virtualTokenReserve_,
            virtualEthReserve_,
            graduationTargetEth_,
            tradeFeeBps_,
            graduator_,
            antiSniperBlocks_,
            buybackBurnBps_,
            launcher_
        );
    }

    /// @notice Whitelist-aware init. Same fields as `initialize` plus a `WhitelistInit`
    ///         struct that configures the reserved slice, per-address cap, fallback
    ///         timestamp, and the source-project transparency fields. Callers should
    ///         only invoke this variant when they actually have a Merkle root to bind.
    function initializeWithWhitelist(
        address token_,
        address feeReceiver_,
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_,
        address graduator_,
        uint32 antiSniperBlocks_,
        uint16 buybackBurnBps_,
        address launcher_,
        WhitelistInit calldata wl
    ) external {
        _init(
            token_,
            feeReceiver_,
            curveSupply_,
            virtualTokenReserve_,
            virtualEthReserve_,
            graduationTargetEth_,
            tradeFeeBps_,
            graduator_,
            antiSniperBlocks_,
            buybackBurnBps_,
            launcher_
        );
        _setWhitelist(wl);
    }

    function _init(
        address token_,
        address feeReceiver_,
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_,
        address graduator_,
        uint32 antiSniperBlocks_,
        uint16 buybackBurnBps_,
        address launcher_
    ) internal {
        if (_initialized != 0) revert BondingCurve__AlreadyInitialized();
        _initialized = 1;
        if (token_ == address(0) || feeReceiver_ == address(0)) revert BondingCurve__ZeroAddress();
        // URU-A05: reject zero / non-contract Graduator at init. Previously
        // CurveFactory allowed graduator=0 (comment: "disables v4 graduation"),
        // and BondingCurve._graduate silently no-op'd — combined effect was a
        // curve that could mark itself graduated while permanently retaining
        // ETH + tokens. Fail loudly at init so this state is unreachable.
        if (graduator_ == address(0) || graduator_.code.length == 0) {
            revert BondingCurve__GraduatorUnset();
        }

        token = token_;
        feeReceiver = feeReceiver_;
        curveSupply = curveSupply_;
        virtualTokenReserve = virtualTokenReserve_;
        virtualEthReserve = virtualEthReserve_;
        graduationTargetEth = graduationTargetEth_;
        tradeFeeBps = tradeFeeBps_;
        graduator = graduator_;
        antiSniperBlocks = antiSniperBlocks_;
        buybackBurnBps = buybackBurnBps_;
        launcher = launcher_;

        tokenReserve = curveSupply_;
        ethReserve = 0;

        emit CurveInitialized(
            token_,
            feeReceiver_,
            curveSupply_,
            virtualTokenReserve_,
            virtualEthReserve_,
            graduationTargetEth_,
            tradeFeeBps_
        );
    }

    function _setWhitelist(
        WhitelistInit calldata wl
    ) internal {
        // Caller-mistake guards — the WL variant of init is opt-in; if the caller
        // reached it without a real root / cap, they meant to use plain `initialize`.
        if (wl.root == bytes32(0)) revert BondingCurve__ZeroAddress();
        if (wl.reservedTokens == 0 || wl.reservedTokens > curveSupply) {
            revert BondingCurve__ExceedsSupply(wl.reservedTokens, curveSupply);
        }
        if (wl.maxWlPerAddress == 0) revert BondingCurve__ZeroAmount();
        // Reject fallback timestamps that don't leave a real WL window. `<=` covers
        // both the "0 default" and "past block" cases — either would ship a launch
        // where the WL is documented in the emitted event but structurally unreachable
        // (buyWithProof reverts WlNotActive; buy opens with the merkle root ignored).
        if (wl.fallbackTs <= block.timestamp) revert BondingCurve__WlFallbackInPast();

        whitelistRoot = wl.root;
        reservedTokens = wl.reservedTokens;
        maxWlPerAddress = wl.maxWlPerAddress;
        fallbackTs = wl.fallbackTs;
        sourceTokenAddress = wl.sourceTokenAddress;
        sourceChainId = wl.sourceChainId;
        declaredHolderCount = wl.declaredHolderCount;

        emit WhitelistConfigured(
            wl.root,
            wl.reservedTokens,
            wl.maxWlPerAddress,
            wl.fallbackTs,
            wl.sourceTokenAddress,
            wl.sourceChainId,
            wl.declaredHolderCount
        );
    }

    // (Legacy _publicAvailable helper removed — the time-gated design makes public buys
    // impossible during the WL window, and post-window everyone draws from the full
    // tokenReserve, so no per-bucket accounting is needed on the public path.)

    // ============================================================
    // Quoting — pure math, cheap to call off-chain and pre-trade
    // ============================================================
    function quoteBuy(
        uint256 ethIn
    ) public view returns (uint256 tokensOut, uint256 fee) {
        if (graduated) return (0, 0);
        fee = (ethIn * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = ethIn - fee;
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        // URU-A17 Low: match buy()'s tokenReserve-1 floor so quotes never
        // exceed what execution will actually settle. Without this, a UI
        // showing quoteBuy(ethIn)==tokenReserve would submit a buy that
        // reverts BondingCurve__InsufficientReserves.
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) tokensOut = available;
    }

    function quoteSell(
        uint256 tokensIn
    ) public view returns (uint256 ethOut, uint256 fee) {
        if (graduated) return (0, 0);
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
    }

    /// @notice Current spot price in wei-per-token (18-decimal fixed-point).
    function priceWeiPerToken() external view returns (uint256) {
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        return (effEth * 1e18) / effToken;
    }

    // ============================================================
    // Buy / sell
    // ============================================================
    function buy(
        uint256 minTokensOut
    ) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert BondingCurve__Graduated();
        if (msg.value == 0) revert BondingCurve__ZeroAmount();

        uint256 fee = (msg.value * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = msg.value - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        // URU-A04: a buy may NEVER consume the complete remaining token reserve.
        // Leaving at least 1 wei-token reserved guarantees `_graduate` can always
        // find non-zero LP inventory to hand the Graduator (which reverts
        // `GraduationReserveRequired` on empty). Combined with the reachability
        // safety margin in CurveFactory, prevents the terminal states in which
        // (a) the ETH target crosses with zero tokens left, marking graduated
        // but skipping v4 pool creation, or (b) whitelist tokens sit locked with
        // no graduation ever possible.
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert BondingCurve__ExceedsSupply(tokensOut, available);
        // Dust-buy guard — msg.value small enough that the curve math rounds
        // tokensOut to 0. Without this check, a griefer can push ethReserve
        // toward graduationTargetEth for near-zero tokens per tx, and any
        // buyer who forgot to set minTokensOut pays ETH for nothing.
        if (tokensOut == 0) revert BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert BondingCurve__Slippage(tokensOut, minTokensOut);

        // Time-gated WL: during the exclusive window the public path is closed —
        // eligible wallets use `buyWithProof`, non-eligible wait for `fallbackTs`.
        // Curve auto-merges the unfilled WL slice into public at that timestamp so
        // slow-fill whitelists never strand the launch.
        if (whitelistRoot != bytes32(0) && block.timestamp < fallbackTs) {
            revert BondingCurve__WlWindowActive(fallbackTs);
        }

        tokenReserve -= tokensOut;
        publicSold += tokensOut;
        ethReserve += ethAfterFee;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, msg.sender, tokensOut);

        emit Trade(msg.sender, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        // Only graduate when ethReserve crosses the target. The old alternate
        // trigger — `tokenReserve == 0` — could fire when the curve math drained
        // token side before hitting the ETH target (possible with custom / off-
        // spec curve params), flipping `graduated = true` while `_graduate`'s
        // internal guard `tokenOut > 0` skipped the Graduator call → ethReserve
        // stranded on-curve forever with no withdraw path. Now graduation is
        // gated on ethReserve alone; the subsequent `_graduate` still checks
        // `tokenOut > 0` as belt-and-suspenders in case a custom curve invariant
        // ever produces 0-token graduation.
        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    /// @notice Same as `buy` but the purchased tokens go to `recipient` instead
    ///         of `msg.sender`. Payer is still `msg.sender` (they pay the ETH).
    ///         Introduced for GH #8 so `Router.launchAndBuy` can execute the
    ///         creator's first buy atomically with token deployment, denying
    ///         snipers any window between launch and first trade.
    /// @dev    All existing guards are preserved (graduated check, WL window,
    ///         zero-amount, dust, slippage, ExceedsSupply floor). Reserve
    ///         updates, fee routing, and the graduation trigger are identical
    ///         to `buy`. The only differences are:
    ///           * the ERC20 `safeTransfer` targets `recipient`;
    ///           * the `Trade` event's `trader` field is `recipient` (not
    ///             `msg.sender`) so indexer / analytics attribution follows
    ///             the actual holder rather than the Router when Router
    ///             brokers the buy in `launchAndBuy`;
    ///           * a `BoughtFor(msg.sender, recipient, ...)` event is
    ///             additionally emitted so consumers that need the payer /
    ///             recipient split still see both sides;
    ///           * zero-recipient reverts `BondingCurve__ZeroRecipient`.
    ///         WL state (`wlHeldForUser`, `wlSold`) is not touched — this
    ///         path is public-window ONLY, matching `buy`'s semantics.
    function buyFor(
        address recipient,
        uint256 minTokensOut
    ) external payable nonReentrant returns (uint256 tokensOut) {
        if (recipient == address(0)) revert BondingCurve__ZeroRecipient();
        if (graduated) revert BondingCurve__Graduated();
        if (msg.value == 0) revert BondingCurve__ZeroAmount();

        uint256 fee = (msg.value * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = msg.value - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        // URU-A04: same tokenReserve-1 floor as `buy` — never let a buy consume
        // the complete remaining reserve, so `_graduate` always has non-zero LP
        // inventory. See `buy` for full rationale.
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert BondingCurve__ExceedsSupply(tokensOut, available);
        // Dust-buy guard — msg.value small enough that curve math rounds
        // tokensOut to 0. Same as `buy`.
        if (tokensOut == 0) revert BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert BondingCurve__Slippage(tokensOut, minTokensOut);

        // Same time-gated WL window as `buy`. This is a public-buy path — during
        // the exclusive window it MUST revert regardless of who the recipient
        // is, otherwise `buyFor` would be a WL bypass (router-forwarded buys
        // land ahead of the fallback timestamp with no proof required).
        if (whitelistRoot != bytes32(0) && block.timestamp < fallbackTs) {
            revert BondingCurve__WlWindowActive(fallbackTs);
        }

        tokenReserve -= tokensOut;
        publicSold += tokensOut;
        ethReserve += ethAfterFee;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, recipient, tokensOut);

        // Standard Trade event for OHLC pipelines. Trader = `recipient`, NOT
        // `msg.sender`. Router.launchAndBuy is the primary caller of buyFor,
        // and there `msg.sender == Router` while the actual trader is the
        // launcher / whoever will end up holding the tokens. Attributing the
        // Trade to Router would misreport every atomic first-buy as
        // "Router bought" in indexer feeds / holder analytics. `buy()` keeps
        // trader = msg.sender because payer and recipient are the same there.
        // Full payer/recipient split is still surfaced via `BoughtFor` for
        // consumers that need both sides of the split.
        emit Trade(recipient, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);
        emit BoughtFor(msg.sender, recipient, ethAfterFee, tokensOut);

        // Same graduation trigger as `buy` — see comment there for why the
        // `tokenReserve == 0` alternate was removed.
        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    /// @notice Whitelist-only buy. Draws from the reserved slice (bounded by
    ///         `maxWlPerAddress`), same pricing curve as `buy()`. Bought tokens are
    ///         **held on the curve** and only released to the buyer via `claimWl()`
    ///         after graduation — the structural lock-until-graduation.
    /// @dev    Reverts if no whitelist is configured, if `fallbackTs` has elapsed
    ///         (post-fallback, callers should use `buy()`), if the proof doesn't
    ///         verify, or if any bucket / cap is exhausted.
    function buyWithProof(
        bytes32[] calldata proof,
        uint256 minTokensOut
    ) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert BondingCurve__Graduated();
        if (msg.value == 0) revert BondingCurve__ZeroAmount();
        if (whitelistRoot == bytes32(0)) revert BondingCurve__WlNotActive();
        // Post-fallback: reserved slice merged into public → use `buy()` instead.
        if (block.timestamp >= fallbackTs) revert BondingCurve__WlNotActive();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        if (!MerkleProofLib.verify(proof, whitelistRoot, leaf)) revert BondingCurve__WlProofInvalid();

        uint256 fee = (msg.value * tradeFeeBps) / 10_000;
        uint256 ethAfterFee = msg.value - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + ethAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        // URU-A04: previously this path CLAMPED tokensOut to tokenReserve when
        // the curve had less inventory than the buy priced for. That produced
        // two terminal lock states: (a) WL buyers holding tokens that graduation
        // never fires for; (b) target crossing with zero tokens left → no v4
        // pool + stranded ETH. Match `buy()` — never clamp, always leave at
        // least 1 wei-token as the graduation floor.
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert BondingCurve__ExceedsSupply(tokensOut, available);
        // Dust-buy guard — same rationale as buy(); WL buyer paying vanishing
        // ETH must not sink ETH for zero WL entitlement.
        if (tokensOut == 0) revert BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert BondingCurve__Slippage(tokensOut, minTokensOut);

        // Reserved-slice gate.
        uint256 reservedRemaining = reservedTokens - wlSold;
        if (tokensOut > reservedRemaining) {
            revert BondingCurve__WlReservedExhausted(tokensOut, reservedRemaining);
        }

        // Per-address cap. Revert (not clamp) so the caller understands they overshot.
        uint256 alreadyBought = wlHeldForUser[msg.sender];
        uint256 remainingCap = alreadyBought >= maxWlPerAddress ? 0 : maxWlPerAddress - alreadyBought;
        if (tokensOut > remainingCap) revert BondingCurve__WlPerAddressCapHit(tokensOut, remainingCap);

        // Effects: reduce tokenReserve (same pricing curve as public), record WL-held
        // balance (tokens stay on curve until claimWl post-graduation).
        tokenReserve -= tokensOut;
        wlSold += tokensOut;
        wlHeldForUser[msg.sender] = alreadyBought + tokensOut;
        wlHeldTotal += tokensOut;
        ethReserve += ethAfterFee;

        // Interactions: ETH fee forward only — token transfer intentionally skipped.
        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);

        emit WlBought(msg.sender, ethAfterFee, tokensOut, alreadyBought + tokensOut);
        emit Trade(msg.sender, true, ethAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        // Same ethReserve-only trigger as buy() — see the comment there for why
        // the `tokenReserve == 0` alternate was removed.
        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    /// @notice Post-graduation withdrawal of WL-held tokens. Callable exactly once
    ///         per buyer per curve — sets their held balance to zero on the way out.
    function claimWl() external nonReentrant returns (uint256 amount) {
        if (!graduated) revert BondingCurve__NotGraduated();
        amount = wlHeldForUser[msg.sender];
        if (amount == 0) revert BondingCurve__WlNothingToClaim();
        wlHeldForUser[msg.sender] = 0;
        wlHeldTotal -= amount;
        SafeTransferLib.safeTransfer(token, msg.sender, amount);
        emit WlClaimed(msg.sender, amount);
    }

    function sell(
        uint256 tokensIn,
        uint256 minEthOut
    ) external nonReentrant returns (uint256 ethOut) {
        if (graduated) revert BondingCurve__Graduated();
        if (tokensIn == 0) revert BondingCurve__ZeroAmount();

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokensIn);

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 ethGross = effEth - newEffEth;
        if (ethGross > ethReserve) ethGross = ethReserve;
        uint256 fee = (ethGross * tradeFeeBps) / 10_000;
        ethOut = ethGross - fee;
        if (ethOut < minEthOut) revert BondingCurve__Slippage(ethOut, minEthOut);

        tokenReserve += tokensIn;
        ethReserve -= ethGross;

        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        SafeTransferLib.safeTransferETH(msg.sender, ethOut);

        emit Trade(msg.sender, false, ethOut, tokensIn, ethReserve, tokenReserve, block.timestamp);
    }

    // ============================================================
    // Graduation — atomic transfer to v4 pool via Graduator (URU-A04, URU-A05).
    //
    // Previously this function set `graduated = true` before the external call
    // AND permitted the Graduator call to be silently skipped if
    // (graduator == 0 || ethOut == 0 || tokenOut == 0). That combination let a
    // curve reach a graduated=true state while never moving its ETH + tokens
    // to a v4 pool, permanently stranding both.
    //
    // The atomic version:
    //   * requires a non-zero, code-bearing graduator (URU-A05);
    //   * requires tokenOut > 0 (guaranteed by the buy-side no-clamp floor);
    //   * marks graduated + zeros reserves + calls execute in a single tx;
    //   * if execute reverts, the outer buy tx reverts too (`nonReentrant`
    //     protects the entrypoints); no partial state possible.
    // ============================================================
    function _graduate() internal {
        uint256 ethOut = ethReserve;
        uint256 tokenOut = tokenReserve;
        // Belt-and-suspenders: `buy` / `buyWithProof` now leave at least 1
        // wei-token in reserve, so tokenOut > 0 is invariant. Explicit revert
        // is defence in case a future change breaks that invariant.
        if (tokenOut == 0) revert BondingCurve__GraduationReserveRequired();
        address g = graduator;
        if (g == address(0) || g.code.length == 0) revert BondingCurve__GraduatorUnset();

        // Mark + zero BEFORE the external call so any reentry lands on
        // `graduated == true` and reverts `Graduated()`. If the external call
        // reverts, the whole tx unwinds and none of these writes persist.
        graduated = true;
        ethReserve = 0;
        tokenReserve = 0;
        SafeTransferLib.safeApprove(token, g, tokenOut);
        IGraduator(g).execute{value: ethOut}(token, ethOut, tokenOut, antiSniperBlocks, buybackBurnBps, launcher);
        emit Graduated(ethOut, tokenOut, block.timestamp);
    }

    // Accept refunds from failed transfers etc.
    receive() external payable {}
}
