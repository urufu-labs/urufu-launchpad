'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAddress, formatEther } from 'viem';

import { mockProgressPct, launchKind, type MockLaunch } from '@/lib/mockLaunches';
import { formatCurveAmount, isPairLaunch } from '@/lib/dn404Feed';
import { useLaunchFeed } from '@/lib/useLaunchFeed';
import { useMockDataMode } from '@/lib/mockDataMode';
import { loadMetadata, safeBackgroundImage } from '@/lib/metadata';
import { useActiveChain } from '@/components/ChainSwitcher';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { sizeForName } from '@/lib/nameSize';
import { useLastTradeMap } from '@/lib/useTradeFlash';
import styles from './trade-entry.module.css';

/// Trade index: paste an address to open a market, or pick any curve token from the
/// list (active, graduated or all; sorted by most recent trade, then launch time).
export default function TradeIndex() {
  const [addr, setAddr] = useState('');
  const router = useRouter();
  const valid = isAddress(addr);
  const activeChain = useActiveChain();
  const mockData = useMockDataMode();
  const feed = useLaunchFeed(CHAIN_KEY_TO_ID[activeChain]);
  // /trade is for bonding-curve trading — filter direct-mint tokens out; they show up on
  // home + discover instead. Sort so tokens with a recent trade bubble to the top; ties
  // fall back to launch recency so new curves aren't stuck below silent old ones.
  const lastTradeMap = useLastTradeMap();
  const feedLaunches = useMemo(() => {
    return feed.launches
      .filter((l) => launchKind(l) === 'curve')
      .slice()
      .sort((a, b) => {
        const aTs = lastTradeMap.get(a.address.toLowerCase()) ?? 0;
        const bTs = lastTradeMap.get(b.address.toLowerCase()) ?? 0;
        if (aTs !== bTs) return bTs - aTs;
        return b.launchedAt - a.launchedAt;
      });
  }, [feed.launches, lastTradeMap]);
  const [filter, setFilter] = useState<'active' | 'graduated' | 'all'>('active');
  const shown = useMemo(
    () =>
      feedLaunches.filter((l) => (filter === 'all' ? true : filter === 'graduated' ? l.graduated : !l.graduated)),
    [feedLaunches, filter],
  );
  const activeCount = feedLaunches.filter((l) => !l.graduated).length;

  return (
    <div className={styles.entryPage}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Trade</p>
          <h1 className={styles.title}>Find a market</h1>
          <p className={styles.lede}>Paste a token address, or pick a coin that is trading on its bonding curve.</p>
        </div>
      </header>

      <form
        className={styles.lookup}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) router.push(`/trade/${addr}`);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className={styles.lookupIcon}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          className={styles.lookupInput}
          value={addr}
          onChange={(e) => setAddr(e.target.value.trim())}
          placeholder="Paste a token address (0x…)"
          aria-label="Token address"
          autoFocus
        />
        <button type="submit" disabled={!valid} className="ui-btn" data-variant="primary" data-size="lg">
          Open market
        </button>
      </form>

      <section className={styles.listPanel}>
        <div className={styles.listHead}>
          <div>
            <h2 className={styles.listTitle}>Bonding curves</h2>
            <p className={styles.listSub}>
              {mockData.enabled ? 'Demo data' : feed.error && feedLaunches.length === 0 ? 'Live data unavailable' : !feed.ready ? 'Loading…' : `${activeCount} active on ${activeChain}`}
            </p>
          </div>
          <div className="ui-seg" role="group" aria-label="Filter curves">
            {(['active', 'graduated', 'all'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'active' ? 'Active' : f === 'graduated' ? 'Graduated' : 'All'}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.rowHead} aria-hidden>
          <span>Token</span>
          <span>Graduation</span>
          <span className={styles.right}>Raised</span>
        </div>
        {shown.map((l) => (
          <TradeTile key={l.address} launch={l} />
        ))}
        {shown.length === 0 && feed.error && (
          <div className={styles.emptyState}>
            <div className="uru-feed-error" role="status" style={{ textAlign: 'left' }}>
              <b>Couldn&apos;t load live data</b>
              <p>Our data service didn&apos;t respond, so curves aren&apos;t showing. Nothing is lost. We&apos;ll keep retrying automatically.</p>
              <button type="button" className="ui-btn" data-variant="primary" onClick={() => window.location.reload()}>Retry now</button>
            </div>
          </div>
        )}
        {shown.length === 0 && !feed.error && !feed.ready && (
          <div className={styles.emptyState}>Loading curves…</div>
        )}
        {shown.length === 0 && !feed.error && feed.ready && (
          <div className={styles.emptyState}>
            {filter === 'graduated'
              ? 'No graduated coins on this chain yet.'
              : 'No active bonding curves on this chain yet. Paste a token address above, or launch the first coin.'}
          </div>
        )}
        <div className={styles.listFoot}>
          <Link href="/discover">Browse all launches</Link>
        </div>
      </section>

      <details className={styles.helpPanel}>
        <summary>How trading works</summary>
        <ol>
          <li>
            <b>Launch.</b> Anyone can launch a coin on the{' '}
            <Link href="/create">launch page</Link> with a name, ticker and picture.
          </li>
          <li>
            <b>Trade on the curve.</b> The coin trades right away. The price goes up as people buy and down as they sell.
          </li>
          <li>
            <b>Graduate.</b> When the curve reaches its target, the coin moves to a Uniswap v4 pool and its liquidity locks forever.
          </li>
        </ol>
      </details>
    </div>
  );
}

function TradeTile({ launch }: { launch: MockLaunch }) {
  // Prefer indexer-supplied imageUrl (shared), fall back to browser local.
  const [localImage, setLocalImage] = useState<string | undefined>();
  useEffect(() => {
    if (launch.imageUrl) return;
    const m = loadMetadata(launch.chainId, launch.address);
    if (m?.logoDataUrl) setLocalImage(m.logoDataUrl);
  }, [launch.imageUrl, launch.chainId, launch.address]);
  const logoDataUrl = launch.imageUrl ?? localImage;
  const pct = mockProgressPct(launch);
  return (
    <Link href={`/trade/${launch.address}`} className={styles.row}>
      <span className={styles.token}>
        <span className={styles.tokenImg} style={{ background: safeBackgroundImage(logoDataUrl) }}>
          {!logoDataUrl && launch.ticker.slice(0, 3)}
        </span>
        <span className={styles.tokenText}>
          <span className={styles.tokenName} style={{ fontSize: Math.min(15, sizeForName(launch.name, 15)) }}>{launch.name}</span>
          <span className={styles.tokenSym}>${launch.ticker}</span>
        </span>
      </span>
      <span className={styles.progress}>
        <span className={styles.progressTrack}>
          <span className={styles.progressFill} style={{ width: `${pct}%` }} data-graduated={launch.graduated ? 'true' : undefined} />
        </span>
        <span className={styles.progressPct}>{launch.graduated ? 'Graduated' : `${pct.toFixed(1)}%`}</span>
      </span>
      <span className={`${styles.raised} ${styles.right}`}>
        {isPairLaunch(launch)
          ? `${formatCurveAmount(launch, launch.ethReserve)} / ${formatCurveAmount(launch, launch.graduationTargetEth)}`
          : `${Number(formatEther(launch.ethReserve)).toFixed(3)} / ${Number(formatEther(launch.graduationTargetEth)).toFixed(1)} ETH`}
      </span>
    </Link>
  );
}
