'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';
import {
  mockMarketCapEth,
  mockProgressPct,
  launchKind,
  tradeCountOf,
  type MockLaunch,
  type LaunchKind,
} from '@/lib/mockLaunches';
import { useAgo } from '@/lib/useAgo';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { loadMetadata } from '@/lib/metadata';
import { formatGweiPerToken } from '@/lib/priceFmt';

// 'direct' switches the pool to direct-mint tokens; every other filter operates on curve
// tokens only (progress / mcap / graduation are curve concepts).
type Filter = 'trending' | 'new' | 'mcap' | 'near-graduation' | 'graduated' | 'all' | 'direct';

const FILTERS: Array<{ id: Filter; label: string; jp: string }> = [
  { id: 'trending', label: 'trending', jp: '人気' },
  { id: 'new', label: 'new', jp: '新着' },
  { id: 'mcap', label: 'top mcap', jp: '時価' },
  { id: 'near-graduation', label: 'near grad', jp: '卒業' },
  { id: 'graduated', label: 'graduated', jp: '完了' },
  { id: 'all', label: 'all', jp: '全部' },
  { id: 'direct', label: 'direct mint', jp: '直接' },
];

// Relative-time formatting has moved to `useAgo` — a hook that returns null on SSR to
// avoid hydration mismatch, then real "12s / 3m / 2h / 5d" strings post-mount, ticking
// every 30s. Legacy static NOW here caused live launches (post-2026-06) to render as
// negative time since they happened after the frozen constant.

export default function DiscoverPage() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const [filter, setFilter] = useState<Filter>('trending');
  const [query, setQuery] = useState('');
  // Unified feed: indexer-backed for live chains, mocks for preview chains.
  const feed = useLaunchFeed(activeChainId);
  const indexerChecked = feed.ready;
  const indexerLaunches = feed.source === 'indexer' ? feed.launches : null;
  const source = feed.launches;

  const filtered = useMemo(() => {
    // 'direct' filter narrows to direct-mint tokens; every other filter is curve-only.
    const wantKind: LaunchKind = filter === 'direct' ? 'direct' : 'curve';
    let list = source.filter((l) => launchKind(l) === wantKind);
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
      case 'trending':
        list.sort((a, b) => tradeCountOf(b) - tradeCountOf(a));
        break;
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
      case 'direct':
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case 'all':
      default:
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
    }
    return list;
  }, [filter, query, source]);

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
      {/* ================================================================
          COMPACT HEADER — one row: mascot + title + chain badge + count
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '12px 18px',
          marginBottom: 10,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Mascot size={44} mood="happy" className="uru-idle-bob" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="uru-eyebrow" style={{ marginBottom: 2 }}>❁ launches · {CHAIN_LABELS[activeChain]}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 24, lineHeight: 1 }}>the feed</h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              新着
            </span>
            <span
              style={{
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 11,
                color: 'var(--anchor-soft)',
                marginLeft: 4,
              }}
            >
              · {source.length} on this chain
            </span>
          </div>
        </div>
        <Link href="/create" className="uru-btn uru-btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}>
          launch a token <span className="uru-arrow">→</span>
        </Link>
      </section>

      {/* ================================================================
          DATA-SOURCE STRIP — slim colored bar instead of full shell
          ================================================================ */}
      <div
        style={{
          padding: '6px 12px',
          marginBottom: 10,
          background: indexerLaunches ? 'var(--mint)' : 'var(--yolk)',
          borderLeft: '4px solid var(--anchor)',
          border: '1.5px solid var(--anchor)',
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10.5,
          color: 'var(--anchor)',
        }}
      >
        {indexerLaunches ? (
          <>
            <b>● live feed</b> ~ {indexerLaunches.length} launch{indexerLaunches.length === 1 ? '' : 'es'} from the indexer ✿
          </>
        ) : indexerChecked ? (
          <><b>◐ preview</b> ~ indexer reachable but no launches yet; mock feed shown until the first real one lands.</>
        ) : (
          <><b>◐ preview</b> ~ mock tokens. broadcast phase 1 + start the indexer for a live feed.</>
        )}
      </div>

      {/* ================================================================
          TOOLBAR — tabs + search on one row, hides gracefully on mobile
          ================================================================ */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="uru-chip"
              data-active={filter === f.id}
              style={{ padding: '5px 12px' }}
            >
              {f.label}
              <span
                style={{
                  fontFamily: 'var(--font-jp), monospace',
                  fontSize: 10,
                  marginLeft: 4,
                  opacity: 0.7,
                }}
              >
                {f.jp}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <input
          className="uru-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search name / ticker / addr"
          style={{ maxWidth: 260, fontSize: 12 }}
        />
      </div>

      {/* ================================================================
          DENSE CARD GRID — 4-col at lg, 3-col at md, 2-col at sm
          ================================================================ */}
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {filtered.map((l) => (
          <LaunchCard key={l.address} launch={l} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="uru-shell" style={{ padding: 22, textAlign: 'center', marginTop: 12 }}>
          <Mascot size={44} mood="confused" />
          <div
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 11,
              color: 'var(--anchor-soft)',
            }}
          >
            no launches match ~~
          </div>
        </div>
      )}
    </div>
  );
}

function LaunchCard({ launch }: { launch: MockLaunch }) {
  const progress = mockProgressPct(launch);
  const mcap = mockMarketCapEth(launch);
  const spotPriceWei = useMemo(() => {
    const num = (launch.ethReserve + launch.virtualEthReserve) * 10n ** 18n;
    const den = launch.tokenReserve + launch.virtualTokenReserve;
    return den > 0n ? num / den : 0n;
  }, [launch.ethReserve, launch.virtualEthReserve, launch.tokenReserve, launch.virtualTokenReserve]);

  const [logoDataUrl, setLogoDataUrl] = useState<string | undefined>();
  useEffect(() => {
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLogoDataUrl(m.logoDataUrl);
  }, [launch.chainId, launch.address]);

  return (
    <Link
      href={`/trade/${launch.address}`}
      className="uru-shell-tight uru-launch-card"
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            border: '1.5px solid var(--anchor)',
            background: logoDataUrl
              ? `#fff url(${logoDataUrl}) center/cover no-repeat`
              : launch.logoBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          {!logoDataUrl && launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <div
              className="uru-h2"
              style={{
                fontSize: 13,
                lineHeight: 1.1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {launch.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 10,
                color: 'var(--anchor-soft)',
              }}
            >
              ${launch.ticker}
            </div>
          </div>
          {launch.description && (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--anchor-soft)',
                marginTop: 1,
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {launch.description}
            </div>
          )}
        </div>
      </div>

      {/* Price + mcap strip */}
      <div
        style={{
          marginTop: 8,
          padding: '4px 6px',
          background: 'var(--cream-deep)',
          border: '1px dashed var(--anchor)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 6,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 9.5,
          color: 'var(--anchor-soft)',
        }}
      >
        <span>
          px{' '}
          <span style={{ color: 'var(--anchor)', fontWeight: 700, fontSize: 11 }}>
            {spotPriceWei > 0n ? formatGweiPerToken(spotPriceWei) : '—'}
          </span>
          {' '}gwei
        </span>
        <span>
          mcap{' '}
          <span style={{ color: 'var(--anchor)', fontWeight: 700, fontSize: 11 }}>
            {Number(formatEther(mcap)).toFixed(3)}
          </span>
          {' '}Ξ
        </span>
      </div>

      {/* Progress */}
      <div style={{ marginTop: 6 }}>
        <div
          style={{
            height: 6,
            background: 'var(--cream-deep)',
            border: '1.5px solid var(--anchor)',
          }}
        >
          <div
            className={progress > 85 && !launch.graduated ? 'uru-shimmer' : ''}
            style={{
              width: `${progress}%`,
              height: '100%',
              background: launch.graduated ? 'var(--mint-hot)' : 'var(--pink-hot)',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 3,
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            color: 'var(--anchor-soft)',
          }}
        >
          <span>{launch.graduated ? '✿ graduated' : `${progress.toFixed(1)}% → v4`}</span>
          <span>{Number(formatEther(launch.ethReserve)).toFixed(2)}/{Number(formatEther(launch.graduationTargetEth)).toFixed(1)}Ξ</span>
        </div>
      </div>

      {/* Trades + time */}
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 9.5,
          color: 'var(--anchor-soft)',
        }}
      >
        <span>{tradeCountOf(launch)} tx · <AgoLabel ts={launch.launchedAt} /></span>
        <span
          style={{
            color: 'var(--pink-hot)',
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          trade <span className="uru-arrow">→</span>
        </span>
      </div>
    </Link>
  );
}

function AgoLabel({ ts }: { ts: number }) {
  const label = useAgo(ts);
  return <>{label ?? '—'}</>;
}
