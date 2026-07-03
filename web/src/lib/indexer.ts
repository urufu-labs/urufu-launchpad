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

/// Health probe — used by pages to decide whether to try indexer queries at all before
/// falling back to mocks. Cheap: hits the GraphQL endpoint's introspection.
export async function isIndexerReachable(): Promise<boolean> {
  const data = await gql<{ __schema: unknown }>(`query { __schema { queryType { name } } }`);
  return data !== null;
}
