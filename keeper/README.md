# @vm/keeper

DN404 tax keeper for Robinhood. Finds every taxed DN404 launch on its own,
sweeps accumulated tax (the token sends 5% to the keeper treasury in the
same tx), and carries out each launch's chosen destination on chain.

Requires `Dn404TaxTemplateV2` launches: V2 exempts the graduators, both hook
hosts and the current keeper from tax, which is what lets taxed launches
graduate and lets the keeper swap / add liquidity through normal v4 routers.

## Per tick

1. **Discover**: scan `Dn404LaunchFactory.Dn404Launched` logs (5000-block
   chunks, incremental) and watch every launch with a tax mode at launch.
2. **Snapshot** each launch (taxMode, keeper, accumulatedTax, supply, unit,
   owner, graduated). Only launches whose on-chain `keeper()` is our wallet
   are acted on.
3. **Decide** (`decideSweep`): sweep when accumulatedTax >= 1 bps of supply,
   refuse above 5% (alert). Pool-dependent modes wait for graduation.
4. **Sweep**: `setSkipNFT(true)` once per launch (so sweeps never mint NFTs
   under RH's 32M per-tx gas cap), then `sweepAccumulated(keeper, all)`.
5. **Act** on the keeper's full balance of that token:

| Mode | Action |
| --- | --- |
| Off | nothing (no tax surface) |
| BurnDead | nothing: the token burns tax to 0x…dEaD inside the transfer |
| BuybackURU | token -> URU (direct for URU pairs; token -> ETH -> WETH -> URU for ETH pairs), URU sent to the sink (default 0x…dEaD) |
| BuyAllowedToken | token -> `taxTarget` (URU today), delivered to the launcher |
| AddToLP | swap half to the pair, mint full-range liquidity in the launch pool owned by 0x…dEaD (locked forever) |
| HolderReflections | pro-rata token payouts to holders (from Transfer logs, infra excluded), bounded per tick |
| MirrorFloorSupport | buy OpenSea listings priced >= 10% under the NFT's pool value via Seaport, then send all remaining tokens to 0x…dEaD, which burns the bought NFTs too |

All swaps go through the Universal Router (+ Permit2), priced by the v4
Quoter: minOut = quote * (1 - 3%), never 0; a swap is halved until its quote
is within 10% of spot, so thin pools are worked down across ticks.

## Running

```
cp .env.example .env   # set KEEPER_RPC_URL, KEEPER_PRIVATE_KEY, OPENSEA_API_KEY
npm run dev
```

## Tests

- `npm test`: unit tests (decisions, TickMath, pool ids vs live, encoders, pro-rata, floor selection, OpenSea encoding).
- `npm run test:fork`: end-to-end on an anvil fork of Robinhood. Installs V2 on the live launch factory as the deployer, launches every mode, generates real tax, runs `Keeper.tick()` with the real keeper key, asserts outcomes. Needs `ROBINHOOD_RPC_URL` and `DN404_KEEPER_*` in the repo-root `.env`.
- `npm run test:live-opensea`: read-only call to the real OpenSea API (slug + best listings for $SMOKE).

## Deploy (Railway)

`Dockerfile` + `railway.json` (watch paths: keeper/ and workspace manifests).
Env: `KEEPER_RPC_URL`, `KEEPER_PRIVATE_KEY`, `OPENSEA_API_KEY`, optionally the
tuning vars in `.env.example`. Fund the keeper wallet with a little ETH for gas.
