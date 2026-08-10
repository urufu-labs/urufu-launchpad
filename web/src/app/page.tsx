'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { sizeForName } from '@/lib/nameSize';
import {
  MOCK_LAUNCHES,
  mockProgressPct,
  launchKind,
  tradeCountOf,
  type MockLaunch,
  type MockTrade,
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
type HomeTrade = { l: MockLaunch; t: MockTrade };
type PreviewTicket = {
  address: string;
  creator: string;
  tone: 'pink' | 'sky' | 'mint';
  progress: number;
  raised: string;
  trades: number;
};
type PreviewTrade = {
  id: string;
  wallet: string;
  ticker: string;
  amount: string;
};

const PREVIEW_LAUNCHES = MOCK_LAUNCHES.filter(
  (launch) => launch.chainId === 11155111 && launchKind(launch) === 'curve',
).slice(0, 3);
const PREVIEW_TICKETS: PreviewTicket[] = [
  {
    address: PREVIEW_LAUNCHES[0]!.address,
    creator: 'studio 02',
    tone: 'pink',
    progress: 82,
    raised: '3.48 Ξ',
    trades: 19,
  },
  {
    address: PREVIEW_LAUNCHES[1]!.address,
    creator: 'momo press',
    tone: 'sky',
    progress: 56,
    raised: '1.87 Ξ',
    trades: 12,
  },
  {
    address: PREVIEW_LAUNCHES[2]!.address,
    creator: 'pink unit',
    tone: 'mint',
    progress: 29,
    raised: '0.74 Ξ',
    trades: 7,
  },
];
const PREVIEW_TRADE_SEEDS: PreviewTrade[] = [
  { id: 'momo-mochi', wallet: 'momo.eth', ticker: '$MOCHI', amount: '0.42 Ξ' },
  { id: 'wallet-kawaii', wallet: '0x7b··f3', ticker: '$KAWAII', amount: '0.18 Ξ' },
  { id: 'pink-ramen', wallet: 'pinkunit', ticker: '$RAMEN', amount: '0.09 Ξ' },
  { id: 'studio-kawaii', wallet: 'studio02', ticker: '$KAWAII', amount: '0.64 Ξ' },
  { id: 'lilypad-mochi', wallet: 'lilypad.eth', ticker: '$MOCHI', amount: '0.26 Ξ' },
];
const PREVIEW_STATS = {
  tokens: '27',
  graduated: '6',
  ethRaised: '18.42 Ξ',
  trades: '163',
  chain: 'Robinhood',
};

// Preview data is for local reviews by default. A staging deployment must opt in with
// NEXT_PUBLIC_ENABLE_HOME_PREVIEW=true; production does not render the control unless
// someone deliberately supplies that flag.
const HOME_PREVIEW_AVAILABLE =
  process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_ENABLE_HOME_PREVIEW === 'true';

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
  // The local/staging review starts with the expressive fixture state on. The toggle
  // remains available there to inspect the real empty/live state; it never renders in
  // production unless that environment deliberately supplies the staging flag.
  const [previewEnabled, setPreviewEnabled] = useState(HOME_PREVIEW_AVAILABLE);
  const [previewRun, setPreviewRun] = useState(0);
  const [previewTrades, setPreviewTrades] = useState<PreviewTrade[]>(() =>
    HOME_PREVIEW_AVAILABLE ? PREVIEW_TRADE_SEEDS.slice(0, 3).reverse() : [],
  );
  const [previewIncomingTradeId, setPreviewIncomingTradeId] = useState<string | null>(null);
  const previewTradeListRef = useRef<HTMLUListElement>(null);
  const previewTradePositions = useRef(new Map<string, DOMRect>());

  // Real indexer feed for chains with deployed contracts, mocks otherwise.
  const feed = useLaunchFeed(chainId);
  const chainMocks = feed.launches;
  const previewLaunches = PREVIEW_LAUNCHES;
  const sourceLaunches = previewEnabled ? previewLaunches : chainMocks;
  const sourceLabel = previewEnabled ? PREVIEW_STATS.chain : CHAIN_LABELS[activeChain];

  // Chain-scoped aggregates for the stat strip. On live chains this reflects real indexer
  // launches; on preview chains it aggregates the mock fixtures useLaunchFeed returned.
  const stats = useMemo(() => {
    const total = sourceLaunches.length;
    const graduated = sourceLaunches.filter((l) => l.graduated).length;
    const totalEth = sourceLaunches.reduce((acc, l) => acc + l.ethReserve, 0n);
    const totalTrades = sourceLaunches.reduce((acc, l) => acc + tradeCountOf(l), 0);
    return { total, graduated, totalEth, totalTrades };
  }, [sourceLaunches]);

  const filtered = useMemo(() => {
    // All tabs are curve-only after the direct-mint tab drop; non-curve tokens
    // (legacy pre-rename direct launches + any NFT bases) never surface here.
    let list = sourceLaunches.filter((l) => launchKind(l) === 'curve');
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
  }, [sourceLaunches, query, tab]);

  // Right-rail "live activity", real trades from the indexer on chains with deployed
  // contracts, mocks on preview chains. Polls every 20s so users see fresh activity
  // without a refresh. Falls back cleanly when the indexer is down (returns [] → we
  // render the empty-state placeholder in the rail).
  const [liveTradesReal, setLiveTradesReal] = useState<IndexerTrade[] | null>(null);
  const [liveV4Real, setLiveV4Real] = useState<IndexerV4Swap[] | null>(null);
  const liveIsRealChain = CONTRACTS[activeChain] !== null;
  useEffect(() => {
    if (previewEnabled || !liveIsRealChain) return;
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
  }, [liveIsRealChain, chainId, previewEnabled]);

  // Normalize both curve trades and v4 swaps to the shape the JSX rail expects: { l, t }.
  // v4 swap direction is derived from the sign of amount0 (currency0 = ETH): amount0 < 0
  // means the pool paid out ETH (user bought token), amount0 > 0 means the pool received
  // ETH (user sold token). Amounts are absolute values of the pool-side delta.
  const liveTrades = useMemo<HomeTrade[]>(() => {
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

  // The static review's rail tells a small, readable story: three creator-first rows,
  // a replay button, and a gentle FLIP-like arrival sequence. It remains review-only;
  // production activity below still comes exclusively from the indexer.
  useEffect(() => {
    if (!previewEnabled || PREVIEW_TRADE_SEEDS.length === 0) {
      setPreviewTrades([]);
      return;
    }
    const initialReviewState = previewRun === 0;
    let next = initialReviewState ? 3 : 0;
    const timers: number[] = [];
    let interval: number | undefined;
    const addTrade = () => {
      const row = PREVIEW_TRADE_SEEDS[next % PREVIEW_TRADE_SEEDS.length]!;
      next += 1;
      previewTradePositions.current = new Map(
        [...(previewTradeListRef.current?.children ?? [])].map((entry) => [
          entry.getAttribute('data-trade-id') ?? '',
          entry.getBoundingClientRect(),
        ]),
      );
      setPreviewIncomingTradeId(row.id);
      setPreviewTrades((current) => [row, ...current.filter((item) => item.id !== row.id)].slice(0, 3));
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setPreviewTrades(PREVIEW_TRADE_SEEDS.slice(0, 3).reverse());
      next = 3;
    } else if (initialReviewState) {
      // Local review opens on the settled static-mock arrangement. New activity begins
      // after the same pause as the original mock instead of briefly flashing empty.
      timers.push(
        window.setTimeout(() => {
          addTrade();
          interval = window.setInterval(addTrade, 2_200);
        }, 1_900),
      );
    } else {
      setPreviewTrades([]);
      [0, 280, 560].forEach((delay) => timers.push(window.setTimeout(addTrade, delay)));
      timers.push(
        window.setTimeout(() => {
          addTrade();
          interval = window.setInterval(addTrade, 2_200);
        }, 1_900),
      );
    }
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (interval) window.clearInterval(interval);
    };
  }, [previewEnabled, previewRun]);

  // Keep the existing three rows moving when a new review trade arrives. This is the
  // same FLIP idea as the static mock, expressed with the Web Animations API so React
  // can still own the list order and keep the production rail entirely separate.
  useLayoutEffect(() => {
    const previous = previewTradePositions.current;
    const list = previewTradeListRef.current;
    if (
      !previewEnabled ||
      previous.size === 0 ||
      !list ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      previewTradePositions.current = new Map();
      return;
    }
    [...list.children].forEach((entry) => {
      const oldPosition = previous.get(entry.getAttribute('data-trade-id') ?? '');
      if (!oldPosition || entry.getAttribute('data-trade-id') === previewIncomingTradeId) return;
      const deltaY = oldPosition.top - entry.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1 || typeof entry.animate !== 'function') return;
      const animation = entry.animate(
        [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
        { duration: 680, easing: 'cubic-bezier(0.22, 0.85, 0.32, 1)', fill: 'both' },
      );
      animation.onfinish = () => animation.cancel();
    });
    previewTradePositions.current = new Map();
  }, [previewEnabled, previewIncomingTradeId, previewTrades]);

  const displayedStats = previewEnabled
    ? PREVIEW_STATS
    : {
        tokens: String(stats.total),
        graduated: String(stats.graduated),
        ethRaised: `${Number(formatEther(stats.totalEth)).toFixed(2)} Ξ`,
        trades: String(stats.totalTrades),
        chain: sourceLabel,
      };
  const bulletinLaunch = previewEnabled ? PREVIEW_LAUNCHES[1] ?? PREVIEW_LAUNCHES[0] : filtered[0];
  const bulletinTicket = bulletinLaunch
    ? PREVIEW_TICKETS.find((ticket) => ticket.address === bulletinLaunch.address)
    : undefined;

  return (
    <main className="uru-home-shell">
      <section className="uru-home-hero-frame" aria-labelledby="hero-title">
        <span className="uru-home-tape uru-home-tape-top" aria-hidden="true" />
        {HOME_PREVIEW_AVAILABLE && (
          <button
            type="button"
            className="uru-home-preview-toggle"
            aria-pressed={previewEnabled}
            onClick={() =>
              setPreviewEnabled((enabled) => {
                const next = !enabled;
                if (next) setPreviewRun((run) => run + 1);
                return next;
              })
            }
          >
            <span className="uru-home-preview-dot" aria-hidden="true" />
            mock data: {previewEnabled ? 'on' : 'off'}
          </button>
        )}
        <div className="uru-home-hero">
          <div className="uru-home-hero-copy">
            <p className="uru-home-eyebrow">✿ urufu labs launchpad</p>
            <h1 id="hero-title" className="uru-home-title">
              The culture-first token launchpad.<span aria-hidden="true"> ✦</span>
            </h1>
            <p className="uru-home-subtitle">
              Artist-first ERC-20 releases with V4 hooks for permanent liquidity, creator fees, and
              a protected opening.
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
                modules
              </Link>
            </div>
          </div>

          <HeroArt />
        </div>

        <section className="uru-home-stat-strip" aria-label="Launchpad statistics">
          <StatTile label="tokens" jp="数" value={displayedStats.tokens} />
          <StatTile label="graduated" jp="卒業" value={displayedStats.graduated} accent="mint" />
          <StatTile label="eth raised" jp="集金" value={displayedStats.ethRaised} accent="pink" />
          <StatTile label="trades" jp="取引" value={displayedStats.trades} />
          <StatTile label="chain" jp="鎖" value={displayedStats.chain} accent="mizuiro" />
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
                  role="tab"
                  aria-selected={tab === t.id}
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
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search name / ticker"
              aria-label="Search name or ticker"
            />
            {previewEnabled && <span className="uru-home-feed-preview">preview data</span>}
            <Link href="/discover" className="uru-home-feed-link">
              see all »
            </Link>
          </div>

          {filtered.length > 0 ? (
            <div className="uru-home-launch-grid">
              {filtered.slice(0, 12).map((l) => (
                <LaunchTile
                  key={l.address}
                  launch={l}
                  preview={PREVIEW_TICKETS.find((ticket) => ticket.address === l.address)}
                />
              ))}
            </div>
          ) : (
            <div className="uru-home-empty">
              <div>
                <Mascot size={52} mood="confused" />
                <p>no launches on {sourceLabel} yet ~~</p>
                <Link href="/create">launch the first one »</Link>
              </div>
            </div>
          )}
        </section>

        <aside className="uru-home-side-rail">
          <section
            className="uru-home-sidebar-card"
            aria-label={previewEnabled ? 'Preview trades' : 'Live trades'}
          >
            <div className="uru-home-sidebar-title">
              <span>
                ✦ live trades{' '}
                <span
                  className="uru-home-live-dot"
                  aria-label={previewEnabled ? 'Preview activity' : 'Live activity'}
                />
              </span>
              {previewEnabled && (
                <button
                  type="button"
                  className="uru-home-trade-replay"
                  onClick={() => setPreviewRun((run) => run + 1)}
                >
                  replay ↻
                </button>
              )}
            </div>
            {previewEnabled ? (
              previewTrades.length > 0 ? (
                <ul
                  ref={previewTradeListRef}
                  className="uru-home-trade-list uru-home-trade-list-preview"
                  aria-label="Mock live trades"
                >
                  {previewTrades.map((row) => (
                    <li
                      key={row.id}
                      data-trade-id={row.id}
                      className={row.id === previewIncomingTradeId ? 'uru-home-trade-incoming' : undefined}
                    >
                      <span>
                        {row.wallet} bought <b>{row.ticker}</b>
                      </span>
                      <span className="uru-home-trade-value">
                        {row.amount}<small>now</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="uru-home-trade-empty">waiting on the first launch ~~</p>
              )
            ) : liveTrades.length > 0 ? (
              <ul className="uru-home-trade-list">
                {liveTrades.map((row) => (
                  <li key={homeTradeKey(row)} className="uru-home-trade-incoming">
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

          <section className="uru-home-sidebar-card" aria-label="Launch fee split">
            <div className="uru-home-sidebar-title">
              <span>❀ launch fee split</span>
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

      <CultureBulletin
        launch={bulletinLaunch}
        preview={bulletinTicket}
        previewLaunches={previewEnabled ? PREVIEW_LAUNCHES : filtered.slice(0, 3)}
        collectors={
          previewEnabled
            ? previewTrades.map((trade) => trade.wallet)
            : liveTrades.slice(0, 3).map((trade) => shortWallet(trade.t.trader))
        }
      />
    </main>
  );
}

// ============================================================================
// small components
// ============================================================================

function homeTradeKey(row: HomeTrade) {
  return `${row.l.address}-${row.t.trader}-${row.t.ethAmount}-${row.t.timestamp}`;
}

function shortWallet(wallet: string) {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}··${wallet.slice(-3)}` : wallet;
}

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

function LaunchTile({ launch, preview }: { launch: MockLaunch; preview?: PreviewTicket }) {
  const progress = preview?.progress ?? mockProgressPct(launch);
  // Prefer indexer-supplied imageUrl (shared everywhere), fall back to browser local
  // for the seconds right after launch before the metadata POST completes.
  const [localImage, setLocalImage] = useState<string | undefined>();
  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);
  const logoDataUrl = launch.imageUrl ?? localImage;
  const name = launch.name;
  const ticker = launch.ticker;
  const raised = preview?.raised ?? `${Number(formatEther(launch.ethReserve)).toFixed(2)} Ξ`;
  const creator = preview?.creator ?? `${launch.creator.slice(0, 6)}··${launch.creator.slice(-3)}`;
  const tradeCount = preview?.trades ?? tradeCountOf(launch);
  const tone = preview?.tone ?? (launch.graduated ? 'mint' : 'pink');
  return (
    <Link
      href={`/trade/${launch.address}`}
      className="uru-launch-ticket"
      data-tone={tone}
      data-preview={preview ? 'true' : undefined}
    >
      <div className="uru-launch-ticket-top">
        <div
          className="uru-launch-ticket-art"
          role="img"
          aria-label={logoDataUrl ? `${name} token artwork` : undefined}
          style={{ background: safeBackgroundImage(logoDataUrl, launch.logoBg) }}
        >
          {!logoDataUrl && launch.logoEmoji}
        </div>
        <span className="uru-launch-ticket-tag">{preview ? 'mock' : launch.graduated ? 'grad' : 'curve'}</span>
      </div>
      <span className="uru-launch-ticket-name">{name}</span>
      <span className="uru-launch-ticket-symbol">${ticker}</span>
      <div className="uru-launch-ticket-meta">
        <span>
          curve<b>{launch.graduated ? '100%' : `${progress.toFixed(0)}%`}</b>
        </span>
        <span>
          raised<b>{raised}</b>
        </span>
      </div>
      <div className="uru-launch-ticket-progress" aria-label={`${progress.toFixed(0)} percent of the bonding curve`}>
        <span
          className={`uru-launch-progress-fill ${progress > 85 && !launch.graduated ? 'uru-shimmer' : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="uru-launch-ticket-foot">
        {creator} · {tradeCount} trades
      </p>
    </Link>
  );
}

function AgoLabel({ ts }: { ts: number }) {
  const label = useAgo(ts);
  return <>{label ?? '~'}</>;
}

function HeroArt() {
  return (
    <div
      className="uru-home-hero-art"
      role="img"
      aria-label="An Urufu creator tending a glowing token-launch altar"
    >
      <span className="uru-home-art-label">
        <b>❋ urufu gēmu</b> / soft + cruel
      </span>
    </div>
  );
}

function CultureBulletin({
  launch,
  preview,
  previewLaunches,
  collectors,
}: {
  launch?: MockLaunch;
  preview?: PreviewTicket;
  previewLaunches: MockLaunch[];
  collectors: string[];
}) {
  const progress = launch ? (preview?.progress ?? mockProgressPct(launch)) : 0;
  const raised = launch
    ? (preview?.raised ?? `${Number(formatEther(launch.ethReserve)).toFixed(2)} Ξ`)
    : '—';
  const trades = launch ? (preview?.trades ?? tradeCountOf(launch)) : 0;
  const creator = launch
    ? (preview?.creator ?? `${launch.creator.slice(0, 6)}··${launch.creator.slice(-3)}`)
    : 'waiting for a first token launch';

  return (
    <section className="uru-home-bulletin" aria-labelledby="bulletin-title">
      <div className="uru-home-bulletin-topline">
        <span id="bulletin-title">token launches</span>
        <span>creator token launches</span>
      </div>

      <div className="uru-home-bulletin-art">
        {launch ? (
          <Link href={`/trade/${launch.address}`} aria-label={`Open ${launch.name} token`}>
            <div
              className="uru-home-bulletin-artwork"
              role="img"
              aria-label={launch.imageUrl ? `${launch.name} token artwork` : undefined}
              style={{
                background: safeBackgroundImage(launch.imageUrl, launch.logoBg),
                backgroundSize: 'contain',
              }}
            />
          </Link>
        ) : (
          <div className="uru-home-bulletin-artwork uru-home-bulletin-artwork-empty" aria-hidden="true" />
        )}
      </div>

      <div className="uru-home-bulletin-note">
        <span className="uru-home-bulletin-kicker">token details</span>
        {launch ? (
          <>
            <h2 style={launch.name.length > 12 ? { fontSize: sizeForName(launch.name, 34), lineHeight: 1.02 } : undefined}>{launch.name}</h2>
            <p className="uru-home-bulletin-symbol">${launch.ticker}</p>
            <p className="uru-home-bulletin-byline">by {creator}</p>
            <Link href={`/trade/${launch.address}`} className="uru-home-bulletin-link">
              open token <span aria-hidden="true">→</span>
            </Link>
          </>
        ) : (
          <>
            <h2>no token launch yet</h2>
            <p className="uru-home-bulletin-byline">Launch a token to show it here.</p>
            <Link href="/create" className="uru-home-bulletin-link">
              launch a token <span aria-hidden="true">→</span>
            </Link>
          </>
        )}
      </div>

      <div className="uru-home-bulletin-signal" aria-label="Token metrics">
        <span className="uru-home-bulletin-kicker">token metrics</span>
        <dl>
          <div>
            <dt>curve</dt>
            <dd>{launch ? `${progress.toFixed(0)}%` : '—'}</dd>
          </div>
          <div>
            <dt>raised</dt>
            <dd>{raised}</dd>
          </div>
          <div>
            <dt>trades</dt>
            <dd>{launch ? String(trades) : '—'}</dd>
          </div>
        </dl>
        <div className="uru-home-bulletin-collectors">
          <span>recent traders</span>
          {collectors.slice(0, 3).map((collector) => <b key={collector}>{collector}</b>)}
          {collectors.length === 0 && <b>waiting for the first trader</b>}
        </div>
        <div className="uru-home-bulletin-hooks" aria-label="Selected launch protections">
          <span>selected hooks</span>
          <ul>
          <li>LP locked forever</li>
          <li>creator fees</li>
          <li>safe launch</li>
        </ul>
        </div>
      </div>

      <div className="uru-home-bulletin-from">
        <span className="uru-home-bulletin-kicker">more token launches</span>
        <div className="uru-home-bulletin-artists">
          {previewLaunches.slice(0, 3).map((item) => {
            const itemPreview = PREVIEW_TICKETS.find((ticket) => ticket.address === item.address);
            const itemCreator = itemPreview?.creator ?? `${item.creator.slice(0, 6)}··${item.creator.slice(-3)}`;
            return (
              <Link key={item.address} href={`/trade/${item.address}`} className="uru-home-bulletin-artist">
                <span>${item.ticker}</span>
                <b>{itemCreator}</b>
              </Link>
            );
          })}
          {previewLaunches.length === 0 && <span className="uru-home-bulletin-artist-empty">new token launches will appear here.</span>}
        </div>
      </div>

      <Link href="/create" className="uru-home-bulletin-cta">
        launch a token <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
