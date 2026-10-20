# Fair launch lane: internal security review

> **Status:** internal pre-audit pass, 2026-10-20. Not a substitute for the external audit.

Scope: `contracts/src/fair/*` (FairLaunchFactory, OpeningBatch, FairBondingCurve,
FairGraduator, FairHookHost) and `contracts/script/DeployFairLane.s.sol`.

Method: Slither 0.11.5 (repo `slither.config.json`, scoped with
`--include-paths "src/fair|script/DeployFairLane"`), then a line-by-line manual
pass of all five contracts, then a regression test for every fix.

## Slither

94 results, **0 High**. Every Medium was checked by hand:

| Detector | Where | Verdict |
|---|---|---|
| divide-before-multiply | hook fee split, factory reachability, graduator tick bounds | Intended. Same math as MultiHookHost / CurveFactory / GraduatorV3. Rounding is at most 1 wei in the platform's favor or in the safe direction. |
| incorrect-equality | `launchTs == 0`, `totalTake == 0` | Sentinel checks on values we set, not balances. Safe. |
| reentrancy-no-eth | `burnBank` writes `bankedEth` after `poolManager.unlock` | `burnBank` is `nonReentrant`, and the only callback inside that unlock is our own swap, where v4 skips the hook's swap callbacks. Safe. |
| uninitialized-local | `forfeitedShare` | Zero by default is the intended value. |
| unused-return | PoolManager `settle` / `initialize` / `unlock` / `modifyLiquidity`, batch quote helpers, graduator `claimFor` | Deliberate. Deltas are read from `modifyLiquidity`'s first return; `settle` return equals what we paid. |

Lows (timestamp use, benign reentrancy through trusted contracts, events after calls)
and Informationals reviewed; nothing actionable. Timestamp use is required by the spec
(Robinhood `block.number` is the L1 block).

## Manual findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | High | **Sniper tax could be dodged with range orders.** Anyone could add a one-sided ETH position just above the price right after graduation; buyers pushing the price through it convert that ETH to tokens with no swap, so no tax. Same in reverse for selling. | Fixed. FairHookHost now has `beforeAddLiquidity` (flags `0x28C4`): only the graduator can add liquidity until the tax window ends. Tests: `test_ThirdPartyLiquidityLockedDuringTax` (local) and `test_Fork_ThirdPartyLiquidityLockedDuringTax_LivePoolManager` (live RH fork). |
| F-2 | Medium | **Pre-graduation transfer escaped the forfeit.** Baseline was just the creator's balance at graduation, so moving tokens to an alt before graduation lowered the bar and the alt could dump with no penalty. | Fixed. The curve records `creatorBought`; the graduator compares the creator's balance to curve buys + batch share. More than 10% short means the pool starts forfeited. Tests: `test_PreGradTransferToAlt_ForfeitsFromStart`, `test_PreGradSmallTransfer_UnderAllowance_NotForfeited`. |
| F-3 | Medium | **A claim could be blocked by its ETH refund.** A contract wallet that rejects ETH (or burns gas in `receive`) could never claim its tokens, and the graduator's creator auto-claim silently failed for it. | Fixed. The refund is pushed with a 100k gas stipend; if that fails it is parked in `refundOwed` and pulled later with `withdrawRefund(to)`. `sweepDust` reserves parked refunds. Graduator claim gas budget raised to 400k. Tests: gas-burner / ETH-rejecting creator tests, `test_SweepDustReservesParkedRefunds`. |
| F-4 | Low | **Graduation could brick on extreme admin settings.** If target * 1e18 < supply, the opening price rounds to 0 and the sqrt-price division reverts. | Fixed. `setDefaults` rejects it. |

## Known limits, second pass (same day)

The four limits left after the first pass, and what was done:

| # | Limit | Status |
|---|---|---|
| L-1 | A dev buying from fresh wallets cannot be linked on-chain. | **Flagged off-chain.** The trade page lists batch depositors and early buyers that got ETH or this token straight from the creator wallet in the 3 days before launch or after, read from Robinhood Blockscout in the visitor's browser (Blockscout blocks servers). Warning only; funding through an exchange, bridge or second hop still passes. `web/src/lib/devFunded.ts` + tests. |
| L-2 | The creator's own dumping swap still paid them that swap's creator fee (the router settles the tokens after the hook runs). | **Fixed.** Creator fees now sit as *pending* per pool and only become claimable after a check in a LATER transaction sees the creator still above the floor. A failed check forfeits the pool and burns everything pending, the dump's fee included. Checks run on the first swap of each tx (transient-storage flag) and in `pokeForfeit` / `claimCreatorFees`, which refuse while the PoolManager is unlocked, so a dev cannot dump and claim mid-swap. An empty claim no longer reverts, so the forfeit it detects always sticks. Tests: `FairLaneLoopholes` L2 cases (aggregator dump, pay-after-swap dump, dump-and-claim in one tx, claim mid-unlock, honest creator still paid) and `test_Fork_CreatorDumpViaUniswapApp_FeeClawedBack` on live Robinhood. |
| L-3 | A creator holding nothing at graduation could never be forfeited, so earned fees while holding nothing. | **Fixed (option a, "no holdings, no fee").** The graduator starts the pool forfeited if the creator holds under 0.1% of supply; the hook also forfeits on a zero baseline. Tests: zero, dust and small-real holder cases. |
| L-4 | `burnBank` was permissionless with only a caller-chosen slippage floor, so it could be sandwiched. | **Fixed.** The hook records the pool price at the start of each second (first swap or first burn). `burnBank` refuses if the price moved more than 1% (sqrt price, ~2% price) from that reference, and each burn stops at 0.5% sqrt-price impact, leaving the rest banked. A front-run has to land in the same second, so it trips the check. Tests: sandwich refused, per-burn cap, per-second bound. |

Remaining, by design:
- Oversubscribed batches are pro rata by ETH, so the wallet with the most ETH gets the most of the 25% slice. `walletCap` exists but is off by default because splitting across wallets defeats it.
- Pending creator fees cover only the most recent transaction(s) before a check, so an honest creator's last fees burn if the creator later dumps before any other swap confirms them. That is part of the penalty.
- A creator who can flash-borrow the token from some other venue could pass a single check. There is no such venue for a new Fair token at launch.

## Tests after fixes

`forge test --match-path "test/fair/*"`: 77 passing (37 unit, 19 adversarial incl. 3
fuzz at 1000 runs, 11 loophole, 10 fork on live Robinhood). All fair suites run in
Foundry isolate mode so each call is its own transaction, like on chain (the
per-transaction creator check depends on it). Slither after the second pass: 102
results, 0 High; new Mediums are the same trusted-PoolManager reentrancy and
default-zero patterns triaged above.
