'use client';

/// Public profile view for a wallet address.
///
/// Data sources:
///  - Ponder indexer: creations (launches), activity (trades), holdings.
///    All queries are defensive — if the indexer is down we render empty states.
///  - localStorage: profile identity (name/avatar/bio/socials). Phase-1 MVP so
///    identity is per-browser; anyone visiting your profile from another device
///    still gets the address + indexer stats but not your bio/avatar. Phase 2
///    will pin identity to IPFS.
///
/// If the connected wallet matches the profile address, an "edit" button opens
/// the modal below. All edits go straight to localStorage (no network).

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, formatUnits, isAddress, type Address } from 'viem';
import { useAccount } from 'wagmi';

import { Mascot } from '@/components/Mascot';
import {
  fetchLaunchesByCreator,
  fetchLaunchesByTokens,
  fetchTradesByTrader,
  fetchHoldingsByAddress,
  type IndexerLaunch,
  type IndexerTrade,
  type IndexerHolding,
} from '@/lib/indexer';
import {
  displayNameFor,
  loadProfile,
  saveProfile,
  readAvatarFile,
  type UserProfile,
} from '@/lib/profile';
import { playSfx } from '@/lib/audio/sfx';
import { getFollowing, isFollowing, onFollowsChange, toggleFollow } from '@/lib/follows';
import { computePositions, type Position } from '@/lib/pnl';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const resolved = use(params);
  const raw = resolved.address;
  const address = (isAddress(raw) ? raw : ZERO_ADDR) as Address;
  const isValid = address !== ZERO_ADDR;

  const { address: wallet } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const isOwn = mounted && !!wallet && wallet.toLowerCase() === address.toLowerCase();

  const [profile, setProfile] = useState<UserProfile>(() => ({ address: address.toLowerCase(), savedAt: 0 }));
  useEffect(() => {
    if (!isValid) return;
    setProfile(loadProfile(address));
  }, [address, isValid]);

  const [launches, setLaunches] = useState<IndexerLaunch[] | null>(null);
  const [trades, setTrades] = useState<IndexerTrade[] | null>(null);
  const [holdings, setHoldings] = useState<IndexerHolding[] | null>(null);
  const [tokenMeta, setTokenMeta] = useState<Record<string, { name: string; ticker: string }>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isValid) return;
    let cancelled = false;
    (async () => {
      const [l, t, h] = await Promise.all([
        fetchLaunchesByCreator(address, 40),
        fetchTradesByTrader(address, 200),
        fetchHoldingsByAddress(address, 50),
      ]);
      if (cancelled) return;
      setLaunches(l);
      setTrades(t);
      setHoldings(h);

      // Build friendly name/ticker map for every token this wallet touches, so the
      // activity + positions + holdings lists render "URUFU" instead of "0x74…f462".
      // Tokens the user launched themselves are already in `l`; anything else needs
      // a second fetch. Batched with a single `_in` query.
      const meta: Record<string, { name: string; ticker: string }> = {};
      const seed = (rows: IndexerLaunch[] | null | undefined) => {
        for (const r of rows ?? []) {
          meta[r.tokenAddress.toLowerCase()] = { name: r.name, ticker: r.ticker };
        }
      };
      seed(l);
      const traded = new Set((t ?? []).map((tr) => tr.tokenAddress.toLowerCase()));
      const held = new Set((h ?? []).map((hh) => hh.tokenAddress.toLowerCase()));
      const missing = [...new Set([...traded, ...held])].filter((addr) => !meta[addr]) as Address[];
      if (missing.length > 0) {
        const extra = await fetchLaunchesByTokens(missing);
        if (cancelled) return;
        seed(extra);
      }
      setTokenMeta(meta);

      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [address, isValid]);

  // Renders a friendly ticker (uppercase) for a token if the indexer has it, falling
  // back to the shortened address otherwise. Ticker fits the tight columns better than
  // name; hover shows the full name + address for disambiguation.
  function tokenLabel(addr: Address): { display: string; full: string } {
    const meta = tokenMeta[addr.toLowerCase()];
    if (meta) return { display: meta.ticker || meta.name, full: `${meta.name} (${meta.ticker}) — ${addr}` };
    return { display: `${addr.slice(0, 6)}…${addr.slice(-4)}`, full: addr };
  }

  const positions: Position[] = useMemo(() => computePositions(trades ?? []), [trades]);
  const realizedTotal = useMemo(() => positions.reduce((sum, p) => sum + p.realizedPnl, 0n), [positions]);

  const stats = useMemo(() => {
    const tradesList = trades ?? [];
    let ethSpent = 0n;
    let ethReceived = 0n;
    let buyCount = 0;
    let sellCount = 0;
    for (const tr of tradesList) {
      const eth = BigInt(tr.ethAmount);
      if (tr.isBuy) { ethSpent += eth; buyCount += 1; }
      else { ethReceived += eth; sellCount += 1; }
    }
    const netFlow = ethReceived - ethSpent;
    return {
      launched: launches?.length ?? 0,
      tradeCount: tradesList.length,
      buyCount,
      sellCount,
      ethSpent,
      ethReceived,
      netFlow,
    };
  }, [launches, trades]);

  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowingThis, setIsFollowingThis] = useState(false);
  useEffect(() => {
    const refresh = () => {
      setFollowingCount(getFollowing().length);
      setIsFollowingThis(isFollowing(address));
    };
    refresh();
    return onFollowsChange(refresh);
  }, [address]);

  const [editing, setEditing] = useState(false);

  if (!isValid) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center">
        <Mascot size={72} mood="confused" />
        <div className="uru-h1 mt-3" style={{ fontSize: 26 }}>bad address ~~</div>
        <p style={{ marginTop: 6, color: 'var(--anchor-soft)' }}>
          the url doesnt look like an ethereum address. try{' '}
          <code style={{ fontFamily: 'var(--font-pixel), monospace' }}>/profile/0x…</code>
        </p>
      </div>
    );
  }

  const name = displayNameFor(profile, address);

  return (
    <div className="mx-auto max-w-6xl px-3 sm:px-4 py-4">
      {/* ================================================================
          IDENTITY HEADER — avatar + name + address + socials + CTA
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '14px 18px',
          marginBottom: 10,
          display: 'flex',
          gap: 14,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            flexShrink: 0,
            borderRadius: 12,
            border: '1.5px solid var(--anchor)',
            boxShadow: '2px 2px 0 var(--anchor)',
            background: profile.avatarDataUrl
              ? `#fff url(${profile.avatarDataUrl}) center/cover no-repeat`
              : 'var(--cream-deep)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 28,
            color: 'var(--anchor)',
          }}
        >
          {!profile.avatarDataUrl && 'ウ'}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="uru-eyebrow">♡ profile</div>
          <h1 className="uru-h1" style={{ fontSize: 24, lineHeight: 1.1 }}>
            {name}
          </h1>
          <div
            style={{
              marginTop: 2,
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10,
              color: 'var(--anchor-soft)',
              wordBreak: 'break-all',
            }}
          >
            {address}
          </div>
          {profile.bio && (
            <p style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.45, maxWidth: 520 }}>
              {profile.bio}
            </p>
          )}
          {(profile.twitter || profile.telegram || profile.discord || profile.website) && (
            <div style={{ marginTop: 8, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {profile.twitter && <MiniLink href={profile.twitter} label="twitter" />}
              {profile.telegram && <MiniLink href={profile.telegram} label="tg" />}
              {profile.discord && <MiniLink href={profile.discord} label="discord" />}
              {profile.website && <MiniLink href={profile.website} label="site" />}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'flex-start' }}>
          {isOwn ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="uru-btn uru-btn-primary"
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              ✿ edit profile
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const nowFollowing = toggleFollow(address);
                playSfx(nowFollowing ? 'coin' : 'flip');
              }}
              className={isFollowingThis ? 'uru-btn' : 'uru-btn uru-btn-primary'}
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              {isFollowingThis ? '✿ following' : '+ follow'}
            </button>
          )}
          {isOwn && (
            <Link
              href="/feed"
              className="uru-btn uru-btn-mint"
              style={{ justifyContent: 'center', fontSize: 11, padding: '5px 10px' }}
            >
              ur feed ({followingCount})
            </Link>
          )}
        </div>
      </section>

      {/* ================================================================
          STATS STRIP — 6 tiles, data-forward
          ================================================================ */}
      <section
        className="grid gap-2 mb-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}
      >
        <StatTile label="launches" value={stats.launched.toString()} />
        <StatTile label="trades" value={stats.tradeCount.toString()} />
        <StatTile label="buys" value={stats.buyCount.toString()} accent="mint" />
        <StatTile label="sells" value={stats.sellCount.toString()} accent="pink" />
        <StatTile
          label="net eth flow"
          value={`${formatSignedEth(stats.netFlow)} Ξ`}
          accent={stats.netFlow > 0n ? 'mint' : stats.netFlow < 0n ? 'pink' : undefined}
        />
        <StatTile
          label="realized pnl"
          value={`${formatSignedEth(realizedTotal)} Ξ`}
          accent={realizedTotal > 0n ? 'mint' : realizedTotal < 0n ? 'pink' : undefined}
        />
      </section>

      <div
        style={{
          marginBottom: 12,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10,
          color: 'var(--anchor-soft)',
        }}
      >
        spent {formatEther(stats.ethSpent)} Ξ · received {formatEther(stats.ethReceived)} Ξ ~ realized pnl uses buy-side avg cost basis
      </div>

      {/* ================================================================
          MAIN + RAIL
          ================================================================ */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* MAIN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {/* creations */}
          <section>
            <SectionHead label="creations" jp="発行" count={launches?.length} />
            {launches === null && !loaded && <LoadingRow />}
            {loaded && launches && launches.length === 0 && (
              <EmptyRow label={isOwn ? "u havent launched anything yet ~ head to /create" : "no launches yet"} />
            )}
            {launches && launches.length > 0 && (
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
              >
                {launches.map((l) => (
                  <Link
                    key={l.id}
                    href={`/trade/${l.tokenAddress}`}
                    className="uru-shell-tight uru-launch-card"
                    style={{
                      textDecoration: 'none',
                      color: 'inherit',
                      padding: 8,
                    }}
                  >
                    <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.15 }}>
                      {l.name}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 10,
                        color: 'var(--anchor-soft)',
                      }}
                    >
                      ${l.ticker} · {BASE_LABEL[l.base] ?? '?'}
                    </div>
                    <div style={{ marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {l.installedBondingCurve && <MiniBadge label="curve" tint="mint" />}
                      {l.installedHook && <MiniBadge label="hook" tint="mizuiro" />}
                    </div>
                    <div
                      style={{
                        marginTop: 5,
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 9,
                        color: 'var(--anchor-soft)',
                      }}
                    >
                      {formatAgo(Number(l.blockTimestamp) * 1000)} ago
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* positions */}
          <section>
            <SectionHead label="positions" jp="持高" count={positions.length} />
            {trades === null && !loaded && <LoadingRow />}
            {loaded && positions.length === 0 && <EmptyRow label="no positions yet" />}
            {positions.length > 0 && (
              <div className="uru-shell-tight" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(120px, 1.5fr) 1fr 1fr 1fr',
                    gap: 8,
                    padding: '5px 10px',
                    background: 'var(--cream-deep)',
                    borderBottom: '1.5px solid var(--anchor)',
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    color: 'var(--anchor-soft)',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>token</span>
                  <span>trades</span>
                  <span>held</span>
                  <span style={{ textAlign: 'right' }}>realized pnl</span>
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {positions.map((p, i) => (
                    <li
                      key={p.tokenAddress}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(120px, 1.5fr) 1fr 1fr 1fr',
                        gap: 8,
                        alignItems: 'center',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 11,
                        padding: '5px 10px',
                        borderBottom: i === positions.length - 1 ? 'none' : '1px dotted var(--anchor)',
                        borderLeft: `3px solid ${p.realizedPnl > 0n ? 'var(--mint-hot,#2b8a3e)' : p.realizedPnl < 0n ? 'var(--pink-hot)' : 'transparent'}`,
                      }}
                    >
                      {(() => {
                        const lbl = tokenLabel(p.tokenAddress);
                        return (
                          <Link
                            href={`/trade/${p.tokenAddress}`}
                            title={lbl.full}
                            style={{
                              color: 'var(--link-blue)',
                              textDecoration: 'underline',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {lbl.display}
                          </Link>
                        );
                      })()}
                      <span title="buys · sells">
                        <span style={{ color: 'var(--mint-hot,#2b8a3e)' }}>{p.buyCount}b</span>
                        {' · '}
                        <span style={{ color: 'var(--pink-hot)' }}>{p.sellCount}s</span>
                      </span>
                      <span title="net token balance from trades">
                        {p.netTokens > 0n
                          ? Number(formatUnits(p.netTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : 'flat'}
                      </span>
                      <span
                        style={{
                          textAlign: 'right',
                          fontWeight: 700,
                          color: p.realizedPnl > 0n
                            ? 'var(--mint-hot,#2b8a3e)'
                            : p.realizedPnl < 0n
                              ? 'var(--pink-hot)'
                              : 'var(--anchor)',
                        }}
                      >
                        {formatSignedEth(p.realizedPnl)} Ξ
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* activity */}
          <section>
            <SectionHead label="activity" jp="取引" count={trades?.length} />
            {trades === null && !loaded && <LoadingRow />}
            {loaded && trades && trades.length === 0 && (
              <EmptyRow label={isOwn ? "no trades yet ~ hit /trade to get started" : "no trades yet"} />
            )}
            {trades && trades.length > 0 && (
              <div className="uru-shell-tight" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '42px 1fr 1fr auto',
                    gap: 8,
                    padding: '5px 10px',
                    background: 'var(--cream-deep)',
                    borderBottom: '1.5px solid var(--anchor)',
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    color: 'var(--anchor-soft)',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>side</span>
                  <span>eth</span>
                  <span>token</span>
                  <span style={{ textAlign: 'right' }}>ago</span>
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {trades.slice(0, 30).map((t, i) => (
                    <li
                      key={t.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '42px 1fr 1fr auto',
                        gap: 8,
                        alignItems: 'center',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 11,
                        padding: '5px 10px',
                        borderBottom: i === Math.min(29, trades.length - 1) ? 'none' : '1px dotted var(--anchor)',
                      }}
                    >
                      <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                        {t.isBuy ? 'BUY' : 'SELL'}
                      </span>
                      <span>{Number(formatEther(BigInt(t.ethAmount))).toFixed(4)} Ξ</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(() => {
                          const lbl = tokenLabel(t.tokenAddress);
                          return (
                            <Link
                              href={`/trade/${t.tokenAddress}`}
                              title={lbl.full}
                              style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
                            >
                              {lbl.display}
                            </Link>
                          );
                        })()}
                      </span>
                      <span style={{ color: 'var(--anchor-soft)', textAlign: 'right' }}>
                        {formatAgo(Number(t.blockTimestamp) * 1000)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        {/* RAIL — holdings */}
        <aside
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            minWidth: 0,
          }}
          className="lg:sticky lg:top-4 lg:h-fit"
        >
          <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>✿ holdings</div>
            {holdings === null && !loaded && <LoadingRow tight />}
            {loaded && holdings && holdings.filter((h) => BigInt(h.balance) > 0n).length === 0 && (
              <EmptyRow label="no urufu tokens held" tight />
            )}
            {holdings && holdings.length > 0 && (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {holdings
                  .filter((h) => BigInt(h.balance) > 0n)
                  .slice(0, 20)
                  .map((h) => (
                    <li
                      key={h.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '3px 0',
                        borderBottom: '1px dashed var(--cream-shadow)',
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 10.5,
                      }}
                    >
                      {(() => {
                        const lbl = tokenLabel(h.tokenAddress);
                        return (
                          <Link
                            href={`/trade/${h.tokenAddress}`}
                            title={lbl.full}
                            style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
                          >
                            {lbl.display}
                          </Link>
                        );
                      })()}
                      <span>
                        {Number(formatUnits(BigInt(h.balance), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <div
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10,
              color: 'var(--anchor-soft)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            profile identity is local to ur browser for phase 1. followers + shared pnl ship w/ the backend ~
          </div>
        </aside>
      </div>

      {editing && (
        <EditProfileModal
          initial={profile}
          onClose={() => setEditing(false)}
          onSave={(next) => { setProfile(next); setEditing(false); }}
        />
      )}
    </div>
  );
}

// ============================================================================
// subcomponents
// ============================================================================

function SectionHead({ label, jp, count }: { label: string; jp: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
      <span className="uru-h1" style={{ fontSize: 16, lineHeight: 1 }}>{label}</span>
      <span
        style={{
          fontFamily: 'var(--font-jp), monospace',
          fontSize: 12,
          color: 'var(--anchor-soft)',
        }}
      >
        {jp}
      </span>
      {typeof count === 'number' && (
        <span
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
            marginLeft: 2,
          }}
        >
          · {count}
        </span>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'pink' | 'mint' | 'mizuiro';
}) {
  const bg =
    accent === 'pink' ? 'var(--pink-warm)' :
    accent === 'mint' ? 'var(--mint)' :
    accent === 'mizuiro' ? 'var(--mizuiro)' :
    'var(--cream)';
  const color =
    accent === 'pink' ? 'var(--pink-hot)' :
    accent === 'mint' ? 'var(--mint-hot,#2b8a3e)' :
    'var(--anchor)';
  return (
    <div className="uru-shell-tight" style={{ background: bg, padding: '8px 12px', minWidth: 0 }}>
      <div className="uru-eyebrow">{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 17,
          fontWeight: 700,
          color,
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

function MiniBadge({ label, tint }: { label: string; tint?: 'mint' | 'mizuiro' }) {
  const bg = tint === 'mint' ? 'var(--mint)' : tint === 'mizuiro' ? 'var(--mizuiro)' : 'var(--cream-deep)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 5px',
        background: bg,
        border: '1px solid var(--anchor)',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 9,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        lineHeight: 1.2,
      }}
    >
      {label}
    </span>
  );
}

function LoadingRow({ tight }: { tight?: boolean }) {
  return (
    <div
      style={{
        padding: tight ? 8 : 14,
        textAlign: 'center',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 11,
        color: 'var(--anchor-soft)',
      }}
    >
      loading ~~
    </div>
  );
}

function EmptyRow({ label, tight }: { label: string; tight?: boolean }) {
  return (
    <div
      style={{
        padding: tight ? 8 : 14,
        textAlign: 'center',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 11,
        color: 'var(--anchor-soft)',
      }}
    >
      {label}
    </div>
  );
}

function MiniLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="uru-88"
      style={{
        padding: '2px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-pixel), monospace',
      }}
    >
      {label} →
    </a>
  );
}

function EditProfileModal({
  initial,
  onClose,
  onSave,
}: {
  initial: UserProfile;
  onClose: () => void;
  onSave: (p: UserProfile) => void;
}) {
  const [username, setUsername] = useState(initial.username ?? '');
  const [bio, setBio] = useState(initial.bio ?? '');
  const [twitter, setTwitter] = useState(initial.twitter ?? '');
  const [telegram, setTelegram] = useState(initial.telegram ?? '');
  const [discord, setDiscord] = useState(initial.discord ?? '');
  const [website, setWebsite] = useState(initial.website ?? '');
  const [avatarDataUrl, setAvatarDataUrl] = useState(initial.avatarDataUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  const pickAvatar = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    try {
      const url = await readAvatarFile(file);
      setAvatarDataUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read file');
    }
  };

  const save = () => {
    const next: UserProfile = {
      address: initial.address,
      username: username || undefined,
      bio: bio || undefined,
      twitter: twitter || undefined,
      telegram: telegram || undefined,
      discord: discord || undefined,
      website: website || undefined,
      avatarDataUrl: avatarDataUrl || undefined,
      savedAt: Date.now(),
    };
    const res = saveProfile(next);
    if (!res.ok) { setError(res.error); playSfx('error'); return; }
    playSfx('coin');
    onSave(next);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(58,44,58,0.35)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="uru-shell"
        style={{ maxWidth: 520, width: '100%', marginTop: 24, background: 'var(--cream)' }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="uru-eyebrow">✿ edit profile</div>
          <button type="button" onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 18, cursor: 'pointer' }} aria-label="close">✕</button>
        </div>

        <div className="space-y-3">
          <label style={{ display: 'block' }}>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>avatar</span>
            <div style={{ marginTop: 4, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div
                style={{
                  width: 72, height: 72, borderRadius: 12,
                  border: '1.5px solid var(--anchor)', boxShadow: '2px 2px 0 var(--anchor)',
                  background: avatarDataUrl ? `#fff url(${avatarDataUrl}) center/cover no-repeat` : 'var(--cream-deep)',
                  flexShrink: 0,
                }}
              />
              <div>
                <label className="uru-btn uru-btn-mint" style={{ cursor: 'pointer', fontSize: 12, padding: '6px 12px' }}>
                  {avatarDataUrl ? 'change' : 'upload'}
                  <input type="file" accept="image/*" onChange={(e) => pickAvatar(e.target.files?.[0])} style={{ display: 'none' }} />
                </label>
                {avatarDataUrl && (
                  <button
                    type="button"
                    onClick={() => setAvatarDataUrl('')}
                    style={{ marginLeft: 6, background: 'transparent', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, padding: '5px 10px', cursor: 'pointer' }}
                  >
                    remove
                  </button>
                )}
                <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)' }}>
                  png / jpg / svg / gif ~ max ~400KB
                </div>
              </div>
            </div>
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>username (max 24)</span>
            <input className="uru-input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} placeholder="ur name ~" style={{ marginTop: 3 }} />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>bio (max 200)</span>
            <textarea className="uru-input" rows={2} maxLength={200} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="say something ~" style={{ marginTop: 3 }} />
          </label>

          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <label>
              <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>twitter</span>
              <input className="uru-input" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/…" style={{ marginTop: 3 }} />
            </label>
            <label>
              <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>telegram</span>
              <input className="uru-input" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/…" style={{ marginTop: 3 }} />
            </label>
            <label>
              <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>discord</span>
              <input className="uru-input" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.gg/…" style={{ marginTop: 3 }} />
            </label>
            <label>
              <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>website</span>
              <input className="uru-input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" style={{ marginTop: 3 }} />
            </label>
          </div>

          {error && (
            <div style={{ padding: 8, background: 'var(--pink-warm)', border: '1px solid var(--anchor)', fontSize: 11, color: 'var(--anchor)' }}>
              ~~ {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose} className="uru-btn" data-sfx="click">cancel</button>
            <button type="button" onClick={save} className="uru-btn uru-btn-primary">✿ save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// helpers
// ============================================================================

const BASE_LABEL: Record<number, string> = { 0: 'ERC-20', 1: 'ERC-721A', 2: 'ERC-1155' };

function formatSignedEth(v: bigint): string {
  const n = Number(formatEther(v < 0n ? -v : v));
  const sign = v > 0n ? '+' : v < 0n ? '−' : '';
  return `${sign}${n.toFixed(4)}`;
}

function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
