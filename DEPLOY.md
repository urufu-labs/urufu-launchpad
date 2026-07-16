# Deploy — indexer + compile service on Railway

The web frontend on Vercel needs two backends: **Ponder indexer(s)** for on-chain
data + **compile-service** for social/UGC + IPFS pinning.

## Recommended: per-chain indexer services (isolation + speed)

Rather than one Ponder process syncing every chain, run **one Railway service per
chain**. Reasons this matters in prod:

- **Each service gets its own Alchemy CU quota** — historical sync runs 3-5× faster
  because subscriptions don't compete for RPC bandwidth
- **Config changes are isolated per chain** — a schema change on Base doesn't force
  Ethereum + Robinhood to re-sync
- **A stuck subscription on one chain doesn't block the others** from indexing
  real-time events
- **Failures are isolated** — if Base RPC has an outage, other chains keep working

Trade-off: 4 services instead of 1 (~$5-10/mo extra on Railway). Frontend uses
`NEXT_PUBLIC_INDEXER_URL_<CHAIN>` per chain to route GraphQL queries.

The code supports BOTH patterns — you can migrate from single-service to per-chain
without touching frontend code, just by adding the per-chain URL env vars on Vercel.

## One-time Railway project setup

1. `railway init` in the repo root (or use the Railway UI to create a new project).
2. Add **one Postgres plugin** — shared across all indexer services. Railway
   auto-injects `DATABASE_URL` + `DATABASE_PRIVATE_URL`.
3. Create additional databases in Postgres (one per chain — isolates the on-chain
   data + Ponder's cached sync pointers between chains):
   ```sql
   -- Connect to Postgres via Railway's shell, then:
   CREATE DATABASE indexer_base;
   CREATE DATABASE indexer_mainnet;
   CREATE DATABASE indexer_robinhood;
   CREATE DATABASE indexer_base_sepolia;
   ```
4. Add **N services** (one per chain + one compile-service). Each indexer service
   points at the same repo but with a different `INDEXER_CHAINS` + `DATABASE_URL`
   (see below).

## Per-chain indexer services

Each chain gets its own Railway service. All point at the same
`indexer/Dockerfile` from the repo root. What differs per service:

- `INDEXER_CHAINS` — single chain slug (e.g. `base`)
- `DATABASE_URL` — points to its own database (e.g. `${{Postgres.DATABASE_URL}}` with
  `?schema=public` swapped for the chain-specific database name via
  `${{Postgres.HOST}}:${{Postgres.PORT}}/indexer_base` in Railway's syntax)
- `<PREFIX>_RPC_URL` + address vars for that chain only

Environment variable pattern: `<PREFIX>_<CONTRACT>_ADDRESS` where PREFIX is the
chain slug uppercased (dashes → underscores): `BASE`, `MAINNET`, `ROBINHOOD`,
`BASE_SEPOLIA`, `SEPOLIA`, `ROBINHOOD_TESTNET`.

### Service: indexer-base

```
INDEXER_CHAINS=base
DATABASE_URL=<Postgres URL pointed at indexer_base database>
BASE_RPC_URL=<your paid Alchemy Base URL>
BASE_NAME_REGISTRY_ADDRESS=0xC3e117CD904db351F919134adCee7237F3ebC2A7
BASE_ROUTER_ADDRESS=0x38461D94d6f84204399132AEc891E3B90563939a
BASE_ERC20_FACTORY_ADDRESS=0x347c9567bf379a5a046f925498FD805a9A34457A
BASE_ERC721A_FACTORY_ADDRESS=0x330e6c63d4c976D63029fA65f21bA4218157c6e6
BASE_ERC1155_FACTORY_ADDRESS=0xb0F341CB55FcD23c1BE08d2D1CcAe5829CF2FE7a
BASE_CURVE_FACTORY_ADDRESS=0x7d89aa4AE1f53bB185e905a005D0673014220a61
BASE_POOL_MANAGER_ADDRESS=0x498581fF718922c3f8e6A244956aF099B2652b2b
BASE_V4_SWAP_ROUTER_ADDRESS=0x6657e76803d3Bb000CFb68Af9C9587C4D9eF8288
BASE_MULTI_HOOK_HOST_ADDRESS=0x6af35A106C9e3CD0c29Bd68385573a1B0D45A2C4
PONDER_START_BLOCK_BASE=48674693
URU_TOKEN_ADDRESS=0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac
GEMU_NFT_ADDRESS=0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A
```

Replicate this pattern for `indexer-mainnet`, `indexer-robinhood`, and
`indexer-base-sepolia` — each with its own `INDEXER_CHAINS=<slug>`,
`DATABASE_URL` (pointing at its own database), and per-chain address block.

### Vercel — wire the per-chain URLs

Set these on Vercel so the frontend routes queries to the right service:

```
NEXT_PUBLIC_INDEXER_URL_BASE=https://indexer-base-xxx.up.railway.app
NEXT_PUBLIC_INDEXER_URL_MAINNET=https://indexer-mainnet-xxx.up.railway.app
NEXT_PUBLIC_INDEXER_URL_ROBINHOOD=https://indexer-robinhood-xxx.up.railway.app
NEXT_PUBLIC_INDEXER_URL_BASE_SEPOLIA=https://indexer-base-sepolia-xxx.up.railway.app
```

Frontend automatically fans out cross-chain queries (home page live rail,
discover feed) to all four services in parallel and merges results.

## Legacy: single indexer service (still supported)

If you want to start with one indexer service that syncs all chains, the code
still supports it — just set `INDEXER_CHAINS=base,mainnet,robinhood,base-sepolia`
+ every chain's env vars on one service. Not recommended for prod but fine for
local dev / initial rollout.

**Env vars — Base Sepolia only (current):**

```
INDEXER_CHAINS=base-sepolia
BASE_SEPOLIA_RPC_URL=<Alchemy URL>
BASE_SEPOLIA_NAME_REGISTRY_ADDRESS=...
BASE_SEPOLIA_ROUTER_ADDRESS=...
BASE_SEPOLIA_ERC20_FACTORY_ADDRESS=...
BASE_SEPOLIA_ERC721A_FACTORY_ADDRESS=...
BASE_SEPOLIA_ERC1155_FACTORY_ADDRESS=...
BASE_SEPOLIA_CURVE_FACTORY_ADDRESS=...
BASE_SEPOLIA_POOL_MANAGER_ADDRESS=...
BASE_SEPOLIA_V4_SWAP_ROUTER_ADDRESS=...
BASE_SEPOLIA_MULTI_HOOK_HOST_ADDRESS=...
PONDER_START_BLOCK_BASE_SEPOLIA=<deploy_block>
```

**Adding Base mainnet (day of):** append these to the same service, redeploy.

```
INDEXER_CHAINS=base-sepolia,base
BASE_RPC_URL=<Alchemy mainnet URL>
BASE_NAME_REGISTRY_ADDRESS=...
BASE_ROUTER_ADDRESS=...
BASE_ERC20_FACTORY_ADDRESS=...
BASE_ERC721A_FACTORY_ADDRESS=...
BASE_ERC1155_FACTORY_ADDRESS=...
BASE_CURVE_FACTORY_ADDRESS=...
BASE_POOL_MANAGER_ADDRESS=...
BASE_V4_SWAP_ROUTER_ADDRESS=...
BASE_MULTI_HOOK_HOST_ADDRESS=...
PONDER_START_BLOCK_BASE=<mainnet_deploy_block>
```

**Backward-compat:** the unprefixed legacy `NEXT_PUBLIC_*_ADDRESS` env vars +
`INDEXER_CHAIN=base-sepolia` still work — the indexer reads them as a fallback
for whichever slug matches `INDEXER_CHAIN`. Prefer the prefixed pattern for new
chains; the frontend + Vercel config are unaffected.

After the first deploy Railway will assign a public URL like
`https://indexer-production-xyz.up.railway.app` — that becomes
`NEXT_PUBLIC_INDEXER_URL` in Vercel.

## Service B — compile service

**Root Directory:** repo root
**Config file:** `compile-service/railway.json`
**Env vars:**

```
DATABASE_URL=${{Postgres.DATABASE_URL}}   # same Postgres addon; app schema for social tables
PINATA_JWT=<Pinata JWT with pinFileToIPFS scope>
PINATA_GATEWAY=<your-gateway>.mypinata.cloud
```

- `PINATA_JWT` is **server-side ONLY** — never expose it as `NEXT_PUBLIC_*` in Vercel.
  The frontend uploads via `POST /pin/file` on this service, which forwards to Pinata
  using the server-held JWT. Prevents a leaked bundle from burning your Pinata quota.
- `DATABASE_URL` is what unlocks the social endpoints (metadata / profile / chat).
- Optional: `COMPILE_SERVICE_RATE_LIMIT=60` (req/min per IP, default 30).

After first deploy, Railway URL → `NEXT_PUBLIC_COMPILE_SERVICE_URL` in Vercel.

## Wiring the frontend (Vercel)

In your Vercel project's **Environment Variables** (per Preview + Production):

```
NEXT_PUBLIC_INDEXER_URL=<indexer railway URL>
NEXT_PUBLIC_COMPILE_SERVICE_URL=<compile-service railway URL>
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=<Alchemy URL>
# … plus every NEXT_PUBLIC_*_ADDRESS the indexer has, so wagmi reads hit the
# same contracts the indexer is subscribed to.
```

Trigger a redeploy so `NEXT_PUBLIC_*` gets baked into the bundle.

## Mainnet cutover checklist

Once contracts are broadcast on Base mainnet:

1. `pnpm contracts:deploy:mainnet` → writes `deployment.8453.json`
2. `node tools/sync-addresses.mjs base` → patches `web/src/lib/config.ts`
3. On Railway indexer service: append the `BASE_*` env-var block from the
   "Adding Base mainnet" section above, flip
   `INDEXER_CHAINS=base-sepolia` → `base-sepolia,base`. Redeploy. The same
   service now indexes both chains and exposes them via one GraphQL endpoint.
4. On Vercel web: add BASE contract addresses to the frontend `web/src/lib/config.ts`
   via the sync tool + push. No env changes needed for the indexer URL.
5. Verify the shop can quote a launch against the new Router.

No contract redeploys needed unless the launchpad ABIs change — the ABIs in this
repo are the source of truth for both indexer + web, so a code-only shipping
across chains is a config-only change.

## Local dev (unchanged)

`pnpm dev:indexer` still uses pglite (no DATABASE_URL set) and writes to
`indexer/.ponder/`. Nuke that directory when the schema changes to force a
reindex from scratch.
