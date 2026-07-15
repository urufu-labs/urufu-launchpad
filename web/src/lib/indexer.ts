/// Thin fetch client for the Ponder indexer. Ponder exposes GraphQL at
/// `${INDEXER_URL}/graphql`. Every helper here is defensive: if the indexer isn't reachable,
/// or returns an error, or returns empty data, the caller falls back to the mock feed.
///
/// Env var: `NEXT_PUBLIC_INDEXER_URL`. Default `http://localhost:42069` matches Ponder dev.
/// After broadcast, set this to the deployed indexer URL (Vercel / Railway / self-hosted).

import type { Address } from 'viem';

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';
const GRAPHQL_URL = `${INDEXER_URL.replace(/\/$/, '')}/graphql`;

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      // Ponder is expected on-network but we don't want a page to hang forever if it's down.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      console.warn('indexer errors', json.errors);
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    // AbortError / network error / DNS failure — silent, caller falls back.
    return null;
  }
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

/// Fetch the most recent launches. Returns `null` if the indexer is unreachable so the caller
/// can fall back to the mock feed cleanly.
export async function fetchRecentLaunches(limit = 40): Promise<IndexerLaunch[] | null> {
  const data = await gql<{ launchess: { items: IndexerLaunch[] } }>(
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
  return data?.launchess.items ?? null;
}

/// Curve state for a token address (case-insensitive). Returns null when nothing indexed.
export async function fetchCurveByToken(token: Address): Promise<IndexerCurve | null> {
  const data = await gql<{ curvess: { items: IndexerCurve[] } }>(
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
  const data = await gql<{ tradess: { items: IndexerTrade[] } }>(
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
  // Filter to swaps whose poolId reverse-mapped to a launchpad token — anything else
  // (random v4 activity on the same PoolManager) would just get dropped by the home
  // page's `byToken` lookup anyway, and on busy chains that filter can eat the entire
  // response before any of our tokens' swaps make the cut.
  const data = await gql<{ v4Swapss: { items: IndexerV4Swap[] } }>(
    `query RecentV4Swaps($limit: Int!) {
      v4Swapss(
        where: { tokenAddress_not: null },
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
    { limit },
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
  const data = await gql<{ v4Swapss: { items: IndexerV4Swap[] } }>(
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
  const data = await gql<{ tradess: { items: IndexerTrade[] } }>(
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
  const data = await gql<{ launchess: { items: IndexerLaunch[] } }>(
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

/// Every v4 swap this wallet has ever made (post-graduation trades). Feeds the profile
/// activity feed alongside curve trades — without this, profile pages show 0 sells for
/// anyone who traded a graduated token via V4SwapRouter.
export async function fetchV4SwapsByTrader(trader: Address, limit = 200): Promise<IndexerV4Swap[] | null> {
  const data = await gql<{ v4Swapss: { items: IndexerV4Swap[] } }>(
    `query V4SwapsByTrader($trader: String!, $limit: Int!) {
      v4Swapss(
        where: { sender: $trader },
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
    { trader: trader.toLowerCase(), limit },
  );
  return data?.v4Swapss.items ?? null;
}

/// Every trade this wallet has ever made across every curve, newest first. Feeds the
/// activity feed + is the raw input to PnL math.
export async function fetchTradesByTrader(trader: Address, limit = 200): Promise<IndexerTrade[] | null> {
  const data = await gql<{ tradess: { items: IndexerTrade[] } }>(
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
  const data = await gql<{ launchess: { items: IndexerLaunch[] } }>(
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
  const data = await gql<{ holderss: { items: IndexerHolding[] } }>(
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
