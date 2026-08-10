'use client';

/// Followed-wallet activity feed. Fans out one indexer query per address you follow
/// and merges the results into a chronological stream of buys / sells / launches.
///
/// Runs entirely in the browser — no backend / server-side rendering. If the indexer
/// isn't reachable, each fan-out returns null and the merged list is empty.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import {
  fetchLaunchesByCreator,
  fetchTradesByTrader,
  type IndexerLaunch,
  type IndexerTrade,
} from '@/lib/indexer';
import { getFollowing, onFollowsChange } from '@/lib/follows';
import { displayNameFor, loadProfile, type UserProfile } from '@/lib/profile';
import styles from './feed.module.css';

type FeedItem =
  | { kind: 'trade'; ts: number; who: string; data: IndexerTrade }
  | { kind: 'launch'; ts: number; who: string; data: IndexerLaunch };

type Kind = 'all' | 'launches' | 'buys' | 'sells';

const KINDS: Array<{ id: Kind; label: string; jp: string }> = [
  { id: 'all', label: 'all', jp: '全部' },
  { id: 'launches', label: 'launches', jp: '発行' },
  { id: 'buys', label: 'buys', jp: '買い' },
  { id: 'sells', label: 'sells', jp: '売り' },
];

export default function FeedPage() {
  const [following, setFollowing] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>('all');

  useEffect(() => {
    const refresh = () => setFollowing(getFollowing());
    refresh();
    return onFollowsChange(refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (following.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }
    (async () => {
      const profileMap: Record<string, UserProfile> = {};
      for (const addr of following) profileMap[addr] = loadProfile(addr);

      const results = await Promise.all(
        following.map(async (addr) => {
          const [trades, launches] = await Promise.all([
            fetchTradesByTrader(addr as Address, 30),
            fetchLaunchesByCreator(addr as Address, 15),
          ]);
          return { addr, trades: trades ?? [], launches: launches ?? [] };
        }),
      );
      if (cancelled) return;

      const merged: FeedItem[] = [];
      for (const r of results) {
        for (const t of r.trades) {
          merged.push({ kind: 'trade', ts: Number(t.blockTimestamp), who: r.addr, data: t });
        }
        for (const l of r.launches) {
          merged.push({ kind: 'launch', ts: Number(l.blockTimestamp), who: r.addr, data: l });
        }
      }
      merged.sort((a, b) => b.ts - a.ts);

      setProfiles(profileMap);
      setItems(merged.slice(0, 100));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [following]);

  const followingCount = following.length;

  const filteredItems = useMemo(() => {
    if (!items) return items;
    switch (kind) {
      case 'launches': return items.filter((i) => i.kind === 'launch');
      case 'buys': return items.filter((i) => i.kind === 'trade' && i.data.isBuy);
      case 'sells': return items.filter((i) => i.kind === 'trade' && !i.data.isBuy);
      case 'all':
      default: return items;
    }
  }, [items, kind]);

  // Per-kind counts for chip badges.
  const counts = useMemo(() => {
    const c = { all: 0, launches: 0, buys: 0, sells: 0 };
    if (!items) return c;
    for (const i of items) {
      c.all++;
      if (i.kind === 'launch') c.launches++;
      else if (i.data.isBuy) c.buys++;
      else c.sells++;
    }
    return c;
  }, [items]);

  return (
    <div className={styles.feedFrame}>
      <section className={styles.ledgerMasthead}>
        <div>
          <div className="uru-eyebrow">wallet activity</div>
          <h1 className={`uru-h1 ${styles.feedTitle}`}>feed</h1>
        </div>
        <span className={styles.headerMeta}>
          {followingCount} wallet{followingCount === 1 ? '' : 's'} followed locally
        </span>
        <Link href="/discover" className="uru-btn">
          browse tokens
        </Link>
      </section>

      <div className={styles.ledgerLayout}>
        <aside className={styles.filterRail}>
          <div className={styles.filterGroup} aria-label="activity filters">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setKind(k.id)}
                className="uru-chip"
                data-active={kind === k.id}
              >
                <span>{k.label}</span>
                <small>
                  {k.jp}
                </small>
                {items && <b>{counts[k.id]}</b>}
              </button>
            ))}
          </div>

          <div className={styles.followRail}>
            <div className={styles.railHeader}>
              <div className="uru-eyebrow">following</div>
              <span className={styles.railHint}>{followingCount}</span>
            </div>
            {followingCount === 0 ? (
              <div className={styles.railHint}>no wallets followed yet</div>
            ) : (
              <ul className={styles.followedList}>
                {following.map((addr) => {
                  const p = profiles[addr];
                  const n = displayNameFor(p, addr);
                  return (
                    <li key={addr}>
                      <Link href={`/profile/${addr}`} className={styles.followedLink}>
                        <span aria-hidden className={styles.followedDot} />
                        <span className={styles.truncate}>{n}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <Link href="/discover" className={styles.findLink}>find more wallets</Link>
          </div>
        </aside>

        <section className={styles.ledgerPaper}>
          <div className={styles.ledgerHead}>
            <span>event</span>
            <span>wallet / token</span>
            <span>age</span>
          </div>

          {followingCount === 0 && (
            <div className={styles.emptyLedger}>
              <Mascot size={48} mood="sleepy" />
              <div className={`uru-h2 ${styles.emptyTitle}`}>no followed wallets yet</div>
              <p className={styles.emptyCopy}>
                paste a wallet at <code>/profile/0x…</code> and follow it. This feed is built from the addresses saved in this browser.
              </p>
              <div className={styles.emptyActions}>
                <Link href="/discover" className="uru-btn">browse tokens</Link>
                <Link href="/trade" className="uru-btn uru-btn-primary">find traders</Link>
              </div>
            </div>
          )}

          {followingCount > 0 && loading && <FeedFallback text="loading feed ~~" />}

          {followingCount > 0 && !loading && filteredItems && filteredItems.length === 0 && (
            <FeedFallback text={
              kind === 'all'
                ? 'nothing to show yet ~ the wallets u follow havent traded or launched anything the indexer knows about'
                : `no ${kind} yet ~ try the "all" tab`
            } />
          )}

          {filteredItems && filteredItems.length > 0 && (
            <>
              <ol className={styles.ledgerList}>
                {filteredItems.map((item, i) => (
                  <li key={`${item.kind}-${i}-${item.ts}`}>
                    <FeedRow item={item} profile={profiles[item.who]} />
                  </li>
                ))}
              </ol>
              <div className={styles.feedLimit}>
                showing latest {filteredItems.length} · follow more wallets to broaden this local feed
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function FeedRow({ item, profile }: { item: FeedItem; profile: UserProfile | undefined }) {
  const name = displayNameFor(profile, item.who);
  const ago = formatAgo(item.ts * 1000);

  if (item.kind === 'launch') {
    const l = item.data;
    return (
      <article className={styles.ledgerRow} data-kind="launch">
        <time className={styles.rowMeta}>{ago}</time>
        <span className={styles.rowKind}>launch</span>
        <div className={styles.rowBody}>
          <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
          <span> launched </span>
          <Link href={`/trade/${l.tokenAddress}`} className={styles.tokenLink}>
            {l.name} <span>${l.ticker}</span>
          </Link>
        </div>
      </article>
    );
  }

  const t = item.data;
  const eth = Number(formatEther(BigInt(t.ethAmount))).toFixed(4);
  return (
    <article className={styles.ledgerRow} data-kind={t.isBuy ? 'buy' : 'sell'}>
      <time className={styles.rowMeta}>{ago}</time>
      <span className={styles.rowKind}>{t.isBuy ? 'buy' : 'sell'}</span>
      <div className={styles.rowBody}>
        <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
        <span>{t.isBuy ? ' bought ' : ' sold '}</span>
        <b className={styles.ethValue}>{eth} ETH</b>
        <span>{t.isBuy ? ' into ' : ' from '}</span>
        <Link href={`/trade/${t.tokenAddress}`} className={styles.rowLink}>
          {t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}
        </Link>
      </div>
    </article>
  );
}

function FeedFallback({ text }: { text: string }) {
  return (
    <div className={styles.fallbackShell}>
      <div className={styles.fallbackText}>{text}</div>
    </div>
  );
}

function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
