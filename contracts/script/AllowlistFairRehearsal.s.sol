// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";

import {FairLaunchFactory} from "src/fair/FairLaunchFactory.sol";
import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairGraduator} from "src/fair/FairGraduator.sol";

interface IV4SwapRouterRehearsal {
    function swapExactETHForToken(
        PoolKey calldata key,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256);
}

/// @title  AllowlistFairRehearsal
/// @notice Makes the small live pool on FairHookHost that the Uniswap v4 hook
///         allowlist reviewers ask for (same idea as AllowlistV10RehearsalFlow for the
///         token-lane hook). NOT BROADCAST as of 2026-10-20. Two broadcasts, at least
///         10 seconds apart, because the Fair lane's opening batch has a minimum window:
///
///         Phase 1 (factory owner):
///           1. snapshot the factory's defaults and launch gate
///           2. setDefaults with a 0.001 ETH graduation target, a 10 s batch window and
///              a 0.01% batch cap (the factory's own checks require the cap to cost less
///              than the target)
///           3. open launches, launch the rehearsal token with a 0.0005 ETH creator deposit
///           4. restore the snapshotted defaults and launch gate in the same broadcast
///              (curve params are frozen per launch, so the rehearsal keeps its tiny target)
///         Phase 2 (anyone, after the batch window; run as the same wallet so the
///         creator holds and earns):
///           5. settle the batch, buy just past the target: graduation opens the v4 pool
///              on FairHookHost through FairGraduator
///           6. one 0.0001 ETH swap through the site's V4SwapRouter so every hook
///              callback has fired on the real pool
///
///         Env: FAIR_LAUNCH_FACTORY (phase 1 + 2), FAIR_REHEARSAL_TOKEN (phase 2, printed
///         by phase 1). Costs about 0.003 ETH plus gas. Hide the token from feeds after
///         (hiddenTokens), like V10AL.
///
///         forge script script/AllowlistFairRehearsal.s.sol --sig "phase1()" --rpc-url $ROBINHOOD_RPC_URL
///         forge script script/AllowlistFairRehearsal.s.sol --sig "phase2()" --rpc-url $ROBINHOOD_RPC_URL
contract AllowlistFairRehearsal is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant V4_SWAP_ROUTER = 0xDb3D1C43225faEe04551b663E5aA0969937beEa4;
    uint256 internal constant TINY_TARGET = 0.001 ether;
    uint32 internal constant TINY_WINDOW = 10;
    uint16 internal constant TINY_CAP_BPS = 1;
    uint256 internal constant CREATOR_DEPOSIT = 0.0005 ether;
    uint256 internal constant SWAP_SIZE = 0.0001 ether;
    string internal constant NAME = "Fair Allowlist Rehearsal";
    string internal constant SYMBOL = "FAIRAL";

    struct Defaults {
        uint256 supply;
        uint256 vTok;
        uint256 vEth;
        uint256 target;
        uint16 feeBps;
        uint32 window;
        uint16 capBps;
        uint256 walletCap;
        bool open;
    }

    bool internal _test;
    address internal _sender;

    // ------------------------------------------------------------ entrypoints

    function phase1() external returns (address token) {
        return _phase1(FairLaunchFactory(vm.envAddress("FAIR_LAUNCH_FACTORY")));
    }

    function phase2() external returns (PoolId id) {
        return _phase2(FairLaunchFactory(vm.envAddress("FAIR_LAUNCH_FACTORY")), vm.envAddress("FAIR_REHEARSAL_TOKEN"));
    }

    /// Fork-test entrypoints: prank `sender` instead of broadcasting.
    function phase1ForTest(
        FairLaunchFactory f,
        address sender
    ) external returns (address) {
        _test = true;
        _sender = sender;
        return _phase1(f);
    }

    function phase2ForTest(
        FairLaunchFactory f,
        address token,
        address sender
    ) external returns (PoolId) {
        _test = true;
        _sender = sender;
        return _phase2(f, token);
    }

    // ------------------------------------------------------------ phases

    function _phase1(
        FairLaunchFactory f
    ) internal returns (address token) {
        Defaults memory d = _snapshot(f);
        _start();
        f.setDefaults(d.supply, d.vTok, d.vEth, TINY_TARGET, d.feeBps, TINY_WINDOW, TINY_CAP_BPS, 0);
        if (!d.open) f.setLaunchesOpen(true);
        // The owner pays the normal ETH deploy fee like anyone else.
        (token,,) = f.launch{value: CREATOR_DEPOSIT + f.ethFeeFor(_who())}(NAME, SYMBOL);
        f.setDefaults(d.supply, d.vTok, d.vEth, d.target, d.feeBps, d.window, d.capBps, d.walletCap);
        if (!d.open) f.setLaunchesOpen(false);
        _stop();

        Defaults memory after_ = _snapshot(f);
        require(
            after_.target == d.target && after_.window == d.window && after_.capBps == d.capBps, "defaults not restored"
        );
        require(after_.open == d.open, "launch gate not restored");
        console2.log("rehearsal token (set FAIR_REHEARSAL_TOKEN):", token);
        console2.log("batch closes at:", uint256(OpeningBatch(payable(f.batchFor(token))).closeTs()));
    }

    function _phase2(
        FairLaunchFactory f,
        address token
    ) internal returns (PoolId id) {
        FairBondingCurve curve = FairBondingCurve(payable(f.curveFor(token)));
        OpeningBatch batch = OpeningBatch(payable(f.batchFor(token)));
        require(address(curve) != address(0), "not a Fair token");
        require(block.timestamp >= batch.closeTs(), "batch window still open, wait and rerun");
        FairGraduator g = FairGraduator(payable(f.graduator()));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: g.fee(),
            tickSpacing: g.tickSpacing(),
            hooks: IHooks(address(g.hook()))
        });
        id = key.toId();

        _start();
        if (!batch.settled()) batch.settle();
        if (!curve.graduated()) {
            uint256 need = curve.graduationTargetEth() - curve.ethReserve();
            uint256 gross = (need * 10_000) / (10_000 - curve.tradeFeeBps()) + 0.0002 ether;
            curve.buy{value: gross}(0);
        }
        require(curve.graduated(), "did not graduate");
        uint256 out = IV4SwapRouterRehearsal(V4_SWAP_ROUTER).swapExactETHForToken{value: SWAP_SIZE}(
            key, 0, _who(), block.timestamp + 300
        );
        _stop();
        require(out > 0, "post-graduation swap delivered nothing");

        console2.log("hook :", address(key.hooks));
        console2.log("token:", token);
        console2.logBytes32(PoolId.unwrap(id));
    }

    // ------------------------------------------------------------ helpers

    function _snapshot(
        FairLaunchFactory f
    ) internal view returns (Defaults memory d) {
        d.supply = f.defaultCurveSupply();
        d.vTok = f.defaultVirtualTokenReserve();
        d.vEth = f.defaultVirtualEthReserve();
        d.target = f.defaultGraduationTargetEth();
        d.feeBps = f.defaultTradeFeeBps();
        d.window = f.batchWindowSecs();
        d.capBps = f.batchCapBps();
        d.walletCap = f.walletCap();
        d.open = f.launchesOpen();
    }

    function _who() internal view returns (address) {
        return _test ? _sender : msg.sender;
    }

    function _start() internal {
        if (_test) vm.startPrank(_sender);
        else vm.startBroadcast();
    }

    function _stop() internal {
        if (_test) vm.stopPrank();
        else vm.stopBroadcast();
    }
}
