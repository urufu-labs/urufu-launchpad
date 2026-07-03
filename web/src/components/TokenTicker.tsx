'use client';

/// Global token ticker — mounted once in the root layout so every page shows a live
/// scrolling strip of recent launches with their spot price. Clickable pills route to
/// each token's trade page. Falls back to the mock feed when the indexer is empty or
/// unreachable so the ticker is never blank.
///
/// Data-source order:
///  1. Ponder indexer via fetchRecentLaunches (curve-installed launches only)
///  2. Mock fixtures for the currently-picked chain
///  3. Empty-state hint pointing to /create

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { parseEther } from 'viem';

import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import {
  fetchRecentLaunches,
  fetchCurveByToken,
  type IndexerLaunch,
} from '@/lib/indexer';
import { formatGweiPerToken } from '@/lib/priceFmt';
import { mocksForChain, type MockLaunch } from '@/lib/mockLaunches';

export function TokenTicker() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const chainLabel = CHAIN_LABELS[activeChain];

  const [indexerLaunches, setIndexerLaunches] = useState<MockLaunch[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchRecentLaunches(30);
      if (cancelled || !rows || rows.length === 0) return;
      const curveRows = rows.filter((r) => r.installedBondingCurve && r.curveAddress);
      if (curveRows.length === 0) return;
      const mapped = await Promise.all(curveRows.map((r) => indexerToTickerLaunch(r)));
      if (!cancelled) setIndexerLaunches(mapped.filter((l): l is MockLaunch => l !== null));
    })();
    return () => { cancelled = true; };
  }, []);

  const mocks = useMemo(() => mocksForChain(activeChainId), [activeChainId]);
  const source = useMemo(() => {
    if (indexerLaunches && indexerLaunches.length > 0) {
      return indexerLaunches.filter((l) => l.chainId === activeChainId);
    }
    return mocks;
  }, [indexerLaunches, mocks, activeChainId]);

  const entries = useMemo(() => {
    if (source.length === 0) {
      return [
        { key: 'empty-1', node: <span>✿ no launches yet on {chainLabel} ~ launch the first ✿</span> },
        { key: 'empty-2', node: <span>❀ head to /create → tap tap launch ★</span> },
      ];
    }
    return source.slice(0, 20).map((l, i) => {
      const priceWei = spotPriceOf(l);
      const priceStr = priceWei > 0n ? `${formatGweiPerToken(priceWei)} gwei` : '—';
      return {
        key: `${l.address}-${i}`,
        node: (
          <Link
            href={`/trade/${l.address}`}
            style={{
              display: 'inline-flex',
              gap: 6,
              alignItems: 'center',
              color: 'var(--anchor)',
              textDecoration: 'none',
              padding: '1px 8px',
              borderLeft: `2px solid ${l.graduated ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}`,
            }}
          >
            <span style={{ fontSize: 13 }}>{l.logoEmoji}</span>
            <span style={{ fontWeight: 700 }}>${l.ticker}</span>
            <span style={{ color: 'var(--anchor-soft)' }}>{priceStr}</span>
            {l.graduated && <span style={{ color: 'var(--mint-hot,#2b8a3e)', fontWeight: 700 }}>✿ grad</span>}
          </Link>
        ),
      };
    });
  }, [source, chainLabel]);

  // Duplicate so translateX(-50%) wraps seamlessly.
  const loop = [...entries, ...entries];

  return (
    <div className="uru-marquee-wrap" aria-hidden>
      <div className="uru-marquee">
        <div className="uru-marquee-track">
          {loop.map((e, i) => (
            <span key={`${e.key}-${i}`}>{e.node}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function spotPriceOf(l: MockLaunch): bigint {
  const num = (l.ethReserve + l.virtualEthReserve) * 10n ** 18n;
  const den = l.tokenReserve + l.virtualTokenReserve;
  return den > 0n ? num / den : 0n;
}

/// Mirror of the discover page's indexer→mock mapping so the ticker can reuse the
/// MockLaunch card shape without a schema change. Total supply defaults to CurveFactory's
/// baseline until the indexer surfaces it directly.
async function indexerToTickerLaunch(row: IndexerLaunch): Promise<MockLaunch | null> {
  if (!row.curveAddress) return null;
  const curve = await fetchCurveByToken(row.tokenAddress);
  if (!curve) return null;
  const b = (s: string) => BigInt(s);
  return {
    chainId: row.chainId,
    address: row.tokenAddress,
    name: row.name || row.ticker,
    ticker: row.ticker,
    description: '',
    logoBg: '#c9e6ff',
    logoEmoji: '✿',
    creator: row.launchedBy,
    launchedAt: Number(row.blockTimestamp),
    ethReserve: b(curve.ethReserve),
    tokenReserve: b(curve.tokenReserve),
    virtualEthReserve: b(curve.virtualEthReserve),
    virtualTokenReserve: b(curve.virtualTokenReserve),
    graduationTargetEth: b(curve.graduationTargetEth),
    curveSupply: b(curve.curveSupply),
    totalSupply: parseEther('1000000000'),
    tradeFeeBps: curve.tradeFeeBps,
    graduated: curve.graduated,
    trades: [],
  };
}
