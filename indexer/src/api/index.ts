// GH-13: aggregator-friendly REST launch-card API.
//
// Ponder 0.7 discovers this file automatically (glob `src/api/**/*.{ts,mts,js,mjs}`)
// and mounts every `ponder.get(...)` / `ponder.post(...)` handler onto its Hono
// server. IMPORTANT: the moment ANY custom route is registered, Ponder stops
// auto-mounting the default GraphQL middleware (see @ponder/core src/server/index.ts
// line ~135 — `if (userRoutes.length === 0)` gates the auto-mount). We
// re-mount GraphQL below so `/graphql` and `/` keep working for existing web/
// consumers.

import { ponder } from '@/generated';
import { graphql, and, eq, desc } from '@ponder/core';
import type { Address, Hex } from 'viem';

import {
  launches,
  curves,
  graduations,
  poolPolicy,
  v4Swaps,
} from '../../ponder.schema.ts';
import { hookHostForChainId, loyaltyStateForChainId } from '../../chains.ts';
import { buildLaunchCard, computeV4PoolId } from './launch-card.ts';

// ---- graphql passthrough (see file header) ----
ponder.use('/graphql', graphql());
ponder.use('/', graphql());

// ---- GET /api/launches/:token ----
//
// Resolves a launched token → aggregator launch-card. Optional `?chainId=`
// query narrows the multi-chain indexer to a single chain when the same token
// address exists on multiple chains (rare but the schema allows it).
//
// Response shape: see LaunchCard in ./launch-card.ts. The `hookPolicy` block
// is populated from the `poolPolicy` table (fed by `MHH.HookPolicySet` at
// graduation-time `beforeInitialize`). Pre-graduation launches return
// `hookPolicy: null` and `installedHook: false` even if the launcher
// requested a hook — see the field-cleanup doc on LaunchCard for the
// rationale.

ponder.get('/api/launches/:token', async (c) => {
  const rawToken = c.req.param('token');
  if (!rawToken || !/^0x[0-9a-fA-F]{40}$/.test(rawToken)) {
    return c.json({ error: 'invalid token address; expected 0x-prefixed 40-hex' }, 400);
  }
  const token = rawToken.toLowerCase() as Address;
  const chainIdRaw = c.req.query('chainId');
  const wantChainId = chainIdRaw ? Number(chainIdRaw) : undefined;
  if (wantChainId !== undefined && (!Number.isInteger(wantChainId) || wantChainId <= 0)) {
    return c.json({ error: 'chainId must be a positive integer' }, 400);
  }

  const launchWhere = wantChainId
    ? and(eq(launches.tokenAddress, token), eq(launches.chainId, wantChainId))
    : eq(launches.tokenAddress, token);
  const launchRows = await c.db.select().from(launches).where(launchWhere).limit(1);
  const launchRow = launchRows[0];
  if (!launchRow) {
    return c.json(
      { error: 'launch not indexed on this indexer', token, chainId: wantChainId ?? null },
      404,
    );
  }

  const chainId = launchRow.chainId;

  let curveRow: any = undefined;
  if (launchRow.curveAddress) {
    const rows = await c.db
      .select()
      .from(curves)
      .where(and(eq(curves.tokenAddress, token), eq(curves.chainId, chainId)))
      .limit(1);
    curveRow = rows[0];
  }

  const gradRows = await c.db
    .select()
    .from(graduations)
    .where(and(eq(graduations.tokenAddress, token), eq(graduations.chainId, chainId)))
    .limit(1);
  const gradRow = gradRows[0];

  // Prefer the graduation-stored poolId (canonical, matches emitted Swap
  // events). Fall back to re-deriving from the wired hook so pre-graduation
  // launches still get a useful pool.poolId in the response.
  let poolId: Hex | null = gradRow?.poolId ?? null;
  let hookAddress: Address | null = gradRow?.hookAddress ?? null;
  const wiredHook = hookHostForChainId(chainId);
  if (!poolId && wiredHook) {
    hookAddress = wiredHook;
    poolId = computeV4PoolId(token, wiredHook);
  }

  let policyRow: any = undefined;
  if (poolId) {
    const rows = await c.db
      .select()
      .from(poolPolicy)
      .where(and(eq(poolPolicy.poolId, poolId), eq(poolPolicy.chainId, chainId)))
      .limit(1);
    policyRow = rows[0];
  }

  let latestSwap: any = undefined;
  if (poolId) {
    const swapRows = await c.db
      .select()
      .from(v4Swaps)
      .where(and(eq(v4Swaps.poolId, poolId), eq(v4Swaps.chainId, chainId)))
      .orderBy(desc(v4Swaps.blockNumber))
      .limit(1);
    latestSwap = swapRows[0];
  }

  const card = buildLaunchCard({
    launch: launchRow as any,
    curve: curveRow ?? null,
    graduation: gradRow
      ? {
          poolId: gradRow.poolId,
          hookAddress: gradRow.hookAddress,
          txHash: gradRow.txHash,
          blockNumber: gradRow.blockNumber,
        }
      : null,
    fallbackPoolId: poolId,
    fallbackHookAddress: hookAddress,
    policy: policyRow ?? null,
    latestSwap: latestSwap
      ? {
          sqrtPriceX96: latestSwap.sqrtPriceX96,
          liquidity: latestSwap.liquidity,
        }
      : null,
    // GH-15: per-chain loyalty metadata derived from indexer env config.
    loyalty: loyaltyStateForChainId(chainId),
  });

  return c.json(card);
});

export { buildLaunchCard, computeV4PoolId } from './launch-card.ts';
export type { LaunchCard } from './launch-card.ts';
