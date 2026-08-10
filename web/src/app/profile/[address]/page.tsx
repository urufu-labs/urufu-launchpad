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
import { useAccount, useSignMessage } from 'wagmi';

import { Mascot } from '@/components/Mascot';
import {
  fetchLaunchesByCreator,
  fetchLaunchesByTokens,
  fetchTradesByTrader,
  fetchV4SwapsByTrader,
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
  shouldHideHoldingsFromView,
  type UserProfile,
} from '@/lib/profile';
import { fetchProfile, saveProfile as saveProfileRemote } from '@/lib/socialApi';
import { safeBackgroundImage } from '@/lib/metadata';
import { uploadImageToIpfs } from '@/lib/ipfs';
import {
  assertProfileAvatarFile,
  isProfileAvatarBlobConfigured,
  uploadProfileAvatar,
} from '@/lib/profileAvatarUpload';
import type { NftAvatarSource, WalletNftAvatar } from '@/lib/nftAvatarApi';
import { playSfx } from '@/lib/audio/sfx';
import { getFollowing, isFollowing, onFollowsChange, toggleFollow, toggleFollowRemote } from '@/lib/follows';
import { fetchFollowers, fetchFollowing } from '@/lib/socialApi';
import { FollowersModal, type FollowsMode } from '@/components/FollowersModal';
import { computePositions, type Position } from '@/lib/pnl';
import { CreatorEarnings } from '@/components/CreatorEarnings';
import { GraduatorRefund } from '@/components/GraduatorRefund';
import { EcosystemHoldings } from '@/components/EcosystemHoldings';
import { FlywheelRewards } from '@/components/FlywheelRewards';
import { TokenOwnerControls } from '@/components/TokenOwnerControls';
import { useActiveChain } from '@/components/ChainSwitcher';

import { NftAvatarPicker } from '@/components/NftAvatarPicker';
import styles from '../profile.module.css';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const resolved = use(params);
  const raw = resolved.address;
  const address = (isAddress(raw) ? raw : ZERO_ADDR) as Address;
  const isValid = address !== ZERO_ADDR;

  const { address: wallet } = useAccount();
  const { signMessageAsync: signMessageAsyncTop } = useSignMessage();
  const activeChain = useActiveChain();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Bumped after the X OAuth callback returns to this page so we re-fetch the
  // remote profile and pick up the freshly-persisted xVerified* fields.
  const [xVerifiedRefreshTick, setXVerifiedRefreshTick] = useState(0);
  const [xVerifiedToast, setXVerifiedToast] = useState<string | null>(null);

  // Post-OAuth callback landing: /api/auth/x/callback always redirects here
  // with ?xVerified=<code>. Surface a toast, refetch the profile so the
  // freshly-persisted verified fields appear, and strip the query param so
  // a refresh doesn't re-fire the toast.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const reason = url.searchParams.get('xVerified');
    if (!reason) return;
    const msg = _X_VERIFIED_TOAST[reason] ?? _X_VERIFIED_TOAST.error;
    setXVerifiedToast(msg);
    if (reason === 'ok') {
      setXVerifiedRefreshTick((n) => n + 1);
      playSfx('coin');
    } else {
      playSfx('error');
    }
    url.searchParams.delete('xVerified');
    window.history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));
    const t = setTimeout(() => setXVerifiedToast(null), 5000);
    return () => clearTimeout(t);
  }, []);
  const isOwn = mounted && !!wallet && wallet.toLowerCase() === address.toLowerCase();

  const [profile, setProfile] = useState<UserProfile>(() => ({ address: address.toLowerCase(), savedAt: 0 }));
  useEffect(() => {
    if (!isValid) return;
    // Local snapshot first (instant paint, offline-friendly), then hydrate from the
    // shared API — anyone else's profile only exists on the API since it was never
    // written to *this* browser's localStorage.
    const local = loadProfile(address);
    setProfile(local);
    (async () => {
      const remote = await fetchProfile(address);
      if (!remote) return;
      setProfile((prev) => ({
        address: prev.address,
        username: remote.username ?? prev.username,
        bio: remote.bio ?? prev.bio,
        twitter: remote.twitter ?? prev.twitter,
        telegram: remote.telegram ?? prev.telegram,
        discord: remote.discord ?? prev.discord,
        website: remote.website ?? prev.website,
        // Prefer the remote avatar URL — shared across every browser.
        // Fall back to whatever local snapshot this browser has so first-visit users
        // see something immediately while the API is in flight.
        avatarDataUrl: remote.avatarUrl ?? prev.avatarDataUrl,
        // Verified X binding — server-authoritative. If the server says null,
        // we clear whatever local cache we had (a disconnect on another device
        // must propagate here).
        xVerifiedHandle: remote.xVerifiedHandle ?? undefined,
        xVerifiedId: remote.xVerifiedId ?? undefined,
        xVerifiedAt: remote.xVerifiedAt ?? undefined,
        xAvatarUrl: remote.xAvatarUrl ?? undefined,
        // Privacy preference is server-authoritative too — if another device
        // flipped it since this browser's last save, the remote value wins.
        // Backend already normalizes NULL to false, so the shape is stable.
        hideHoldings: remote.hideHoldings === true,
        // NFT-avatar binding — nested object when the user picked one, else
        // preserve whatever prev had (avoids clobbering local state on transient
        // remote nulls).
        avatarNft: remote.avatarNftChainId && remote.avatarNftChain && remote.avatarNftContractAddress && remote.avatarNftTokenId
          ? {
              chainId: remote.avatarNftChainId,
              chain: remote.avatarNftChain,
              contractAddress: remote.avatarNftContractAddress,
              tokenId: remote.avatarNftTokenId,
              collectionName: remote.avatarNftCollectionName ?? null,
              tokenName: remote.avatarNftTokenName ?? null,
            }
          : remote.avatarUrl ? prev.avatarNft : undefined,
        savedAt: Number(new Date(remote.updatedAt).getTime()) || prev.savedAt,
      }));
    })();
  }, [address, isValid, xVerifiedRefreshTick]);

  const [launches, setLaunches] = useState<IndexerLaunch[] | null>(null);
  const [trades, setTrades] = useState<IndexerTrade[] | null>(null);
  const [v4Trades, setV4Trades] = useState<IndexerTrade[]>([]);
  const [holdings, setHoldings] = useState<IndexerHolding[] | null>(null);
  const [tokenMeta, setTokenMeta] = useState<Record<string, { name: string; ticker: string }>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isValid) return;
    let cancelled = false;
    (async () => {
      const [l, t, v4, h] = await Promise.all([
        fetchLaunchesByCreator(address, 40),
        fetchTradesByTrader(address, 200),
        fetchV4SwapsByTrader(address, 200),
        fetchHoldingsByAddress(address, 50),
      ]);
      if (cancelled) return;
      setLaunches(l);
      setTrades(t);
      setHoldings(h);

      // Normalize router-swap rows to the IndexerTrade shape so downstream code
      // (stats, activity list, PnL math) doesn't need a second branch. The router
      // event carries `isBuy` + `amountIn`/`amountOut` directly:
      //   BUY  → amountIn = ETH paid,  amountOut = tokens received
      //   SELL → amountIn = tokens in, amountOut = ETH received
      const v4Normalized: IndexerTrade[] = (v4 ?? []).map((s) => {
        const ethAmount = s.isBuy ? s.amountIn : s.amountOut;
        const tokenAmount = s.isBuy ? s.amountOut : s.amountIn;
        return {
          id: s.id,
          chainId: s.chainId,
          curveAddress: '0x0000000000000000000000000000000000000000' as Address,
          tokenAddress: s.tokenAddress,
          trader: s.user,
          isBuy: s.isBuy,
          ethAmount,
          tokenAmount,
          ethReserveAfter: '0',
          tokenReserveAfter: '0',
          priceWeiPerToken: '0',
          blockNumber: s.blockNumber,
          blockTimestamp: s.blockTimestamp,
          txHash: s.txHash,
        };
      });
      setV4Trades(v4Normalized);

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
      const v4Touched = new Set(v4Normalized.map((tr) => tr.tokenAddress.toLowerCase()));
      const held = new Set((h ?? []).map((hh) => hh.tokenAddress.toLowerCase()));
      const missing = [...new Set([...traded, ...v4Touched, ...held])].filter((addr) => !meta[addr]) as Address[];
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

  // All trades this wallet has done — curve + v4 — sorted newest first. Feeds stats,
  // activity list, and PnL math without any downstream branching on trade source.
  const allTrades = useMemo<IndexerTrade[]>(() => {
    return [...(trades ?? []), ...v4Trades].sort(
      (a, b) => Number(BigInt(b.blockTimestamp) - BigInt(a.blockTimestamp)),
    );
  }, [trades, v4Trades]);

  // Renders a friendly ticker (uppercase) for a token if the indexer has it, falling
  // back to the shortened address otherwise. Ticker fits the tight columns better than
  // name; hover shows the full name + address for disambiguation.
  function tokenLabel(addr: Address): { display: string; full: string } {
    const meta = tokenMeta[addr.toLowerCase()];
    if (meta) return { display: meta.ticker || meta.name, full: `${meta.name} (${meta.ticker}) — ${addr}` };
    return { display: `${addr.slice(0, 6)}…${addr.slice(-4)}`, full: addr };
  }

  const positions: Position[] = useMemo(() => computePositions(allTrades), [allTrades]);
  // Realized PnL keeps closed positions in the sum — someone who bought + sold
  // a token still has a realized number worth showing at the aggregate stat.
  const realizedTotal = useMemo(() => positions.reduce((sum, p) => sum + p.realizedPnl, 0n), [positions]);
  // The "positions" list itself is meant to be a snapshot of what the wallet
  // still HOLDS from trades — a fully-sold-out entry (netTokens == 0) belongs
  // in trade history, not here. Filter closed positions from the display.
  const openPositions = useMemo(() => positions.filter((p) => p.netTokens > 0n), [positions]);

  const stats = useMemo(() => {
    let ethSpent = 0n;
    let ethReceived = 0n;
    let buyCount = 0;
    let sellCount = 0;
    for (const tr of allTrades) {
      const eth = BigInt(tr.ethAmount);
      if (tr.isBuy) { ethSpent += eth; buyCount += 1; }
      else { ethReceived += eth; sellCount += 1; }
    }
    const netFlow = ethReceived - ethSpent;
    return {
      launched: launches?.length ?? 0,
      tradeCount: allTrades.length,
      buyCount,
      sellCount,
      ethSpent,
      ethReceived,
      netFlow,
    };
  }, [launches, allTrades]);

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

  // Remote counts for the profile being viewed — powers the clickable
  // "N followers · N following" pills. Local `followingCount` above is for
  // the wallet's own feed count, not the viewed profile's counts.
  //
  // `remoteRefreshTick` is bumped explicitly by the follow-button handler
  // AFTER the backend write completes, so we don't fire a refetch on the
  // instant localStorage flip (which races the signature prompt + backend
  // write and reads the OLD count).
  const [remoteFollowersCount, setRemoteFollowersCount] = useState<number | null>(null);
  const [remoteFollowingCount, setRemoteFollowingCount] = useState<number | null>(null);
  const [remoteRefreshTick, setRemoteRefreshTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [flw, fwg] = await Promise.all([
        fetchFollowers(address).catch(() => []),
        fetchFollowing(address).catch(() => []),
      ]);
      if (cancelled) return;
      setRemoteFollowersCount(flw.length);
      setRemoteFollowingCount(fwg.length);
    })();
    return () => { cancelled = true; };
  }, [address, remoteRefreshTick]);

  const [modalMode, setModalMode] = useState<FollowsMode | null>(null);

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
    <div className={styles.profileFrame}>
      {xVerifiedToast && (
        <div
          role="status"
          style={{
            marginBottom: 10,
            padding: '8px 12px',
            border: '1.5px solid var(--anchor)',
            background: xVerifiedToast.startsWith('X connected') ? 'var(--mint)' : 'var(--pink-warm)',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 12.5,
            color: 'var(--anchor)',
            boxShadow: '2px 2px 0 var(--anchor)',
          }}
        >
          {xVerifiedToast}
        </div>
      )}
      {/* ================================================================
          IDENTITY HEADER — avatar + name + address + socials + CTA
          Uses the pressKit two-pane grid: identityPlate (avatar + text)
          on the left, actionShelf on the right (edit / follow / feed).
          ================================================================ */}
      <section className={styles.pressKit}>
        <div className={styles.identityPlate}>
          {/* Avatar is a CSS background — same approach as 10x's design. We
              previously used <Image fill> here for LCP tuning, but .avatarStamp
              lacks position:relative, so fill climbed to the viewport and
              painted the PFP over the whole page. Background-image sizes
              itself to the 118px box regardless of source (data URL, IPFS,
              Vercel Blob) and never escapes the container. */}
          <div className={styles.avatarStamp} style={{ background: safeBackgroundImage(profile.avatarDataUrl) }}>
            {!profile.avatarDataUrl && <span>ウ</span>}
          </div>

          <div className={styles.identityText}>
            <div className="uru-eyebrow">creator profile</div>
            <h1 className={`uru-h1 ${styles.profileName}`}>{name}</h1>
            <div className={styles.addressLine}>{address}</div>
            {profile.bio && <p className={styles.bio}>{profile.bio}</p>}
            {(profile.xVerifiedHandle || profile.twitter || profile.telegram || profile.discord || profile.website) && (
              <div className={styles.socials}>
                {profile.xVerifiedHandle ? (
                  // Verified X — link out and show the green checkmark. Uses the
                  // exact stored handle string; the id is what actually pins the
                  // binding (see xVerifiedId) but the handle is what humans read.
                  <XVerifiedBadge handle={profile.xVerifiedHandle} />
                ) : profile.twitter ? (
                  // Legacy / unverified self-declared handle — NEVER link out
                  // (phishing vector: anyone could type "https://x.com/vitalik").
                  // Rendered gray + noninteractive with an "unverified" hint.
                  <XUnverifiedBadge value={profile.twitter} />
                ) : null}
                {profile.telegram && <MiniLink href={profile.telegram} label="tg" />}
                {profile.discord && <MiniLink href={profile.discord} label="discord" />}
                {profile.website && <MiniLink href={profile.website} label="site" />}
              </div>
            )}
            {/* Follower/following pills open the modal listing that bucket. */}
            <div className={styles.followPills}>
              <button type="button" onClick={() => setModalMode('followers')} className={styles.followPill}>
                <b className="uru-num">{remoteFollowersCount ?? '—'}</b> followers
              </button>
              <button type="button" onClick={() => setModalMode('following')} className={styles.followPill}>
                <b className="uru-num">{remoteFollowingCount ?? '—'}</b> following
              </button>
            </div>
          </div>
        </div>

        <div className={styles.pressFacts}>
          <div className={styles.actionShelf}>
            {isOwn ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="uru-btn uru-btn-primary"
              >
                edit profile
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  // Optimistic local toggle for the instant button flip, then
                  // fire the signed backend write so the followee's /followers
                  // list reflects it. If the wallet isn't connected we fall back
                  // to local-only (backend needs a signature).
                  if (wallet) {
                    const nowFollowing = await toggleFollowRemote(wallet, address, ({ message }) => signMessageAsyncTop({ message }));
                    playSfx(nowFollowing ? 'coin' : 'flip');
                    // Backend write completed — bump the tick so the counts
                    // pill refetches the new server-side state. Without this
                    // the refetch races the signature and reads stale data.
                    setRemoteRefreshTick((n) => n + 1);
                  } else {
                    const nowFollowing = toggleFollow(address);
                    playSfx(nowFollowing ? 'coin' : 'flip');
                  }
                }}
                className={isFollowingThis ? 'uru-btn' : 'uru-btn uru-btn-primary'}
              >
                {isFollowingThis ? 'following' : '+ follow'}
              </button>
            )}
            {isOwn && (
              <Link href="/feed" className="uru-btn uru-btn-mint">
                ur feed ({followingCount})
              </Link>
            )}
          </div>
          {/* Six-key facts pane — mirrors the stats strip but presented as
              a labelled dl grid, which pairs with the pressKit layout on
              wide screens (stats sit next to the identity plate). */}
          <dl className={styles.factGrid}>
            <div>
              <dt>launches</dt>
              <dd>{stats.launched.toString()}</dd>
            </div>
            <div>
              <dt>trades</dt>
              <dd>{stats.tradeCount.toString()}</dd>
            </div>
            <div>
              <dt>buys</dt>
              <dd>{stats.buyCount.toString()}</dd>
            </div>
            <div>
              <dt>sells</dt>
              <dd>{stats.sellCount.toString()}</dd>
            </div>
            <div>
              <dt>net eth</dt>
              <dd>{formatSignedEth(stats.netFlow)} Ξ</dd>
            </div>
            <div>
              <dt>realized pnl</dt>
              <dd>{formatSignedEth(realizedTotal)} Ξ</dd>
            </div>
          </dl>
        </div>
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
      <div className={styles.profileBody}>
        {/* MAIN */}
        <div className={styles.dossierPanel} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            <SectionHead label="positions" jp="持高" count={openPositions.length} />
            {trades === null && !loaded && <LoadingRow />}
            {loaded && openPositions.length === 0 && <EmptyRow label="no positions yet" />}
            {openPositions.length > 0 && (
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
                  {openPositions.map((p, i) => (
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
                        borderBottom: i === openPositions.length - 1 ? 'none' : '1px dotted var(--anchor)',
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
            <SectionHead label="activity" jp="取引" count={allTrades.length} />
            {trades === null && !loaded && <LoadingRow />}
            {loaded && allTrades.length === 0 && (
              <EmptyRow label={isOwn ? "no trades yet ~ hit /trade to get started" : "no trades yet"} />
            )}
            {allTrades.length > 0 && (
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
                  {allTrades.slice(0, 30).map((t, i) => (
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
                        borderBottom: i === Math.min(29, allTrades.length - 1) ? 'none' : '1px dotted var(--anchor)',
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

        {/* RAIL — holdings
            ============================================================
            The privacy gate lives HERE at the render layer, not inside
            the child components. Rationale:
              - EcosystemHoldings fetches its OWN balances via wagmi
                (independent of the page's holdings state), so passing an
                `isVisible` flag through would still fire the RPC read
                even when nothing renders. Gating at the render layer
                skips the mount entirely — no wasted RPC calls.
              - The launchpad holdings section reads from the page's
                `holdings` state, which is already fetched for the stats
                strip / positions math. We keep the fetch (so stats
                still work) and just swap the render.
              - CreatorEarnings / TokenOwnerControls / FlywheelRewards
                are ALREADY isSelf-gated internally — they render
                nothing when a stranger visits, so the privacy toggle
                is a no-op for them and they stay in the tree
                unchanged.
            When the toggle is on AND a stranger is viewing, we render a
            single explanatory placeholder card so the absence of data
            is obvious (never silent). */}
        <aside className={styles.sideStack}>
          {isOwn && profile.hideHoldings && <PrivateModeHint />}

          {shouldHideHoldingsFromView({ isOwn, hideHoldings: profile.hideHoldings }) ? (
            <HoldingsHiddenPlaceholder />
          ) : (
            <>
              <EcosystemHoldings visibleFor={address} chain={activeChain} />

              <section className={styles.sideCard}>
                <div className="uru-eyebrow" style={{ marginBottom: 6 }}>launchpad holdings</div>
                {holdings === null && !loaded && <LoadingRow tight />}
                {loaded && holdings && holdings.filter((h) => BigInt(h.balance) > 0n).length === 0 && (
                  <EmptyRow label="no urufu tokens held" tight />
                )}
                {holdings && holdings.length > 0 && (
                  <ul className={styles.holdingList}>
                    {holdings
                      .filter((h) => BigInt(h.balance) > 0n)
                      .slice(0, 20)
                      .map((h) => (
                        <li key={h.id} className={styles.holdingRow}>
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
            </>
          )}

          {/* isSelf-gated internally — always safe to render. */}
          <CreatorEarnings visibleFor={address} chain={activeChain} />
          <TokenOwnerControls visibleFor={address} chain={activeChain} />
          <FlywheelRewards visibleFor={address} chain={activeChain} />
          <GraduatorRefund visibleFor={address} chain={activeChain} />
        </aside>
      </div>

      {editing && (
        <EditProfileModal
          initial={profile}
          onClose={() => setEditing(false)}
          onSave={(next) => { setProfile(next); setEditing(false); }}
        />
      )}
      {modalMode && (
        <FollowersModal address={address} mode={modalMode} onClose={() => setModalMode(null)} />
      )}
    </div>
  );
}

// ============================================================================
// subcomponents
// ============================================================================

function SectionHead({ label, jp, count }: { label: string; jp: string; count?: number }) {
  return (
    <div className={styles.sectionHead}>
      <span className={`uru-h1 ${styles.sectionTitle}`}>{label}</span>
      <span className={styles.sectionJp}>{jp}</span>
      {typeof count === 'number' && (
        <span className={styles.sectionCount}>· {count}</span>
      )}
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

/// Shown at the top of the rail on the OWNER's own view when the privacy
/// toggle is on — a gentle reminder that others can't see what they see.
/// Never rendered to strangers (they get `HoldingsHiddenPlaceholder` instead).
function PrivateModeHint() {
  return (
    <div
      className="uru-shell-tight"
      style={{
        background: 'var(--mint)',
        padding: '6px 10px',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 10.5,
        color: 'var(--anchor)',
        lineHeight: 1.35,
      }}
    >
      <span aria-hidden="true">♡ </span>private mode on ~ others cannot see this section
    </div>
  );
}

/// Rendered in place of the holdings + balances rail when a viewer other than
/// the profile owner lands on a profile whose owner has flipped the privacy
/// toggle on. Deliberately explicit — silent hiding would leave visitors
/// guessing whether the wallet is empty vs. hidden.
function HoldingsHiddenPlaceholder() {
  return (
    <section
      className="uru-shell-tight"
      style={{
        background: 'var(--cream)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div className="uru-eyebrow">✿ holdings + balances hidden</div>
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-round), Klee One, cursive',
          fontSize: 12,
          lineHeight: 1.45,
          color: 'var(--anchor)',
        }}
      >
        this user chose to keep their holdings private.
      </p>
    </section>
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

function XVerifiedBadge({ handle }: { handle: string }) {
  return (
    <a
      href={`https://x.com/${encodeURIComponent(handle)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="uru-88"
      style={{
        padding: '2px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-pixel), monospace',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--mint)',
        color: 'var(--mint-hot,#2b8a3e)',
      }}
      title="verified X account"
    >
      @{handle} <span aria-hidden="true">✓</span>
      <span className="sr-only">verified</span>
    </a>
  );
}

function XUnverifiedBadge({ value }: { value: string }) {
  // Strip a leading @ or https://x.com/ prefix for display; keep the handle bit.
  const display = value.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  return (
    <span
      style={{
        padding: '2px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-pixel), monospace',
        border: '1px dashed var(--anchor-soft)',
        color: 'var(--anchor-soft)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
      title="self-declared handle, not verified"
    >
      @{display || value} (unverified)
    </span>
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

function ConnectXButton({
  wallet,
  xVerifiedHandle,
  onDisconnect,
}: {
  wallet: Address;
  xVerifiedHandle: string | undefined;
  onDisconnect: () => void;
}) {
  const { address: connected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectedMatches = !!connected && connected.toLowerCase() === wallet.toLowerCase();

  const startConnect = async () => {
    if (busy) return;
    if (!connected) { setError('connect ur wallet first'); return; }
    if (!connectedMatches) { setError('connect the wallet that owns this profile'); return; }
    setError(null);
    setBusy('connect');
    try {
      const nonce = _randomNonce();
      // 10-minute window — matches the cookie TTL enforced in /start route.
      const expires = Date.now() + 10 * 60 * 1000;
      const message = [
        'Link my X account to urufulabs.xyz',
        `wallet: ${connected.toLowerCase()}`,
        `nonce: ${nonce}`,
        `expires: ${Math.floor(expires / 1000)}`,
      ].join('\n');
      const signature = await signMessageAsync({ message });
      const res = await fetch('/api/auth/x/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: connected, signature, nonce, expires }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        throw new Error(body.code ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { url?: string };
      if (!j.url) throw new Error('no url');
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect failed');
      setBusy(null);
    }
  };

  const startDisconnect = async () => {
    if (busy) return;
    if (!connected || !connectedMatches) { setError('connect the wallet that owns this profile'); return; }
    setError(null);
    setBusy('disconnect');
    try {
      const timestamp = Date.now();
      // Canonical shape matches compile-service auth.ts (sorted empty object).
      const message = `urufu:x:disconnect:${JSON.stringify({})}:${timestamp}`;
      const signature = await signMessageAsync({ message });
      const res = await fetch('/api/auth/x/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: connected, signature, timestamp }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        throw new Error(body.code ?? `HTTP ${res.status}`);
      }
      onDisconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'disconnect failed');
    } finally {
      setBusy(null);
    }
  };

  if (!connected) {
    return (
      <div>
        <button type="button" className="uru-btn" disabled style={{ fontSize: 12, padding: '6px 12px' }}>
          connect wallet to link X
        </button>
      </div>
    );
  }

  if (xVerifiedHandle) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '4px 10px',
            background: 'var(--mint)',
            border: '1.5px solid var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 12,
            color: 'var(--mint-hot,#2b8a3e)',
          }}
        >
          @{xVerifiedHandle} ✓ verified
        </span>
        <button
          type="button"
          onClick={startDisconnect}
          disabled={busy !== null}
          className="uru-btn"
          style={{ fontSize: 11, padding: '5px 10px' }}
        >
          {busy === 'disconnect' ? 'disconnecting…' : 'disconnect'}
        </button>
        {error && (
          <span style={{ fontSize: 11, color: 'var(--pink-hot)' }}>~~ {error}</span>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={startConnect}
        disabled={busy !== null || !connectedMatches}
        className="uru-btn uru-btn-primary"
        style={{ fontSize: 12, padding: '6px 12px' }}
      >
        {busy === 'connect' ? 'opening X…' : 'connect X'}
      </button>
      {!connectedMatches && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          connect {wallet.slice(0, 6)}…{wallet.slice(-4)} to link X
        </div>
      )}
      {error && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pink-hot)' }}>~~ {error}</div>
      )}
    </div>
  );
}

function _randomNonce(): string {
  // 128 bits of entropy is plenty for a single-use nonce; base36 keeps it URL-safe
  // and printable. Uses crypto.getRandomValues so it works on the browser.
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  // `twitter` is retained ONLY for hydrating legacy self-declared handles
  // stored before the OAuth flow shipped. It is NOT edited from the modal;
  // the sole way to set a Twitter handle now is the Connect X button below,
  // which routes through /api/auth/x/start and populates xVerified* server-side.
  const twitter = initial.twitter ?? '';
  const [telegram, setTelegram] = useState(initial.telegram ?? '');
  const [discord, setDiscord] = useState(initial.discord ?? '');
  const [website, setWebsite] = useState(initial.website ?? '');
  const [avatarDataUrl, setAvatarDataUrl] = useState(initial.avatarDataUrl ?? '');
  const [hideHoldings, setHideHoldings] = useState(initial.hideHoldings === true);
  const [avatarNft, setAvatarNft] = useState<NftAvatarSource | undefined>(initial.avatarNft);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
  }, [avatarPreviewUrl]);

  const pickAvatar = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    try {
      // The browser-object preview lets Vercel Blob accept a real File rather than
      // inflating it to base64 before upload. A legacy IPFS fallback is kept below
      // until the Blob store is provisioned in the deployed Vercel project.
      assertProfileAvatarFile(file);
      setAvatarFile(file);
      setAvatarNft(undefined);
      setAvatarPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not select file');
    }
  };

  const [saving, setSaving] = useState(false);
  const { signMessageAsync } = useSignMessage();
  const save = async () => {
    let resolvedAvatar = avatarDataUrl || undefined;
    let resolvedAvatarNft = avatarNft;
    if (avatarFile) {
      try {
        if (await isProfileAvatarBlobConfigured()) {
          resolvedAvatar = await uploadProfileAvatar(avatarFile, initial.address, ({ message }) => signMessageAsync({ message }));
        } else {
          // Compatibility for local development / a deployment that has not yet
          // linked Blob. This path retains the existing small-IPFS behavior only.
          resolvedAvatar = await readAvatarFile(avatarFile);
        }
        resolvedAvatarNft = undefined;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not upload avatar');
        playSfx('error');
        return;
      }
    }
    const next: UserProfile = {
      address: initial.address,
      username: username || undefined,
      bio: bio || undefined,
      twitter: twitter || undefined,
      telegram: telegram || undefined,
      discord: discord || undefined,
      website: website || undefined,
      // Resolved avatar: either just-uploaded blob URL, freshly-picked NFT
      // avatar, or the previously-saved value.
      avatarDataUrl: resolvedAvatar,
      avatarNft: resolvedAvatarNft,
      // Preserve server-authoritative verified X binding across a profile
      // save — the modal never edits it, but must not accidentally drop it
      // from the localStorage snapshot either.
      xVerifiedHandle: initial.xVerifiedHandle,
      xVerifiedId: initial.xVerifiedId,
      xVerifiedAt: initial.xVerifiedAt,
      xAvatarUrl: initial.xAvatarUrl,
      hideHoldings: hideHoldings === true ? true : undefined,
      savedAt: Date.now(),
    };
    // Local first — always succeeds, keeps offline UX intact.
    const localRes = saveProfile(next);
    if (!localRes.ok) { setError(localRes.error); playSfx('error'); return; }
    // Shared save via API — signature-gated. If the user cancels the wallet popup we
    // treat it as "local-only mode" for this session, no error banner.
    setSaving(true);
    try {
      // Avatar: if it's still a base64 data URL (freshly picked or not yet pinned),
      // upload it through the compile-service pin proxy. If it's already an http URL
      // (loaded from a previous save), pass through. Empty → null.
      let avatarUrl: string | null = null;
      const av = next.avatarDataUrl;
      if (av) {
        if (av.startsWith('data:')) {
          const pin = await uploadImageToIpfs(av);
          if (pin) {
            avatarUrl = pin.gatewayUrl;
            // Persist the URL locally too so future paints skip the reupload cycle.
            next.avatarDataUrl = pin.gatewayUrl;
            saveProfile(next);
          }
        } else {
          avatarUrl = av;
        }
      }
      const remote = await saveProfileRemote(
        initial.address as Address,
        {
          username: next.username ?? null,
          bio: next.bio ?? null,
          twitter: next.twitter ?? null,
          telegram: next.telegram ?? null,
          discord: next.discord ?? null,
          website: next.website ?? null,
          avatarUrl,
          // Always send the boolean so a toggle-off explicitly writes false to
          // the server instead of leaving the previous true in place. The
          // signed-message canonicalization sorts keys, so adding this field
          // does not change the shape older clients relied on.
          hideHoldings: hideHoldings === true,
          avatarNft: next.avatarNft ?? null,
        },
        ({ message }) => signMessageAsync({ message }),
      );
      if (!remote.ok) {
        // Only surface a warning if the server rejected — user cancel throws before we
        // get here and is handled by the catch below silently.
        setError(`local saved; shared save failed (${remote.error})`);
      }
    } catch {
      // Signature cancelled or network error — profile stays local for this session.
    } finally {
      setSaving(false);
    }
    playSfx('coin');
    onSave(next);
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`uru-shell ${styles.editModal}`}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <div className="uru-eyebrow">edit profile</div>
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
                  background: safeBackgroundImage(avatarPreviewUrl ?? avatarDataUrl),
                  flexShrink: 0,
                }}
              />
              <div>
                <label className="uru-btn uru-btn-mint" style={{ cursor: 'pointer', fontSize: 12, padding: '6px 12px' }}>
                  {avatarPreviewUrl || avatarDataUrl ? 'change' : 'upload'}
                  <input type="file" accept="image/*" onChange={(e) => pickAvatar(e.target.files?.[0])} style={{ display: 'none' }} />
                </label>
                {(avatarPreviewUrl || avatarDataUrl) && (
                  <button
                    type="button"
                    onClick={() => {
                      setAvatarDataUrl('');
                      setAvatarNft(undefined);
                      setAvatarFile(null);
                      setAvatarPreviewUrl(null);
                    }}
                    style={{ marginLeft: 6, background: 'transparent', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, padding: '5px 10px', cursor: 'pointer' }}
                  >
                    remove
                  </button>
                )}
                <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)' }}>
                  png / jpg / webp / gif / avif · up to 10MB with Vercel Blob
                </div>
              </div>
            </div>
          </label>

          <NftAvatarPicker
            address={initial.address}
            selected={avatarNft}
            onSelect={(nft: WalletNftAvatar) => {
              setAvatarDataUrl(nft.imageUrl);
              setAvatarNft({
                chainId: nft.chainId,
                chain: nft.chain,
                contractAddress: nft.contractAddress,
                tokenId: nft.tokenId,
                collectionName: nft.collectionName,
                tokenName: nft.tokenName,
              });
              setAvatarFile(null);
              setAvatarPreviewUrl(null);
              setError(null);
            }}
          />

          <label style={{ display: 'block' }}>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>username (max 24)</span>
            <input className="uru-input" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} placeholder="ur name ~" style={{ marginTop: 3 }} />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>bio (max 200)</span>
            <textarea className="uru-input" rows={2} maxLength={200} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="say something ~" style={{ marginTop: 3 }} />
          </label>

          <div>
            <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>X (twitter)</span>
            <div style={{ marginTop: 3 }}>
              <ConnectXButton
                wallet={initial.address as Address}
                xVerifiedHandle={initial.xVerifiedHandle}
                onDisconnect={() => onClose()}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
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

          {/* Privacy toggle — hides the holdings + balances rail from viewers
              other than the profile owner. Note copy is deliberately honest
              about the limits of this shield: the indexer is public, so an
              on-chain lookup by address still returns the same balances.
              Keep this above the error banner + action buttons so it never
              gets pushed off a short screen. */}
          <div
            style={{
              borderTop: '1px dashed var(--anchor-soft)',
              paddingTop: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div className="uru-eyebrow">✿ privacy</div>
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontFamily: 'var(--font-round), Klee One, cursive',
                fontSize: 12.5,
                lineHeight: 1.4,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={hideHoldings}
                onChange={(e) => setHideHoldings(e.target.checked)}
                style={{
                  marginTop: 3,
                  width: 14,
                  height: 14,
                  accentColor: 'var(--pink-hot)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              />
              <span>hide my holdings + balances from public profile</span>
            </label>
            <div
              style={{
                marginLeft: 22,
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 10,
                color: 'var(--anchor-soft)',
                lineHeight: 1.5,
              }}
            >
              ~ note: on-chain data is still public, this only hides
              from your profile page here.
            </div>
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

/// Human-readable toast copy per xVerified reason code emitted by the callback
/// route. Keys align with the return values from web/src/app/api/auth/x/callback/route.ts.
const _X_VERIFIED_TOAST: Record<string, string> = {
  ok: 'X connected! ur handle is verified now ✿',
  denied: 'X sign-in cancelled ~ no changes made',
  expired: 'that link expired, hit connect X again',
  walletMismatch: 'wallet changed mid-flow, please retry with the same wallet',
  xUserMismatch: 'that X account is already linked to a different wallet',
  badRequest: 'something went sideways ~ pls try again',
  error: 'X sign-in failed ~ try again in a moment',
};

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
