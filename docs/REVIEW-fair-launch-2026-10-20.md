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

## V1 deploy (Robinhood, 2026-10-20) - SUPERSEDED by V2 below

Deployed before the external audit so the Uniswap hook allowlist review can run in
parallel. **Launches are closed on-chain** (`launchesOpen = false`); nothing can be
launched until the owner opens them.

| Contract | Address |
|---|---|
| FairLaunchFactory | `0x0aaD9FC0703e7704DCAe564e53E754155da6fD64` |
| FairHookHost (flags 0x28C4, CREATE2 salt 9210) | `0xfa7FECCFB9a08E69457F876C3beBCCbB39bDE8C4` |
| FairGraduator | `0xaFBC1a4f148c59320a2052be336CE00eC6490a9B` |
| FairBondingCurve impl | `0xf50492c6569463eC7efb9e20dfb735C598a43978` |
| OpeningBatch impl | `0xd4fF34aa373E5F2d7a5Aa4D912b6739E872E7584` |
| ERC20Template impl | `0xb467F639E5d2E6394Ca7885fA82aA8e87Ab37B5B` |

Blocks 93,559,145 to 93,559,323. Owner `0x6d60...5Bb9`. All six verified on
Blockscout (runs 10000, via-IR). Wiring re-read on-chain after the broadcast: hook
initializer = graduator, graduator factory = factory, fees to FeeSplitter
`0x20d2...0FfA`, 1% + 1%, tax 20% over 300 s, forfeit at 10%, live curve defaults
(800M / 2 ETH / 4.2 ETH), 60 s window, 25% cap.

**Allowlist rehearsal pool** (AllowlistFairRehearsal.s.sol, both phases broadcast):
token FAIRAL `0x389A15167307C1A96E05D25270083dA63e5D9b77`, pool id
`0x3c3e8bb36671952d259cc6a0c4c04aeb70721ad1fc3449819b33f505a66be03a`, graduation tx
`0x304b5b96...a25b1`, swap tx `0x1124b3ca...377c7`. Factory defaults and the launch
gate were restored in the same broadcast. Pool opened at 2.5029e-9 ETH/token vs the
curve's last price 2.5030e-9: **0.004% below, no cliff**. Hidden from feeds.

## V2 deploy (Robinhood, 2026-10-20) - CURRENT

Redeployed the same day to add the deploy fee (ETH or URU, same amounts and holder
discount as the token lane). V1 above stays on chain with launches closed; nothing
was ever launched on it except its rehearsal token.

| Contract | Address |
|---|---|
| FairLaunchFactory | `0x986BFC6c7be4b8d613FC3d25c6633eD9af27701d` |
| FairHookHost (flags 0x28C4, salt 9790) | `0xDdc9A293cfDd6A824DbD33C58A9e78FEE85828C4` |
| FairGraduator | `0x9c3dc971714087DB8E05cF41cf4d4C490baCfEBC` |
| FairBondingCurve impl | `0x43C515A8cd2BA30374b09268a46EdC26250ef2f6` |
| OpeningBatch impl | `0xf13A5948201726CEF0F27eA3d1b81E993F15D183` |
| ERC20Template impl | `0xeD15EB1A5Ee94e513c7C47Cf2E3a5C99b880e19D` |

Blocks 93,599,948 to 93,600,192, 12 txs, all verified on Blockscout. Re-read on chain:
same wiring as V1 plus deploy fee 0.001 ETH or 1,000 URU (copied from the live Router),
URU to sink `0xeCD3...C8C8`, LoyaltyOracle `0xDcAd...0b52`, launches closed.

Rehearsal pool: FAIRAL `0x8b470575309a3c2DaDA29ce34E050A0b0A276C9f`, pool id
`0x098be768b820945e74a6dd09236a8aa099e641b513dc3be6b2bb062cf3e58625`, graduation tx
`0x8e8a8e41...06fc`, swap tx `0x8f9aae44...37e0`. Opened 0.004% below the curve's last
price. Hidden from feeds.
