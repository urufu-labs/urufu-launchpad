'use client';

/// Followed-wallet activity feed. Fans out one indexer query per address you follow
/// and merges the results into a chronological stream of buys / sells / launches.
///
/// Runs entirely in the browser — no backend / server-side rendering. If the indexer
/// isn't reachable, each fan-out returns null and the merged list is empty.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { formatEther, formatUnits, zeroAddress, type Address } from 'viem';

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
  fetchRecentLaunches,
  fetchRecentNftCollections,
  fetchRecentNftMints,
  fetchRecentPairTrades,
  fetchRecentTrades,
  fetchTradesByTrader,
  type IndexerLaunch,
  type IndexerNftCollection,
  type IndexerNftMint,
  type IndexerPairTrade,
  type IndexerTrade,
} from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { getFollowing, onFollowsChange } from '@/lib/follows';
import { fetchFollowing } from '@/lib/socialApi';
import { withCreatorDetails } from '@/lib/collectionDetails';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { displayNameFor, loadProfile, type UserProfile } from '@/lib/profile';
import { AgentTag, useAgentTags, type AgentInfo } from '@/components/AgentBadge';
import styles from './feed.module.css';

/// NFT + DN404 lanes are Robinhood-only; launchers' saved images live there.
const ROBINHOOD_ID = CHAIN_KEY_TO_ID.robinhood;

/// `trade` and `launch` are the ERC-20 rows and render exactly as before.
/// The other three come from the NFT and DN404 lanes.
type FeedItem =
  | { kind: 'trade'; ts: number; who: string; data: IndexerTrade }
  | { kind: 'launch'; ts: number; who: string; data: IndexerLaunch }
  | { kind: 'nftLaunch'; ts: number; who: string; data: IndexerNftCollection }
  | { kind: 'nftMint'; ts: number; who: string; data: IndexerNftMint }
  | { kind: 'pairTrade'; ts: number; who: string; data: IndexerPairTrade };

type Scope = 'everyone' | 'following';

type Kind = 'all' | 'launches' | 'mints' | 'buys' | 'sells';

const KINDS: Array<{ id: Kind; label: string; jp: string }> = [
  { id: 'all', label: 'All', jp: '' },
  { id: 'launches', label: 'Launches', jp: '' },
  { id: 'mints', label: 'Mints', jp: '' },
  { id: 'buys', label: 'Buys', jp: '' },
  { id: 'sells', label: 'Sells', jp: '' },
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
  const { address: wallet } = useAccount();
  const [localFollowing, setLocalFollowing] = useState<string[]>([]);
  // Follows saved on the server for the connected wallet. The profile page
  // reads these, so the feed has to as well: localStorage alone is empty on
  // a new browser or device even when the wallet follows people.
  const [remoteFollowing, setRemoteFollowing] = useState<string[]>([]);
  const followKey = Array.from(new Set([...localFollowing, ...remoteFollowing])).sort().join(',');
  const following = useMemo(() => (followKey ? followKey.split(',') : []), [followKey]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>('all');
  const [tokenMeta, setTokenMeta] = useState<Record<string, TokenMeta>>({});
  // Collection name, cover and payment token for mint rows, by address.
  const [collectionMeta, setCollectionMeta] = useState<Record<string, IndexerNftCollection>>({});

  useEffect(() => {
    const refresh = () => setLocalFollowing(getFollowing());
    refresh();
    return onFollowsChange(refresh);
  }, []);

  useEffect(() => {
    if (!wallet) { setRemoteFollowing([]); return; }
    let cancelled = false;
    void fetchFollowing(wallet)
      .then((rows) => { if (!cancelled) setRemoteFollowing(rows.map((r) => r.address.toLowerCase())); })
      .catch(() => { /* server unreachable: local list still works */ });
    return () => { cancelled = true; };
  }, [wallet]);

  // "everyone" reads the newest activity across the whole launchpad, so the
  // feed has something in it before you follow anyone. Follows live in this
  // browser's storage, so a fresh browser starts on "everyone".
  const [scopeChoice, setScopeChoice] = useState<Scope | null>(null);
  const scope: Scope = scopeChoice ?? (following.length > 0 ? 'following' : 'everyone');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (scope === 'everyone') {
      (async () => {
        const [trades, launches, nftLaunches, pairTrades, nftMints] = await Promise.all([
          fetchRecentTrades(60),
          fetchRecentLaunches(20),
          nftOn || dn404On ? fetchRecentNftCollections(20).then((r) => withCreatorDetails(r ?? [], ROBINHOOD_ID)) : Promise.resolve([]),
          dn404On ? fetchRecentPairTrades(40) : Promise.resolve([]),
          // Mints used to load only in "Following", so everyone else's mints
          // never reached this view (Visions of Lambro, 2026-10-25).
          nftOn ? fetchRecentNftMints(40) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const merged: FeedItem[] = [];
        for (const t of trades ?? []) merged.push({ kind: 'trade', ts: Number(t.blockTimestamp), who: t.trader, data: t });
        for (const l of launches ?? []) merged.push({ kind: 'launch', ts: Number(l.blockTimestamp), who: l.launchedBy, data: l });
        for (const c of nftLaunches ?? []) {
          const isDn404 = c.lane === 'dn404';
          if (isDn404 ? !dn404On : !nftOn) continue;
          merged.push({ kind: 'nftLaunch', ts: Number(c.blockTimestamp), who: c.launchedBy, data: c });
        }
        for (const p of pairTrades ?? []) merged.push({ kind: 'pairTrade', ts: Number(p.blockTimestamp), who: p.trader, data: p });
        for (const m of nftMints ?? []) merged.push({ kind: 'nftMint', ts: Number(m.blockTimestamp), who: m.minter, data: m });
        merged.sort((a, b) => b.ts - a.ts);
        const capped = merged.slice(0, 100);
        const profileMap: Record<string, UserProfile> = {};
        for (const it of capped) if (!profileMap[it.who]) profileMap[it.who] = loadProfile(it.who);
        setProfiles(profileMap);
        setItems(capped);
        setLoading(false);

        const tradeTokens = new Set<string>();
        const mintedCollections = new Set<string>();
        for (const it of capped) {
          if (it.kind === 'trade' || it.kind === 'pairTrade') tradeTokens.add(it.data.tokenAddress.toLowerCase());
          if (it.kind === 'nftMint') mintedCollections.add(it.data.collectionAddress.toLowerCase());
        }
        const [tokLaunches, dn404Rows, mintCollections] = await Promise.all([
          tradeTokens.size ? fetchLaunchesByTokens(Array.from(tradeTokens) as Address[]) : Promise.resolve([]),
          tradeTokens.size && dn404On ? fetchDn404ByPairedTokens(Array.from(tradeTokens) as Address[]) : Promise.resolve([]),
          // Mint rows show the collection's name + art from this map.
          mintedCollections.size
            ? fetchNftCollectionsByAddresses(Array.from(mintedCollections) as Address[]).then((r) => withCreatorDetails(r ?? [], ROBINHOOD_ID))
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const meta: Record<string, TokenMeta> = {};
        for (const d of dn404Rows ?? []) {
          if (d.pairedToken) meta[d.pairedToken.toLowerCase()] = { name: d.name, ticker: d.ticker, pairCurrency: d.pairCurrency };
        }
        for (const l of tokLaunches ?? []) meta[l.tokenAddress.toLowerCase()] = { name: l.name, ticker: l.ticker };
        setTokenMeta(meta);
        const cmeta: Record<string, IndexerNftCollection> = {};
        for (const c of mintCollections ?? []) cmeta[c.collectionAddress.toLowerCase()] = c;
        setCollectionMeta(cmeta);
      })();
      return () => { cancelled = true; };
    }
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
        nftOn || dn404On ? fetchNftCollectionsByLaunchers(wallets, 50).then((r) => withCreatorDetails(r ?? [], ROBINHOOD_ID)) : Promise.resolve([]),
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
        mintedCollections.size
          ? fetchNftCollectionsByAddresses(Array.from(mintedCollections) as Address[]).then((r) => withCreatorDetails(r ?? [], ROBINHOOD_ID))
          : Promise.resolve([]),
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
  }, [following, nftOn, dn404On, scope]);

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
  const feedAgents = useAgentTags((filteredItems ?? []).map((i) => i.who));

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

  const showEmptyFollowing = scope === 'following' && followingCount === 0;

  return (
    <div className={styles.feedFrame}>
      <header className={styles.ledgerMasthead}>
        <div>
          <p className={styles.eyebrow}>Feed</p>
          <h1 className={styles.feedTitle}>What people are doing</h1>
          <p className={styles.lede}>
            Launches, buys and sells as they land. Follow a wallet from its profile to build your own feed.
          </p>
        </div>
        <div className="ui-seg" data-size="lg" role="group" aria-label="Feed scope">
          {(['everyone', 'following'] as const).map((sc) => (
            <button
              key={sc}
              type="button"
              aria-pressed={scope === sc}
              onClick={() => setScopeChoice(sc)}
            >
              {sc === 'everyone' ? 'Everyone' : `Following${followingCount ? ` ${followingCount}` : ''}`}
            </button>
          ))}
        </div>
      </header>

      <div className={styles.ledgerLayout}>
        <aside className={styles.filterRail}>
          <div>
            <p className={styles.railLabel}>Show</p>
            <div className={styles.filterGroup} aria-label="activity filters">
              {KINDS.filter((k) => k.id !== 'mints' || nftOn).map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setKind(k.id)}
                  className={styles.filterBtn}
                  data-active={kind === k.id}
                >
                  <span>{k.label}</span>
                  {items && <b>{counts[k.id]}</b>}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.followRail}>
            <div className={styles.railHeader}>
              <p className={styles.railLabel}>Following</p>
              <span className={styles.railHint}>{followingCount}</span>
            </div>
            {followingCount === 0 ? (
              <p className={styles.railHint}>
                You aren&apos;t following anyone in this browser yet.
              </p>
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
            <Link href="/discover" className={styles.findLink}>Find people to follow</Link>
          </div>
        </aside>

        <section className={styles.ledgerPaper}>
          <div className={styles.paperHead}>
            <div>
              <h2 className={styles.paperTitle}>{scope === 'everyone' ? 'Latest across urufu labs' : 'From wallets you follow'}</h2>
              {filteredItems && filteredItems.length > 0 && (
                <p className={styles.paperSub}>Showing the latest {filteredItems.length}</p>
              )}
            </div>
          </div>

          {showEmptyFollowing && (
            <div className={styles.emptyLedger}>
              <h3 className={styles.emptyTitle}>You aren&apos;t following anyone yet</h3>
              <p className={styles.emptyCopy}>
                Open someone&apos;s profile and hit follow. Follows are saved in this browser, so they
                won&apos;t carry over to another device or site.
              </p>
              <div className={styles.emptyActions}>
                <button type="button" className="ui-btn" onClick={() => setScopeChoice('everyone')}>
                  See everyone
                </button>
                <Link href="/discover" className="ui-btn" data-variant="primary">Browse tokens</Link>
              </div>
            </div>
          )}

          {!showEmptyFollowing && loading && <FeedFallback text="Loading activity…" />}

          {!showEmptyFollowing && !loading && filteredItems && filteredItems.length === 0 && (
            <FeedFallback text={
              kind === 'all'
                ? scope === 'everyone'
                  ? 'Nothing has happened yet.'
                  : 'The wallets you follow haven\'t launched, minted or traded anything yet.'
                : `No ${kind} yet. Try "All".`
            } />
          )}

          {!showEmptyFollowing && filteredItems && filteredItems.length > 0 && (
            <ol className={styles.ledgerList}>
              {filteredItems.map((item, i) => (
                <li key={`${item.kind}-${i}-${item.ts}`}>
                  <FeedRow
                    item={item}
                    profile={profiles[item.who]}
                    tokenMeta={tokenMeta}
                    collectionMeta={collectionMeta}
                    chainKey={activeChain}
                    agent={feedAgents.get(item.who.toLowerCase())}
                  />
                </li>
              ))}
            </ol>
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
  agent,
}: {
  item: FeedItem;
  profile: UserProfile | undefined;
  tokenMeta: Record<string, TokenMeta>;
  collectionMeta: Record<string, IndexerNftCollection>;
  chainKey: ChainKey;
  agent: AgentInfo | undefined;
}) {
  const name = displayNameFor(profile, item.who);
  const ago = formatAgo(item.ts * 1000);
  // Agents link to their agent page and carry the Agent tag.
  const who = agent ? (
    <>
      <Link href={`/agent/${item.who}`} className={styles.rowLink}>{name}</Link>{' '}
      <AgentTag address={item.who} info={agent} />
    </>
  ) : (
    <Link href={`/profile/${item.who}`} className={styles.rowLink}>{name}</Link>
  );

  if (item.kind === 'nftLaunch') {
    const c = item.data;
    const isDn404 = c.lane === 'dn404';
    const href = isDn404 && c.pairedToken ? `/trade/${c.pairedToken}` : `/collection/${c.collectionAddress}`;
    return (
      <article className={styles.ledgerRow} data-kind="launch">
        <span className={styles.rowKind}>{isDn404 ? 'DN404' : 'NFT'}</span>
        <div className={styles.rowBody}>
          {who}
          <span>{isDn404 ? ' launched DN404 ' : ' launched the collection '}</span>
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
        <span className={styles.rowKind}>Mint</span>
        <div className={styles.rowBody}>
          {who}
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
        <span className={styles.rowKind}>{p.isBuy ? 'Buy' : 'Sell'}</span>
        <div className={styles.rowBody}>
          {who}
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
        <span className={styles.rowKind}>Launch</span>
        <div className={styles.rowBody}>
          {who}
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
      <span className={styles.rowKind}>{t.isBuy ? 'Buy' : 'Sell'}</span>
      <div className={styles.rowBody}>
        {who}
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
