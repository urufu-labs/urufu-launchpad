'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';
import {
  MOCK_LAUNCHES,
  mocksForChain,
  mockMarketCapEth,
  mockProgressPct,
  type MockLaunch,
} from '@/lib/mockLaunches';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { CHAIN_LABELS } from '@/lib/config';

type Tab = 'trending' | 'new' | 'near' | 'graduated';

const TABS: Array<{ id: Tab; label: string; jp: string }> = [
  { id: 'trending', label: 'trending', jp: '人気' },
  { id: 'new', label: 'new', jp: '新着' },
  { id: 'near', label: 'near grad', jp: '卒業' },
  { id: 'graduated', label: 'graduated', jp: '完了' },
];

// Static "now" so relative times match the deterministic mock timestamps.
const NOW = 1_780_000_000;
function ago(ts: number): string {
  const s = NOW - ts;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function HomePage() {
  const activeChain = useActiveChain();
  const chainId = CHAIN_KEY_TO_ID[activeChain];
  const [tab, setTab] = useState<Tab>('trending');
  const [query, setQuery] = useState('');

  const chainMocks = useMemo(() => mocksForChain(chainId), [chainId]);

  // Cross-chain aggregates so the stat strip stays meaningful even on an empty chain.
  const stats = useMemo(() => {
    const total = MOCK_LAUNCHES.length;
    const graduated = MOCK_LAUNCHES.filter((l) => l.graduated).length;
    const totalEth = MOCK_LAUNCHES.reduce((acc, l) => acc + l.ethReserve, 0n);
    const totalTrades = MOCK_LAUNCHES.reduce((acc, l) => acc + l.trades.length, 0);
    return { total, graduated, totalEth, totalTrades };
  }, []);

  const filtered = useMemo(() => {
    let list = chainMocks.slice();
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (l) => l.name.toLowerCase().includes(q) || l.ticker.toLowerCase().includes(q),
      );
    }
    switch (tab) {
      case 'trending':
        list.sort((a, b) => b.trades.length - a.trades.length);
        break;
      case 'new':
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case 'near':
        list = list.filter((l) => !l.graduated).sort((a, b) => mockProgressPct(b) - mockProgressPct(a));
        break;
      case 'graduated':
        list = list.filter((l) => l.graduated);
        break;
    }
    return list;
  }, [chainMocks, query, tab]);

  // Cross-chain most-recent trades for the right-rail live activity list. Slice-per-launch
  // caps the fan-in so a single hyper-active launch can't dominate the rail.
  const liveTrades = useMemo(() => {
    return MOCK_LAUNCHES
      .flatMap((l) => l.trades.slice(-3).map((t) => ({ l, t })))
      .sort((a, b) => b.t.timestamp - a.t.timestamp)
      .slice(0, 14);
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
      {/* ===================================================================
          COMPACT HERO — one row, mascot inline, CTA on the right
          =================================================================== */}
      <section
        className="uru-shell"
        style={{
          padding: '14px 20px',
          marginBottom: 12,
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Mascot size={64} mood="happy" className="uru-idle-bob" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="uru-eyebrow" style={{ marginBottom: 3 }}>✿ urufu labs launchpad</div>
          <div className="uru-h1" style={{ fontSize: 'clamp(22px, 3vw, 30px)', lineHeight: 1.05 }}>
            a launchpad <span style={{ color: 'var(--pink-hot)' }}>u</span> can compose
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--anchor-soft)' }}>
            compose a token, ship real solidity, own the liquidity forever ✿
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/create" className="uru-btn uru-btn-primary">
            launch a token <span className="uru-arrow">→</span>
          </Link>
          <Link href="/catalog" className="uru-btn uru-btn-mint">
            shelf
          </Link>
        </div>
      </section>

      {/* ===================================================================
          STATS STRIP — data-forward, pixel-font values
          =================================================================== */}
      <section
        className="grid gap-2 mb-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}
      >
        <StatTile label="tokens" jp="数" value={String(stats.total)} />
        <StatTile label="graduated" jp="卒業" value={String(stats.graduated)} accent="mint" />
        <StatTile
          label="eth raised"
          jp="集金"
          value={`${Number(formatEther(stats.totalEth)).toFixed(2)} Ξ`}
          accent="pink"
        />
        <StatTile label="trades" jp="取引" value={String(stats.totalTrades)} />
        <StatTile label="chain" jp="鎖" value={CHAIN_LABELS[activeChain]} accent="mizuiro" />
      </section>

      {/* ===================================================================
          MAIN GRID — dense feed on the left, live-activity rail on the right
          =================================================================== */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            {/* -------------- feed column -------------- */}
            <section style={{ minWidth: 0 }}>
              {/* Tabs + search */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  marginBottom: 10,
                }}
              >
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      className="uru-chip"
                      data-active={tab === t.id}
                      style={{ padding: '5px 12px' }}
                    >
                      {t.label}
                      <span
                        style={{
                          fontFamily: 'var(--font-jp), monospace',
                          fontSize: 10,
                          marginLeft: 4,
                          opacity: 0.7,
                        }}
                      >
                        {t.jp}
                      </span>
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1 }} />
                <input
                  className="uru-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search name / ticker"
                  style={{ maxWidth: 200, fontSize: 12 }}
                />
                <Link
                  href="/discover"
                  style={{
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 11,
                    color: 'var(--link-blue)',
                    textDecoration: 'underline',
                    whiteSpace: 'nowrap',
                  }}
                >
                  see all »
                </Link>
              </div>

              {/* Dense card grid — 3-col at lg, 2-col at sm, 1-col mobile */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.slice(0, 12).map((l) => (
                  <LaunchTile key={l.address} launch={l} />
                ))}
              </div>

              {filtered.length === 0 && (
                <div
                  className="uru-shell"
                  style={{ padding: 22, textAlign: 'center' }}
                >
                  <Mascot size={44} mood="confused" />
                  <div
                    style={{
                      marginTop: 6,
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 11,
                      color: 'var(--anchor-soft)',
                    }}
                  >
                    no launches on {CHAIN_LABELS[activeChain]} yet ~~
                  </div>
                  <Link
                    href="/create"
                    style={{
                      display: 'inline-block',
                      marginTop: 10,
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 11,
                      color: 'var(--link-blue)',
                      textDecoration: 'underline',
                    }}
                  >
                    launch the first one »
                  </Link>
                </div>
              )}
            </section>

            {/* -------------- live-activity + flywheel rail -------------- */}
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 6,
                  }}
                >
                  <div className="uru-eyebrow">✦ live trades</div>
                  <span
                    aria-hidden
                    title="preview data"
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: 'var(--mint-hot)',
                      boxShadow: '0 0 6px var(--mint-hot)',
                    }}
                  />
                </div>
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {liveTrades.map((row, i) => (
                    <li
                      key={`${row.l.address}-${row.t.timestamp}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                        padding: '3px 0',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 10,
                        borderBottom: '1px dashed var(--cream-shadow)',
                      }}
                    >
                      <span
                        style={{
                          color: row.t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)',
                          fontWeight: 700,
                          width: 24,
                        }}
                      >
                        {row.t.isBuy ? 'BUY' : 'SEL'}
                      </span>
                      <Link
                        href={`/trade/${row.l.address}`}
                        style={{
                          color: 'var(--anchor)',
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textDecoration: 'none',
                        }}
                      >
                        ${row.l.ticker}
                      </Link>
                      <span style={{ color: 'var(--anchor-soft)' }}>
                        {Number(formatEther(row.t.ethAmount)).toFixed(3)}Ξ
                      </span>
                      <span style={{ color: 'var(--anchor-soft)', width: 24, textAlign: 'right' }}>
                        {ago(row.t.timestamp)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
                <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ the flywheel</div>
                <ul
                  className="uru-list-flower"
                  style={{ margin: 0, fontSize: 11, lineHeight: 1.55 }}
                >
                  <li><b style={{ color: 'var(--pink-hot)' }}>40%</b> URU buyback</li>
                  <li><b style={{ color: 'var(--pink-hot)' }}>35%</b> urufu gemu nft holders</li>
                  <li><b style={{ color: 'var(--pink-hot)' }}>25%</b> treasury</li>
                </ul>
                <div
                  style={{
                    marginTop: 8,
                    padding: 6,
                    background: 'var(--yolk)',
                    border: '1px solid var(--anchor)',
                    fontSize: 10,
                    lineHeight: 1.4,
                  }}
                >
                  hold URU or an urufu gemu nft → up to <b>50%</b> off launch fees
                </div>
              </div>
            </aside>
      </div>

      {/* ===================================================================
          HOW IT WORKS — demoted below the feed, compact 3-tile strip
          =================================================================== */}
      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span className="uru-h1" style={{ fontSize: 18 }}>how it works</span>
          <span
            style={{
              fontFamily: 'var(--font-jp), monospace',
              fontSize: 14,
              color: 'var(--anchor-soft)',
            }}
          >
            流れ
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StepTile n="01" title="pick a base" body="erc-20 · 721a · 1155" tape="pink" />
          <StepTile n="02" title="drag modules" body="audited fragments in ur cart" tape="mint" />
          <StepTile n="03" title="launch" body="one tx · address on etherscan" tape="mizuiro" />
        </div>
      </section>

    </div>
  );
}

// ============================================================================
// small components
// ============================================================================

function StatTile({
  label,
  jp,
  value,
  accent,
}: {
  label: string;
  jp: string;
  value: string;
  accent?: 'pink' | 'mint' | 'mizuiro';
}) {
  const bg =
    accent === 'pink' ? 'var(--pink-warm)' :
    accent === 'mint' ? 'var(--mint)' :
    accent === 'mizuiro' ? 'var(--mizuiro)' :
    'var(--cream)';
  return (
    <div
      className="uru-shell-tight"
      style={{ background: bg, padding: '8px 12px', minWidth: 0 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="uru-eyebrow">{label}</span>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          {jp}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--anchor)',
          lineHeight: 1.05,
          marginTop: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function LaunchTile({ launch }: { launch: MockLaunch }) {
  const progress = mockProgressPct(launch);
  const mcap = mockMarketCapEth(launch);
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
            width: 40,
            height: 40,
            borderRadius: 8,
            border: '1.5px solid var(--anchor)',
            background: launch.logoBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          {launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <div
              className="uru-h2"
              style={{
                fontSize: 13,
                lineHeight: 1.1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
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
          <div
            style={{
              marginTop: 2,
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10,
              color: 'var(--anchor-soft)',
            }}
          >
            <span>
              mcap <b style={{ color: 'var(--anchor)' }}>{Number(formatEther(mcap)).toFixed(3)}</b>Ξ
            </span>
            <span>{launch.trades.length} tx</span>
          </div>
        </div>
      </div>
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
          <span>{launch.graduated ? '✿ graduated' : `${progress.toFixed(0)}% → v4`}</span>
          <span>{ago(launch.launchedAt)} ago</span>
        </div>
      </div>
    </Link>
  );
}

function StepTile({
  n,
  title,
  body,
  tape,
}: {
  n: string;
  title: string;
  body: string;
  tape: 'pink' | 'mint' | 'mizuiro';
}) {
  const tapeClass = tape === 'mint' ? 'uru-tape-mint' : tape === 'mizuiro' ? 'uru-tape-mizuiro' : '';
  return (
    <div
      className="uru-shell-tight relative"
      style={{ padding: 14, textAlign: 'center' }}
    >
      <span
        className={`uru-tape ${tapeClass}`}
        style={{ width: 56, height: 12, top: -5, left: '50%', marginLeft: -28 }}
      />
      <div className="uru-h1" style={{ fontSize: 26, color: 'var(--pink-hot)', lineHeight: 1 }}>
        {n}
      </div>
      <div className="uru-h2" style={{ fontSize: 13, marginTop: 5 }}>
        {title}
      </div>
      <div
        style={{
          marginTop: 2,
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 11,
          color: 'var(--anchor-soft)',
        }}
      >
        {body}
      </div>
    </div>
  );
}
