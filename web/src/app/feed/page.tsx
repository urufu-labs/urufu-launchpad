'use client';

/// Followed-wallet activity feed. Fans out one indexer query per address you follow
/// and merges the results into a chronological stream of buys / sells / launches.
///
/// Runs entirely in the browser — no backend / server-side rendering. If the indexer
/// isn't reachable, each fan-out returns null and the merged list is empty.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, formatUnits, zeroAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { useActiveChain } from '@/components/ChainSwitcher';
import { DN404_LAUNCHES_ENABLED, DN404_PAIR_CURRENCIES, NFT_LAUNCHES_ENABLED, type ChainKey } from '@/lib/config';
import {
  fetchDn404ByPairedTokens,
  fetchLaunchesByCreator,
  fetchLaunchesByTokens,
  fetchNftCollectionsByAddresses,
  fetchNftCollectionsByLaunchers,
  fetchNftMintsByMinters,
  fetchPairTradesByTraders,
  fetchTradesByTrader,
  type IndexerLaunch,
  type IndexerNftCollection,
  type IndexerNftMint,
  type IndexerPairTrade,
  type IndexerTrade,
} from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { getFollowing, onFollowsChange } from '@/lib/follows';
import { displayNameFor, loadProfile, type UserProfile } from '@/lib/profile';
import styles from './feed.module.css';

/// `trade` and `launch` are the ERC-20 rows and render exactly as before.
/// The other three come from the NFT and DN404 lanes.
type FeedItem =
  | { kind: 'trade'; ts: number; who: string; data: IndexerTrade }
  | { kind: 'launch'; ts: number; who: string; data: IndexerLaunch }
  | { kind: 'nftLaunch'; ts: number; who: string; data: IndexerNftCollection }
  | { kind: 'nftMint'; ts: number; who: string; data: IndexerNftMint }
  | { kind: 'pairTrade'; ts: number; who: string; data: IndexerPairTrade };

type Kind = 'all' | 'launches' | 'mints' | 'buys' | 'sells';

const KINDS: Array<{ id: Kind; label: string; jp: string }> = [
  { id: 'all', label: 'all', jp: '全部' },
  { id: 'launches', label: 'launches', jp: '発行' },
  { id: 'mints', label: 'mints', jp: '鋳造' },
  { id: 'buys', label: 'buys', jp: '買い' },
  { id: 'sells', label: 'sells', jp: '売り' },
];

function isBuyItem(i: FeedItem): boolean {
  return (i.kind === 'trade' || i.kind === 'pairTrade') && i.data.isBuy;
}
function isSellItem(i: FeedItem): boolean {
  return (i.kind === 'trade' || i.kind === 'pairTrade') && !i.data.isBuy;
}

/// Compact name+ticker for a token address, resolved from the launch record.
/// Falls back to a truncated address when the indexer has no launch row for
/// that token (e.g. pre-launchpad tokens someone traded through the site).
interface TokenMeta {
  name: string;
  ticker: string;
  /// DN404 tokens only: the curve's pair currency (zero = ETH).
  pairCurrency?: string;
}

export default function FeedPage() {
  const activeChain = useActiveChain();
  const nftOn = NFT_LAUNCHES_ENABLED[activeChain] === true;
  const dn404On = DN404_LAUNCHES_ENABLED[activeChain] === true;
  const [following, setFollowing] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>('all');
  const [tokenMeta, setTokenMeta] = useState<Record<string, TokenMeta>>({});
  // Collection name, cover and payment token for mint rows, by address.
  const [collectionMeta, setCollectionMeta] = useState<Record<string, IndexerNftCollection>>({});

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
      // NFT + DN404 activity: one batched query per kind across every
      // followed wallet (3 requests total, not 3 per wallet).
      const wallets = following as Address[];
      const [nftLaunches, nftMints, pairTrades] = await Promise.all([
        nftOn || dn404On ? fetchNftCollectionsByLaunchers(wallets, 50) : Promise.resolve([]),
        nftOn ? fetchNftMintsByMinters(wallets, 100) : Promise.resolve([]),
        dn404On ? fetchPairTradesByTraders(wallets, 100) : Promise.resolve([]),
      ]);
      if (cancelled) return;

      // Feed rows are keyed to the followed address as stored (case kept).
      const whoOf = (addr: string) => following.find((f) => f.toLowerCase() === addr.toLowerCase()) ?? addr;

      const merged: FeedItem[] = [];
      for (const r of results) {
        for (const t of r.trades) {
          merged.push({ kind: 'trade', ts: Number(t.blockTimestamp), who: r.addr, data: t });
        }
        for (const l of r.launches) {
          merged.push({ kind: 'launch', ts: Number(l.blockTimestamp), who: r.addr, data: l });
        }
      }
      for (const c of nftLaunches ?? []) {
        const isDn404 = c.lane === 'dn404';
        if (isDn404 ? !dn404On : !nftOn) continue;
        merged.push({ kind: 'nftLaunch', ts: Number(c.blockTimestamp), who: whoOf(c.launchedBy), data: c });
      }
      for (const m of nftMints ?? []) {
        merged.push({ kind: 'nftMint', ts: Number(m.blockTimestamp), who: whoOf(m.minter), data: m });
      }
      for (const p of pairTrades ?? []) {
        merged.push({ kind: 'pairTrade', ts: Number(p.blockTimestamp), who: whoOf(p.trader), data: p });
      }
      merged.sort((a, b) => b.ts - a.ts);

      setProfiles(profileMap);
      const capped = merged.slice(0, 100);
      setItems(capped);
      setLoading(false);

      // Second-pass enrichment: pull launch metadata for every token address
      // referenced by a trade row so the ledger renders "into $TICKER (name)"
      // instead of the raw contract address. Runs async so it doesn't gate the
      // initial paint — rows show the address fallback until this fills in.
      const tradeTokens = new Set<string>();
      const mintedCollections = new Set<string>();
      for (const it of capped) {
        if (it.kind === 'trade' || it.kind === 'pairTrade') tradeTokens.add(it.data.tokenAddress.toLowerCase());
        if (it.kind === 'nftMint') mintedCollections.add(it.data.collectionAddress.toLowerCase());
      }
      const [launches, dn404Rows, collections] = await Promise.all([
        tradeTokens.size ? fetchLaunchesByTokens(Array.from(tradeTokens) as Address[]) : Promise.resolve([]),
        // DN404 tokens have no Router launch row; name them from the indexer's
        // DN404 collection rows (covers ETH-paired DN404 trades too).
        tradeTokens.size && dn404On ? fetchDn404ByPairedTokens(Array.from(tradeTokens) as Address[]) : Promise.resolve([]),
        mintedCollections.size ? fetchNftCollectionsByAddresses(Array.from(mintedCollections) as Address[]) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const meta: Record<string, TokenMeta> = {};
      for (const d of dn404Rows ?? []) {
        if (d.pairedToken) meta[d.pairedToken.toLowerCase()] = { name: d.name, ticker: d.ticker, pairCurrency: d.pairCurrency };
      }
      // Router launch rows win for ERC-20 tokens, same as before.
      for (const l of launches ?? []) meta[l.tokenAddress.toLowerCase()] = { name: l.name, ticker: l.ticker };
      setTokenMeta(meta);
      const cmeta: Record<string, IndexerNftCollection> = {};
      for (const c of collections ?? []) cmeta[c.collectionAddress.toLowerCase()] = c;
      setCollectionMeta(cmeta);
    })();
    return () => { cancelled = true; };
  }, [following, nftOn, dn404On]);

  const followingCount = following.length;

  const filteredItems = useMemo(() => {
    if (!items) return items;
    switch (kind) {
      case 'launches': return items.filter((i) => i.kind === 'launch' || i.kind === 'nftLaunch');
      case 'mints': return items.filter((i) => i.kind === 'nftMint');
      case 'buys': return items.filter(isBuyItem);
      case 'sells': return items.filter(isSellItem);
      case 'all':
      default: return items;
    }
  }, [items, kind]);

  // Per-kind counts for chip badges.
  const counts = useMemo(() => {
    const c = { all: 0, launches: 0, mints: 0, buys: 0, sells: 0 };
    if (!items) return c;
    for (const i of items) {
      c.all++;
      if (i.kind === 'launch' || i.kind === 'nftLaunch') c.launches++;
      else if (i.kind === 'nftMint') c.mints++;
      else if (isBuyItem(i)) c.buys++;
      else if (isSellItem(i)) c.sells++;
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
            {KINDS.filter((k) => k.id !== 'mints' || nftOn).map((k) => (
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
                ? 'nothing to show yet ~ the wallets u follow havent traded, minted or launched anything the indexer knows about'
                : `no ${kind} yet ~ try the "all" tab`
            } />
          )}

          {filteredItems && filteredItems.length > 0 && (
            <>
              <ol className={styles.ledgerList}>
                {filteredItems.map((item, i) => (
                  <li key={`${item.kind}-${i}-${item.ts}`}>
                    <FeedRow
                      item={item}
                      profile={profiles[item.who]}
                      tokenMeta={tokenMeta}
                      collectionMeta={collectionMeta}
                      chainKey={activeChain}
                    />
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

/// Label for a DN404 pair currency (zero address = ETH).
function pairLabel(chainKey: ChainKey, pair: string | undefined): string {
  if (!pair || pair.toLowerCase() === zeroAddress) return 'ETH';
  return (DN404_PAIR_CURRENCIES[chainKey] ?? []).find((o) => o.address.toLowerCase() === pair.toLowerCase())?.label
    ?? 'tokens';
}

/// Up to 4 decimals, trailing zeros dropped (URU amounts are large).
function shortAmount(raw: bigint): string {
  const n = Number(formatUnits(raw, 18));
  return n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(4).replace(/\.?0+$/, '');
}

/// Cover thumbnail. Uses the indexer's cover when it has one, else token #1's
/// image from the collection metadata (the indexer left covers empty while
/// public IPFS gateways were down), same as the collection page.
function FeedThumb({ cover, baseUri }: { cover: string | undefined; baseUri: string | undefined }) {
  const [src, setSrc] = useState<string | null>(() => toGatewayUrl(cover));
  useEffect(() => {
    const direct = toGatewayUrl(cover);
    if (direct) { setSrc(direct); return; }
    if (!baseUri) return;
    let cancelled = false;
    void fetchIpfsJson<{ image?: string }>(`${baseUri}1`).then((meta) => {
      if (!cancelled) setSrc(toGatewayUrl(meta?.image));
    });
    return () => { cancelled = true; };
  }, [cover, baseUri]);
  if (!src) return null;
  return (
    <span
      aria-hidden="true"
      className={styles.feedThumb}
      // Metadata is untrusted: encode so a quote in the URL can't break out of url("").
      style={{ backgroundImage: `url("${encodeURI(src).replace(/"/g, '%22')}")` }}
    />
  );
}

function FeedRow({
  item,
  profile,
  tokenMeta,
  collectionMeta,
  chainKey,
}: {
  item: FeedItem;
  profile: UserProfile | undefined;
  tokenMeta: Record<string, TokenMeta>;
  collectionMeta: Record<string, IndexerNftCollection>;
  chainKey: ChainKey;
}) {
  const name = displayNameFor(profile, item.who);
  const ago = formatAgo(item.ts * 1000);

  if (item.kind === 'nftLaunch') {
    const c = item.data;
    const isDn404 = c.lane === 'dn404';
    const href = isDn404 && c.pairedToken ? `/trade/${c.pairedToken}` : `/collection/${c.collectionAddress}`;
    return (
      <article className={styles.ledgerRow} data-kind="launch">
        <span className={styles.rowKind}>{isDn404 ? 'dn404' : 'nft'}</span>
        <div className={styles.rowBody}>
          <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
          <span>{isDn404 ? ' launched dn404 ' : ' launched nft collection '}</span>
          <Link href={href} className={styles.tokenLink}>
            <FeedThumb cover={c.coverImageUrl} baseUri={c.baseUri} />
            {c.name} {c.ticker && <span>${c.ticker}</span>}
          </Link>
        </div>
        <time className={styles.rowMeta}>{ago}</time>
      </article>
    );
  }

  if (item.kind === 'nftMint') {
    const m = item.data;
    const c = collectionMeta[m.collectionAddress.toLowerCase()];
    // Price is per NFT, in the collection's payment token (URU or ETH).
    const total = BigInt(m.pricePaidWei) * BigInt(m.quantity);
    const unit = c?.paymentToken && c.paymentToken.toLowerCase() !== zeroAddress ? 'URU' : 'ETH';
    const shortCol = `${m.collectionAddress.slice(0, 6)}…${m.collectionAddress.slice(-4)}`;
    return (
      <article className={styles.ledgerRow} data-kind="mint">
        <span className={styles.rowKind}>mint</span>
        <div className={styles.rowBody}>
          <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
          <span> minted {m.quantity} from </span>
          <Link href={`/collection/${m.collectionAddress}`} className={styles.tokenLink}>
            {c && <FeedThumb cover={c.coverImageUrl} baseUri={c.baseUri} />}
            {c ? c.name : shortCol}
          </Link>
          {c && total > 0n && (
            <>
              <span> for </span>
              <b className={styles.ethValue}>{shortAmount(total)} {unit}</b>
            </>
          )}
        </div>
        <time className={styles.rowMeta}>{ago}</time>
      </article>
    );
  }

  if (item.kind === 'pairTrade') {
    const p = item.data;
    const meta = tokenMeta[p.tokenAddress.toLowerCase()];
    const shortAddr = `${p.tokenAddress.slice(0, 6)}…${p.tokenAddress.slice(-4)}`;
    // Amounts are in the pair token (URU today), never ETH.
    const unit = meta?.pairCurrency ? pairLabel(chainKey, meta.pairCurrency) : 'URU';
    return (
      <article className={styles.ledgerRow} data-kind={p.isBuy ? 'buy' : 'sell'}>
        <span className={styles.rowKind}>{p.isBuy ? 'buy' : 'sell'}</span>
        <div className={styles.rowBody}>
          <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
          <span>{p.isBuy ? ' bought ' : ' sold '}</span>
          <b className={styles.ethValue}>{shortAmount(BigInt(p.pairAmount))} {unit}</b>
          <span>{p.isBuy ? ' into ' : ' from '}</span>
          <Link href={`/trade/${p.tokenAddress}`} className={styles.tokenLink}>
            {meta ? <>{meta.name} <span>${meta.ticker}</span></> : shortAddr}
          </Link>
        </div>
        <time className={styles.rowMeta}>{ago}</time>
      </article>
    );
  }

  if (item.kind === 'launch') {
    const l = item.data;
    // Row DOM matches the ledger header (event | wallet/token | age) so the
    // grid columns line up. Earlier version had age first in the DOM which
    // rendered "age | event | body" under an "event | wallet/token | age"
    // header — the two were visually swapped.
    return (
      <article className={styles.ledgerRow} data-kind="launch">
        <span className={styles.rowKind}>launch</span>
        <div className={styles.rowBody}>
          <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
          <span> launched </span>
          <Link href={`/trade/${l.tokenAddress}`} className={styles.tokenLink}>
            {l.name} <span>${l.ticker}</span>
          </Link>
        </div>
        <time className={styles.rowMeta}>{ago}</time>
      </article>
    );
  }

  const t = item.data;
  const eth = Number(formatEther(BigInt(t.ethAmount))).toFixed(4);
  // Prefer the launch's name+ticker (populated in a second-pass fetch after
  // the initial trades load). Fall back to a truncated address when the
  // indexer has no launch row for this token (pre-launchpad token, etc).
  const meta = tokenMeta[t.tokenAddress.toLowerCase()];
  const shortAddr = `${t.tokenAddress.slice(0, 6)}…${t.tokenAddress.slice(-4)}`;
  return (
    <article className={styles.ledgerRow} data-kind={t.isBuy ? 'buy' : 'sell'}>
      <span className={styles.rowKind}>{t.isBuy ? 'buy' : 'sell'}</span>
      <div className={styles.rowBody}>
        <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
        <span>{t.isBuy ? ' bought ' : ' sold '}</span>
        <b className={styles.ethValue}>{eth} ETH</b>
        <span>{t.isBuy ? ' into ' : ' from '}</span>
        <Link href={`/trade/${t.tokenAddress}`} className={styles.tokenLink}>
          {meta ? <>{meta.name} <span>${meta.ticker}</span></> : shortAddr}
        </Link>
      </div>
      <time className={styles.rowMeta}>{ago}</time>
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
