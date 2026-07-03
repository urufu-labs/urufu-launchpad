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
  // Wagmi hydrates async — `wallet` is undefined on SSR then may be set on the client. Any
  // conditional keyed off `isOwn` mismatches without a mount gate.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const isOwn = mounted && !!wallet && wallet.toLowerCase() === address.toLowerCase();

  // ---------- Local identity ----------
  const [profile, setProfile] = useState<UserProfile>(() => ({ address: address.toLowerCase(), savedAt: 0 }));
  useEffect(() => {
    if (!isValid) return;
    setProfile(loadProfile(address));
  }, [address, isValid]);

  // ---------- Indexer-backed data ----------
  const [launches, setLaunches] = useState<IndexerLaunch[] | null>(null);
  const [trades, setTrades] = useState<IndexerTrade[] | null>(null);
  const [holdings, setHoldings] = useState<IndexerHolding[] | null>(null);
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
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [address, isValid]);

  // ---------- Per-token positions + realized PnL (unrealized ships once spot prices land) ----------
  const positions: Position[] = useMemo(() => computePositions(trades ?? []), [trades]);
  const realizedTotal = useMemo(() => positions.reduce((sum, p) => sum + p.realizedPnl, 0n), [positions]);

  // ---------- Derived stats ----------
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

  // ---------- Follow state — subscribe to storage-level changes so the button flips
  // instantly across tabs when the same wallet follows/unfollows elsewhere.
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

  // ---------- Edit modal ----------
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
    <div className="mx-auto max-w-5xl px-4 py-4">
      {/* Header — avatar + identity + edit button */}
      <div className="uru-shell" style={{ marginBottom: 10, position: 'relative' }}>
        <span className="uru-tape" style={{ width: 82, height: 16, top: -8, left: 40, transform: 'rotate(-6deg)' }} />
        <span className="uru-tape uru-tape-mint" style={{ width: 68, height: 16, top: -6, right: 60, transform: 'rotate(3deg)' }} />

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div
            style={{
              width: 96,
              height: 96,
              flexShrink: 0,
              borderRadius: 16,
              border: '1.5px solid var(--anchor)',
              boxShadow: '3px 3px 0 var(--anchor)',
              background: profile.avatarDataUrl
                ? `#fff url(${profile.avatarDataUrl}) center/cover no-repeat`
                : 'var(--cream-deep)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-jp), monospace',
              fontSize: 34,
              color: 'var(--anchor)',
            }}
          >
            {!profile.avatarDataUrl && 'ウ'}
          </div>

          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="uru-eyebrow">profile</div>
            <h1 className="uru-h1" style={{ fontSize: 30, lineHeight: 1.15 }}>
              {name}
            </h1>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
              {address}
            </div>
            {profile.bio && (
              <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, maxWidth: 520 }}>{profile.bio}</p>
            )}
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {profile.twitter && <MiniLink href={profile.twitter} label="twitter" />}
              {profile.telegram && <MiniLink href={profile.telegram} label="tg" />}
              {profile.discord && <MiniLink href={profile.discord} label="discord" />}
              {profile.website && <MiniLink href={profile.website} label="site" />}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'flex-start' }}>
            {isOwn ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="uru-btn uru-btn-primary"
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
              >
                {isFollowingThis ? '✿ following' : '+ follow'}
              </button>
            )}
            {isOwn && (
              <Link href="/feed" className="uru-btn uru-btn-mint" style={{ justifyContent: 'center', fontSize: 12 }}>
                ✿ ur feed ({followingCount})
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <div className="uru-shell uru-shell-tight" style={{ marginBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
          <StatCell label="launches" value={stats.launched.toString()} />
          <StatCell label="trades" value={stats.tradeCount.toString()} />
          <StatCell label="buys" value={stats.buyCount.toString()} tint="mint" />
          <StatCell label="sells" value={stats.sellCount.toString()} tint="pink" />
          <StatCell
            label="net ETH flow"
            value={formatSignedEth(stats.netFlow)}
            tint={stats.netFlow > 0n ? 'mint' : stats.netFlow < 0n ? 'pink' : undefined}
          />
          <StatCell
            label="realized PnL"
            value={formatSignedEth(realizedTotal)}
            tint={realizedTotal > 0n ? 'mint' : realizedTotal < 0n ? 'pink' : undefined}
          />
        </div>
        <div style={{ marginTop: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          spent {formatEther(stats.ethSpent)} ETH · received {formatEther(stats.ethReceived)} ETH ~ realized PnL uses buy-side avg cost basis
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* MAIN — creations grid + activity */}
        <div className="space-y-3">
          <section className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ creations</div>
            {launches === null && !loaded && <LoadingRow />}
            {loaded && launches && launches.length === 0 && (
              <EmptyRow label={isOwn ? "u havent launched anything yet ~ head to /create" : "no launches yet"} />
            )}
            {launches && launches.length > 0 && (
              <div className="grid" style={{ gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
                {launches.map((l) => (
                  <Link
                    key={l.id}
                    href={l.installedBondingCurve ? `/trade/${l.tokenAddress}` : `/catalog#${l.tokenAddress}`}
                    className="uru-polaroid"
                    style={{ textDecoration: 'none', color: 'inherit', padding: '8px 8px 14px' }}
                  >
                    <div className="uru-h2" style={{ fontSize: 13, lineHeight: 1.2 }}>{l.name}</div>
                    <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                      ${l.ticker} · {BASE_LABEL[l.base] ?? '?'}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {l.installedBondingCurve && (
                        <span className="uru-stamp uru-stamp-mint" style={{ transform: 'rotate(-3deg)' }}>curve</span>
                      )}
                      {l.installedHook && (
                        <span className="uru-stamp uru-stamp-mizuiro" style={{ transform: 'rotate(2deg)' }}>hook</span>
                      )}
                    </div>
                    <div style={{ marginTop: 4, fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)' }}>
                      {formatAgo(Number(l.blockTimestamp) * 1000)} ago
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ positions ~ realized PnL by token</div>
            {trades === null && !loaded && <LoadingRow />}
            {loaded && positions.length === 0 && <EmptyRow label="no positions yet" />}
            {positions.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 6 }}>
                {positions.map((p) => (
                  <li
                    key={p.tokenAddress}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(120px, 1.5fr) repeat(3, 1fr)',
                      gap: 8,
                      alignItems: 'center',
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 11,
                      padding: '4px 6px',
                      background: p.realizedPnl > 0n
                        ? 'rgba(107, 203, 119, 0.10)'
                        : p.realizedPnl < 0n
                          ? 'rgba(232, 110, 132, 0.10)'
                          : 'transparent',
                      borderLeft: `3px solid ${p.realizedPnl > 0n ? 'var(--mint-hot,#2b8a3e)' : p.realizedPnl < 0n ? 'var(--pink-hot)' : 'var(--anchor-soft)'}`,
                    }}
                  >
                    <Link href={`/trade/${p.tokenAddress}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.tokenAddress.slice(0, 6)}…{p.tokenAddress.slice(-4)}
                    </Link>
                    <span title="buys · sells">
                      <span style={{ color: 'var(--mint-hot,#2b8a3e)' }}>{p.buyCount}b</span>{' · '}
                      <span style={{ color: 'var(--pink-hot)' }}>{p.sellCount}s</span>
                    </span>
                    <span title="net token balance from trades">
                      {p.netTokens > 0n
                        ? `${Number(formatUnits(p.netTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} held`
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
                      {formatSignedEth(p.realizedPnl)} ETH
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ activity</div>
            {trades === null && !loaded && <LoadingRow />}
            {loaded && trades && trades.length === 0 && (
              <EmptyRow label={isOwn ? "no trades yet ~ hit /trade to get started" : "no trades yet"} />
            )}
            {trades && trades.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 4 }}>
                {trades.slice(0, 30).map((t) => (
                  <li
                    key={t.id}
                    style={{ display: 'grid', gridTemplateColumns: '48px 1fr 1fr auto', gap: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 11 }}
                  >
                    <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                      {t.isBuy ? 'BUY' : 'SELL'}
                    </span>
                    <span>{Number(formatEther(BigInt(t.ethAmount))).toFixed(4)} ETH</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <Link href={`/trade/${t.tokenAddress}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
                        {t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}
                      </Link>
                    </span>
                    <span style={{ color: 'var(--anchor-soft)' }}>{formatAgo(Number(t.blockTimestamp) * 1000)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* SIDEBAR — holdings */}
        <aside className="space-y-3 lg:sticky lg:top-4 lg:h-fit">
          <section className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ holdings</div>
            {holdings === null && !loaded && <LoadingRow />}
            {loaded && holdings && holdings.filter((h) => BigInt(h.balance) > 0n).length === 0 && (
              <EmptyRow label="no urufu tokens held" />
            )}
            {holdings && holdings.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 4 }}>
                {holdings
                  .filter((h) => BigInt(h.balance) > 0n)
                  .slice(0, 20)
                  .map((h) => (
                    <li key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 11 }}>
                      <Link href={`/trade/${h.tokenAddress}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
                        {h.tokenAddress.slice(0, 6)}…{h.tokenAddress.slice(-4)}
                      </Link>
                      <span>{Number(formatUnits(BigInt(h.balance), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', textAlign: 'center', lineHeight: 1.5 }}>
            profile identity is local to ur browser for phase 1. followers + shared PnLs ship w/ the backend ~
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
// subcomponents kept in-file for locality
// ============================================================================

function StatCell({ label, value, tint }: { label: string; value: string; tint?: 'mint' | 'pink' }) {
  const color = tint === 'mint' ? 'var(--mint-hot,#2b8a3e)' : tint === 'pink' ? 'var(--pink-hot)' : 'var(--anchor)';
  return (
    <div style={{ padding: '4px 8px' }}>
      <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 18, fontWeight: 700, color, lineHeight: 1.15 }}>{value}</div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div style={{ padding: 12, textAlign: 'center', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
      loading ~~
    </div>
  );
}
function EmptyRow({ label }: { label: string }) {
  return (
    <div style={{ padding: 12, textAlign: 'center', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
      {label}
    </div>
  );
}
function MiniLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="uru-88" style={{ padding: '2px 8px', fontSize: 11, fontFamily: 'var(--font-pixel), monospace' }}>
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
