# SPEC — Indexer (Ponder)

> Real-time indexing of every Launch, Trade, Graduation, and CurveInstalled event. Powers the
> live feed on `/discover` and the trade page's chart + recent-trades list. Falls back to
> client-side `getLogs` when the indexer is unreachable so the app degrades gracefully.

**Status:** IMPLEMENTED — handlers written, dynamic BondingCurve subscription wired.
**File:** `indexer/ponder.config.ts`, `ponder.schema.ts`, `src/index.ts`
**Version:** Ponder v0.7.17

---

## Config

```
Networks: sepolia (chainId 11155111)
RPC: process.env.SEPOLIA_RPC_URL || public node
Start block: process.env.PONDER_START_BLOCK_SEPOLIA (defaults 6_000_000; set to DeployPhase1's block after broadcast)
```

Contracts subscribed:

| Contract | ABI | Address source |
|---|---|---|
| NameRegistry | `Reserved` event | `NEXT_PUBLIC_NAME_REGISTRY_ADDRESS` |
| Router | `Launched`, `CurveInstalled` events | `NEXT_PUBLIC_ROUTER_ADDRESS` |
| ERC20Factory / ERC721AFactory / ERC1155Factory | `Deployed` event | Per-base env var |
| CurveFactory | `CurveCreated` event | `NEXT_PUBLIC_CURVE_FACTORY_ADDRESS` |
| **BondingCurve (dynamic)** | `CurveInitialized`, `Trade`, `Graduated` | Factory pattern — every CurveCreated adds the new curve as a source |

The BondingCurve dynamic subscription is the important trick: **one config, unlimited curves**. Every `CurveCreated` fires from `CurveFactory` → Ponder auto-adds the new curve address as a Trade/Graduated event source. No per-launch config touch needed.

## Schema

Six tables:

### `launches`

Row per token launched through Router. Populated by the `Router.Launched` event; `installedBondingCurve` + `curveAddress` upserted from `Router.CurveInstalled`; `configHash` + `impl` upserted from the base factory's `Deployed` event; `name` + `ticker` upserted from `NameRegistry.Reserved`.

Key fields: `tokenAddress`, `launchedBy`, `base` (enum 0/1/2), `feePaid`, `installedHook`, `installedGovernance`, `installedBondingCurve`, `curveAddress` (null if direct launch).

### `curves`

One row per BondingCurve. Populated by `CurveInitialized`; live state (`ethReserve`, `tokenReserve`, `tradeCount`, `graduated`, `graduatedAt`) rolled forward by every `Trade` + `Graduated`.

### `trades`

Row per Trade event. Trader, isBuy, amounts, running reserves, realized price (`ethAmount * 1e18 / tokenAmount`). This is what powers the OHLC chart aggregation.

### `graduations`

One row per Graduated event. Final reserves, block, tx.

### `holders`, `transfers` — scaffolded, not yet populated

Placeholder tables for per-token ERC-20 balance tracking. Dynamic Transfer subscription per launched token is a TODO — see `URU-901` follow-up.

## Handlers

`src/index.ts` — 6 event handlers:

1. **`Router:Launched`** — insert into `launches` with defaults (`installedBondingCurve=false`, `curveAddress=null`)
2. **`Router:CurveInstalled`** — update the launch row: `installedBondingCurve=true`, `curveAddress=curve`
3. **`NameRegistry:Reserved`** — upsert `name`, `ticker` on the launch row
4. **`<base>Factory:Deployed`** — upsert `configHash`, `impl` on the launch row
5. **`BondingCurve:CurveInitialized`** — insert into `curves` with fresh state
6. **`BondingCurve:Trade`** — insert into `trades` + roll `curves.ethReserve/tokenReserve/tradeCount`
7. **`BondingCurve:Graduated`** — insert into `graduations` + set `curves.graduated=true, graduatedAt=block.timestamp`

Handler ordering isn't strictly guaranteed within a single tx. Each handler upserts + `.catch(() => {})` on the update path so late-firing handlers don't crash.

## Client wiring

`web/src/lib/indexer.ts` — thin fetch client hitting Ponder's GraphQL endpoint at `${INDEXER_URL}/graphql`. Every helper returns `null` on any error (timeout, network, GraphQL error) so callers can fall back to mocks or client-side `getLogs`.

Exposed queries:
- `fetchRecentLaunches(limit = 40)` — used by `/discover`
- `fetchCurveByToken(tokenAddress)` — used by `/discover` + `/trade`
- `fetchTradesForCurve(curveAddress, limit = 500)` — used by `/trade/[address]` chart

## Fallback pattern

Every consumer of the indexer follows the same shape:

```typescript
const indexed = await fetchTradesForCurve(curveAddress, 500);
if (indexed && indexed.length > 0) {
  // use indexer data
} else {
  // fall back to client-side getLogs with a bounded block window
}
```

Result: `/trade/[address]` works before the indexer exists (via `getLogs`), works with an empty indexer (fallback kicks in), and works with a full indexer (5000-block cap replaced by full history + faster load).

## Run

```bash
pnpm dev:indexer                # Ponder dev server + GraphQL at :42069
pnpm --filter @vm/indexer typecheck
```

Post-broadcast:
1. `pnpm sync:addresses` prints an env block including `NEXT_PUBLIC_*_ADDRESS` + `PONDER_START_BLOCK_SEPOLIA=<block>`
2. Copy into `.env`
3. Restart the indexer — Ponder syncs from `startBlock` to head

## Attack surface

- **Indexer down** — every consumer falls back. UI doesn't break.
- **RPC rate limiting** — Ponder's default backoff handles it. In production use Alchemy/Infura not the public node.
- **Reorg** — Ponder handles reorgs natively via block confirmations. Default is 5 blocks; can be tuned.
- **Malicious CurveFactory event forgery** — impossible if the CurveFactory address in config is correct. The factory pattern only subscribes to `CurveCreated` from THAT address.

## Deployment

Not yet in this repo — indexer runs locally in dev. Production deploy options:
- Railway / Vercel Postgres backend
- Ponder's own hosted product
- Self-host on any Node-capable box + external Postgres

`docker-compose.yml` for the whole stack (web + indexer + compile-service + Postgres) is a TODO.
