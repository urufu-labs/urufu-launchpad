// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant, console2} from "forge-std/Test.sol";

import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {BaseType} from "src/types/VMTypes.sol";

/// @notice Sink that can be flipped to reject ETH, so the fuzzer can exercise
///         `_distribute`'s reverting-sink rollover path (a slice whose sink
///         reverts must fall through to the treasury, never be lost).
contract ToggleSink {
    bool public accepting = true;
    uint256 public received;

    function setAccepting(
        bool v
    ) external {
        accepting = v;
    }

    receive() external payable {
        require(accepting, "sink closed");
        received += msg.value;
    }
}

/// @notice Sink that burns gas so the 100_000-gas cap in `_distribute` trips.
///         Distinct from an outright revert — it proves the cap itself is a
///         rollover trigger, not just an explicit `require`.
contract GasHogSink {
    uint256 public sink;

    receive() external payable {
        for (uint256 i; i < 10_000; ++i) {
            sink = i;
        }
    }
}

contract FeeSplitterHandler is Test {
    FeeSplitter public splitter;
    ToggleSink public buybackSink;
    ToggleSink public nftSink;
    ToggleSink public treasurySink;
    GasHogSink public gasHog;

    address public owner = makeAddr("fs-owner");
    address public sweepTarget = makeAddr("fs-sweep");

    // ---- ghosts ----
    uint256 public totalIn;
    uint256 public totalSwept;
    uint256 public feeCalls;
    uint256 public configCalls;
    uint256 public sweepCalls;

    constructor() {
        buybackSink = new ToggleSink();
        nftSink = new ToggleSink();
        treasurySink = new ToggleSink();
        gasHog = new GasHogSink();

        // URU-A11: production uses minConfigDelay > 0 (propose+activate),
        // but the invariant harness fuzzes configuration rotations directly
        // and needs the sync `setConfig` path. Use 0 in this test harness so
        // the direct setter is enabled — the timelock invariant is verified
        // separately in FeeSplitter.t.sol::test_SetConfig_TimelockGate.
        splitter = new FeeSplitter(owner, address(treasurySink), 0);

        // Install the real 40/35/25 split.
        vm.prank(owner);
        splitter.setConfig(address(buybackSink), address(nftSink), address(treasurySink), 4000, 3500, 2500);

        vm.deal(address(this), 1_000_000 ether);
    }

    /// Fees arrive through the IFeeReceiver entrypoint (Router / curves / hooks).
    function receiveFee(
        uint256 amount
    ) public {
        amount = bound(amount, 1, 50 ether);
        if (address(this).balance < amount) return;
        totalIn += amount;
        feeCalls++;
        splitter.receiveFee{value: amount}(address(0xA11CE), BaseType.ERC20);
    }

    /// Bare transfers hit `receive()` — the other distribution entrypoint.
    function receiveBare(
        uint256 amount
    ) public {
        amount = bound(amount, 1, 50 ether);
        if (address(this).balance < amount) return;
        totalIn += amount;
        feeCalls++;
        (bool ok,) = address(splitter).call{value: amount}("");
        ok;
    }

    /// Flip sinks open/closed so the rollover paths get exercised.
    function toggleSinks(
        uint256 seed
    ) public {
        buybackSink.setAccepting(seed % 2 == 0);
        nftSink.setAccepting((seed >> 1) % 3 != 0);
        // Treasury stays open most of the time; when it closes, ETH must stay
        // in-contract rather than vanish.
        treasurySink.setAccepting((seed >> 2) % 5 != 0);
    }

    /// Rotate config on the fly, including zero-sink configurations whose
    /// slices must roll into the treasury. Uses direct setConfig — the
    /// handler splitter is deployed with minConfigDelay = 0.
    function rotateConfig(
        uint256 seed
    ) public {
        uint16 a = uint16(bound(seed, 0, 10_000));
        uint16 b = uint16(bound(seed >> 8, 0, 10_000 - a));
        uint16 c = uint16(10_000 - a - b);

        address bSink = (seed >> 16) % 2 == 0 ? address(buybackSink) : address(0);
        address nSink = (seed >> 17) % 3 == 0 ? address(gasHog) : address(nftSink);

        configCalls++;
        vm.prank(owner);
        try splitter.setConfig(bSink, nSink, address(treasurySink), a, b, c) {} catch {}
    }

    function sweep() public {
        uint256 bal = address(splitter).balance;
        if (bal == 0) return;
        sweepCalls++;
        vm.prank(owner);
        try splitter.sweep(sweepTarget) {
            totalSwept += bal;
        } catch {}
    }

    receive() external payable {}
}

/// @title  FeeSplitterInvariantTest
/// @notice The FeeSplitter is the single choke point for every launch fee, curve
///         trade fee, and post-graduation swap fee in the protocol. Its one
///         non-negotiable property is **conservation**: every wei that goes in
///         must be accounted for downstream or still be sitting in the contract.
///         Never destroyed, never conjured.
///
///         `_distribute` has three separate fallthrough paths that could each
///         leak value if they got the arithmetic wrong — unset-sink rollover,
///         reverting-sink rollover, and the gas-capped call that treats an
///         out-of-gas sink as a failure. This suite fuzzes all three at once.
contract FeeSplitterInvariantTest is StdInvariant, Test {
    FeeSplitterHandler internal handler;

    function setUp() public {
        handler = new FeeSplitterHandler();

        bytes4[] memory sel = new bytes4[](5);
        sel[0] = FeeSplitterHandler.receiveFee.selector;
        sel[1] = FeeSplitterHandler.receiveBare.selector;
        sel[2] = FeeSplitterHandler.toggleSinks.selector;
        sel[3] = FeeSplitterHandler.rotateConfig.selector;
        sel[4] = FeeSplitterHandler.sweep.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// THE property: nothing is created or destroyed. Everything that entered
    /// is either sitting in a sink, was swept out, or is still in the splitter.
    function invariant_EthIsConserved() public view {
        uint256 out = address(handler.buybackSink()).balance + address(handler.nftSink()).balance
            + address(handler.treasurySink()).balance + address(handler.gasHog()).balance
            + address(handler.sweepTarget()).balance + address(handler.splitter()).balance;

        assertEq(out, handler.totalIn(), "ETH conservation broken across the splitter");
    }

    /// The splitter is a pass-through, not a vault. What it retains can only be
    /// per-distribution rounding residue (<3 wei) plus whatever a reverting
    /// treasury forced it to hold. It must never exceed total inflow.
    function invariant_RetainedNeverExceedsInflow() public view {
        assertLe(address(handler.splitter()).balance, handler.totalIn(), "splitter holds more than ever entered");
    }

    /// The bps triple is the accounting basis for every split. If it can ever
    /// drift off 10_000, slices silently stop summing to the whole.
    function invariant_BpsAlwaysSumToFull() public view {
        FeeSplitter s = handler.splitter();
        uint256 total = uint256(s.uruBuybackBps()) + uint256(s.nftRevenueBps()) + uint256(s.treasuryBps());
        assertEq(total, 10_000, "bps no longer sum to 10_000");
    }

    /// The treasury sink can never be unset — it is the rollover target of last
    /// resort, so a zero here would send every orphaned slice to address(0).
    function invariant_TreasurySinkNeverZero() public view {
        assertTrue(address(handler.splitter().treasurySink()) != address(0), "treasury sink was zeroed");
    }

    function invariant_CallSummary() public view {
        console2.log("fee calls   :", handler.feeCalls());
        console2.log("config calls:", handler.configCalls());
        console2.log("sweep calls :", handler.sweepCalls());
        console2.log("total in    :", handler.totalIn());
        console2.log("retained    :", address(handler.splitter()).balance);
    }
}
