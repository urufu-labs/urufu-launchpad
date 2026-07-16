'use client';

import { useEffect, useState } from 'react';
import { parseEther } from 'viem';

import type { Address } from 'viem';
import { fetchRecentLaunches, fetchCurveByToken, fetchV4SummaryForToken, type IndexerLaunch } from './indexer';
import { MOCK_LAUNCHES, type MockLaunch } from './mockLaunches';
import { CONTRACTS, type ChainKey } from './config';
import { CHAIN_ID_TO_KEY } from './wagmi';
import { fetchTokenMetadataBatch, type RemoteTokenMetadata } from './socialApi';

interface FeedState {
  source: 'indexer' | 'mock';
  launches: MockLaunch[];
  ready: boolean;
}

import { isHiddenToken } from './hiddenTokens';

// Chains where CONTRACTS[chain] has been populated by sync-addresses.mjs — the mock preview
// no longer belongs on these because there are real launches to show. Kept as a lazy read so
// tree-shaking of unused chain configs doesn't matter.
function hasLiveContracts(chainId: number): boolean {
  const key = CHAIN_ID_TO_KEY[chainId] as ChainKey | undefined;
  return key ? CONTRACTS[key] !== null : false;
}

/// Unified launch-feed hook consumed by home / discover / trade-list.
///
/// - On chains with deployed contracts (CONTRACTS[key] !== null) it queries Ponder and
///   returns the mapped MockLaunch[] filtered to the requested chain. Mocks are suppressed.
/// - On chains without contracts (pure preview mode) it returns the mocks for that chain.
///
/// `ready` flips true once the indexer probe has finished, so pages can render a skeleton
/// or an "indexer offline" fallback without briefly flashing the mock list.
export function useLaunchFeed(chainId: number): FeedState {
  const [state, setState] = useState<FeedState>(() => {
    // First paint: if we already know the chain has no live contracts, render the mock
    // preview immediately (SSR-safe, deterministic). Otherwise start empty and let the
    // effect fill in from the indexer — avoids a flash of unrelated mock tokens.
    if (!hasLiveContracts(chainId)) {
      return {
        source: 'mock',
        launches: MOCK_LAUNCHES.filter((l) => l.chainId === chainId).filter(
          (l) => !isHiddenToken(l.chainId, l.address),
        ),
        ready: true,
      };
    }
    return { source: 'indexer', launches: [], ready: false };
  });

  useEffect(() => {
    let cancelled = false;

    if (!hasLiveContracts(chainId)) {
      setState({
        source: 'mock',
        launches: MOCK_LAUNCHES.filter((l) => l.chainId === chainId).filter(
          (l) => !isHiddenToken(l.chainId, l.address),
        ),
        ready: true,
      });
      return () => { cancelled = true; };
    }

    // First run per chainId — clear so we don't flash mocks from another chain while
    // fetching. Subsequent poll ticks reuse setState in place so the marquee doesn't
    // clear on every refresh (that would blink every 15s).
    setState({ source: 'indexer', launches: [], ready: false });

    const load = async () => {
      const rows = await fetchRecentLaunches(60);
      if (cancelled) return;
      if (!rows) {
        setState((prev) => (prev.ready ? prev : { source: 'indexer', launches: [], ready: true }));
        return;
      }
      const forChain = rows
        .filter((r) => r.chainId === chainId)
        .filter((r) => !isHiddenToken(r.chainId, r.tokenAddress));
      const meta = await fetchTokenMetadataBatch(
        chainId,
        forChain.map((r) => r.tokenAddress as Address),
      );
      if (cancelled) return;
      const mapped = await Promise.all(forChain.map((r) => indexerRowToLaunch(r, meta)));
      if (cancelled) return;
      setState({
        source: 'indexer',
        launches: mapped.filter((l): l is MockLaunch => l !== null),
        ready: true,
      });
    };
    load();
    // Poll so the ticker + home rail + discover feed pick up new launches and freshly
    // mined trades (curve state + v4 spot are re-read per row inside indexerRowToLaunch)
    // without a page refresh. 15s is a friendly cadence — indexer catch-up is usually
    // sub-second so this feels near-real-time without hammering the backend.
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [chainId]);

  return state;
}

async function indexerRowToLaunch(
  row: IndexerLaunch,
  metadataMap: Record<string, RemoteTokenMetadata>,
): Promise<MockLaunch | null> {
  const b = (s: string) => BigInt(s);
  // Always probe the curves table by tokenAddress, not just when the launches row has
  // installedBondingCurve set. A token can be launched direct and get its curve created
  // later via CurveFactory.createCurve(), in which case installedBondingCurve stays false
  // on the launches row but the curves row exists — the presence of a curve row is the
  // real source of truth for "this token has a bonding curve."
  const curve = await fetchCurveByToken(row.tokenAddress);
  // Graduated tokens need a second query for their v4 pool activity — otherwise mcap
  // reads 0 (curve drained) + tx count freezes at the last pre-grad trade. Cheap: one
  // indexed lookup per launch, only for the graduated subset.
  const isGraduated = curve?.graduated ?? false;
  const v4Summary = isGraduated ? await fetchV4SummaryForToken(row.tokenAddress) : null;
  const meta = metadataMap[row.tokenAddress.toLowerCase()];
  return {
    chainId: row.chainId,
    address: row.tokenAddress,
    name: row.name || row.ticker || row.tokenAddress.slice(0, 8),
    ticker: row.ticker,
    description: meta?.description ?? '',
    logoBg: '#c9e6ff',
    logoEmoji: '✿',
    imageUrl: meta?.imageUrl ?? undefined,
    website: meta?.website ?? undefined,
    twitter: meta?.twitter ?? undefined,
    telegram: meta?.telegram ?? undefined,
    creator: row.launchedBy,
    launchedAt: Number(row.blockTimestamp),
    ethReserve: curve ? b(curve.ethReserve) : 0n,
    tokenReserve: curve ? b(curve.tokenReserve) : 0n,
    virtualEthReserve: curve ? b(curve.virtualEthReserve) : 0n,
    virtualTokenReserve: curve ? b(curve.virtualTokenReserve) : 0n,
    graduationTargetEth: curve ? b(curve.graduationTargetEth) : 0n,
    curveSupply: curve ? b(curve.curveSupply) : 0n,
    // Real minted supply for our launched tokens equals the curve's initial supply
    // (the launchpad templates never mint after init). Fall through to 1B only for
    // tokens that never had a curve (edge case). Wrong before this: hardcoded 1B
    // for every token, which made discover mcap disagree with trade page (which
    // reads the actual ERC20 totalSupply from chain).
    totalSupply: curve ? b(curve.curveSupply) : parseEther('1000000000'),
    tradeFeeBps: curve?.tradeFeeBps ?? 0,
    graduated: isGraduated,
    trades: [],
    tradeCount: curve?.tradeCount ?? 0,
    v4SwapCount: v4Summary?.count ?? 0,
    poolLatestSqrtPriceX96: v4Summary?.latestSqrtPriceX96 ?? 0n,
    kind: curve ? 'curve' : 'direct',
  };
}
