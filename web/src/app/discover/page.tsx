'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, parseEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';
import {
  mocksForChain,
  mockMarketCapEth,
  mockProgressPct,
  type MockLaunch,
} from '@/lib/mockLaunches';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchRecentLaunches, fetchCurveByToken, type IndexerLaunch } from '@/lib/indexer';

type Filter = 'new' | 'mcap' | 'near-graduation' | 'graduated' | 'all';

const FILTERS: Array<{ id: Filter; label: string; jp: string }> = [
  { id: 'new', label: 'new', jp: '新着' },
  { id: 'mcap', label: 'top mkt cap', jp: '時価' },
  { id: 'near-graduation', label: 'near grad', jp: '卒業' },
  { id: 'graduated', label: 'graduated', jp: '完了' },
  { id: 'all', label: 'all', jp: '全部' },
];

function ago(ts: number): string {
  const now = 1_780_000_000; // static "now" so it matches mock timestamps
  const s = now - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function DiscoverPage() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const [filter, setFilter] = useState<Filter>('new');
  const [query, setQuery] = useState('');
  const [indexerLaunches, setIndexerLaunches] = useState<MockLaunch[] | null>(null);
  const [indexerChecked, setIndexerChecked] = useState(false);

  // Try the indexer once on mount. If it's up and returns launches, use those instead of the
  // mock fixture; otherwise stay on mocks. The resulting `MockLaunch` shape is the same for
  // both paths so the rest of the page doesn't care.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchRecentLaunches(40);
      if (cancelled) return;
      if (!rows || rows.length === 0) { setIndexerChecked(true); return; }
      // Only surface launches that have a curve — the discover feed is trade-focused.
      const curveRows = rows.filter((r) => r.installedBondingCurve && r.curveAddress);
      if (curveRows.length === 0) { setIndexerChecked(true); return; }
      const mapped = await Promise.all(curveRows.map((r) => indexerLaunchToMock(r)));
      if (!cancelled) {
        setIndexerLaunches(mapped.filter((l): l is MockLaunch => l !== null));
        setIndexerChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Chain-filter both sources so the user only sees launches on the chain they picked.
  const chainMocks = useMemo(() => mocksForChain(activeChainId), [activeChainId]);
  const chainIndexed = useMemo(
    () => (indexerLaunches ? indexerLaunches.filter((l) => l.chainId === activeChainId) : null),
    [indexerLaunches, activeChainId],
  );
  const source = chainIndexed ?? chainMocks;

  const filtered = useMemo(() => {
    let list = source.slice();
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          l.ticker.toLowerCase().includes(q) ||
          l.address.toLowerCase().includes(q),
      );
    }
    switch (filter) {
      case 'new':
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case 'mcap':
        list.sort((a, b) => Number(mockMarketCapEth(b) - mockMarketCapEth(a)));
        break;
      case 'near-graduation':
        list = list.filter((l) => !l.graduated);
        list.sort((a, b) => mockProgressPct(b) - mockProgressPct(a));
        break;
      case 'graduated':
        list = list.filter((l) => l.graduated);
        break;
      case 'all':
      default:
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
    }
    return list;
  }, [filter, query, source]);

  return (
    <>
      <div className="uru-marquee-wrap">
        <div className="uru-marquee">
          <div className="uru-marquee-track">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i}>
                ✿ browse launches ✿ {chainMocks.length} tokens on {CHAIN_LABELS[activeChain]} ❀ freshly launched ★{' '}
                <span style={{ fontFamily: 'var(--font-jp), monospace' }}>新着</span> ❁ preview mode ~~
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* Header cluster */}
        <div className="flex items-end gap-4 mb-6" style={{ position: 'relative' }}>
          <Mascot size={72} mood="happy" className="uru-idle-bob" />
          <div>
            <div className="uru-eyebrow">launches ✿ {CHAIN_LABELS[activeChain]}</div>
            <h1 className="uru-h1" style={{ fontSize: 36, lineHeight: 1 }}>
              the feed
              <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 22, marginLeft: 8 }}>
                新着
              </span>
            </h1>
            <p style={{ marginTop: 4, fontSize: 13, color: 'var(--anchor-soft)', maxWidth: 520 }}>
              every token launched on urufu labs shows up here ~ click into one to trade against its
              bonding curve. use the chain switcher in the header to swap networks (◕‿◕✿)
            </p>
          </div>
        </div>

        {/* Data source banner — flips from preview to live once the indexer has launches */}
        <div
          className="uru-shell"
          style={{
            padding: 12,
            marginBottom: 16,
            background: indexerLaunches ? 'var(--mint)' : 'var(--yolk)',
          }}
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Mascot size={32} mood={indexerLaunches ? 'happy' : 'confused'} />
            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor)' }}>
              {indexerLaunches ? (
                <>
                  <b>live feed</b> ~ {indexerLaunches.length} launch{indexerLaunches.length === 1 ? '' : 'es'} from the indexer ✿
                </>
              ) : indexerChecked ? (
                <><b>preview mode</b> ~ indexer reachable but no launches yet. mock feed shown until the first real one lands.</>
              ) : (
                <><b>preview mode</b> ~ mock tokens for UI preview. broadcast phase 1 + start the indexer for a live feed.</>
              )}
            </div>
          </div>
        </div>

        {/* Filter tabs + search */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="uru-btn"
              style={{
                fontSize: 12,
                padding: '4px 10px',
                background: filter === f.id ? 'var(--pink-warm)' : 'transparent',
                fontWeight: 700,
              }}
            >
              {f.label}{' '}
              <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 10, opacity: 0.7 }}>{f.jp}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <input
            className="uru-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search name/ticker/addr"
            style={{ maxWidth: 240, fontSize: 12 }}
          />
        </div>

        {/* Card grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((l) => (
            <LaunchCard key={l.address} launch={l} />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="uru-shell" style={{ padding: 20, textAlign: 'center', marginTop: 16 }}>
            <Mascot size={48} mood="confused" />
            <div style={{ marginTop: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 12, color: 'var(--anchor-soft)' }}>
              no launches match ~~
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/// Map an indexer launch (+ its curve state) to the same MockLaunch shape the feed already
/// renders, so the same LaunchCard works for both. Only used on the client after mount.
async function indexerLaunchToMock(row: IndexerLaunch): Promise<MockLaunch | null> {
  if (!row.curveAddress) return null;
  const curve = await fetchCurveByToken(row.tokenAddress);
  if (!curve) return null;

  // Rehydrate bigint strings.
  const b = (s: string) => BigInt(s);
  return {
    chainId: row.chainId,
    address: row.tokenAddress,
    name: row.name || row.ticker,
    ticker: row.ticker,
    description: '', // metadata sits in launcher-side storage / IPFS (Phase 3)
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
    // Total supply isn't in the indexer schema (yet); reasonable default matches CurveFactory.
    totalSupply: parseEther('1000000000'),
    tradeFeeBps: curve.tradeFeeBps,
    graduated: curve.graduated,
    trades: [], // trade list is fetched on the trade page, not the feed
  };
}

function LaunchCard({ launch }: { launch: MockLaunch }) {
  const progress = mockProgressPct(launch);
  const mcap = mockMarketCapEth(launch);

  return (
    <Link
      href={`/trade/${launch.address}`}
      className="uru-shell"
      style={{
        padding: 12,
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'transform 0.12s ease, box-shadow 0.12s ease',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 10,
            border: '1.5px solid var(--anchor)',
            boxShadow: '2px 2px 0 var(--anchor)',
            background: launch.logoBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            flexShrink: 0,
          }}
        >
          {launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <div className="uru-h2" style={{ fontSize: 15, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {launch.name}
            </div>
            <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
              ${launch.ticker}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--anchor-soft)', marginTop: 2, lineHeight: 1.35 }}>
            {launch.description.length > 84 ? launch.description.slice(0, 84) + '…' : launch.description}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 3 }}>
          <span>{launch.graduated ? '✿ graduated ✿' : `${progress.toFixed(1)}% → v4`}</span>
          <span>{Number(formatEther(launch.ethReserve)).toFixed(3)} / {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} ETH</span>
        </div>
        <div style={{ height: 8, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)', position: 'relative' }}>
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: launch.graduated ? 'var(--mint)' : 'var(--pink-hot)',
            }}
          />
        </div>
      </div>

      {/* Stats row */}
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
        <span>
          mcap <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>{Number(formatEther(mcap)).toFixed(2)} ETH</span>
        </span>
        <span>{launch.trades.length} trades</span>
        <span>{ago(launch.launchedAt)}</span>
      </div>
    </Link>
  );
}
