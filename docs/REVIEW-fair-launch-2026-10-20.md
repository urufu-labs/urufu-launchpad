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

## Known limits (documented, not fixed)

- A dev who buys from other wallets from the very start cannot be linked on-chain.
- The creator's own dumping swap still pays them that one swap's creator fee: the hook
  checks the balance in `afterSwap`, before the router settles the tokens. The very
  next swap (or `pokeForfeit`) flips the pool.
- A creator holding zero tokens at graduation (never deposited, never bought) cannot
  trigger the forfeit; there is nothing to dump.
- `burnBank` is permissionless with a caller-chosen `minTokensOut`. Robinhood has a
  sequencer and no public mempool, but a caller passing 0 could sandwich a large bank.
  The keeper should burn often so banks stay small.
- Oversubscribed batches are pro rata by ETH, so a whale with the most ETH gets the most
  of the 25% slice. Per-wallet cap exists (`walletCap`) but defaults to off because
  splitting across wallets defeats it anyway.

## Tests after fixes

`forge test --match-path "test/fair/*"`: 65 passing (37 unit, 19 adversarial incl. 3
fuzz at 1000 runs, 9 fork on live Robinhood).
