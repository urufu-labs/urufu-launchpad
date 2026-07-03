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

type FeedItem =
  | { kind: 'trade'; ts: number; who: string; data: IndexerTrade }
  | { kind: 'launch'; ts: number; who: string; data: IndexerLaunch };

export default function FeedPage() {
  const [following, setFollowing] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  // Track the current follow list — refreshes on toggleFollow anywhere in the app.
  useEffect(() => {
    const refresh = () => setFollowing(getFollowing());
    refresh();
    return onFollowsChange(refresh);
  }, []);

  // Fan out to indexer + merge whenever the follow list changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (following.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }
    (async () => {
      // Load local profiles synchronously so names/avatars show on the merged rows.
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <header style={{ marginBottom: 12 }}>
        <div className="uru-eyebrow">feed</div>
        <h1 className="uru-h1" style={{ fontSize: 30 }}>
          ur feed{' '}
          <span style={{ fontFamily: 'var(--font-jp), monospace', color: 'var(--anchor-soft)', fontSize: 20, marginLeft: 6 }}>
            近況
          </span>
        </h1>
        <p style={{ marginTop: 4, fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13, color: 'var(--anchor-soft)' }}>
          activity from the {followingCount} wallet{followingCount === 1 ? '' : 's'} u follow ~ chronological, newest first
        </p>
      </header>

      {followingCount === 0 && (
        <div className="uru-shell uru-shell-tight" style={{ textAlign: 'center', padding: 24 }}>
          <Mascot size={64} mood="sleepy" />
          <div className="uru-h2" style={{ marginTop: 8, fontSize: 16 }}>u arent following anyone yet ~~</div>
          <p style={{ marginTop: 4, fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
            paste a wallet in <code>/profile/0x…</code> and hit + follow ✿ then come back here
          </p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <Link href="/discover" className="uru-btn">« browse launches</Link>
            <Link href="/trade" className="uru-btn uru-btn-primary">✿ find traders →</Link>
          </div>
        </div>
      )}

      {followingCount > 0 && loading && (
        <FeedFallback text="loading feed ~~" />
      )}

      {followingCount > 0 && !loading && items && items.length === 0 && (
        <FeedFallback text="nothing to show yet ~ the wallets u follow havent traded or launched anything the indexer knows about" />
      )}

      {items && items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 6 }}>
          {items.map((item, i) => (
            <li key={`${item.kind}-${i}-${item.ts}`}>
              <FeedRow item={item} profile={profiles[item.who]} />
            </li>
          ))}
        </ul>
      )}

      {items && items.length > 0 && (
        <div style={{ marginTop: 16, textAlign: 'center', fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          showing latest {items.length} events ~ follow more wallets to get a richer feed ✿
        </div>
      )}
    </div>
  );
}

function FeedRow({ item, profile }: { item: FeedItem; profile: UserProfile | undefined }) {
  const name = displayNameFor(profile, item.who);
  const ago = formatAgo(item.ts * 1000);

  if (item.kind === 'launch') {
    const l = item.data;
    return (
      <div className="uru-shell uru-shell-tight" style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
          <span>
            <Link href={`/profile/${item.who}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>{name}</Link>
            {' launched '}
            <Link href={`/trade/${l.tokenAddress}`} style={{ color: 'var(--pink-hot)', fontWeight: 700, textDecoration: 'underline' }}>
              {l.name} <span style={{ color: 'var(--anchor-soft)', fontWeight: 400 }}>${l.ticker}</span>
            </Link>
            {' ✿'}
          </span>
          <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>{ago}</span>
        </div>
      </div>
    );
  }

  const t = item.data;
  const eth = Number(formatEther(BigInt(t.ethAmount))).toFixed(4);
  return (
    <div
      className="uru-shell uru-shell-tight"
      style={{
        padding: '10px 12px',
        borderLeft: `4px solid ${t.isBuy ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
        <span>
          <Link href={`/profile/${item.who}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>{name}</Link>
          {t.isBuy ? ' aped ' : ' dumped '}
          <b style={{ color: t.isBuy ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)' }}>{eth} ETH</b>
          {t.isBuy ? ' into ' : ' out of '}
          <Link href={`/trade/${t.tokenAddress}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
            {t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}
          </Link>
        </span>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>{ago}</span>
      </div>
    </div>
  );
}

function FeedFallback({ text }: { text: string }) {
  return (
    <div className="uru-shell uru-shell-tight" style={{ textAlign: 'center', padding: 20 }}>
      <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 12, color: 'var(--anchor-soft)' }}>{text}</div>
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
