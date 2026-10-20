# Fair launch lane (spec)

> **Status:** approved 2026-10-19 with all defaults (D1-D7)
> _written 2026-10-19_

A fourth launch type next to Token, NFT and DN404. Same ERC-20 token, same
bonding curve math, same graduation to a locked Uniswap v4 pool. What changes
is who gets an edge:

1. **Opening batch.** The first minute of buys all fill at one shared price.
2. **Sniper tax that burns.** A high fee right after graduation that decays to
   zero, and the tax is burned, not paid to anyone.
3. **Dev sells, dev loses fees.** If the creator wallet sells, its 1% creator
   fee switches to buyback and burn for good.

One-line pitch for the create page: *No sniper edge, no bundle edge, and the
dev only earns while they hold.*

---

## Ground rules

- **Parallel files only.** Everything lives under `contracts/src/fair/`. The
  frozen V10 stack (CurveFactory, BondingCurve, Graduator, Router) and the
  live MultiHookHost are never edited. Same rule DN404 followed.
- **New hook contract.** MultiHookHost's permissions are baked into its
  address bits (no `beforeSwapReturnDelta`, fee taken in `afterSwap`), and it
  holds no per-pool tax or forfeit state. The lane gets its own mined hook,
  `FairHookHost`, and its own Uniswap hook-allowlist submission.
- **Time, not blocks.** Robinhood Chain's `block.number` is the Ethereum L1
  block (~12 s), so every window below uses `block.timestamp`.
- **Audit before live.** Four new contracts. Site stays dark for this lane
  (grayed out on the create page) until audit + fork tests pass.

## Contracts

| Contract | Job |
|---|---|
| `FairLaunchFactory` | Deploys token + `FairBondingCurve` + `OpeningBatch` in one tx; wires creator |
| `OpeningBatch` | Collects ETH during the window, does one aggregate curve buy, splits tokens pro rata |
| `FairBondingCurve` | Copy of BondingCurve math; trading locked until the batch settles; records if the creator sold before graduation |
| `FairGraduator` | Copy of GraduatorV3 LP math (raw-ratio pricing, owner sweep, pre-flight check); writes baseline + forfeit flag to the hook |
| `FairHookHost` | Platform + creator fee like MHH, plus decaying sniper tax, creator-fee forfeit, burn bank |

---

## 1. Opening batch

**Why curve-side, not a hook:** the sniping that hurts most happens at launch,
when the token is still on the bonding curve and not yet a v4 pool. A plain
contract in front of the curve solves it with far less risk than a
custom-accounting v4 hook.

**Flow**

1. Launch opens a window of `W` seconds (D1, default 60 s). The curve rejects
   direct buys until the batch settles.
2. Anyone (including the creator, see below) calls `deposit()` with ETH during
   the window. Optional per-wallet cap.
3. After the window, anyone calls `settle()`. It makes **one** curve buy with
   the total ETH, so everyone pays the same average price.
4. Each depositor gets `tokens * theirEth / totalEth`. `claim()` sends them, or
   a keeper pushes them.
5. Curve trading opens right after `settle()`. The first direct curve trade
   also triggers `settle()`, so it can't get stuck.

**Why this kills bundling:** the split is linear in ETH, so splitting one
bankroll across 50 wallets gets exactly the same tokens as one wallet. Being
first in the window gets nothing extra either.

**Oversubscription:** the batch can buy at most `B`% of curve supply (D2,
default 25%). If more ETH comes in than that slice costs, each depositor gets
filled pro rata and the leftover ETH is refunded in the same `claim()`. Stops
one hot minute from graduating the token.

**Creator:** `launchAndBuy` for this lane just makes the creator's first
deposit. Same price as everyone else. No dev-first edge.

**Edge cases**
- No deposits: `settle()` is a no-op and the curve opens.
- Dust depositors: `claim()` rounds down; the remainder stays with the batch
  and is swept to burn after a long timeout.
- Gas: deposit is O(1); claim is per user; no loops over depositors.

## 2. Sniper tax that burns

Applies in `FairHookHost` from the moment the v4 pool opens at graduation.

- Extra fee starts at `T0` (D3, default 20%) and decays linearly to 0 over
  `D` seconds (D3, default 5 min). On top of the normal platform + creator fee.
- **Buys:** the tax is taken in tokens and sent to the burn address right away
  (same code path as MHH's buyback-burn).
- **Sells:** the tax is taken in ETH into a per-pool burn bank. Anyone can
  call `burnBank(poolId)`, which swaps it for tokens in its own unlock and
  burns them (the keeper calls it every few minutes).
- **Why not donate into the pool:** the Graduator owns the locked full-range
  position directly and has no `collect`, so donated value would just strand.
  Burning gives the same "snipers pay holders" effect.
- The existing anti-sniper revert gate stays available but defaults to off for
  this lane: the tax replaces it.

## 3. Dev sells, dev loses fees

- At graduation, `FairGraduator` writes `creatorBaseline =
  token.balanceOf(creator)` to the hook.
- `FairBondingCurve` sets `creatorSold = true` if the creator wallet ever sells
  on the curve. Graduator passes it through, so a pre-graduation dump forfeits
  from the start.
- On every swap, the hook reads `balanceOf(creator)`. The first time it is
  below `creatorBaseline * (100 - X)%` (D4, default X = 10), the pool flips
  `forfeited = true`, **permanently**, and emits `CreatorFeeForfeited`.
- After forfeit, the creator's share goes to the burn path (token side burned
  now, ETH side into the burn bank). Fees accrued before the forfeit stay
  claimable: they were earned.
- Transfers count: moving tokens to another wallet drops the balance too.
- **Limit:** a dev who buys with extra wallets from the start can't be caught
  on-chain. The trade page says what this does and doesn't cover.
- Gas: one `balanceOf` per swap (~2.6k gas).

---

## Fees

Normal fee stays the same as the token lane (platform + 1% creator), so the
40/35/25 flywheel keeps working (D5). The sniper tax and forfeited creator
fees are burned; the platform never takes a cut of either.

## Indexer

New Ponder sources: `FairLaunchFactory` (launch), `OpeningBatch` (Deposited,
Settled, Claimed), `FairHookHost` (FeeAccrued, SniperTaxBurned,
CreatorFeeForfeited, BankBurned). Events only, no block jobs. Count the
`logFilterIntervals` rows before pushing and warn about restart time.

## Web

- **Create:** new "Fair launch" card. Shows window, batch cap, tax curve, and
  forfeit rule in plain words. ETH pair only (D7).
- **Trade page, before settle:** countdown, total ETH in, your deposit,
  estimated tokens at the current total, Deposit button.
- **After settle:** Claim button until claimed, then the normal curve UI.
- **After graduation:** live "Sniper tax: 12%, gone in 2:40" chip, and a dev
  badge: "Dev still holding, earns fees" or "Dev sold, their fees now burn".

## Tests (before any deploy)

- Unit: pro-rata math, oversubscription refunds, rounding, settle trigger,
  tax decay curve, forfeit trigger and permanence, burn bank.
- Fork tests on live RH: replay the Uniswap app's Universal Router order and an
  aggregator-style swap through `FairHookHost`, both directions, exact-in and
  exact-out. Graduation end to end with the live PoolManager.
- Adversarial: 50-wallet bundle gets the same as 1 wallet; creator transfer
  to a fresh wallet forfeits; settle griefing; reentrancy on claim.

## Decisions to sign off

| # | Question | Default |
|---|---|---|
| D1 | Opening batch window | 60 s |
| D2 | Max share of curve the batch can buy | 25% |
| D3 | Sniper tax start and decay | 20%, linear to 0 over 5 min |
| D4 | Creator balance drop that forfeits | more than 10% below graduation balance |
| D5 | Normal fees | same as token lane (platform + 1% creator) |
| D6 | Name on the site | "Fair launch" |
| D7 | Pair currency | ETH only for v1 |

## Later, not v1

- Volatility fee (#4 from the brainstorm).
- Hook-native curve: trade on Uniswap from block 0 with virtual liquidity
  (`beforeSwapReturnDelta`), no separate bonding curve. Bigger build, and the
  direction the "hooks are the last hope" thread points at.
