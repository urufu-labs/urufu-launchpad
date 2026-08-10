'use client';

/// Public profile view for a wallet address.
///
/// Data sources:
///  - Ponder indexer: creations (launches), activity (trades), holdings.
///    All queries are defensive — if the indexer is down we render empty states.
///  - localStorage: instant local profile snapshot (name/avatar/bio/socials).
///  - social API: shared, signature-gated profile fields. Avatars are either a
///    Vercel Blob URL or an NFT's existing media URL; no NFT asset bytes are copied.
///
/// If the connected wallet matches the profile address, an "edit" button opens
/// the modal below. Local state updates first, then a signature-gated API save
/// shares the profile with other browsers.

import { use, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { EcosystemHoldings } from '@/components/EcosystemHoldings';
import { FlywheelRewards } from '@/components/FlywheelRewards';
import { TokenOwnerControls } from '@/components/TokenOwnerControls';
import { useActiveChain } from '@/components/ChainSwitcher';
import { NftAvatarPicker } from '@/components/NftAvatarPicker';
import styles from '../profile.module.css';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
type ProfileSection = 'releases' | 'holdings' | 'activity';

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
  }, [address, isValid]);

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
  const [profileSection, setProfileSection] = useState<ProfileSection>('releases');

  if (!isValid) {
    return (
      <div className={styles.badAddress}>
        <Mascot size={72} mood="confused" />
        <div className="uru-h1 mt-3" style={{ fontSize: 30 }}>bad address</div>
        <p style={{ marginTop: 6, color: 'var(--anchor-soft)' }}>
          the url does not look like an ethereum address. try{' '}
          <code style={{ fontFamily: 'var(--font-pixel), monospace' }}>/profile/0x…</code>
        </p>
      </div>
    );
  }

  const name = displayNameFor(profile, address);
  const positiveHoldings = (holdings ?? []).filter((h) => BigInt(h.balance) > 0n);

  return (
    <div className={styles.profileFrame}>
      <section className={styles.pressKit}>
        <div className={styles.identityPlate}>
          <div className={styles.avatarStamp} style={{ background: safeBackgroundImage(profile.avatarDataUrl) }}>
            {!profile.avatarDataUrl && <span>{name.slice(0, 1).toUpperCase()}</span>}
          </div>
          <div className={styles.identityText}>
            <div className="uru-eyebrow">creator profile</div>
            <h1 className={`uru-h1 ${styles.profileName}`}>{name}</h1>
            <div className={styles.addressLine}>{address}</div>
            {profile.avatarNft && (
              <div style={{ marginTop: 5, color: 'var(--anchor-soft)', fontFamily: 'var(--font-pixel), monospace', fontSize: 9 }}>
                NFT PFP · {profile.avatarNft.tokenName ?? profile.avatarNft.collectionName ?? `#${profile.avatarNft.tokenId}`} · {profile.avatarNft.chain}
              </div>
            )}
            {profile.bio && <p className={styles.bio}>{profile.bio}</p>}
            {(profile.twitter || profile.telegram || profile.discord || profile.website) && (
              <div className={styles.socials}>
                {profile.twitter && <MiniLink href={profile.twitter} label="twitter" />}
                {profile.telegram && <MiniLink href={profile.telegram} label="tg" />}
                {profile.discord && <MiniLink href={profile.discord} label="discord" />}
                {profile.website && <MiniLink href={profile.website} label="site" />}
              </div>
            )}
          </div>
        </div>

        <aside className={styles.pressFacts}>
          <div className={styles.actionShelf}>
            {isOwn ? (
              <button type="button" onClick={() => setEditing(true)} className="uru-btn uru-btn-primary">
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
                {isFollowingThis ? 'following' : 'follow'}
              </button>
            )}
            {isOwn && <Link href="/feed" className="uru-btn uru-btn-mint">feed ({followingCount})</Link>}
          </div>

          <div className={styles.followPills}>
            <button type="button" onClick={() => setModalMode('followers')} className={styles.followPill}>
              <b className="uru-num">{remoteFollowersCount ?? '—'}</b> followers
            </button>
            <button type="button" onClick={() => setModalMode('following')} className={styles.followPill}>
              <b className="uru-num">{remoteFollowingCount ?? '—'}</b> following
            </button>
          </div>

          <dl className={styles.factGrid}>
            <div><dt>launched</dt><dd>{stats.launched}</dd></div>
            <div><dt>held</dt><dd>{positiveHoldings.length}</dd></div>
            <div><dt>trades</dt><dd>{stats.tradeCount}</dd></div>
            <div><dt>net flow</dt><dd>{formatSignedEth(stats.netFlow)} Ξ</dd></div>
          </dl>
        </aside>
      </section>

      <section className={styles.collectionBoard}>
        <div className={styles.boardHead}>
          <SectionHead label="launched tokens" jp="作品" count={launches?.length} />
          <span className={styles.financeNote}>
            spent {formatEther(stats.ethSpent)} Ξ · received {formatEther(stats.ethReceived)} Ξ · realized pnl {formatSignedEth(realizedTotal)} Ξ
          </span>
        </div>
        {launches === null && !loaded && <LoadingRow />}
        {loaded && launches && launches.length === 0 && (
          <div className={styles.emptySpecimen}>
            {isOwn ? "u havent launched anything yet ~ head to /create" : 'no launches yet'}
          </div>
        )}
        {launches && launches.length > 0 && (
          <div className={styles.specimenRow}>
            {launches.slice(0, 6).map((l) => <ReleaseSpecimen key={l.id} launch={l} />)}
          </div>
        )}
      </section>

      <nav className={styles.profileTabs} aria-label="profile sections">
        {([
          ['releases', 'launched', launches?.length ?? 0],
          ['holdings', 'holdings', positiveHoldings.length + openPositions.length],
          ['activity', 'activity', allTrades.length],
        ] as const).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            className={styles.profileTab}
            data-active={profileSection === id}
            onClick={() => setProfileSection(id)}
          >
            <span>{label}</span>
            <b>{count}</b>
          </button>
        ))}
      </nav>

      <div className={styles.profileBody}>
        <main className={styles.dossierPanel}>
          {profileSection === 'releases' && (
            <section className={styles.sectionBlock}>
              <SectionHead label="launched tokens" jp="発行" count={launches?.length} />
              {launches === null && !loaded && <LoadingRow />}
              {loaded && launches && launches.length === 0 && (
                <EmptyRow label={isOwn ? "u havent launched anything yet ~ head to /create" : 'no launches yet'} />
              )}
              {launches && launches.length > 0 && (
                <div className={styles.releaseGrid}>
                  {launches.map((l) => <ReleaseSpecimen key={l.id} launch={l} compact />)}
                </div>
              )}
            </section>
          )}

          {profileSection === 'holdings' && (
            <section className={styles.sectionBlock}>
              <SectionHead label="holdings" jp="持高" count={positiveHoldings.length + openPositions.length} />
              {holdings === null && !loaded && <LoadingRow />}
              {loaded && positiveHoldings.length === 0 && openPositions.length === 0 && <EmptyRow label="no positions yet" />}
              {openPositions.length > 0 && (
                <ProfileTable
                  headerClass={styles.positionHeader}
                  headers={['token', 'trades', 'held', 'realized pnl']}
                >
                  {openPositions.map((p) => {
                    const lbl = tokenLabel(p.tokenAddress);
                    return (
                      <li
                        key={p.tokenAddress}
                        className={`${styles.tableRow} ${styles.positionRow}`}
                        style={{
                          borderLeft: `3px solid ${p.realizedPnl > 0n ? 'var(--mint-hot,#2b8a3e)' : p.realizedPnl < 0n ? 'var(--pink-hot)' : 'transparent'}`,
                        }}
                      >
                        <Link href={`/trade/${p.tokenAddress}`} title={lbl.full} className={styles.truncate}>
                          {lbl.display}
                        </Link>
                        <span title="buys · sells"><b>{p.buyCount}b</b> · <b>{p.sellCount}s</b></span>
                        <span title="net token balance from trades">
                          {p.netTokens > 0n
                            ? Number(formatUnits(p.netTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                            : 'flat'}
                        </span>
                        <span style={{ textAlign: 'right', fontWeight: 700 }}>
                          {formatSignedEth(p.realizedPnl)} Ξ
                        </span>
                      </li>
                    );
                  })}
                </ProfileTable>
              )}
            </section>
          )}

          {profileSection === 'activity' && (
            <section className={styles.sectionBlock}>
              <SectionHead label="activity" jp="取引" count={allTrades.length} />
              {trades === null && !loaded && <LoadingRow />}
              {loaded && allTrades.length === 0 && (
                <EmptyRow label={isOwn ? "no trades yet ~ hit /trade to get started" : 'no trades yet'} />
              )}
              {allTrades.length > 0 && (
                <ProfileTable
                  headerClass={styles.activityHeader}
                  headers={['side', 'eth', 'token', 'ago']}
                >
                  {allTrades.slice(0, 30).map((t) => {
                    const lbl = tokenLabel(t.tokenAddress);
                    return (
                      <li key={t.id} className={`${styles.tableRow} ${styles.activityRow}`}>
                        <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                          {t.isBuy ? 'BUY' : 'SELL'}
                        </span>
                        <span>{Number(formatEther(BigInt(t.ethAmount))).toFixed(4)} Ξ</span>
                        <span className={styles.truncate}>
                          <Link href={`/trade/${t.tokenAddress}`} title={lbl.full}>{lbl.display}</Link>
                        </span>
                        <span style={{ color: 'var(--anchor-soft)', textAlign: 'right' }}>
                          {formatAgo(Number(t.blockTimestamp) * 1000)}
                        </span>
                      </li>
                    );
                  })}
                </ProfileTable>
              )}
            </section>
          )}
        </main>

        <aside className={styles.sideStack}>
          <EcosystemHoldings visibleFor={address} chain={activeChain} />

          <section className={styles.sideCard}>
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>launchpad holdings</div>
            {holdings === null && !loaded && <LoadingRow tight />}
            {loaded && positiveHoldings.length === 0 && (
              <EmptyRow label="no urufu tokens held" tight />
            )}
            {positiveHoldings.length > 0 && (
              <ul className={styles.holdingList}>
                {positiveHoldings.slice(0, 20).map((h) => (
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

          <CreatorEarnings visibleFor={address} chain={activeChain} />
          <TokenOwnerControls visibleFor={address} chain={activeChain} />
          <FlywheelRewards visibleFor={address} chain={activeChain} />
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

function ReleaseSpecimen({ launch, compact }: { launch: IndexerLaunch; compact?: boolean }) {
  const ticker = (launch.ticker || launch.name || 'URU').slice(0, 5).toUpperCase();
  return (
    <Link
      href={`/trade/${launch.tokenAddress}`}
      className={`${styles.specimenCard} ${compact ? styles.compactSpecimen : ''}`}
    >
      <div className={styles.specimenArt} aria-hidden>
        <span>{ticker}</span>
      </div>
      <div className={styles.specimenCopy}>
        <div className={`uru-h2 ${styles.releaseTitle}`}>{launch.name}</div>
        <div className={styles.tokenMeta}>${launch.ticker}</div>
        <div className={styles.badgeRow}>
          {launch.installedBondingCurve && <MiniBadge label="curve" tint="mint" />}
          {launch.installedHook && <MiniBadge label="hook" tint="mizuiro" />}
        </div>
        <div className={styles.timeMeta}>{formatAgo(Number(launch.blockTimestamp) * 1000)} ago</div>
      </div>
    </Link>
  );
}

function ProfileTable({
  headerClass,
  headers,
  children,
}: {
  headerClass: string;
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className={styles.tableShell}>
      <div className={`${styles.tableHeader} ${headerClass}`}>
        {headers.map((h, i) => (
          <span key={h} style={i === headers.length - 1 ? { textAlign: 'right' } : undefined}>
            {h}
          </span>
        ))}
      </div>
      <ul className={styles.tableList}>{children}</ul>
    </div>
  );
}

function SectionHead({ label, jp, count }: { label: string; jp: string; count?: number }) {
  return (
    <div className={styles.sectionHead}>
      <span className={`uru-h1 ${styles.sectionTitle}`}>{label}</span>
      <span className={styles.sectionJp}>{jp}</span>
      {typeof count === 'number' && (
        <span className={styles.sectionCount}>
          · {count}
        </span>
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
      className={`uru-88 ${styles.miniLink}`}
    >
      {label}
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
      avatarDataUrl: resolvedAvatar,
      avatarNft: resolvedAvatarNft,
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
    <div
      className={styles.modalBackdrop}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`uru-shell ${styles.editModal}`}
      >
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
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose} className="uru-btn" data-sfx="click">cancel</button>
            <button type="button" onClick={save} className="uru-btn uru-btn-primary" disabled={saving}>
              {saving ? 'saving' : 'save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// helpers
// ============================================================================

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
