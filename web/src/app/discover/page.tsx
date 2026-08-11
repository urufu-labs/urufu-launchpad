'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { formatEther } from 'viem';

import styles from './discover.module.css';
import { useActiveChain } from '@/components/ChainSwitcher';
import {
  mockMarketCapEth,
  mockProgressPct,
  mockSpotPriceWei,
  launchKind,
  tradeCountOf,
  type MockLaunch,
} from '@/lib/mockLaunches';
import { useAgo } from '@/lib/useAgo';
import { CHAIN_LABELS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { useMockDataMode } from '@/lib/mockDataMode';
import { loadMetadata, safeBackgroundImage } from '@/lib/metadata';
import { formatMcap, formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';

type Filter = 'trending' | 'new' | 'mcap' | 'near-graduation' | 'graduated' | 'whitelist' | 'all';

const FILTERS: Array<{ id: Filter; label: string; jp: string }> = [
  { id: 'trending', label: 'trending', jp: '人気' },
  { id: 'new', label: 'new', jp: '新着' },
  { id: 'mcap', label: 'top mcap', jp: '時価' },
  { id: 'near-graduation', label: 'near grad', jp: '卒業' },
  { id: 'graduated', label: 'graduated', jp: '完了' },
  { id: 'whitelist', label: 'whitelist', jp: '会員' },
  { id: 'all', label: 'all', jp: '全部' },
];

function classNames(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

export default function DiscoverPage() {
  const activeChain = useActiveChain();
  const activeChainId = CHAIN_KEY_TO_ID[activeChain];
  const [filter, setFilter] = useState<Filter>('trending');
  const [query, setQuery] = useState('');
  const mockData = useMockDataMode();
  const feed = useLaunchFeed(activeChainId);
  const isIndexer = feed.source === 'indexer';
  const source = feed.launches;

  const filtered = useMemo(() => {
    let list = source.filter((l) => launchKind(l) === 'curve');
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
      case 'whitelist':
        list = list.filter((l) => l.hasWhitelist === true);
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case 'all':
      default:
        list.sort((a, b) => b.launchedAt - a.launchedAt);
        break;
    }
    return list;
  }, [filter, query, source]);

  const graduatedCount = source.filter((l) => l.graduated).length;
  const whitelistCount = source.filter((l) => l.hasWhitelist).length;
  const totalTrades = source.reduce((sum, launch) => sum + tradeCountOf(launch), 0);
  const activeFilter = FILTERS.find((item) => item.id === filter)!;

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.identity}>
          <p>release index · {CHAIN_LABELS[activeChain]}</p>
          <h1>Discover</h1>
        </div>
        <label className={styles.searchBox}>
          <span>search releases</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="search"
            placeholder="name, ticker, or address"
            aria-label="Search name, ticker, or token address"
          />
        </label>
        <div className={styles.headerActions}>
          <div
            className={classNames(styles.sourceBadge, isIndexer ? styles.sourceLive : styles.sourcePreview)}
            title={mockData.enabled
              ? 'Fixture launches are enabled for local review.'
              : isIndexer
                ? 'Launches are supplied by the live indexer.'
                : 'This preview chain uses local fixture launches.'}
          >
            {mockData.enabled ? (
              <><b>demo releases</b><span>{source.length} fixtures</span></>
            ) : isIndexer && feed.ready ? (
              <><b>live index</b><span>{source.length} releases</span></>
            ) : isIndexer ? (
              <><b>live index</b><span>checking</span></>
            ) : (
              <><b>preview chain</b><span>{source.length} fixtures</span></>
            )}
          </div>
          <Link href="/create" className="uru-btn uru-btn-primary">
            launch a token <span className="uru-arrow">→</span>
          </Link>
        </div>
      </header>

      <section className={styles.browser} aria-label="Token browser">
        <div className={styles.browseBar}>
          <div className={styles.resultsSummary}>
            <span>browse releases</span>
            <b>{activeFilter.label} <small>{activeFilter.jp}</small></b>
          </div>
          <div className={styles.filterRail} role="tablist" aria-label="Token filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={styles.filterButton}
                data-active={filter === f.id}
                role="tab"
                aria-selected={filter === f.id}
              >
                <span>{f.label}</span>
                <small>{f.jp}</small>
              </button>
            ))}
          </div>
          <div className={styles.marketFacts} aria-label="Market facts">
            <span>{source.length} releases</span>
            <span>{totalTrades} trades</span>
            <span>{graduatedCount} graduated</span>
            {whitelistCount > 0 && <span>{whitelistCount} whitelist</span>}
          </div>
        </div>

        <section className={styles.marketBoard} aria-label="Token results">
          <div className={styles.boardHeader}>
            <div>
              <span>{activeFilter.label} releases</span>
              <b>{filtered.length} result{filtered.length === 1 ? '' : 's'}</b>
            </div>
            <p>open a release to trade, inspect its curve, and see its pool state.</p>
          </div>
          {filtered.length > 0 ? (
            <div className={styles.mosaic}>
              {filtered.map((launch) => (
                <LaunchCard key={launch.address} launch={launch} />
              ))}
            </div>
          ) : (
            <MarketEmpty chainLabel={CHAIN_LABELS[activeChain]} query={query} sourceIsLive={isIndexer} />
          )}
        </section>
      </section>
    </main>
  );
}

function MarketEmpty({
  chainLabel,
  query,
  sourceIsLive,
}: {
  chainLabel: string;
  query: string;
  sourceIsLive: boolean;
}) {
  return (
    <div className={styles.emptyState}>
      <Image
        className={styles.emptyArt}
        src="/culture-first-altar-v2.png"
        width={420}
        height={356}
        alt="Urufu culture-first artwork"
      />
      <div>
        <h2>{query.trim() ? 'No matching tokens' : `No tokens on ${chainLabel} yet`}</h2>
        <p>
          {sourceIsLive
            ? 'The live indexer returned an empty market for this chain. No preview tokens are substituted here.'
            : 'This preview chain has no matching mock tokens for the current filter.'}
        </p>
        <Link href="/create">create a token »</Link>
      </div>
    </div>
  );
}

function LaunchCard({ launch }: { launch: MockLaunch }) {
  const progress = mockProgressPct(launch);
  const mcap = mockMarketCapEth(launch);
  const spotPriceWei = useMemo(() => mockSpotPriceWei(launch), [launch]);
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const [localImage, setLocalImage] = useState<string | undefined>();

  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);

  const image = launch.imageUrl ?? localImage;
  const raised = `${Number(formatEther(launch.ethReserve)).toFixed(2)}Ξ`;
  const target = `${Number(formatEther(launch.graduationTargetEth)).toFixed(1)}Ξ`;
  return (
    <Link
      href={`/trade/${launch.address}`}
      className={styles.releaseCard}
    >
      <div className={styles.releaseArtWrap}>
        {image ? (
          <div
            className={styles.releaseArt}
            role="img"
            aria-label={`${launch.name} token artwork`}
            style={{ background: safeBackgroundImage(image, launch.logoBg) }}
          />
        ) : (
          <div className={styles.missingArt}>
            <span>art pending</span>
          </div>
        )}
        <div className={styles.badges}>
          <span>{launch.graduated ? 'graduated' : 'curve'}</span>
          {launch.hasWhitelist && <span>whitelist</span>}
          {launch.payToken === 'URU' && <span>uru paid</span>}
        </div>
      </div>

      <div className={styles.releaseInfo}>
        <div className={styles.nameRow}>
          <h2>{launch.name}</h2>
          <span>${launch.ticker}</span>
        </div>
        {launch.description && <p>{launch.description}</p>}
      </div>

      <div className={styles.metrics}>
        <Metric label="px" value={formatPrice(spotPriceWei, unit, ethUsd)} />
        <Metric label="mcap" value={formatMcap(mcap, unit, ethUsd)} />
        <Metric label="raised" value={`${raised}/${target}`} />
        <Metric label="tx" value={String(tradeCountOf(launch))} />
      </div>

      <div className={styles.progress}>
        <div>
          <i
            className={progress > 85 && !launch.graduated ? 'uru-shimmer' : undefined}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span>{launch.graduated ? 'pooled on v4' : `${progress.toFixed(1)}% to v4`}</span>
      </div>

      <div className={styles.releaseFoot}>
        <span>
          {launch.creator.slice(0, 6)}··{launch.creator.slice(-3)} · <AgoLabel ts={launch.launchedAt} />
        </span>
        <b>trade <span className="uru-arrow">→</span></b>
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function AgoLabel({ ts }: { ts: number }) {
  const label = useAgo(ts);
  return <>{label ?? '--'}</>;
}
