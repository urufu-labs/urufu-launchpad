# Deploy — indexer + compile service on Railway

Two services need public HTTPS URLs so users can hit them from their browsers: the
Ponder **indexer** and the Foundry-backed **compile service**. The web front-end runs
on Vercel and just reads their URLs from `NEXT_PUBLIC_*` envs. Everything is
container-based, so mainnet-day cutover is only environment variables + a redeploy.

## One-time Railway project setup

1. `railway init` in the repo root (or use the Railway UI to create a new project).
2. Add **two services** (one for each Dockerfile) inside that project.
3. Add the **Postgres** plugin — Railway injects `DATABASE_URL` +
   `DATABASE_PRIVATE_URL` automatically. `ponder.config.ts` switches to Postgres
   when either is present.

## Service A — indexer (multi-chain)

**Root Directory:** repo root
**Config file:** `indexer/railway.json` (points at `indexer/Dockerfile`)

One Ponder process handles every chain listed in `INDEXER_CHAINS`. Enabling a
new chain is a Railway env-var change, not a new service. Env vars follow the
pattern `<PREFIX>_<CONTRACT>_ADDRESS` where PREFIX is the chain slug uppercased
(dashes → underscores): `BASE_SEPOLIA`, `BASE`, `SEPOLIA`, `MAINNET`,
`ROBINHOOD`, `ROBINHOOD_TESTNET`.

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
