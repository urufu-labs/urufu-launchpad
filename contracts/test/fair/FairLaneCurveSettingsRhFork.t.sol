// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {FairBondingCurve} from "src/fair/FairBondingCurve.sol";
import {OpeningBatch} from "src/fair/OpeningBatch.sol";
import {FairLaneRhForkTest} from "./FairLaneRhFork.t.sol";

interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

/// @notice Graduation cliff check for candidate curve settings (higher virtual ETH start
///         and bond target), on a Robinhood mainnet fork against the live PoolManager and
///         Universal Router. For each setting: setDefaults, launch, fill the opening batch
///         to its cap, graduate, then measure
///           * the opening pool price vs the curve's last marginal price, and
///           * a small Uniswap-app buy and sell after the sniper tax ends, vs that price.
///         Run: forge test --match-contract FairLaneCurveSettingsRhFork -vv
/// forge-config: default.isolate = true
contract FairLaneCurveSettingsRhForkTest is FairLaneRhForkTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_CurveSettings_Current_2_4p2() public {
        _checkSetting(2 ether, 4.2 ether);
    }

    function test_CurveSettings_5_5() public {
        _checkSetting(5 ether, 5 ether);
    }

    function test_CurveSettings_8_8() public {
        _checkSetting(8 ether, 8 ether);
    }

    function test_CurveSettings_10_10() public {
        _checkSetting(10 ether, 10 ether);
    }

    function test_CurveSettings_15_15() public {
        _checkSetting(15 ether, 15 ether);
    }

    function _checkSetting(
        uint256 vEth,
        uint256 target
    ) internal {
        vm.prank(admin);
        factory.setDefaults(800_000_000e18, 1, vEth, target, 100, 60, 2500, 0);

        (address token, FairBondingCurve curve, OpeningBatch batch) = _launch("CurveSet", 0.2 ether);
        // Oversubscribe the batch: more ETH than the 25% cap needs, so settle spends the
        // cap and refunds the rest (the bundling scenario the higher start prices).
        _deposit(batch, depositor, target);
        _warpPast(batch);
        batch.settle();
        vm.prank(depositor);
        batch.claim();

        uint256 vE = curve.virtualEthReserve();
        uint256 vT = curve.virtualTokenReserve();
        vm.recordLogs();
        PoolKey memory key = _graduate(curve);
        (uint256 ethAmt, uint256 tokAmt) = _graduatedAmounts(vm.getRecordedLogs());
        assertGt(ethAmt, 0, "Graduated not emitted");

        // Last curve price (ETH per token, 1e18) vs the pool's opening price.
        uint256 marginal = ((vE + ethAmt) * 1e18) / (vT + tokAmt);
        uint256 poolPrice = _poolPrice(key);
        uint256 cliffPpm = _ppm(poolPrice, marginal);
        assertLe(cliffPpm, 1000, "graduation cliff > 0.1%");

        // After the sniper tax: a small buy and sell through the Uniswap app path.
        vm.warp(block.timestamp + 301);
        address t = trader;
        vm.deal(t, 1 ether);
        _approveUr(t, token);
        uint256 balBefore = _bal(token, t);
        _urExactIn(t, key, true, 0.01 ether);
        uint256 got = _bal(token, t) - balBefore;
        uint256 buyPrice = (0.01 ether * 1e18) / got;
        uint256 ethBefore = t.balance;
        _urExactIn(t, key, false, got);
        uint256 sellPrice = ((t.balance - ethBefore) * 1e18) / got;

        // Fees on a pool trade: 0.3% LP + 1% platform + 1% creator = 2.3% each way.
        assertLe(buyPrice, (marginal * 10_300) / 10_000, "buy > 3% over curve price");
        assertGe(sellPrice, (marginal * 9700) / 10_000, "sell < 97% of curve price");

        uint256 burned = _bal(token, 0x000000000000000000000000000000000000dEaD);
        uint256 supply = IERC20Supply(token).totalSupply() - burned;
        emit log_named_uint("vEth (ETH x1e3)", vEth / 1e15);
        emit log_named_uint("target (ETH x1e3)", target / 1e15);
        emit log_named_uint("graduation cliff (ppm)", cliffPpm);
        emit log_named_uint("pool ETH (x1e3)", ethAmt / 1e15);
        emit log_named_uint("tokens to pool (M)", tokAmt / 1e24);
        emit log_named_uint("burned at graduation (M)", burned / 1e24);
        emit log_named_uint("supply after burn (M)", supply / 1e24);
        emit log_named_uint("mcap after grad (milliETH)", (marginal * (supply / 1e18)) / 1e15);
        emit log_named_uint("buy vs curve (bps over)", ((buyPrice * 10_000) / marginal) - 10_000);
        emit log_named_uint("sell vs curve (bps under)", 10_000 - ((sellPrice * 10_000) / marginal));
    }

    function _graduatedAmounts(
        Vm.Log[] memory logs
    ) internal view returns (uint256 ethAmt, uint256 tokAmt) {
        bytes32 topic = keccak256("Graduated(address,address,uint256,uint256,uint160,uint128,address,uint256,bool)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(graduator) && logs[i].topics[0] == topic) {
                (ethAmt, tokAmt) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    function _poolPrice(
        PoolKey memory key
    ) internal view returns (uint256) {
        (uint160 sq,,,) = pm.getSlot0(key.toId());
        uint256 tokPerEthX18 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.fullMulDiv(uint256(sq), uint256(sq), 1 << 96), 1e18, 1 << 96
        );
        return 1e36 / tokPerEthX18;
    }

    function _ppm(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return (d * 1e6) / b;
    }
}
