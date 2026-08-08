'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import {
  MOCK_LAUNCHES,
  mockMarketCapEth,
  mockProgressPct,
  launchKind,
  tradeCountOf,
  type MockLaunch,
} from '@/lib/mockLaunches';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { useAgo } from '@/lib/useAgo';
import {
  fetchRecentTrades,
  fetchRecentV4Swaps,
  type IndexerTrade,
  type IndexerV4Swap,
} from '@/lib/indexer';
import { loadMetadata, safeBackgroundImage } from '@/lib/metadata';
import { CONTRACTS, CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';

// All tabs are curve-only now; the create page only launches curves (quick +
// customizable, both fire installBondingCurve=true). The old 'direct mint' tab
// filtered to no-curve tokens (legacy pre-rename direct launches + NFT bases),
// but NFT bases aren't live yet and legacy direct tokens are hidden. Dropped
// the tab to declutter the bar.
type Tab = 'trending' | 'new' | 'near' | 'graduated';

const TABS: Array<{ id: Tab; label: string; jp: string }> = [
  { id: 'trending', label: 'trending', jp: '人気' },
  { id: 'new', label: 'new', jp: '新着' },
  { id: 'near', label: 'near grad', jp: '卒業' },
  { id: 'graduated', label: 'graduated', jp: '完了' },
];

// Relative time now flows through the `useAgo` hook (returns null on SSR so live
// timestamps don't cause hydration mismatch or negative deltas). Rendered by <AgoLabel />
// below.

export default function HomePage() {
  if (!LAUNCHPAD_LIVE) {
    return <NotLiveYet />;
  }
  return <HomePageContent />;
}

function HomePageContent() {
  const activeChain = useActiveChain();
  const chainId = CHAIN_KEY_TO_ID[activeChain];
  const [tab, setTab] = useState<Tab>('trending');
  const [query, setQuery] = useState('');

  // Real indexer feed for chains with deployed contracts, mocks otherwise.
  const feed = useLaunchFeed(chainId);
  const chainMocks = feed.launches;

  // Chain-scoped aggregates for the stat strip. On live chains this reflects real indexer
  // launches; on preview chains it aggregates the mock fixtures useLaunchFeed returned.
  const stats = useMemo(() => {
    const total = chainMocks.length;
    const graduated = chainMocks.filter((l) => l.graduated).length;
    const totalEth = chainMocks.reduce((acc, l) => acc + l.ethReserve, 0n);
    const totalTrades = chainMocks.reduce((acc, l) => acc + tradeCountOf(l), 0);
    return { total, graduated, totalEth, totalTrades };
  }, [chainMocks]);

  const filtered = useMemo(() => {
    // All tabs are curve-only after the direct-mint tab drop; non-curve tokens
    // (legacy pre-rename direct launches + any NFT bases) never surface here.
    let list = chainMocks.filter((l) => launchKind(l) === 'curve');
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (l) => l.name.toLowerCase().includes(q) || l.ticker.toLowerCase().includes(q),
      );
    }
    switch (tab) {
      case 'trending':
        list.sort((a, b) => tradeCountOf(b) - tradeCountOf(a));
        break;
      case 'new':
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case 'near':
        list = list
          .filter((l) => !l.graduated)
          .sort((a, b) => mockProgressPct(b) - mockProgressPct(a));
        break;
      case 'graduated':
        list = list.filter((l) => l.graduated);
        break;
    }
    return list;
  }, [chainMocks, query, tab]);

  // Right-rail "live activity", real trades from the indexer on chains with deployed
  // contracts, mocks on preview chains. Polls every 20s so users see fresh activity
  // without a refresh. Falls back cleanly when the indexer is down (returns [] → we
  // render the empty-state placeholder in the rail).
  const [liveTradesReal, setLiveTradesReal] = useState<IndexerTrade[] | null>(null);
  const [liveV4Real, setLiveV4Real] = useState<IndexerV4Swap[] | null>(null);
  const liveIsRealChain = CONTRACTS[activeChain] !== null;
  useEffect(() => {
    if (!liveIsRealChain) return;
    let cancelled = false;
    const load = async () => {
      const [curveRows, v4Rows] = await Promise.all([
        fetchRecentTrades(20),
        fetchRecentV4Swaps(20),
      ]);
      if (cancelled) return;
      // Keep the last-good state when a poll returns null (network hiccup, indexer
      // transient) OR when the fresh page came back empty. An empty array is truthy
      // in JS, so the old `if (v4Rows)` check happily wiped state whenever the
      // overfetched-200 window happened to contain zero launchpad-mapped rows —
      // and rare rows (sells on quiet tokens) were the ones that visibly vanished
      // because they never got refilled by the next poll. Only replace state when
      // the fresh response actually contains something.
      const freshCurve = curveRows?.filter((t) => t.chainId === chainId) ?? null;
      const freshV4 = v4Rows?.filter((t) => t.chainId === chainId) ?? null;
      if (freshCurve && freshCurve.length > 0) setLiveTradesReal(freshCurve);
      if (freshV4 && freshV4.length > 0) setLiveV4Real(freshV4);
    };
    load();
    // 5s poll, Base Sepolia has 2s blocks + a fast indexer pipeline, so a fresh trade
    // should surface in ≤10s from confirm to render (indexer processing lag + one poll).
    const id = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveIsRealChain, chainId]);

  // Normalize both curve trades and v4 swaps to the shape the JSX rail expects: { l, t }.
  // v4 swap direction is derived from the sign of amount0 (currency0 = ETH): amount0 < 0
  // means the pool paid out ETH (user bought token), amount0 > 0 means the pool received
  // ETH (user sold token). Amounts are absolute values of the pool-side delta.
  const liveTrades = useMemo(() => {
    if (liveIsRealChain) {
      const byToken = new Map(chainMocks.map((l) => [l.address.toLowerCase(), l] as const));
      const curveRows = (liveTradesReal ?? [])
        .map((t) => {
          const l = byToken.get(t.tokenAddress.toLowerCase());
          if (!l) return null;
          return {
            l,
            t: {
              isBuy: t.isBuy,
              ethAmount: BigInt(t.ethAmount),
              tokenAmount: BigInt(t.tokenAmount),
              trader: t.trader,
              timestamp: Number(t.blockTimestamp),
              ethReserve: BigInt(t.ethReserveAfter),
              tokenReserve: BigInt(t.tokenReserveAfter),
            },
          };
        })
        .filter(<T,>(x: T | null): x is T => x !== null);
      const v4Rows = (liveV4Real ?? [])
        .map((s) => {
          if (!s.tokenAddress) return null;
          const l = byToken.get(s.tokenAddress.toLowerCase());
          if (!l) return null;
          const amt0 = BigInt(s.amount0);
          const amt1 = BigInt(s.amount1);
          const isBuy = amt0 < 0n; // pool paid out ETH ⇒ user bought token
          return {
            l,
            t: {
              isBuy,
              ethAmount: amt0 < 0n ? -amt0 : amt0,
              tokenAmount: amt1 < 0n ? -amt1 : amt1,
              trader: s.sender,
              timestamp: Number(s.blockTimestamp),
              ethReserve: 0n,
              tokenReserve: 0n,
            },
          };
        })
        .filter(<T,>(x: T | null): x is T => x !== null);
      return [...curveRows, ...v4Rows].sort((a, b) => b.t.timestamp - a.t.timestamp).slice(0, 14);
    }
    // Preview chains: aggregate from mock trades so the rail isn't empty on Sepolia/base/etc.
    return MOCK_LAUNCHES.flatMap((l) => l.trades.slice(-3).map((t) => ({ l, t })))
      .sort((a, b) => b.t.timestamp - a.t.timestamp)
      .slice(0, 14);
  }, [liveIsRealChain, liveTradesReal, liveV4Real, chainMocks]);

  return (
    <main className="uru-home-shell">
      <section className="uru-home-hero-frame" aria-labelledby="hero-title">
        <span className="uru-home-tape uru-home-tape-top" aria-hidden="true" />
        <div className="uru-home-hero">
          <div className="uru-home-hero-copy">
            <p className="uru-home-eyebrow">✿ urufu labs launchpad</p>
            <h1 id="hero-title" className="uru-home-title">
              The culture-first token launchpad.<span aria-hidden="true"> ✦</span>
            </h1>
            <p className="uru-home-subtitle">
              Artist-first ERC-20 releases with V4 hooks for permanent liquidity, creator fees, and
              a safe launch.
            </p>
            <div className="uru-home-flags" aria-label="Launch properties">
              <span>erc-20</span>
              <span data-tone="mint">uniswap v4</span>
              <span data-tone="pink">LP locked forever</span>
            </div>
            <div className="uru-home-actions">
              <Link href="/create" className="uru-btn uru-btn-primary">
                launch a token <span className="uru-arrow">→</span>
              </Link>
              <Link href="/catalog" className="uru-btn uru-btn-cream">
                shelf
              </Link>
            </div>
          </div>

          <HeroArt />
        </div>

        <section className="uru-home-stat-strip" aria-label="Launchpad statistics">
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
      </section>

      <div className="uru-home-gallery-layout" id="launches">
        <section className="uru-home-gallery-main" aria-label="Launches">
          <div className="uru-home-feed-bar">
            <div className="uru-home-tabs" role="tablist" aria-label="Launch filters">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className="uru-chip"
                  data-active={tab === t.id}
                >
                  {t.label}
                  <span>{t.jp}</span>
                </button>
              ))}
            </div>
            <input
              className="uru-input uru-home-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search name / ticker"
              aria-label="Search name or ticker"
            />
            <Link href="/discover" className="uru-home-feed-link">
              see all »
            </Link>
          </div>

          {filtered.length > 0 ? (
            <div className="uru-home-launch-grid">
              {filtered.slice(0, 12).map((l) => (
                <LaunchTile key={l.address} launch={l} />
              ))}
            </div>
          ) : (
            <div className="uru-home-empty">
              <div>
                <Mascot size={52} mood="confused" />
                <p>no launches on {CHAIN_LABELS[activeChain]} yet ~~</p>
                <Link href="/create">launch the first one »</Link>
              </div>
            </div>
          )}
        </section>

        <aside className="uru-home-side-rail">
          <section className="uru-home-sidebar-card" aria-label="Live trades">
            <div className="uru-home-sidebar-title">
              <span>✦ live trades</span>
              <span className="uru-home-live-dot" aria-hidden="true" />
            </div>
            {liveTrades.length > 0 ? (
              <ul className="uru-home-trade-list">
                {liveTrades.map((row, i) => (
                  <li key={`${row.l.address}-${row.t.timestamp}-${i}`}>
                    <span data-side={row.t.isBuy ? 'buy' : 'sell'}>
                      {row.t.isBuy ? 'BUY' : 'SELL'}
                    </span>
                    <Link href={`/trade/${row.l.address}`}>${row.l.ticker}</Link>
                    <span>{Number(formatEther(row.t.ethAmount)).toFixed(3)}Ξ</span>
                    <time>
                      <AgoLabel ts={row.t.timestamp} />
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="uru-home-trade-empty">waiting on the first launch ~~</p>
            )}
          </section>

          <section className="uru-home-sidebar-card" aria-label="The flywheel">
            <div className="uru-home-sidebar-title">
              <span>❀ the flywheel</span>
            </div>
            <ul className="uru-home-flywheel-list">
              <li>
                <b>40%</b> URU buyback
              </li>
              <li>
                <b>35%</b> urufu gemu nft holders
              </li>
              <li>
                <b>25%</b> treasury
              </li>
            </ul>
            <p className="uru-home-flywheel-note">
              hold URU or an urufu gemu nft → up to <b>50%</b> off launch fees
            </p>
            {/* Direct-buy CTAs so first-time visitors have a one-tap path to eligibility. */}
            <div className="uru-home-rail-actions">
              <a
                href="https://app.uniswap.org/swap?chain=robinhood&outputCurrency=0x9fbe210007dDd8389f98d0253018e65CC48b9D24"
                target="_blank"
                rel="noopener noreferrer"
                className="uru-btn uru-btn-mint"
              >
                ✿ buy URU
              </a>
              <a
                href="https://opensea.io/collection/urufugemu"
                target="_blank"
                rel="noopener noreferrer"
                className="uru-btn uru-btn-primary"
              >
                ✿ buy gemu nft
              </a>
            </div>
          </section>
        </aside>
      </div>

      <section className="uru-home-how" aria-labelledby="how-title">
        <div className="uru-home-how-title">
          <div id="how-title">
            how it works<small>流れ</small>
          </div>
        </div>
        <StepTile n="01" title="define your coin" body="name · ticker · art · socials" />
        <StepTile
          n="02"
          title="customize contract"
          body="add v4 hooks & custom security modules to your token contract"
        />
        <StepTile
          n="03"
          title="launch"
          body="a smooth guided flow deploys your bonding curve securely"
        />
      </section>
    </main>
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
  return (
    <div className="uru-home-stat" data-accent={accent}>
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
  // Prefer indexer-supplied imageUrl (shared everywhere), fall back to browser local
  // for the seconds right after launch before the metadata POST completes.
  const [localImage, setLocalImage] = useState<string | undefined>();
  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);
  const logoDataUrl = launch.imageUrl ?? localImage;
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
            background: safeBackgroundImage(logoDataUrl, launch.logoBg),
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
            <span>{tradeCountOf(launch)} tx</span>
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
          <span>
            <AgoLabel ts={launch.launchedAt} /> ago
          </span>
        </div>
      </div>
    </Link>
  );
}

function AgoLabel({ ts }: { ts: number }) {
  const label = useAgo(ts);
  return <>{label ?? '~'}</>;
}

function HeroArt() {
  return (
    <div className="uru-home-hero-art" aria-label="Urufu gemu inspired gallery panel" role="img">
      <span className="uru-home-moon uru-home-moon-one" aria-hidden="true" />
      <span className="uru-home-moon uru-home-moon-two" aria-hidden="true" />
      <span className="uru-home-wolf" aria-hidden="true" />
      <span className="uru-home-sheep" aria-hidden="true">
        ●●ᴗ
      </span>
      <span className="uru-home-sheep uru-home-sheep-two" aria-hidden="true">
        ●●ᴗ
      </span>
      <span className="uru-home-petal" aria-hidden="true" />
      <span className="uru-home-petal" aria-hidden="true" />
      <span className="uru-home-petal" aria-hidden="true" />
      <span className="uru-home-petal" aria-hidden="true" />
      <span className="uru-home-art-label">
        <b>❋ urufu gemu</b> / soft + sharp
      </span>
    </div>
  );
}

function StepTile({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="uru-home-how-step">
      <span>{n}</span>
      <b>{title}</b>
      <p>{body}</p>
    </div>
  );
}
