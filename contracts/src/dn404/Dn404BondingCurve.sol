// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/*
 *  ════════════════════════════════════════════════════════════════
 *
 *    ウ  urufu labs  ✯  tap tap launch  ✯  dn404 bonding curve
 *
 *  ════════════════════════════════════════════════════════════════
 *
 *    ERC-20-pair bonding curve for DN404 launches. same math as the
 *    ETH-paired V10 BondingCurve serving plain ERC-20 launches;
 *    only the I/O side is switched to IERC20 transferFrom/transfer
 *    so buyers pay in USDG, COST, NVDA, whatever the launcher picked.
 *
 *          ～  好き好き大好き  ～  launch ur own with urufu labs
 *
 *  ════════════════════════════════════════════════════════════════
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";

interface IDn404Graduator {
    /// @dev Non-payable analog of the V10 IGraduator. Instead of ETH
    ///      passed as msg.value, the pair currency + amount are
    ///      explicit args. Curve approves `pairAmount` of `pairCurrency`
    ///      to the graduator before this call.
    function execute(
        address token,
        address pairCurrency,
        uint256 pairAmount,
        uint256 tokenAmount,
        uint32 antiSniperBlocks,
        uint16 buybackBurnBps,
        address launcher
    ) external;
}

/// @title  Dn404BondingCurve
/// @notice DN404-lane bonding curve where the pair asset is any
///         allowlisted ERC-20 (RH stock tokens, USDG, URU, …) instead
///         of ETH. Firewall: never touched by ERC-20 launches. Only
///         `Dn404LaunchFactory` → `Dn404CurveFactory` reaches this
///         template.
///
/// @dev Same constant-product math + WL semantics + graduation posture
///      as V10 `BondingCurve.sol`. Field names retain `eth`-flavor
///      internally to keep an easy line-by-line diff for audit
///      (`ethReserve` really holds "pair currency reserve", math
///      unchanged); every ETH-related I/O is switched to
///      `IERC20(pairCurrency).*`.
///
///      What changed vs. V10:
///        - added `pairCurrency` immutable-after-init state
///        - buy / buyFor / buyWithProof: `payable` removed, `msg.value`
///          replaced with explicit `pairAmountIn` arg + safeTransferFrom
///        - sell: safeTransferETH replaced with pair-currency transfer
///        - graduator interface renamed to `IDn404Graduator` (non-payable
///          + explicit pair currency args)
///        - `receive() external payable {}` removed — this contract
///          never accepts ETH
contract Dn404BondingCurve is ReentrancyGuard {
    // ============================================================
    // Errors
    // ============================================================
    error Dn404BondingCurve__AlreadyInitialized();
    error Dn404BondingCurve__ZeroAmount();
    error Dn404BondingCurve__Graduated();
    error Dn404BondingCurve__NotGraduated();
    error Dn404BondingCurve__Slippage(uint256 got, uint256 min);
    error Dn404BondingCurve__ExceedsSupply(uint256 requested, uint256 available);
    error Dn404BondingCurve__ZeroAddress();
    error Dn404BondingCurve__ZeroRecipient();
    error Dn404BondingCurve__WlWindowActive(uint256 windowEndsAt);
    error Dn404BondingCurve__WlNotActive();
    error Dn404BondingCurve__WlProofInvalid();
    error Dn404BondingCurve__WlPerAddressCapHit(uint256 requested, uint256 remainingCap);
    error Dn404BondingCurve__WlReservedExhausted(uint256 requested, uint256 reservedRemaining);
    error Dn404BondingCurve__WlFallbackInPast();
    error Dn404BondingCurve__GraduatorUnset();
    error Dn404BondingCurve__GraduationReserveRequired();
    /// New vs. V10 — pair currency must be a non-zero ERC-20 address.
    /// (ETH-paired DN404 launches route through V10, not through this
    /// contract, so pair == 0 here is invalid by construction.)
    error Dn404BondingCurve__PairCurrencyRequired();

    // ============================================================
    // Events — mirrors V10 shape so indexer handlers can reuse the
    // same OHLC pipeline; the pairCurrency indexed field tells the
    // indexer whether `pairAmount` is in ETH-wei or some other
    // 18-decimals-assumed ERC-20 unit.
    // ============================================================
    event Dn404CurveInitialized(
        address indexed token,
        address indexed pairCurrency,
        address indexed feeReceiver,
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualPairReserve,
        uint256 graduationTargetPair,
        uint16 tradeFeeBps
    );
    event Dn404Trade(
        address indexed trader,
        address indexed pairCurrency,
        bool isBuy,
        uint256 pairAmount,
        uint256 tokenAmount,
        uint256 pairReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );
    event Dn404Graduated(
        address indexed pairCurrency,
        uint256 pairReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );
    event WhitelistConfigured(
        bytes32 root,
        uint256 reservedTokens,
        uint256 maxWlPerAddress,
        uint64 fallbackTs,
        address sourceTokenAddress,
        uint32 sourceChainId,
        uint32 declaredHolderCount
    );
    event WlBought(address indexed buyer, uint256 pairIn, uint256 tokensOut, uint256 wlPurchasedAfter);
    event BoughtFor(address indexed payer, address indexed recipient, uint256 pairAmount, uint256 tokensOut);

    // ============================================================
    // Immutable-after-init state
    // ============================================================
    address public token;
    /// The pair currency this curve prices in (USDG, COST, NVDA, ...).
    /// Non-zero required at init — ETH-paired launches go through V10.
    address public pairCurrency;
    address public feeReceiver;
    uint256 public curveSupply;
    uint256 public virtualTokenReserve;
    /// Same role as V10's `virtualEthReserve` — held in "pair currency"
    /// units instead of wei. Name unchanged for line-by-line diff.
    uint256 public virtualEthReserve;
    /// Same role as V10's `graduationTargetEth` — held in pair currency
    /// units. Reached when accumulated `ethReserve` (pair reserve) hits
    /// this amount → curve graduates into a v4 pool paired against
    /// `pairCurrency` via Dn404Graduator.
    uint256 public graduationTargetEth;
    uint16 public tradeFeeBps;
    address public graduator;

    uint32 public antiSniperBlocks;
    uint16 public buybackBurnBps;

    address public launcher;

    // ============================================================
    // Live state
    // ============================================================
    /// Accumulated pair-currency reserve. Name retained from V10 for
    /// diff clarity; unit is `pairCurrency`, NOT ETH-wei.
    uint256 public ethReserve;
    uint256 public tokenReserve;
    bool public graduated;
    uint8 private _initialized;

    // ============================================================
    // Whitelist state — identical semantics to V10.
    // ============================================================
    bytes32 public whitelistRoot;
    uint256 public reservedTokens;
    uint256 public publicSold;
    uint256 public wlSold;
    uint256 public maxWlPerAddress;
    uint64 public fallbackTs;
    address public sourceTokenAddress;
    uint32 public sourceChainId;
    uint32 public declaredHolderCount;
    mapping(address => uint256) public wlBought;

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
    // Init
    // ============================================================
    function initialize(
        address token_,
        address pairCurrency_,
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
            pairCurrency_,
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

    function initializeWithWhitelist(
        address token_,
        address pairCurrency_,
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
            pairCurrency_,
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
        address pairCurrency_,
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
        if (_initialized != 0) revert Dn404BondingCurve__AlreadyInitialized();
        _initialized = 1;
        if (token_ == address(0) || feeReceiver_ == address(0)) revert Dn404BondingCurve__ZeroAddress();
        if (pairCurrency_ == address(0)) revert Dn404BondingCurve__PairCurrencyRequired();
        if (graduator_ == address(0) || graduator_.code.length == 0) {
            revert Dn404BondingCurve__GraduatorUnset();
        }

        token = token_;
        pairCurrency = pairCurrency_;
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

        emit Dn404CurveInitialized(
            token_,
            pairCurrency_,
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
        if (wl.root == bytes32(0)) revert Dn404BondingCurve__ZeroAddress();
        if (wl.reservedTokens == 0 || wl.reservedTokens > curveSupply) {
            revert Dn404BondingCurve__ExceedsSupply(wl.reservedTokens, curveSupply);
        }
        if (wl.maxWlPerAddress == 0) revert Dn404BondingCurve__ZeroAmount();
        if (wl.fallbackTs <= block.timestamp) revert Dn404BondingCurve__WlFallbackInPast();

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

    // ============================================================
    // Quoting — pure math, unchanged vs. V10
    // ============================================================
    function quoteBuy(
        uint256 pairIn
    ) public view returns (uint256 tokensOut, uint256 fee) {
        if (graduated) return (0, 0);
        fee = (pairIn * tradeFeeBps) / 10_000;
        uint256 pairAfterFee = pairIn - fee;
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + pairAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) tokensOut = available;
    }

    function quoteSell(
        uint256 tokensIn
    ) public view returns (uint256 pairOut, uint256 fee) {
        if (graduated) return (0, 0);
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 pairGross = effEth - newEffEth;
        if (pairGross > ethReserve) pairGross = ethReserve;
        fee = (pairGross * tradeFeeBps) / 10_000;
        pairOut = pairGross - fee;
    }

    /// @notice Current spot price in `pairCurrency`-wei-per-token
    ///         (18-decimal fixed-point). Semantically identical to
    ///         V10's `priceWeiPerToken` — unit is the pair currency,
    ///         not literal ETH-wei.
    function priceWeiPerToken() external view returns (uint256) {
        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        return (effEth * 1e18) / effToken;
    }

    // ============================================================
    // Buy / sell
    // ============================================================

    /// @notice Buy tokens paying in `pairCurrency`. Caller must have
    ///         approved this contract for at least `pairAmountIn`
    ///         beforehand (safeTransferFrom will revert otherwise).
    function buy(
        uint256 pairAmountIn,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert Dn404BondingCurve__Graduated();
        if (pairAmountIn == 0) revert Dn404BondingCurve__ZeroAmount();

        uint256 fee = (pairAmountIn * tradeFeeBps) / 10_000;
        uint256 pairAfterFee = pairAmountIn - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + pairAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert Dn404BondingCurve__ExceedsSupply(tokensOut, available);
        if (tokensOut == 0) revert Dn404BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert Dn404BondingCurve__Slippage(tokensOut, minTokensOut);

        if (whitelistRoot != bytes32(0) && block.timestamp < fallbackTs) {
            revert Dn404BondingCurve__WlWindowActive(fallbackTs);
        }

        // Pull the full pair amount from the buyer, then split into
        // fee (immediate forward to feeReceiver) + curve deposit.
        SafeTransferLib.safeTransferFrom(pairCurrency, msg.sender, address(this), pairAmountIn);

        tokenReserve -= tokensOut;
        publicSold += tokensOut;
        ethReserve += pairAfterFee;

        if (fee > 0) SafeTransferLib.safeTransfer(pairCurrency, feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, msg.sender, tokensOut);

        emit Dn404Trade(msg.sender, pairCurrency, true, pairAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    /// @notice Same as `buy` but purchased tokens go to `recipient`
    ///         instead of `msg.sender`. Payer is still `msg.sender` —
    ///         they must have approved this contract for pairAmountIn.
    function buyFor(
        address recipient,
        uint256 pairAmountIn,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensOut) {
        if (recipient == address(0)) revert Dn404BondingCurve__ZeroRecipient();
        if (graduated) revert Dn404BondingCurve__Graduated();
        if (pairAmountIn == 0) revert Dn404BondingCurve__ZeroAmount();

        uint256 fee = (pairAmountIn * tradeFeeBps) / 10_000;
        uint256 pairAfterFee = pairAmountIn - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + pairAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert Dn404BondingCurve__ExceedsSupply(tokensOut, available);
        if (tokensOut == 0) revert Dn404BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert Dn404BondingCurve__Slippage(tokensOut, minTokensOut);

        if (whitelistRoot != bytes32(0) && block.timestamp < fallbackTs) {
            revert Dn404BondingCurve__WlWindowActive(fallbackTs);
        }

        SafeTransferLib.safeTransferFrom(pairCurrency, msg.sender, address(this), pairAmountIn);

        tokenReserve -= tokensOut;
        publicSold += tokensOut;
        ethReserve += pairAfterFee;

        if (fee > 0) SafeTransferLib.safeTransfer(pairCurrency, feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, recipient, tokensOut);

        emit Dn404Trade(recipient, pairCurrency, true, pairAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);
        emit BoughtFor(msg.sender, recipient, pairAfterFee, tokensOut);

        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    function buyWithProof(
        bytes32[] calldata proof,
        uint256 pairAmountIn,
        uint256 minTokensOut
    ) external nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert Dn404BondingCurve__Graduated();
        if (pairAmountIn == 0) revert Dn404BondingCurve__ZeroAmount();
        if (whitelistRoot == bytes32(0)) revert Dn404BondingCurve__WlNotActive();
        if (block.timestamp >= fallbackTs) revert Dn404BondingCurve__WlNotActive();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        if (!MerkleProofLib.verify(proof, whitelistRoot, leaf)) revert Dn404BondingCurve__WlProofInvalid();

        uint256 fee = (pairAmountIn * tradeFeeBps) / 10_000;
        uint256 pairAfterFee = pairAmountIn - fee;

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffEth = effEth + pairAfterFee;
        uint256 newEffToken = k / newEffEth;
        tokensOut = effToken - newEffToken;
        uint256 available = tokenReserve > 0 ? tokenReserve - 1 : 0;
        if (tokensOut > available) revert Dn404BondingCurve__ExceedsSupply(tokensOut, available);
        if (tokensOut == 0) revert Dn404BondingCurve__ZeroAmount();
        if (tokensOut < minTokensOut) revert Dn404BondingCurve__Slippage(tokensOut, minTokensOut);

        uint256 reservedRemaining = reservedTokens - wlSold;
        if (tokensOut > reservedRemaining) {
            revert Dn404BondingCurve__WlReservedExhausted(tokensOut, reservedRemaining);
        }

        uint256 alreadyBought = wlBought[msg.sender];
        uint256 remainingCap = alreadyBought >= maxWlPerAddress ? 0 : maxWlPerAddress - alreadyBought;
        if (tokensOut > remainingCap) revert Dn404BondingCurve__WlPerAddressCapHit(tokensOut, remainingCap);

        SafeTransferLib.safeTransferFrom(pairCurrency, msg.sender, address(this), pairAmountIn);

        tokenReserve -= tokensOut;
        wlSold += tokensOut;
        wlBought[msg.sender] = alreadyBought + tokensOut;
        ethReserve += pairAfterFee;

        if (fee > 0) SafeTransferLib.safeTransfer(pairCurrency, feeReceiver, fee);
        SafeTransferLib.safeTransfer(token, msg.sender, tokensOut);

        emit WlBought(msg.sender, pairAfterFee, tokensOut, alreadyBought + tokensOut);
        emit Dn404Trade(msg.sender, pairCurrency, true, pairAfterFee, tokensOut, ethReserve, tokenReserve, block.timestamp);

        if (ethReserve >= graduationTargetEth) {
            _graduate();
        }
    }

    function sell(
        uint256 tokensIn,
        uint256 minPairOut
    ) external nonReentrant returns (uint256 pairOut) {
        if (graduated) revert Dn404BondingCurve__Graduated();
        if (tokensIn == 0) revert Dn404BondingCurve__ZeroAmount();

        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokensIn);

        uint256 effEth = ethReserve + virtualEthReserve;
        uint256 effToken = tokenReserve + virtualTokenReserve;
        uint256 k = effEth * effToken;
        uint256 newEffToken = effToken + tokensIn;
        uint256 newEffEth = k / newEffToken;
        uint256 pairGross = effEth - newEffEth;
        if (pairGross > ethReserve) pairGross = ethReserve;
        uint256 fee = (pairGross * tradeFeeBps) / 10_000;
        pairOut = pairGross - fee;
        if (pairOut < minPairOut) revert Dn404BondingCurve__Slippage(pairOut, minPairOut);

        tokenReserve += tokensIn;
        ethReserve -= pairGross;

        if (fee > 0) SafeTransferLib.safeTransfer(pairCurrency, feeReceiver, fee);
        SafeTransferLib.safeTransfer(pairCurrency, msg.sender, pairOut);

        emit Dn404Trade(msg.sender, pairCurrency, false, pairOut, tokensIn, ethReserve, tokenReserve, block.timestamp);
    }

    // ============================================================
    // Graduation — atomic transfer to Dn404 v4 pool via Dn404Graduator.
    // Differs from V10 only in that pair currency + amount are passed
    // as explicit args (no msg.value), and the graduator is approved
    // for the pair currency amount before the call rather than sent
    // ETH as msg.value.
    // ============================================================
    function _graduate() internal {
        uint256 pairOut = ethReserve;
        uint256 tokenOut = tokenReserve;
        if (tokenOut == 0) revert Dn404BondingCurve__GraduationReserveRequired();
        address g = graduator;
        if (g == address(0) || g.code.length == 0) revert Dn404BondingCurve__GraduatorUnset();

        graduated = true;
        ethReserve = 0;
        tokenReserve = 0;

        // Approve both sides to the graduator so it can pull them in a
        // single tx. Token side matches V10; pair side is new (V10 sent
        // ETH via msg.value instead).
        SafeTransferLib.safeApprove(token, g, tokenOut);
        SafeTransferLib.safeApprove(pairCurrency, g, pairOut);

        IDn404Graduator(g).execute(
            token,
            pairCurrency,
            pairOut,
            tokenOut,
            antiSniperBlocks,
            buybackBurnBps,
            launcher
        );
        emit Dn404Graduated(pairCurrency, pairOut, tokenOut, block.timestamp);
    }
}
