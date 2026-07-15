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

## Service A — indexer

**Root Directory:** repo root
**Config file:** `indexer/railway.json` (points at `indexer/Dockerfile`)
**Env vars to set in Railway:**

```
INDEXER_CHAIN=base-sepolia          # or `base` on mainnet day
BASE_SEPOLIA_RPC_URL=<Alchemy URL>  # paid tier recommended
NEXT_PUBLIC_NAME_REGISTRY_ADDRESS=...
NEXT_PUBLIC_ROUTER_ADDRESS=...
NEXT_PUBLIC_ERC20_FACTORY_ADDRESS=...
NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS=...
NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS=...
NEXT_PUBLIC_CURVE_FACTORY_ADDRESS=...
NEXT_PUBLIC_POOL_MANAGER_ADDRESS=...
NEXT_PUBLIC_MULTI_HOOK_HOST_ADDRESS=...
PONDER_START_BLOCK_BASE_SEPOLIA=<deploy_block>
```

(Copy the same block that `tools/sync-addresses.mjs base-sepolia` prints locally.)

After the first deploy Railway will assign a public URL like
`https://indexer-production-xyz.up.railway.app` — that becomes
`NEXT_PUBLIC_INDEXER_URL` in Vercel.

## Service B — compile service

**Root Directory:** repo root
**Config file:** `compile-service/railway.json`
**Env vars:** none required for baseline. Optional:
```
COMPILE_SERVICE_RATE_LIMIT=60       # req/min per IP
```

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
3. On Railway indexer service: flip `INDEXER_CHAIN=base-sepolia` → `base`, set
   `BASE_RPC_URL`, set `PONDER_START_BLOCK_BASE=<mainnet_deploy_block>`, update
   the `NEXT_PUBLIC_*_ADDRESS` block. Redeploy.
   (Or: keep base-sepolia running on the current service, spin up a second
   service pointed at mainnet, and give users a chain switcher.)
4. On Vercel web: update the same address envs to mainnet values. Push a commit
   to trigger the rebuild.
5. On Vercel web: verify the shop can quote a launch against the new Router.

No contract redeploys needed unless the launchpad ABIs change — the ABIs in this
repo are the source of truth for both indexer + web, so a code-only shipping
across chains is a config-only change.

## Local dev (unchanged)

`pnpm dev:indexer` still uses pglite (no DATABASE_URL set) and writes to
`indexer/.ponder/`. Nuke that directory when the schema changes to force a
reindex from scratch.
