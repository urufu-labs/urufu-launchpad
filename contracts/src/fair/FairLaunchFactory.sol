// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {LibClone} from "solady/utils/LibClone.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {FairBondingCurve} from "./FairBondingCurve.sol";
import {OpeningBatch} from "./OpeningBatch.sol";

interface IFairTokenInit {
    function initialize(
        bytes calldata data
    ) external;
    function renounceOwnership() external payable;
    function owner() external view returns (address);
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// Same LoyaltyOracle the token lane (Router) and DN404 lane use for holder discounts.
interface IFairLoyaltyOracle {
    function discountBpsFor(
        address holder
    ) external view returns (uint16);
}

/// @title  FairLaunchFactory
/// @notice Fourth launch lane (docs/SPEC-fair-launch.md). One tx deploys the token, its
///         `FairBondingCurve` and its `OpeningBatch`, wires them together, and (when ETH
///         is attached) makes the creator's first batch deposit. The creator pays the same
///         batch price as everyone else; there is no dev-first buy.
///
///         The token is a bare `ERC20Template` clone: whole supply minted straight to the
///         curve, ownership renounced in the same tx, so a Fair token has no admin.
///
///         Deploy fee, same model as the token lane (Router): pay in ETH with `launch`, or
///         in URU with `launchWithURU`. ETH goes to `feeReceiver` (the FeeSplitter, so it
///         feeds the 40/35/25 flywheel), URU goes to the URU sink. Both get the same
///         LoyaltyOracle holder discount, capped at 80% like the Router. Every amount and
///         address is owner-settable after deploy, so fee changes never need a redeploy.
///
/// @dev    Parallel to the V10 Router / CurveFactory, which stay frozen. ETH pair only
///         (spec D7). Owner powers: tune defaults for future launches, open / close new
///         launches. Nothing that touches a launch already made.
contract FairLaunchFactory is Ownable {
    // ============================================================ errors
    error FairLaunchFactory__ZeroAddress();
    error FairLaunchFactory__LaunchesClosed();
    error FairLaunchFactory__NameEmpty();
    error FairLaunchFactory__TickerEmpty();
    error FairLaunchFactory__NameTaken();
    error FairLaunchFactory__InvalidTradeFee(uint16 provided);
    error FairLaunchFactory__InvalidCurve();
    error FairLaunchFactory__UnreachableGraduationTarget(uint256 target, uint256 safeReachable);
    error FairLaunchFactory__InvalidWindow(uint32 secs);
    error FairLaunchFactory__InvalidBatchCap(uint16 bps);
    /// The batch cap alone would cost at least the graduation target, so one hot minute
    /// could graduate the token. Spec §1: the cap exists to stop exactly that.
    error FairLaunchFactory__BatchCapGraduates(uint256 capCostEth, uint256 target);
    error FairLaunchFactory__TokenSetupFailed();
    /// `launch`: attached ETH does not cover the (discounted) ETH deploy fee.
    error FairLaunchFactory__InsufficientEthFee(uint256 required, uint256 provided);
    /// `launchWithURU`: URU amount below the (discounted) URU floor.
    error FairLaunchFactory__InsufficientUru(uint256 required, uint256 provided);
    /// `launchWithURU` before URU payment is configured.
    error FairLaunchFactory__UruUnconfigured();
    error FairLaunchFactory__ZeroUru();
    error FairLaunchFactory__EthFeeTooHigh(uint256 fee, uint256 max);

    // ============================================================ events
    event FairLaunched(
        address indexed token,
        address indexed curve,
        address indexed launcher,
        address batch,
        string name,
        string symbol,
        uint256 curveSupply,
        uint256 batchCapTokens,
        uint64 batchCloseTs,
        uint256 creatorDeposit,
        uint256 feePaid,
        bool feeInUru
    );
    event DefaultsSet(
        uint256 curveSupply,
        uint256 virtualTokenReserve,
        uint256 virtualEthReserve,
        uint256 graduationTargetEth,
        uint16 tradeFeeBps,
        uint32 batchWindowSecs,
        uint16 batchCapBps,
        uint256 walletCap
    );
    event FeeReceiverSet(address feeReceiver);
    event LaunchesOpenSet(bool open);
    event EthLaunchFeeSet(uint256 fee);
    event UruConfigSet(address uru, address uruSink, uint256 minUruFee);
    event LoyaltyOracleSet(address oracle);

    // ============================================================ constants
    uint16 public constant MAX_TRADE_FEE_BPS = 3000;
    uint16 public constant GRADUATION_SAFETY_MARGIN_BPS = 500;
    uint32 public constant MIN_WINDOW_SECS = 10;
    uint32 public constant MAX_WINDOW_SECS = 1 hours;
    uint16 public constant MAX_BATCH_CAP_BPS = 5000;
    /// Same clamp as Router.MAX_LOYALTY_DISCOUNT_BPS: a bad oracle can never take the
    /// fee below 20% of gross.
    uint16 public constant MAX_LOYALTY_DISCOUNT_BPS = 8000;
    /// Typo guard on the ETH deploy fee.
    uint256 public constant MAX_ETH_LAUNCH_FEE = 0.1 ether;

    // ============================================================ wiring
    address public immutable tokenImpl;
    address public immutable curveImpl;
    address public immutable batchImpl;
    address public immutable graduator;
    address public feeReceiver;
    /// New launches are closed until the owner opens them (site stays dark until audit).
    bool public launchesOpen;

    // ============================================================ defaults
    uint256 public defaultCurveSupply;
    uint256 public defaultVirtualTokenReserve;
    uint256 public defaultVirtualEthReserve;
    uint256 public defaultGraduationTargetEth;
    uint16 public defaultTradeFeeBps;
    uint32 public batchWindowSecs;
    uint16 public batchCapBps;
    uint256 public walletCap;

    // ============================================================ deploy fee
    /// Gross ETH deploy fee before the holder discount. 0 = free.
    uint256 public ethLaunchFee;
    /// URU payment: token, sink and gross floor before discount. uru == 0 disables it.
    address public uru;
    address public uruSink;
    uint256 public minUruFee;
    address public loyaltyOracle;

    mapping(address token => address curve) public curveFor;
    mapping(address token => address batch) public batchFor;
    mapping(bytes32 saltKey => bool taken) public nameSaltTaken;

    constructor(
        address owner_,
        address tokenImpl_,
        address curveImpl_,
        address batchImpl_,
        address graduator_,
        address feeReceiver_
    ) {
        if (
            owner_ == address(0) || tokenImpl_ == address(0) || curveImpl_ == address(0) || batchImpl_ == address(0)
                || graduator_ == address(0) || feeReceiver_ == address(0)
        ) revert FairLaunchFactory__ZeroAddress();
        _initializeOwner(owner_);
        tokenImpl = tokenImpl_;
        curveImpl = curveImpl_;
        batchImpl = batchImpl_;
        graduator = graduator_;
        feeReceiver = feeReceiver_;
        // Same curve as the live token lane on 2026-10-19 (800M supply, 1 wei virtual
        // token, 2 ETH virtual ETH, 4.2 ETH target, 1% fee), plus the spec D1 / D2 batch
        // defaults. The deploy script re-reads the live CurveFactory and calls setDefaults
        // so the two lanes cannot drift.
        _setDefaults(800_000_000e18, 1, 2 ether, 4.2 ether, 100, 60, 2500, 0);
    }

    // ============================================================ admin

    function setDefaults(
        uint256 curveSupply_,
        uint256 virtualTokenReserve_,
        uint256 virtualEthReserve_,
        uint256 graduationTargetEth_,
        uint16 tradeFeeBps_,
        uint32 batchWindowSecs_,
        uint16 batchCapBps_,
        uint256 walletCap_
    ) external onlyOwner {
        _setDefaults(
            curveSupply_,
            virtualTokenReserve_,
            virtualEthReserve_,
            graduationTargetEth_,
            tradeFeeBps_,
            batchWindowSecs_,
            batchCapBps_,
            walletCap_
        );
    }

    function setFeeReceiver(
        address feeReceiver_
    ) external onlyOwner {
        if (feeReceiver_ == address(0)) revert FairLaunchFactory__ZeroAddress();
        feeReceiver = feeReceiver_;
        emit FeeReceiverSet(feeReceiver_);
    }

    function setLaunchesOpen(
        bool open
    ) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function setEthLaunchFee(
        uint256 fee
    ) external onlyOwner {
        if (fee > MAX_ETH_LAUNCH_FEE) revert FairLaunchFactory__EthFeeTooHigh(fee, MAX_ETH_LAUNCH_FEE);
        ethLaunchFee = fee;
        emit EthLaunchFeeSet(fee);
    }

    /// `uru_ == address(0)` turns URU payment off (sink and floor are then ignored).
    function setUruConfig(
        address uru_,
        address uruSink_,
        uint256 minUruFee_
    ) external onlyOwner {
        if (uru_ != address(0) && uruSink_ == address(0)) revert FairLaunchFactory__ZeroAddress();
        uru = uru_;
        uruSink = uruSink_;
        minUruFee = minUruFee_;
        emit UruConfigSet(uru_, uruSink_, minUruFee_);
    }

    /// `oracle == address(0)` turns the holder discount off.
    function setLoyaltyOracle(
        address oracle
    ) external onlyOwner {
        loyaltyOracle = oracle;
        emit LoyaltyOracleSet(oracle);
    }

    // ============================================================ fee views

    /// ETH deploy fee `launcher` pays, after their holder discount.
    function ethFeeFor(
        address launcher
    ) public view returns (uint256) {
        return _discounted(ethLaunchFee, launcher);
    }

    /// Minimum URU `launcher` pays with `launchWithURU`, after their holder discount.
    function minUruFeeFor(
        address launcher
    ) public view returns (uint256) {
        return _discounted(minUruFee, launcher);
    }

    function _discounted(
        uint256 gross,
        address launcher
    ) internal view returns (uint256) {
        if (gross == 0) return 0;
        address oracle = loyaltyOracle;
        if (oracle == address(0) || launcher == address(0)) return gross;
        uint16 bps;
        try IFairLoyaltyOracle(oracle).discountBpsFor(launcher) returns (uint16 b) {
            bps = b;
        } catch {
            return gross;
        }
        if (bps > MAX_LOYALTY_DISCOUNT_BPS) bps = MAX_LOYALTY_DISCOUNT_BPS;
        return gross - (gross * bps) / 10_000;
    }

    function _setDefaults(
        uint256 supply,
        uint256 vTok,
        uint256 vEth,
        uint256 target,
        uint16 feeBps,
        uint32 windowSecs,
        uint16 capBps,
        uint256 cap
    ) internal {
        if (feeBps > MAX_TRADE_FEE_BPS) revert FairLaunchFactory__InvalidTradeFee(feeBps);
        if (supply == 0 || vTok == 0 || vEth == 0 || target == 0) revert FairLaunchFactory__InvalidCurve();
        // The graduation price (ETH per whole token, 1e18 fixed point) must round to at
        // least 1, or FairGraduator's sqrt price would divide by zero and brick graduation.
        if (target * 1e18 < supply) revert FairLaunchFactory__InvalidCurve();
        if (windowSecs < MIN_WINDOW_SECS || windowSecs > MAX_WINDOW_SECS) revert FairLaunchFactory__InvalidWindow(windowSecs);
        if (capBps == 0 || capBps > MAX_BATCH_CAP_BPS) revert FairLaunchFactory__InvalidBatchCap(capBps);

        // Reachability with the same 5% margin as CurveFactory (URU-A03).
        uint256 maxReachable = (supply * vEth) / vTok;
        uint256 safeReachable = (maxReachable * (10_000 - uint256(GRADUATION_SAFETY_MARGIN_BPS))) / 10_000;
        if (target >= safeReachable) revert FairLaunchFactory__UnreachableGraduationTarget(target, safeReachable);

        // The full batch cap must land strictly below the graduation target.
        uint256 capTokens = (supply * capBps) / 10_000;
        uint256 effTok = supply + vTok;
        uint256 newEffTok = effTok - capTokens;
        uint256 capCostNet = (vEth * effTok + newEffTok - 1) / newEffTok - vEth;
        if (capCostNet >= target) revert FairLaunchFactory__BatchCapGraduates(capCostNet, target);

        defaultCurveSupply = supply;
        defaultVirtualTokenReserve = vTok;
        defaultVirtualEthReserve = vEth;
        defaultGraduationTargetEth = target;
        defaultTradeFeeBps = feeBps;
        batchWindowSecs = windowSecs;
        batchCapBps = capBps;
        walletCap = cap;
        emit DefaultsSet(supply, vTok, vEth, target, feeBps, windowSecs, capBps, cap);
    }

    // ============================================================ launch

    /// @notice Launch a Fair token, paying the deploy fee in ETH. Attach the fee
    ///         (`ethFeeFor(you)`) plus any ETH for your first opening-batch deposit; the
    ///         part above the fee is deposited at the same price as everyone else.
    function launch(
        string calldata name,
        string calldata symbol
    ) external payable returns (address token, address curve, address batch) {
        if (!launchesOpen) revert FairLaunchFactory__LaunchesClosed();
        uint256 fee = ethFeeFor(msg.sender);
        if (msg.value < fee) revert FairLaunchFactory__InsufficientEthFee(fee, msg.value);
        if (fee > 0) SafeTransferLib.safeTransferETH(feeReceiver, fee);
        return _launch(name, symbol, msg.value - fee, fee, false);
    }

    /// @notice Launch a Fair token, paying the deploy fee in URU (approve this factory
    ///         first). All attached ETH is your opening-batch deposit.
    function launchWithURU(
        string calldata name,
        string calldata symbol,
        uint256 uruAmount
    ) external payable returns (address token, address curve, address batch) {
        if (!launchesOpen) revert FairLaunchFactory__LaunchesClosed();
        address u = uru;
        if (u == address(0)) revert FairLaunchFactory__UruUnconfigured();
        if (uruAmount == 0) revert FairLaunchFactory__ZeroUru();
        uint256 required = minUruFeeFor(msg.sender);
        if (uruAmount < required) revert FairLaunchFactory__InsufficientUru(required, uruAmount);
        SafeTransferLib.safeTransferFrom(u, msg.sender, uruSink, uruAmount);
        return _launch(name, symbol, msg.value, uruAmount, true);
    }

    function _launch(
        string calldata name,
        string calldata symbol,
        uint256 creatorDeposit,
        uint256 feePaid,
        bool feeInUru
    ) internal returns (address token, address curve, address batch) {
        if (bytes(name).length == 0) revert FairLaunchFactory__NameEmpty();
        if (bytes(symbol).length == 0) revert FairLaunchFactory__TickerEmpty();

        bytes32 saltKey = keccak256(abi.encode(msg.sender, name, symbol));
        if (nameSaltTaken[saltKey]) revert FairLaunchFactory__NameTaken();
        nameSaltTaken[saltKey] = true;

        token = LibClone.cloneDeterministic(tokenImpl, keccak256(abi.encode(saltKey, "token")));
        curve = LibClone.cloneDeterministic(curveImpl, keccak256(abi.encode(saltKey, "curve")));
        batch = LibClone.cloneDeterministic(batchImpl, keccak256(abi.encode(saltKey, "batch")));

        uint256 supply = defaultCurveSupply;
        // Whole supply straight to the curve, then drop ownership: no admin on the token.
        IFairTokenInit(token).initialize(abi.encode(address(this), name, symbol, supply, curve, new bytes[](0)));
        IFairTokenInit(token).renounceOwnership();
        if (IFairTokenInit(token).owner() != address(0) || IFairTokenInit(token).balanceOf(curve) != supply) {
            revert FairLaunchFactory__TokenSetupFailed();
        }

        uint64 closeTs = uint64(block.timestamp) + batchWindowSecs;
        uint256 capTokens = (supply * batchCapBps) / 10_000;

        FairBondingCurve(payable(curve)).initialize(
            FairBondingCurve.InitParams({
                token: token,
                feeReceiver: feeReceiver,
                graduator: graduator,
                launcher: msg.sender,
                batch: batch,
                curveSupply: supply,
                virtualTokenReserve: defaultVirtualTokenReserve,
                virtualEthReserve: defaultVirtualEthReserve,
                graduationTargetEth: defaultGraduationTargetEth,
                batchCapTokens: capTokens,
                batchCloseTs: closeTs,
                tradeFeeBps: defaultTradeFeeBps
            })
        );
        OpeningBatch(payable(batch)).initialize(address(this), curve, token, msg.sender, closeTs, walletCap);

        curveFor[token] = curve;
        batchFor[token] = batch;

        if (creatorDeposit > 0) OpeningBatch(payable(batch)).depositFor{value: creatorDeposit}(msg.sender);

        emit FairLaunched(
            token, curve, msg.sender, batch, name, symbol, supply, capTokens, closeTs, creatorDeposit, feePaid, feeInUru
        );
    }

    /// Predicted addresses for a (launcher, name, symbol) triple, for the create page.
    function predictAddresses(
        address launcher,
        string calldata name,
        string calldata symbol
    ) external view returns (address token, address curve, address batch) {
        bytes32 saltKey = keccak256(abi.encode(launcher, name, symbol));
        token = LibClone.predictDeterministicAddress(tokenImpl, keccak256(abi.encode(saltKey, "token")), address(this));
        curve = LibClone.predictDeterministicAddress(curveImpl, keccak256(abi.encode(saltKey, "curve")), address(this));
        batch = LibClone.predictDeterministicAddress(batchImpl, keccak256(abi.encode(saltKey, "batch")), address(this));
    }
}
