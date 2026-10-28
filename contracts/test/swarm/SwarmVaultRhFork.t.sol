// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IFairLaunchFactoryView, SwarmVault} from "src/swarm/SwarmVault.sol";
import {SwarmVaultFactory} from "src/swarm/SwarmVaultFactory.sol";

interface ILiveFairFactory {
    function ethFeeFor(
        address launcher
    ) external view returns (uint256);
    function launch(
        string calldata name,
        string calldata symbol
    ) external payable returns (address token, address curve, address batch);
    function launchesOpen() external view returns (bool);
    function walletCap() external view returns (uint256);
}

interface ILiveBatch {
    function deposit() external payable;
    function closeTs() external view returns (uint64);
    function entitlement(
        address user
    ) external view returns (uint256);
    function totalDeposited() external view returns (uint256);
    function tokensBought() external view returns (uint256);
    function claim() external returns (uint256 tokens, uint256 refund);
}

interface ILiveCurve {
    function graduated() external view returns (bool);
    function graduationTargetEth() external view returns (uint256);
    function ethReserve() external view returns (uint256);
    function tradeFeeBps() external view returns (uint16);
    function buy(
        uint256 minTokensOut
    ) external payable returns (uint256);
}

interface IERC20Bal {
    function balanceOf(
        address
    ) external view returns (uint256);
}

/// @notice Phase 3 on a Robinhood mainnet fork (docs/PLAN-agents-and-swarms.md §4.4): a
///         SwarmVaultFactory pointed at the LIVE FairLaunchFactory runs a full swarm:
///         create -> join + vote -> the named creator launches with the live fee -> the
///         pool joins the opening batch next to ordinary depositors -> settle -> claim ->
///         members withdraw -> the token graduates. The swarm must get exactly what one
///         depositor with the same ETH gets, and each member exactly their pro-rata share.
contract SwarmVaultRhForkTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;
    address internal constant LIVE_FAIR_FACTORY = 0x986BFC6c7be4b8d613FC3d25c6633eD9af27701d;

    ILiveFairFactory internal fair = ILiveFairFactory(LIVE_FAIR_FACTORY);
    SwarmVaultFactory internal swarms;

    address internal creator = makeAddr("swarm-fork-creator");
    address internal a = makeAddr("swarm-fork-a");
    address internal b = makeAddr("swarm-fork-b");
    address internal c = makeAddr("swarm-fork-c");
    address internal twin = makeAddr("swarm-fork-twin");

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (!fair.launchesOpen()) vm.skip(true);
        swarms = new SwarmVaultFactory(IFairLaunchFactoryView(LIVE_FAIR_FACTORY));
    }

    function _join(
        SwarmVault v,
        address who,
        uint256 amount
    ) internal {
        vm.deal(who, amount);
        vm.prank(who);
        v.join{value: amount}();
    }

    function test_Fork_FullSwarm_ExactProRataThenGraduates() public {
        vm.prank(a);
        SwarmVault v = SwarmVault(
            payable(swarms.createSwarm(
                    SwarmVaultFactory.Params({
                        creator: creator,
                        name: "Swarm Fork Test",
                        ticker: "SWFT",
                        joinSeconds: 1 hours,
                        launchSeconds: 1 hours,
                        quorumBps: 6000,
                        minPool: 0.5 ether,
                        maxPool: 0,
                        minDeposit: 0.01 ether,
                        metadataURI: ""
                    })
                ))
        );
        uint256 cap = fair.walletCap();
        // Keep the pool inside a live wallet cap if there is one, so the twin comparison holds.
        uint256 unit = cap != 0 && cap < 3 ether ? cap / 3 : 0.5 ether;
        _join(v, a, unit);
        _join(v, b, unit);
        _join(v, c, unit);
        vm.prank(a);
        v.approve();
        vm.prank(b);
        v.approve();
        assertTrue(v.passed());
        vm.warp(uint256(v.joinDeadline()));

        // The named creator launches through the live factory, paying the live fee.
        uint256 fee = fair.ethFeeFor(creator);
        vm.deal(creator, fee + 0.1 ether);
        vm.prank(creator);
        (address token, address curve, address batch) = fair.launch{value: fee + 0.1 ether}("Swarm Fork Test", "SWFT");
        assertEq(token, v.token());
        assertEq(batch, v.batch());

        v.joinBatch();
        uint256 pool = 3 * unit;
        // An ordinary depositor with exactly the swarm's ETH, and some others.
        vm.deal(twin, pool);
        vm.prank(twin);
        ILiveBatch(batch).deposit{value: pool}();
        address other = makeAddr("swarm-fork-other");
        vm.deal(other, 0.7 ether);
        vm.prank(other);
        ILiveBatch(batch).deposit{value: 0.7 ether}();

        vm.warp(uint256(ILiveBatch(batch).closeTs()) + 1);
        v.claimFromBatch();
        vm.prank(twin);
        (uint256 twinTokens,) = ILiveBatch(batch).claim();
        assertEq(v.tokensReceived(), twinTokens, "the swarm got exactly what one depositor with the same ETH got");
        assertEq(
            v.tokensReceived(),
            ILiveBatch(batch).tokensBought() * pool / ILiveBatch(batch).totalDeposited(),
            "and exactly its pro-rata share of the batch"
        );

        uint256 paid;
        address[3] memory ms = [a, b, c];
        for (uint256 i; i < 3; i++) {
            vm.prank(ms[i]);
            (uint256 t,) = v.withdrawShare();
            assertEq(t, v.tokensReceived() / 3, "equal deposits, equal shares");
            assertEq(IERC20Bal(token).balanceOf(ms[i]), t);
            paid += t;
        }
        assertLt(v.tokensReceived() - paid, 3, "dust only");

        // The token still graduates normally afterwards.
        ILiveCurve cv = ILiveCurve(curve);
        uint256 need = cv.graduationTargetEth() - cv.ethReserve();
        uint256 gross = (need * 10_000) / (10_000 - cv.tradeFeeBps()) + 0.01 ether;
        address whale = makeAddr("swarm-fork-whale");
        vm.deal(whale, gross);
        vm.prank(whale);
        cv.buy{value: gross}(0);
        assertTrue(cv.graduated(), "graduated");
    }
}
