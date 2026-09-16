# @vm/keeper

DN404 tax-hook keeper.

Watches every tax-enabled DN404 launch on Robinhood mainnet, sweeps the
accumulated tax when it crosses a per-launch threshold, and executes the
destination-specific off-chain action (swap → URU, swap → allowed token,
or hold-in-treasury for the three advanced destinations that ship in a
later slice).

## What it does per tick

For each entry in `KEEPER_LAUNCHES`:

1. Read on-chain state: `taxMode`, `taxTarget`, `uruToken`, `keeper`,
   `accumulatedTax` (one round-trip, all parallel calls).
2. Decide whether to sweep — see `src/sweeper.ts::decideSweep` for the
   full ruleset. Short version: skip Off + BurnDead (no accumulator),
   skip if under threshold, skip if the on-chain keeper doesn't match
   our wallet (misconfiguration).
3. If sweeping: submit `sweepAccumulated(keeper, accumulatedTax)` (v1
   sweeps the full balance, not partial), wait for receipt.
4. Dispatch handler based on `taxMode`:

| Mode                | Handler                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| Off                 | never sweeps                                                                         |
| BurnDead            | never sweeps (burned in-place inside `_transfer`)                                    |
| BuybackURU          | swap swept balance → URU via v4, forward to `KEEPER_URU_BUYBACK_SINK`                |
| BuyAllowedToken     | swap swept balance → `taxTarget` via v4, forward to per-launch `finalDestination`    |
| AddToLP             | **v1 stub** — forward to `KEEPER_ADVANCED_DEST_TREASURY`, ops handles manually       |
| HolderReflections   | **v1 stub** — forward to `KEEPER_ADVANCED_DEST_TREASURY`, ops handles manually       |
| MirrorFloorSupport  | **v1 stub** — forward to `KEEPER_ADVANCED_DEST_TREASURY`, ops handles manually       |

The three v1 stubs are called out loudly in the log every time they
fire. Real automation lives in slice E — planned once patterns from
real launches stabilize.

## Running

```bash
cp keeper/.env.example keeper/.env
# fill in KEEPER_PRIVATE_KEY, KEEPER_LAUNCHES, chain-scoped addresses
pnpm --filter @vm/keeper dev
```

Or in prod:

```bash
pnpm --filter @vm/keeper start
```

Deploy target: any node runtime with outbound HTTPS to the RPC + the
ability to sign txs from a private key. Railway / Fly / Render / bare
EC2 all work. No stateful storage — everything the keeper needs lives
on-chain or in env.

## Ops guide

- **Watch the log for "refuse (alert ops)"** — that's the anti-MEV
  ceiling firing. Investigate before manually raising
  `KEEPER_MAX_SWEEP_PER_POLL`.
- **Watch the log for "keeper mismatch"** — the on-chain `keeper` role
  isn't this wallet. Either the launch was initialized with a stale
  keeper, or an admin rotated us out. Fix on-chain (via governance
  `setKeeper` on the launch) or update `KEEPER_PRIVATE_KEY` to match.
- **Watch the log for advanced-stub sweeps** — those are the three
  destinations without automation. Ops picks up the token from
  `KEEPER_ADVANCED_DEST_TREASURY` and executes the destination action
  manually (add to LP, generate merkle, floor buy).
- **The keeper never batches** — one sweep per launch per tick. If a
  launch is accumulating faster than the tick, cumulative sweep across
  N ticks catches up. If it's outpacing the ceiling, alert fires.
