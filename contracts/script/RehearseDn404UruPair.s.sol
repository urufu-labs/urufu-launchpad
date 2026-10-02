// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Dn404LaunchFactory} from "src/dn404/Dn404LaunchFactory.sol";
import {Dn404BondingCurve} from "src/dn404/Dn404BondingCurve.sol";
import {Dn404PairCurrencyAllowlist} from "src/dn404/Dn404PairCurrencyAllowlist.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

interface IErc20Min {
    function balanceOf(
        address who
    ) external view returns (uint256);
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
}

/// @title  RehearseDn404UruPair
/// @notice One-shot rehearsal that produces the first real v4 pool on the
///         DN404 MultiHookHost, so the hook can be submitted to the Uniswap
///         routing allowlist (the form needs a live pool to test against).
///
///         Decision 2026-09-23: pair currencies are ETH + URU only for now,
///         stock tokens later. ETH-paired DN404 launches graduate onto the
///         ERC-20 lane's host (already allowlisted), so the ONLY way to put
///         a pool on the DN404 host is an ERC-20-paired launch. URU is
///         18-decimal, so the factory's raw 1e18 defaults are correct for
///         it (USDG is 6-decimal and is NOT — see the decimals memo).
///
///         Steps, all from the deployer (owner of the allowlist + LF):
///           1. allowlist: URU in, USDG out
///           2. launch a URU-paired DN404 (tax off), paying the URU fee
///           3. buy through the curve past the graduation target
///           4. read the pool back from the PoolManager + host, log the id
///           5. (broadcast only) write deployment-dn404-rehearsal.<chain>.json
///
///         `runForTest(actor)` runs the same body under vm.startPrank(actor)
///         so the fork test executes the exact code that will be broadcast.
contract RehearseDn404UruPair is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error Rehearse__NoBook();
    error Rehearse__NotAllowlistOwner(address owner, address actor);
    error Rehearse__InsufficientUru(uint256 have, uint256 need);
    error Rehearse__DidNotGraduate();
    error Rehearse__PoolNotInitialized();
    error Rehearse__PoolHasNoLiquidity();
    error Rehearse__HostDidNotStampPool();

    /// USDG on Robinhood chain (6 decimals). Removed from the pair allowlist
    /// here because the factory defaults are 1e18-scaled; a USDG curve could
    /// never graduate until setDefaults is called with 6-decimal values.
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// Buy this much over the graduation target so the 1% trade fee slice
    /// can't leave the curve a hair short. Same headroom the fork tests use.
    uint256 internal constant HEADROOM_BPS = 12_500;

    struct Book {
        address launchFactory;
        address curveFactory;
        address pairCurrencyAllowlist;
        address graduator;
        address multiHookHost;
        address poolManager;
        address uru;
        uint24 gradFee;
        int24 gradTickSpacing;
    }

    struct Result {
        address base;
        address mirror;
        address curve;
        bytes32 poolId;
        address currency0;
        address currency1;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 uruFeePaid;
        uint256 uruBuyAmount;
        uint256 tokensOut;
    }

    bool internal _isTestContext;
    address internal _actor;

    function run() external returns (Result memory out) {
        _isTestContext = false;
        _actor = msg.sender;
        out = _runInner();
        _writeBook(out);
    }

    function runForTest(
        address actor
    ) external returns (Result memory out) {
        _isTestContext = true;
        _actor = actor;
        out = _runInner();
    }

    function _start() internal {
        if (_isTestContext) vm.startPrank(_actor);
        else vm.startBroadcast();
    }

    function _stop() internal {
        if (_isTestContext) vm.stopPrank();
        else vm.stopBroadcast();
    }

    function _runInner() internal returns (Result memory r) {
        Book memory b = _readBook();
        Dn404PairCurrencyAllowlist al = Dn404PairCurrencyAllowlist(b.pairCurrencyAllowlist);
        Dn404LaunchFactory lf = Dn404LaunchFactory(b.launchFactory);
        IErc20Min uru = IErc20Min(b.uru);

        // ---- pre-flight, read-only, before any state change
        address alOwner = al.owner();
        if (alOwner != _actor) revert Rehearse__NotAllowlistOwner(alOwner, _actor);
        bool uruAllowed = al.isAllowed(b.uru);
        bool usdgAllowed = al.isAllowed(USDG);
        uint256 fee = lf.minUruFeeFor(_actor);

        console2.log("actor                 ", _actor);
        console2.log("URU allowed (before)  ", uruAllowed);
        console2.log("USDG allowed (before) ", usdgAllowed);
        console2.log("URU launch fee (wei)  ", fee);

        _start();

        // ---- 1. allowlist: URU in, USDG out
        if (!uruAllowed) al.setAllowed(b.uru, true, "URU");
        if (usdgAllowed) al.setAllowed(USDG, false, "");

        // ---- 2. launch a URU-paired DN404, tax off
        //   800M total supply matches Dn404CurveFactory.defaultCurveSupply so
        //   nothing is stranded. unit = 100M tokens per NFT keeps the mirror
        //   collection tiny (8 NFTs) so the graduating buy doesn't spend gas
        //   minting hundreds of NFTs to the buyer in one tx.
        //   The factory keys name uniqueness on (launcher, name, ticker), and
        //   the 2026-09-23 broadcast already took the bare name for the
        //   deployer, so every run salts the name with a tag (default: the
        //   fork block) to stay re-runnable as a regression test.
        string memory tag = vm.envOr("REHEARSAL_TAG", vm.toString(block.number));
        Dn404LaunchFactory.LaunchParams memory p;
        p.name = string.concat("DN404 URU Rehearsal ", tag);
        p.ticker = "REH404";
        p.baseURI = "ipfs://rehearsal/";
        p.contractURI = "ipfs://rehearsal/collection.json";
        p.collectionSize = 8;
        p.unit = 100_000_000;
        p.founderPremintBps = 0;
        p.antiSniperBlocks = 0;
        p.buybackBurnBps = 0;
        p.pairCurrency = b.uru;
        p.taxMode = 0;
        p.taxBps = 0;
        p.taxTarget = address(0);
        p.uruAmount = fee;

        if (fee > 0) uru.approve(b.launchFactory, fee);
        (r.base, r.mirror, r.curve) = lf.launch(p);
        r.uruFeePaid = fee;

        // ---- 3. buy past the graduation target
        Dn404BondingCurve c = Dn404BondingCurve(r.curve);
        uint256 target = c.graduationTargetEth();
        r.uruBuyAmount = (target * HEADROOM_BPS) / 10_000;
        uint256 have = uru.balanceOf(_actor);
        if (have < r.uruBuyAmount) revert Rehearse__InsufficientUru(have, r.uruBuyAmount);

        uru.approve(r.curve, r.uruBuyAmount);
        r.tokensOut = c.buy(r.uruBuyAmount, 0);
        if (!c.graduated()) revert Rehearse__DidNotGraduate();

        _stop();

        // ---- 4. read the pool back; never trust the event alone
        (r.currency0, r.currency1) = r.base < b.uru ? (r.base, b.uru) : (b.uru, r.base);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(r.currency0),
            currency1: Currency.wrap(r.currency1),
            fee: b.gradFee,
            tickSpacing: b.gradTickSpacing,
            hooks: IHooks(b.multiHookHost)
        });
        PoolId pid = key.toId();
        r.poolId = PoolId.unwrap(pid);

        (r.sqrtPriceX96,,,) = IPoolManager(b.poolManager).getSlot0(pid);
        r.liquidity = IPoolManager(b.poolManager).getLiquidity(pid);
        if (r.sqrtPriceX96 == 0) revert Rehearse__PoolNotInitialized();
        if (r.liquidity == 0) revert Rehearse__PoolHasNoLiquidity();

        (uint32 launchBlock,,) = MultiHookHost(payable(b.multiHookHost)).poolConfig(pid);
        if (launchBlock == 0) revert Rehearse__HostDidNotStampPool();

        console2.log("base   ", r.base);
        console2.log("mirror ", r.mirror);
        console2.log("curve  ", r.curve);
        console2.log("hook   ", b.multiHookHost);
        console2.log("c0     ", r.currency0);
        console2.log("c1     ", r.currency1);
        console2.logBytes32(r.poolId);
        console2.log("sqrtPriceX96", r.sqrtPriceX96);
        console2.log("liquidity   ", r.liquidity);
        console2.log("URU fee paid", r.uruFeePaid);
        console2.log("URU bought  ", r.uruBuyAmount);
        console2.log("tokens out  ", r.tokensOut);
    }

    function _readBook() internal view returns (Book memory b) {
        string memory path = string.concat("deployment-dn404.", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) revert Rehearse__NoBook();
        string memory j = vm.readFile(path);
        b.launchFactory = vm.parseJsonAddress(j, ".Dn404LaunchFactory");
        b.curveFactory = vm.parseJsonAddress(j, ".Dn404CurveFactory");
        b.pairCurrencyAllowlist = vm.parseJsonAddress(j, ".Dn404PairCurrencyAllowlist");
        b.graduator = vm.parseJsonAddress(j, ".Dn404Graduator");
        b.multiHookHost = vm.parseJsonAddress(j, ".Dn404MultiHookHost");
        b.poolManager = vm.parseJsonAddress(j, ".PoolManager");
        b.uru = vm.parseJsonAddress(j, ".URU");
        b.gradFee = uint24(vm.parseJsonUint(j, ".GradFee"));
        b.gradTickSpacing = int24(int256(vm.parseJsonUint(j, ".GradTickSpacing")));
    }

    function _writeBook(
        Result memory r
    ) internal {
        string memory obj = "rehearsal";
        vm.serializeAddress(obj, "base", r.base);
        vm.serializeAddress(obj, "mirror", r.mirror);
        vm.serializeAddress(obj, "curve", r.curve);
        vm.serializeBytes32(obj, "poolId", r.poolId);
        vm.serializeAddress(obj, "currency0", r.currency0);
        vm.serializeAddress(obj, "currency1", r.currency1);
        vm.serializeUint(obj, "sqrtPriceX96", r.sqrtPriceX96);
        vm.serializeUint(obj, "liquidity", r.liquidity);
        vm.serializeUint(obj, "uruFeePaid", r.uruFeePaid);
        vm.serializeUint(obj, "uruBuyAmount", r.uruBuyAmount);
        string memory out = vm.serializeUint(obj, "tokensOut", r.tokensOut);
        vm.writeJson(out, string.concat("deployment-dn404-rehearsal.", vm.toString(block.chainid), ".json"));
    }
}
