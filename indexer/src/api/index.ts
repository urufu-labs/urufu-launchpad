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
  flywheelDistributions,
  uruBuybacks,
  uruSinkConversions,
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

// ---- GET /api/flywheel/activity ----
//
// Merged event feed for the public /flywheel dashboard: FeeSplitter
// distributions, UruBuybackVault buybacks, UruDepositSink URU→ETH
// conversions. Rows are combined + sorted by blockNumber DESC, capped at
// ?limit= (default 20, max 100). Optional ?chainId= narrows to one chain;
// omit to fold every chain's activity into one stream.
//
// Response shape (JSON):
//   { activity: Array<{
//       kind: 'distribution' | 'buyback' | 'conversion',
//       chainId, txHash, blockNumber, blockTimestamp,
//       // per-kind fields, all bigints serialized as strings:
//       total?, toBuyback?, toNft?, toTreasury?,  // distribution
//       ethIn?, uruOut?,                          // buyback
//       uruIn?, ethOut?,                          // conversion
//     }> }
//
// Serialization: every bigint gets `.toString()` because JSON can't carry
// them natively and clients parse back to bigint where needed. Same
// pattern the launch-card endpoint uses.
ponder.get('/api/flywheel/activity', async (c) => {
  const limitRaw = c.req.query('limit');
  const limit = Math.max(1, Math.min(100, limitRaw ? Number(limitRaw) : 20));
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: 'limit must be a positive integer' }, 400);
  }
  const chainIdRaw = c.req.query('chainId');
  const chainIdFilter = chainIdRaw ? Number(chainIdRaw) : undefined;
  if (chainIdFilter !== undefined && (!Number.isInteger(chainIdFilter) || chainIdFilter <= 0)) {
    return c.json({ error: 'chainId must be a positive integer' }, 400);
  }

  // Query each table with the (optional) chain filter + newest-first + limit.
  // Do all three in parallel — Postgres can service them concurrently.
  const [dRows, bRows, cRows] = await Promise.all([
    (async () => {
      const q = c.db.select().from(flywheelDistributions);
      const scoped = chainIdFilter ? q.where(eq(flywheelDistributions.chainId, chainIdFilter)) : q;
      return scoped.orderBy(desc(flywheelDistributions.blockNumber)).limit(limit);
    })(),
    (async () => {
      const q = c.db.select().from(uruBuybacks);
      const scoped = chainIdFilter ? q.where(eq(uruBuybacks.chainId, chainIdFilter)) : q;
      return scoped.orderBy(desc(uruBuybacks.blockNumber)).limit(limit);
    })(),
    (async () => {
      const q = c.db.select().from(uruSinkConversions);
      const scoped = chainIdFilter ? q.where(eq(uruSinkConversions.chainId, chainIdFilter)) : q;
      return scoped.orderBy(desc(uruSinkConversions.blockNumber)).limit(limit);
    })(),
  ]);

  // Merge into a single stream, tagged by kind, bigints as strings.
  interface Row {
    kind: 'distribution' | 'buyback' | 'conversion';
    chainId: number;
    txHash: Hex;
    blockNumber: bigint;
    blockTimestamp: bigint;
    [k: string]: unknown;
  }
  const merged: Row[] = [
    ...dRows.map((r): Row => ({
      kind: 'distribution',
      chainId: r.chainId,
      txHash: r.txHash as Hex,
      blockNumber: r.blockNumber,
      blockTimestamp: r.blockTimestamp,
      total: r.total,
      toBuyback: r.toBuyback,
      toNft: r.toNft,
      toTreasury: r.toTreasury,
    })),
    ...bRows.map((r): Row => ({
      kind: 'buyback',
      chainId: r.chainId,
      txHash: r.txHash as Hex,
      blockNumber: r.blockNumber,
      blockTimestamp: r.blockTimestamp,
      ethIn: r.ethIn,
      uruOut: r.uruOut,
    })),
    ...cRows.map((r): Row => ({
      kind: 'conversion',
      chainId: r.chainId,
      txHash: r.txHash as Hex,
      blockNumber: r.blockNumber,
      blockTimestamp: r.blockTimestamp,
      uruIn: r.uruIn,
      ethOut: r.ethOut,
    })),
  ]
    // Newest first. Sub-block ordering falls back to insertion order which is
    // fine — the exact intra-block ordering matters for reorg replay but not
    // for a dashboard.
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0))
    .slice(0, limit);

  const serialised = merged.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = typeof v === 'bigint' ? v.toString() : v;
    }
    return out;
  });

  return c.json({ activity: serialised });
});

// ---- GET /api/flywheel/totals ----
//
// Lifetime aggregates for the flywheel dashboard tiles. The /activity
// endpoint is capped at 100 rows for feed-rendering reasons; using its sum
// as a "since launch" total dramatically undercounts once the feed has
// scrolled past its window. This endpoint iterates every row and sums.
//
// Response shape (JSON, bigints as wei-strings):
//   { chainId?, distributions: { count, total, toBuyback, toNft, toTreasury },
//                buybacks:      { count, ethIn, uruOut },
//                conversions:   { count, uruIn, ethOut } }
//
// Optional ?chainId= narrows to one chain. Rows scanned in memory — cheap
// while row counts stay under ~1M; if the tables ever grow past that, swap
// this to a Drizzle sum() aggregate.
ponder.get('/api/flywheel/totals', async (c) => {
  const chainIdRaw = c.req.query('chainId');
  const chainIdFilter = chainIdRaw ? Number(chainIdRaw) : undefined;
  if (chainIdFilter !== undefined && (!Number.isInteger(chainIdFilter) || chainIdFilter <= 0)) {
    return c.json({ error: 'chainId must be a positive integer' }, 400);
  }

  const [dRows, bRows, cRows] = await Promise.all([
    (async () => {
      const q = c.db.select().from(flywheelDistributions);
      return chainIdFilter ? q.where(eq(flywheelDistributions.chainId, chainIdFilter)) : q;
    })(),
    (async () => {
      const q = c.db.select().from(uruBuybacks);
      return chainIdFilter ? q.where(eq(uruBuybacks.chainId, chainIdFilter)) : q;
    })(),
    (async () => {
      const q = c.db.select().from(uruSinkConversions);
      return chainIdFilter ? q.where(eq(uruSinkConversions.chainId, chainIdFilter)) : q;
    })(),
  ]);

  let dTotal = 0n, dBuyback = 0n, dNft = 0n, dTreasury = 0n;
  for (const r of dRows) {
    dTotal += r.total ?? 0n;
    dBuyback += r.toBuyback ?? 0n;
    dNft += r.toNft ?? 0n;
    dTreasury += r.toTreasury ?? 0n;
  }
  let bEthIn = 0n, bUruOut = 0n;
  for (const r of bRows) {
    bEthIn += r.ethIn ?? 0n;
    bUruOut += r.uruOut ?? 0n;
  }
  let cUruIn = 0n, cEthOut = 0n;
  for (const r of cRows) {
    cUruIn += r.uruIn ?? 0n;
    cEthOut += r.ethOut ?? 0n;
  }

  return c.json({
    chainId: chainIdFilter,
    distributions: {
      count: dRows.length,
      total: dTotal.toString(),
      toBuyback: dBuyback.toString(),
      toNft: dNft.toString(),
      toTreasury: dTreasury.toString(),
    },
    buybacks: {
      count: bRows.length,
      ethIn: bEthIn.toString(),
      uruOut: bUruOut.toString(),
    },
    conversions: {
      count: cRows.length,
      uruIn: cUruIn.toString(),
      ethOut: cEthOut.toString(),
    },
  });
});

export { buildLaunchCard, computeV4PoolId } from './launch-card.ts';
export type { LaunchCard } from './launch-card.ts';
