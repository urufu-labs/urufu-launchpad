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
    <div className="mx-auto max-w-6xl px-3 sm:px-4 py-4">
      {/* ============ COMPACT HEADER ============ */}
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
          <div className="uru-eyebrow" style={{ marginBottom: 2 }}>☆ feed</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1 }}>ur feed</h1>
            <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 14, color: 'var(--anchor-soft)' }}>
              近況
            </span>
            <span
              style={{
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 11,
                color: 'var(--anchor-soft)',
                marginLeft: 4,
              }}
            >
              · {followingCount} wallet{followingCount === 1 ? '' : 's'} followed
            </span>
          </div>
        </div>
        <Link href="/discover" className="uru-btn" style={{ padding: '5px 12px', fontSize: 12 }}>
          browse launches
        </Link>
      </section>

      {/* ============ MAIN + RAIL ============ */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* main feed */}
        <section style={{ minWidth: 0 }}>
          {/* filter chips */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              marginBottom: 10,
            }}
          >
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setKind(k.id)}
                className="uru-chip"
                data-active={kind === k.id}
                style={{ padding: '5px 12px' }}
              >
                {k.label}
                <span
                  style={{
                    fontFamily: 'var(--font-jp), monospace',
                    fontSize: 10,
                    marginLeft: 4,
                    opacity: 0.7,
                  }}
                >
                  {k.jp}
                </span>
                {items && (
                  <span
                    style={{
                      marginLeft: 6,
                      padding: '0 5px',
                      background: kind === k.id ? 'var(--cream)' : 'var(--cream-deep)',
                      borderRadius: 999,
                      fontSize: 9,
                    }}
                  >
                    {counts[k.id]}
                  </span>
                )}
              </button>
            ))}
          </div>

          {followingCount === 0 && (
            <div className="uru-shell" style={{ textAlign: 'center', padding: 24 }}>
              <Mascot size={56} mood="sleepy" />
              <div className="uru-h2" style={{ marginTop: 8, fontSize: 15 }}>
                u arent following anyone yet ~~
              </div>
              <p
                style={{
                  marginTop: 4,
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 11,
                  color: 'var(--anchor-soft)',
                }}
              >
                paste a wallet at <code>/profile/0x…</code> and hit + follow ✿ then come back
              </p>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <Link href="/discover" className="uru-btn">« browse launches</Link>
                <Link href="/trade" className="uru-btn uru-btn-primary">✿ find traders →</Link>
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
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 5 }}>
                {filteredItems.map((item, i) => (
                  <li key={`${item.kind}-${i}-${item.ts}`}>
                    <FeedRow item={item} profile={profiles[item.who]} />
                  </li>
                ))}
              </ul>
              <div
                style={{
                  marginTop: 12,
                  textAlign: 'center',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--anchor-soft)',
                }}
              >
                showing latest {filteredItems.length} · follow more wallets for a richer feed ✿
              </div>
            </>
          )}
        </section>

        {/* rail: followed wallets */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>♡ following</div>
            {followingCount === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>
                no wallets followed yet
              </div>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {following.map((addr) => {
                  const p = profiles[addr];
                  const n = displayNameFor(p, addr);
                  return (
                    <li key={addr}>
                      <Link
                        href={`/profile/${addr}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 4px',
                          fontFamily: 'var(--font-pixel), monospace',
                          fontSize: 10.5,
                          color: 'var(--link-blue)',
                          textDecoration: 'none',
                          borderBottom: '1px dashed var(--cream-shadow)',
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            background: 'var(--pink-hot)',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <div style={{ marginTop: 8 }}>
              <Link
                href="/discover"
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--link-blue)',
                  textDecoration: 'underline',
                }}
              >
                find more wallets »
              </Link>
            </div>
          </div>
        </aside>
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
      <div
        className="uru-shell-tight"
        style={{
          padding: '8px 12px',
          borderLeft: '4px solid var(--yolk-deep)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 12.5,
          }}
        >
          <span>
            <span
              style={{
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 9,
                color: 'var(--yolk-deep)',
                marginRight: 5,
                fontWeight: 700,
              }}
            >
              LAUNCH
            </span>
            <Link href={`/profile/${item.who}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>{name}</Link>
            {' launched '}
            <Link href={`/trade/${l.tokenAddress}`} style={{ color: 'var(--pink-hot)', fontWeight: 700, textDecoration: 'underline' }}>
              {l.name} <span style={{ color: 'var(--anchor-soft)', fontWeight: 400 }}>${l.ticker}</span>
            </Link>
            {' ✿'}
          </span>
          <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', flexShrink: 0 }}>{ago}</span>
        </div>
      </div>
    );
  }

  const t = item.data;
  const eth = Number(formatEther(BigInt(t.ethAmount))).toFixed(4);
  return (
    <div
      className="uru-shell-tight"
      style={{
        padding: '8px 12px',
        borderLeft: `4px solid ${t.isBuy ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 12.5,
        }}
      >
        <span>
          <span
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 9,
              color: t.isBuy ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)',
              marginRight: 5,
              fontWeight: 700,
            }}
          >
            {t.isBuy ? 'BUY' : 'SELL'}
          </span>
          <Link href={`/profile/${item.who}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>{name}</Link>
          {t.isBuy ? ' aped ' : ' dumped '}
          <b style={{ color: t.isBuy ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)' }}>{eth} ETH</b>
          {t.isBuy ? ' into ' : ' out of '}
          <Link href={`/trade/${t.tokenAddress}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
            {t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}
          </Link>
        </span>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', flexShrink: 0 }}>{ago}</span>
      </div>
    </div>
  );
}

function FeedFallback({ text }: { text: string }) {
  return (
    <div className="uru-shell" style={{ textAlign: 'center', padding: 20 }}>
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
