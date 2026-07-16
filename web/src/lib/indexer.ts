/// Thin fetch client for the Ponder indexer. Ponder exposes GraphQL at
/// `${INDEXER_URL}/graphql`. Every helper here is defensive: if the indexer isn't reachable,
/// or returns an error, or returns empty data, the caller falls back to the mock feed.
///
/// Supports TWO deployment modes:
///   1. Single indexer service (legacy): NEXT_PUBLIC_INDEXER_URL points at one Ponder
///      instance that syncs every chain. All fetches hit that URL.
///   2. Per-chain indexer services (recommended for prod): each chain gets its own
///      Ponder service on Railway. Set NEXT_PUBLIC_INDEXER_URL_<CHAIN> per chain, e.g.
///      NEXT_PUBLIC_INDEXER_URL_BASE. Isolates one chain's config-change reindex from
///      the others; each service has its own dedicated Alchemy CU quota so historical
///      sync is 3-5x faster. Fallback: any function that doesn't know the chain uses
///      NEXT_PUBLIC_INDEXER_URL as a shared fallback.

import type { Address } from 'viem';

const FALLBACK_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';

/// Map chain id → per-chain indexer URL if set. Falls back to the shared URL when
/// no per-chain URL is configured. This lets deployers start with the single-service
/// pattern and migrate to per-chain later without touching frontend code.
const PER_CHAIN_URLS: Record<number, string | undefined> = {
  1: process.env.NEXT_PUBLIC_INDEXER_URL_MAINNET,
  8453: process.env.NEXT_PUBLIC_INDEXER_URL_BASE,
  84532: process.env.NEXT_PUBLIC_INDEXER_URL_BASE_SEPOLIA,
  4663: process.env.NEXT_PUBLIC_INDEXER_URL_ROBINHOOD,
  11155111: process.env.NEXT_PUBLIC_INDEXER_URL_SEPOLIA,
  46630: process.env.NEXT_PUBLIC_INDEXER_URL_ROBINHOOD_TESTNET,
};

function graphqlUrlFor(chainId?: number): string {
  const url = (chainId !== undefined && PER_CHAIN_URLS[chainId]) || FALLBACK_URL;
  return `${url.replace(/\/$/, '')}/graphql`;
}

/// Return every configured indexer URL (per-chain + fallback), deduped. Used by cross-
/// chain aggregate queries (`fetchRecentLaunches`, `fetchRecentTrades`, etc.) that
/// want data from all chains at once. Callers merge the per-URL responses client-side.
function allConfiguredUrls(): string[] {
  const urls = new Set<string>();
  urls.add(FALLBACK_URL);
  for (const u of Object.values(PER_CHAIN_URLS)) if (u) urls.add(u);
  return Array.from(urls).map((u) => `${u.replace(/\/$/, '')}/graphql`);
}

/// Send a GraphQL query to a specific URL. When chainId is provided, uses the per-
/// chain URL if configured; otherwise falls back to the shared indexer URL.
async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  chainId?: number,
): Promise<T | null> {
  return gqlAt<T>(graphqlUrlFor(chainId), query, variables);
}

async function gqlAt<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      console.warn('indexer errors', json.errors);
      return null;
    }
    return json.data ?? null;
  } catch {
    // AbortError / network error / DNS failure — silent, caller falls back.
    return null;
  }
}

/// Fan out a GraphQL query across every configured indexer URL in parallel, merging
/// the items[] arrays into a single result. Used by chain-agnostic feeds (home page
/// live trades rail, discover feed) that show data from all chains at once. Each URL
/// only returns its own chain's data in the per-chain deploy pattern, so merging is
/// just concatenating arrays.
async function gqlFanout<T extends { [key: string]: { items: unknown[] } }>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  const urls = allConfiguredUrls();
  if (urls.length === 1) {
    // Single-service pattern — no fanout needed.
    return gqlAt<T>(urls[0]!, query, variables);
  }
  const results = await Promise.all(urls.map((u) => gqlAt<T>(u, query, variables)));
  const nonNull: T[] = [];
  for (const r of results) if (r !== null) nonNull.push(r);
  if (nonNull.length === 0) return null;
  const first = nonNull[0]!;
  // Merge: for each top-level key in the response, concat all items[] arrays.
  const merged = { ...first };
  const keys = Object.keys(first) as Array<keyof T>;
  for (const key of keys) {
    const allItems = nonNull.flatMap((r) => r[key].items);
    (merged[key] as { items: unknown[] }) = { ...first[key], items: allItems };
  }
  return merged;
}

// ---- Row shapes matching ponder.schema.ts ----

export interface IndexerLaunch {
  id: string;
  chainId: number;
  tokenAddress: Address;
  launchedBy: Address;
  base: number;
  name: string;
  ticker: string;
  configHash: `0x${string}`;
  feePaid: string;
  installedHook: boolean;
  installedGovernance: boolean;
  installedBondingCurve: boolean;
  curveAddress: Address | null;
  blockNumber: string;
  blockTimestamp: string;
  txHash: `0x${string}`;
}

export interface IndexerCurve {
  id: string;
  chainId: number;
  curveAddress: Address;
  tokenAddress: Address;
  curveSupply: string;
  virtualTokenReserve: string;
  virtualEthReserve: string;
  graduationTargetEth: string;
  tradeFeeBps: number;
  ethReserve: string;
  tokenReserve: string;
  tradeCount: number;
  graduated: boolean;
  graduatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IndexerTrade {
  id: string;
  chainId: number;
  curveAddress: Address;
  tokenAddress: Address;
  trader: Address;
  isBuy: boolean;
  ethAmount: string;
  tokenAmount: string;
  ethReserveAfter: string;
  tokenReserveAfter: string;
  priceWeiPerToken: string;
  blockNumber: string;
  blockTimestamp: string;
  txHash: `0x${string}`;
}

// ---- Queries ----

/// Fetch the most recent launches. Fans out across every configured indexer URL and
/// merges results — under per-chain deploys each Ponder service only knows its own
/// chain's launches, so merging is required for a chain-agnostic feed. Returns `null`
/// if EVERY indexer is unreachable; caller falls back to mocks.
export async function fetchRecentLaunches(limit = 40): Promise<IndexerLaunch[] | null> {
  const data = await gqlFanout<{ launchess: { items: IndexerLaunch[] } }>(
    `query RecentLaunches($limit: Int!) {
      launchess(orderBy: "blockTimestamp", orderDirection: "desc", limit: $limit) {
        items {
          id chainId tokenAddress launchedBy base name ticker configHash feePaid
          installedHook installedGovernance installedBondingCurve curveAddress
          blockNumber blockTimestamp txHash
        }
      }
    }`,
    { limit },
  );
  if (!data) return null;
  // Merged items may not be globally sorted (each service returns its own order).
  // Sort by blockTimestamp desc + trim to the requested limit.
  return data.launchess.items
    .slice()
    .sort((a, b) => Number(BigInt(b.blockTimestamp) - BigInt(a.blockTimestamp)))
    .slice(0, limit);
}

/// Curve state for a token address (case-insensitive). Returns null when nothing indexed.
export async function fetchCurveByToken(token: Address): Promise<IndexerCurve | null> {
  const data = await gqlFanout<{ curvess: { items: IndexerCurve[] } }>(
    `query CurveByToken($token: String!) {
      curvess(where: { tokenAddress: $token }, limit: 1) {
        items {
          id chainId curveAddress tokenAddress curveSupply virtualTokenReserve virtualEthReserve
          graduationTargetEth tradeFeeBps ethReserve tokenReserve tradeCount graduated graduatedAt
          createdAt updatedAt
        }
      }
    }`,
    { token: token.toLowerCase() },
  );
  return data?.curvess.items[0] ?? null;
}

/// Chronological trades for a curve. Returned oldest → newest for chart aggregation.
export async function fetchTradesForCurve(curve: Address, limit = 500): Promise<IndexerTrade[] | null> {
  const data = await gqlFanout<{ tradess: { items: IndexerTrade[] } }>(
    `query TradesForCurve($curve: String!, $limit: Int!) {
      tradess(
        where: { curveAddress: $curve },
        orderBy: "blockTimestamp",
        orderDirection: "asc",
        limit: $limit
      ) {
        items {
          id chainId curveAddress tokenAddress trader isBuy ethAmount tokenAmount
          ethReserveAfter tokenReserveAfter priceWeiPerToken blockNumber blockTimestamp txHash
        }
      }
    }`,
    { curve: curve.toLowerCase(), limit },
  );
  return data?.tradess.items ?? null;
}

/// Post-graduation swaps indexed from Uniswap v4 PoolManager.Swap. Same rough shape as
/// `IndexerTrade` but sourced from the v4 pool, not the BondingCurve — used by the home
/// page live rail so post-graduation activity keeps flowing after curves close.
export interface IndexerV4Swap {
  id: string;
  chainId: number;
  poolId: `0x${string}`;
  tokenAddress: Address | null;
  sender: Address;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  priceWeiPerToken: string;
  blockNumber: string;
  blockTimestamp: string;
  txHash: `0x${string}`;
}

export async function fetchRecentV4Swaps(limit = 25): Promise<IndexerV4Swap[] | null> {
  // Two-step server-side filter: fetch known launchpad `poolId`s from `graduations`,
  // then ask Ponder for `v4Swaps` where `poolId_in: [...]`. This replaces an earlier
  // "overfetch 200 + client filter for non-null tokenAddress" approach that was
  // squeezing older + rarer launchpad rows (specifically sells on quiet tokens) out
  // of the 200-row window whenever the chain had heavy non-launchpad v4 traffic.
  // Now the filter runs in Postgres so we always get the newest `limit` launchpad
  // swaps regardless of how noisy the rest of the chain is.
  const gradsData = await gqlFanout<{ graduationss: { items: Array<{ poolId: `0x${string}` | null }> } }>(
    `query KnownPoolIds { graduationss(limit: 1000) { items { poolId } } }`,
  );
  const poolIds = (gradsData?.graduationss.items ?? [])
    .map((g) => g.poolId)
    .filter((p): p is `0x${string}` => !!p);
  if (poolIds.length === 0) return [];

  const data = await gqlFanout<{ v4Swapss: { items: IndexerV4Swap[] } }>(
    `query RecentV4Swaps($poolIds: [String!]!, $limit: Int!) {
      v4Swapss(
        where: { poolId_in: $poolIds },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId poolId tokenAddress sender amount0 amount1 sqrtPriceX96 liquidity
          tick fee priceWeiPerToken blockNumber blockTimestamp txHash
        }
      }
    }`,
    { poolIds, limit },
  );
  return data?.v4Swapss.items ?? null;
}

/// Full v4 swap history for a specific token, newest-first. Used by the trade page as
/// the source of truth for post-graduation trades (recent-trades list + chart points).
/// Replaces client-side `publicClient.getLogs` scans that were capped at ~30k blocks
/// lookback -- older swaps were silently invisible on the trade page even when the
/// indexer had them. The indexer's RPC is paid-tier + a single query pulls the whole
/// history from the graduated pool without chunk-walking.
export async function fetchV4SwapsForToken(
  tokenAddress: Address,
  limit = 500,
): Promise<IndexerV4Swap[] | null> {
  const data = await gqlFanout<{ v4Swapss: { items: IndexerV4Swap[] } }>(
    `query V4SwapsForToken($token: String!, $limit: Int!) {
      v4Swapss(
        where: { tokenAddress: $token },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId poolId tokenAddress sender amount0 amount1 sqrtPriceX96 liquidity
          tick fee priceWeiPerToken blockNumber blockTimestamp txHash
        }
      }
    }`,
    { token: tokenAddress.toLowerCase(), limit },
  );
  return data?.v4Swapss.items ?? null;
}

/// Latest v4 swap for a specific token, plus a bounded count of total v4 swaps. Used to
/// enrich graduated launches on the /discover feed so mcap + tx count reflect post-grad
/// pool activity, not the frozen curve-side snapshot. Cheap enough to call per launch;
/// discover's launch pool is small (top 40) and each call is a single indexed lookup.
export async function fetchV4SummaryForToken(
  tokenAddress: Address,
): Promise<{ latestSqrtPriceX96: bigint; count: number } | null> {
  const data = await gqlFanout<{ v4Swapss: { items: IndexerV4Swap[] } }>(
    `query V4SummaryForToken($token: String!) {
      v4Swapss(
        where: { tokenAddress: $token },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: 1000
      ) {
        items { sqrtPriceX96 blockNumber }
      }
    }`,
    { token: tokenAddress.toLowerCase() },
  );
  const items = data?.v4Swapss.items ?? [];
  if (items.length === 0) return { latestSqrtPriceX96: 0n, count: 0 };
  return { latestSqrtPriceX96: BigInt(items[0].sqrtPriceX96), count: items.length };
}

/// Newest trades across every curve on the connected chain, most-recent first. Powers the
/// home page's "live activity" rail so users see fresh buys/sells landing without opening
/// a specific trade page.
export async function fetchRecentTrades(limit = 25): Promise<IndexerTrade[] | null> {
  const data = await gqlFanout<{ tradess: { items: IndexerTrade[] } }>(
    `query RecentTrades($limit: Int!) {
      tradess(orderBy: "blockTimestamp", orderDirection: "desc", limit: $limit) {
        items {
          id chainId curveAddress tokenAddress trader isBuy ethAmount tokenAmount
          ethReserveAfter tokenReserveAfter priceWeiPerToken blockNumber blockTimestamp txHash
        }
      }
    }`,
    { limit },
  );
  return data?.tradess.items ?? null;
}

/// Health probe — used by pages to decide whether to try indexer queries at all before
/// falling back to mocks. Cheap: hits the GraphQL endpoint's introspection.
export async function isIndexerReachable(): Promise<boolean> {
  // Introspection query — no items[] arrays to merge, use plain gql() to fallback URL.
  const data = await gql<{ __schema: unknown }>(`query { __schema { queryType { name } } }`);
  return data !== null;
}

// ---- Profile-scoped queries — for /profile/[address] ----

export interface IndexerHolding {
  id: string;
  chainId: number;
  tokenAddress: Address;
  holderAddress: Address;
  balance: string;
  updatedAt: string;
}

/// All launches created by a given wallet, newest first. Feeds the "creations" grid on a
/// profile — each row is a token this address launched via Router.launch.
export async function fetchLaunchesByCreator(creator: Address, limit = 40): Promise<IndexerLaunch[] | null> {
  const data = await gqlFanout<{ launchess: { items: IndexerLaunch[] } }>(
    `query LaunchesByCreator($creator: String!, $limit: Int!) {
      launchess(
        where: { launchedBy: $creator },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId tokenAddress launchedBy base name ticker configHash feePaid
          installedHook installedGovernance installedBondingCurve curveAddress
          blockNumber blockTimestamp txHash
        }
      }
    }`,
    { creator: creator.toLowerCase(), limit },
  );
  return data?.launchess.items ?? null;
}

/// Post-graduation trades keyed by the actual user wallet. Queries the v4RouterSwaps
/// table which the indexer fills from V4SwapRouter.Swapped(user, token, isBuy, in, out) —
/// PoolManager.Swap.sender is always the router, so filtering v4Swaps by sender never
/// finds a user's own trades. This is the source of truth for profile activity.
export interface IndexerV4RouterSwap {
  id: string;
  chainId: number;
  user: Address;
  tokenAddress: Address;
  isBuy: boolean;
  amountIn: string;
  amountOut: string;
  blockNumber: string;
  blockTimestamp: string;
  txHash: `0x${string}`;
}

export async function fetchV4SwapsByTrader(
  trader: Address,
  limit = 200,
): Promise<IndexerV4RouterSwap[] | null> {
  const data = await gqlFanout<{ v4RouterSwapss: { items: IndexerV4RouterSwap[] } }>(
    `query V4SwapsByTrader($trader: String!, $limit: Int!) {
      v4RouterSwapss(
        where: { user: $trader },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId user tokenAddress isBuy amountIn amountOut
          blockNumber blockTimestamp txHash
        }
      }
    }`,
    { trader: trader.toLowerCase(), limit },
  );
  return data?.v4RouterSwapss.items ?? null;
}

/// Every trade this wallet has ever made across every curve, newest first. Feeds the
/// activity feed + is the raw input to PnL math.
export async function fetchTradesByTrader(trader: Address, limit = 200): Promise<IndexerTrade[] | null> {
  const data = await gqlFanout<{ tradess: { items: IndexerTrade[] } }>(
    `query TradesByTrader($trader: String!, $limit: Int!) {
      tradess(
        where: { trader: $trader },
        orderBy: "blockTimestamp",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId curveAddress tokenAddress trader isBuy ethAmount tokenAmount
          ethReserveAfter tokenReserveAfter priceWeiPerToken blockNumber blockTimestamp txHash
        }
      }
    }`,
    { trader: trader.toLowerCase(), limit },
  );
  return data?.tradess.items ?? null;
}

/// Batch-look-up launch metadata by tokenAddress. Used by the profile page to render
/// friendly name/ticker labels for tokens the user traded but didn't launch (their own
/// launches are already in `fetchLaunchesByCreator`).
///
/// Ponder's GraphQL filter uses `<field>_in: [values]`. `tokens` is deduped +
/// lowercased inside so the caller can pass a raw list.
export async function fetchLaunchesByTokens(tokens: Address[]): Promise<IndexerLaunch[] | null> {
  const uniq = Array.from(new Set(tokens.map((t) => t.toLowerCase()))) as Address[];
  if (uniq.length === 0) return [];
  const data = await gqlFanout<{ launchess: { items: IndexerLaunch[] } }>(
    `query LaunchesByTokens($tokens: [String!]!) {
      launchess(where: { tokenAddress_in: $tokens }, limit: 1000) {
        items {
          id chainId tokenAddress launchedBy base name ticker configHash feePaid
          installedHook installedGovernance installedBondingCurve curveAddress
          blockNumber blockTimestamp txHash
        }
      }
    }`,
    { tokens: uniq },
  );
  return data?.launchess.items ?? null;
}

/// Current per-token balances for a wallet. Used for the "holdings" strip on the profile.
export async function fetchHoldingsByAddress(holder: Address, limit = 100): Promise<IndexerHolding[] | null> {
  const data = await gqlFanout<{ holderss: { items: IndexerHolding[] } }>(
    `query HoldingsByAddress($holder: String!, $limit: Int!) {
      holderss(
        where: { holderAddress: $holder },
        orderBy: "updatedAt",
        orderDirection: "desc",
        limit: $limit
      ) {
        items {
          id chainId tokenAddress holderAddress balance updatedAt
        }
      }
    }`,
    { holder: holder.toLowerCase(), limit },
  );
  return data?.holderss.items ?? null;
}
