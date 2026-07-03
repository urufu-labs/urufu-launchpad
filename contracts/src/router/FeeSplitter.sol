// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {BaseType} from "src/types/VMTypes.sol";
import {IFeeReceiver} from "src/router/FeeReceiver.sol";

/// @title  FeeSplitter
/// @notice Drop-in replacement for `FeeReceiver`. Implements the same `IFeeReceiver`
///         interface so Router doesn't care whether it's the old dumb sink or this smart
///         splitter — swap it in via the same `Router` constructor arg.
///
///         On every `receiveFee`, splits the incoming ETH between 3 sinks per configurable
///         basis-points allocations that MUST sum to 10 000:
///           - `uruBuybackSink`    → typically `UruBuybackVault`
///           - `nftRevenueSink`    → typically `NftRevenueVault` for gemu holders
///           - `treasurySink`      → platform ops
///
///         Any zero-address sink rolls its share into the treasury (safe default: on cold
///         start, treasury = launcher's ops wallet, all other sinks are zero, 100% goes
///         to treasury).
///
///         Design note: an earlier draft had a fourth "creator" slot that would route to
///         the launcher of the specific token. Removed because (a) it created a spam-launch
///         farming surface without adding meaningful launcher incentive (0.005 ETH kickback
///         per launch), and (b) real creator earnings already accrue post-graduation via
///         v4 hooks (`FeeRedirectHook`, `MultiHookHost`) which are gated by the curve
///         actually reaching graduation. That gate is a real market-cap threshold; farming
///         it requires 4 ETH of real trading volume, not a wash-loop.
///
/// @dev    Timelock-controlled config changes are enforced by making `setConfig` reject
///         changes shorter than `MIN_CONFIG_DELAY` after the LAST change. Combined with a
///         multisig owner, this gives users a heads-up before splits shift. Set delay to
///         zero for testnets by passing 0 at construction.
contract FeeSplitter is IFeeReceiver, Ownable {
    // ============================================================
    // Errors
    // ============================================================
    error FeeSplitter__ZeroAddress();
    error FeeSplitter__BadSum(uint256 total);
    error FeeSplitter__TooSoon(uint256 currentTs, uint256 earliestTs);
    error FeeSplitter__ZeroBalance();

    // ============================================================
    // Events — one per config change + one per fee-received (broken down per sink)
    // ============================================================
    event FeeReceived(address indexed launcher, BaseType indexed base, uint256 amount);
    event Distributed(uint256 total, uint256 toBuyback, uint256 toNft, uint256 toTreasury);
    event ConfigSet(
        address uruBuybackSink,
        address nftRevenueSink,
        address treasurySink,
        uint16 uruBuybackBps,
        uint16 nftRevenueBps,
        uint16 treasuryBps
    );
    event Swept(address indexed to, uint256 amount);

    // ============================================================
    // State
    // ============================================================
    uint256 public immutable minConfigDelay;
    uint256 public lastConfigChange;

    address public uruBuybackSink;
    address public nftRevenueSink;
    address public treasurySink;
    uint16 public uruBuybackBps;
    uint16 public nftRevenueBps;
    uint16 public treasuryBps;

    // ============================================================
    // Constructor
    // ============================================================
    constructor(
        address initialOwner,
        address treasury_,
        uint256 minConfigDelay_
    ) {
        if (initialOwner == address(0) || treasury_ == address(0)) revert FeeSplitter__ZeroAddress();
        _initializeOwner(initialOwner);
        treasurySink = treasury_;
        treasuryBps = 10_000; // safe cold-start default: everything to treasury
        minConfigDelay = minConfigDelay_;
        lastConfigChange = block.timestamp;
        emit ConfigSet(address(0), address(0), treasury_, 0, 0, 10_000);
    }

    // ============================================================
    // IFeeReceiver — called by Router / curves / hooks
    // ============================================================
    function receiveFee(
        address launcher,
        BaseType base
    ) external payable {
        emit FeeReceived(launcher, base, msg.value);
        _distribute(msg.value);
    }

    receive() external payable {
        emit FeeReceived(address(0), BaseType.ERC20, msg.value);
        _distribute(msg.value);
    }

    // ============================================================
    // Owner config — timelock-gated
    // ============================================================
    function setConfig(
        address uruBuybackSink_,
        address nftRevenueSink_,
        address treasurySink_,
        uint16 uruBuybackBps_,
        uint16 nftRevenueBps_,
        uint16 treasuryBps_
    ) external onlyOwner {
        uint256 earliest = lastConfigChange + minConfigDelay;
        if (block.timestamp < earliest) revert FeeSplitter__TooSoon(block.timestamp, earliest);
        if (treasurySink_ == address(0)) revert FeeSplitter__ZeroAddress();
        uint256 total = uint256(uruBuybackBps_) + uint256(nftRevenueBps_) + uint256(treasuryBps_);
        if (total != 10_000) revert FeeSplitter__BadSum(total);

        uruBuybackSink = uruBuybackSink_;
        nftRevenueSink = nftRevenueSink_;
        treasurySink = treasurySink_;
        uruBuybackBps = uruBuybackBps_;
        nftRevenueBps = nftRevenueBps_;
        treasuryBps = treasuryBps_;
        lastConfigChange = block.timestamp;

        emit ConfigSet(uruBuybackSink_, nftRevenueSink_, treasurySink_, uruBuybackBps_, nftRevenueBps_, treasuryBps_);
    }

    /// @notice Emergency sweep of stranded ETH (post-distribution residue from rounding, or
    ///         direct sends that hit receive() before the distribute path could fire). Owner
    ///         only; goes to the specified address. Not timelocked — this is a safety valve.
    function sweep(
        address to
    ) external onlyOwner {
        if (to == address(0)) revert FeeSplitter__ZeroAddress();
        uint256 amount = address(this).balance;
        if (amount == 0) revert FeeSplitter__ZeroBalance();
        SafeTransferLib.safeTransferETH(to, amount);
        emit Swept(to, amount);
    }

    // ============================================================
    // Internal
    // ============================================================
    function _distribute(
        uint256 amount
    ) internal {
        if (amount == 0) return;

        // Slices per bps. Rounding residue (up to 3 wei) stays in the contract and is swept
        // via `sweep()` if it ever accumulates meaningfully.
        uint256 toBuyback = (amount * uruBuybackBps) / 10_000;
        uint256 toNft = (amount * nftRevenueBps) / 10_000;
        uint256 toTreasury = amount - toBuyback - toNft;

        // If a sink is unset, roll its slice into the treasury. Ensures we never lose ETH.
        if (uruBuybackSink == address(0) && toBuyback > 0) {
            toTreasury += toBuyback;
            toBuyback = 0;
        }
        if (nftRevenueSink == address(0) && toNft > 0) {
            toTreasury += toNft;
            toNft = 0;
        }

        if (toBuyback > 0) SafeTransferLib.safeTransferETH(uruBuybackSink, toBuyback);
        if (toNft > 0) SafeTransferLib.safeTransferETH(nftRevenueSink, toNft);
        if (toTreasury > 0) SafeTransferLib.safeTransferETH(treasurySink, toTreasury);

        emit Distributed(amount, toBuyback, toNft, toTreasury);
    }
}
