'use client';

/// Marketplace home.
///   Explore: NFTs listed right now across every urufu collection, then the
///            collections themselves (floor, listed, items).
///   Sell:    the connected wallet's NFTs from urufu collections; List opens a
///            dialog, listed ones can be cancelled.
/// URL: /market  (?tab=sell opens Sell)

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import { useAccount } from 'wagmi';

import { NotLiveYet } from '@/components/NotLiveYet';
import { Modal } from '@/components/ui/Overlay';
import { BuyButton } from '@/components/market/BuyButton';
import { CancelButton } from '@/components/market/CancelButton';
import { ListForm } from '@/components/market/ListForm';
import { MyListings } from '@/components/market/MyListings';
import { TokenArt } from '@/components/market/TokenArt';
import { fetchNftCollectionsByAddresses, type IndexerNftCollection } from '@/lib/indexer';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { fetchTokenMetadataBatch } from '@/lib/socialApi';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import {
  NO_FEE_COPY,
  fetchCollectionListings,
  fetchMarketCollections,
  fetchOwnedNfts,
  fetchWalletListings,
  formatEthShort,
  type MarketCollectionSummary,
  type MarketListing,
  type OwnedNft,
} from '@/lib/market';
import { marketCollectionVisible } from '@/lib/marketVisibility';
import styles from './market-page.module.css';

type Collection = MarketCollectionSummary & { meta?: IndexerNftCollection };

export default function MarketPage() {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return (
    <Suspense fallback={null}>
      <MarketHome />
    </Suspense>
  );
}

/// Visible collections + their indexer rows (cover art, description). A
/// launcher's own image + description from Customize your page win.
function useCollections(): Collection[] | null | undefined {
  const [rows, setRows] = useState<Collection[] | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchMarketCollections();
      if (cancelled) return;
      if (!res) { setRows(null); return; }
      const visible = res.collections.filter(marketCollectionVisible);
      const addrs = visible.map((c) => c.collection);
      const [metas, saved] = visible.length > 0
        ? await Promise.all([fetchNftCollectionsByAddresses(addrs), fetchTokenMetadataBatch(CHAIN_KEY_TO_ID.robinhood, addrs)])
        : [[], {}];
      if (cancelled) return;
      const byAddr = new Map((metas ?? []).map((m) => [m.collectionAddress.toLowerCase(), m]));
      const merged = visible.map((c) => {
        const key = c.collection.toLowerCase();
        const m = byAddr.get(key);
        const own = (saved as Record<string, { imageUrl: string | null; description: string | null }>)[key];
        return {
          ...c,
          meta: m && own
            ? { ...m, coverImageUrl: own.imageUrl || m.coverImageUrl, description: own.description || m.description }
            : m,
        };
      });
      // Collections with listings first, then by name.
      merged.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) || a.name.localeCompare(b.name));
      setRows(merged);
    })();
    return () => { cancelled = true; };
  }, []);
  return rows;
}

function MarketHome() {
  const params = useSearchParams();
  const [tab, setTab] = useState<'explore' | 'sell'>(params.get('tab') === 'sell' ? 'sell' : 'explore');
  const collections = useCollections();
  const listedTotal = (collections ?? []).reduce((s, c) => s + c.count, 0);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>urufulabs · Robinhood Chain</div>
          <h1 className={styles.title}>NFT marketplace</h1>
          <div className={styles.statRow}>
            <span className={styles.stat}>Collections<b>{collections ? collections.length : '…'}</b></span>
            <span className={styles.stat}>Listed now<b>{collections ? listedTotal : '…'}</b></span>
            <span className={styles.stat}>Marketplace fee<b>0%</b></span>
          </div>
        </div>
        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'explore'} onClick={() => setTab('explore')}>
            Explore
          </button>
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'sell'} onClick={() => setTab('sell')}>
            Sell
          </button>
        </div>
      </section>
      {tab === 'explore'
        ? <ExploreTab collections={collections} onSell={() => setTab('sell')} />
        : <SellTab collections={collections} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

function ExploreTab({ collections, onSell }: { collections: Collection[] | null | undefined; onSell: () => void }) {
  const [query, setQuery] = useState('');
  const [listed, setListed] = useState<MarketListing[] | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Newest listings across collections that have any.
  useEffect(() => {
    if (!collections) return;
    let cancelled = false;
    (async () => {
      const withListings = collections.filter((c) => c.count > 0);
      const results = await Promise.all(withListings.map((c) => fetchCollectionListings(c.collection, { fresh: nonce > 0 })));
      if (cancelled) return;
      const all = results.flatMap((r) => r?.listings ?? []);
      all.sort((a, b) => b.createdAt - a.createdAt);
      setListed(all.slice(0, 12));
    })();
    return () => { cancelled = true; };
  }, [collections, nonce]);

  const byAddr = useMemo(() => new Map((collections ?? []).map((c) => [c.collection.toLowerCase(), c])), [collections]);
  const shown = (collections ?? []).filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (collections === null) {
    return <div className={styles.empty}><b>Marketplace is busy</b>Couldn&apos;t load collections. Try again in a minute.</div>;
  }

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} data-label="For sale">Listed now</h2>
          <span className={styles.sectionAside}>{NO_FEE_COPY}</span>
        </div>
        {listed === undefined ? (
          <ul className={styles.nftGrid}>{[0, 1, 2, 3].map((i) => <li key={i} className={styles.skeleton} />)}</ul>
        ) : listed.length === 0 ? (
          <div className={styles.empty}>
            <b>Nothing listed yet</b>
            Be the first to list one.
            <button type="button" className="ui-btn" data-variant="primary" onClick={onSell}>List an NFT</button>
          </div>
        ) : (
          <ul className={styles.nftGrid}>
            {listed.map((l) => {
              const c = byAddr.get(l.collection.toLowerCase());
              const pairedToken = c?.pairedToken && c.pairedToken !== zeroAddress ? c.pairedToken : undefined;
              const href = `/collection/${l.collection}/${l.tokenId}`;
              return (
                <li key={l.orderHash} className={styles.nftCard}>
                  <Link href={href} className={styles.nftArtLink} aria-label={`${c?.name ?? 'NFT'} #${l.tokenId}`}>
                    <TokenArt collection={l.collection} tokenId={l.tokenId} image={l.meta?.image} className={styles.art} />
                  </Link>
                  <div className={styles.nftBody}>
                    <Link href={`/market/${l.collection}`} className={styles.nftCollection}>{c?.name ?? 'Collection'}</Link>
                    <Link href={href} className={styles.nftName}>#{l.tokenId}</Link>
                    <div className={styles.priceRow}>
                      <span className={styles.priceLabel}>Price</span>
                      <span className={styles.price}>{formatEthShort(l.priceWei)} ETH</span>
                    </div>
                    <BuyButton listing={l} pairedToken={pairedToken} onDone={refresh} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} data-label="Browse">Collections</h2>
          <input
            className={`ui-input ${styles.search}`}
            placeholder="Search collections"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search collections"
          />
        </div>
        {collections === undefined ? (
          <ul className={styles.colGrid}>{[0, 1, 2].map((i) => <li key={i} className={styles.skeleton} />)}</ul>
        ) : shown.length === 0 ? (
          <div className={styles.empty}><b>No collections found</b></div>
        ) : (
          <ul className={styles.colGrid}>
            {shown.map((c) => (
              <li key={c.collection}>
                <Link href={`/market/${c.collection}`} className={styles.colCard}>
                  <div className={styles.colArtWrap}>
                    {/* No indexer cover yet: token #1's art (ids start at 1 on both lanes). */}
                    <TokenArt collection={c.collection} tokenId="1" image={c.meta?.coverImageUrl || null} className={styles.art} />
                    <span className={styles.laneBadge}>{c.lane === 'dn404' ? 'DN404' : 'NFT'}</span>
                  </div>
                  <div className={styles.colBody}>
                    <h3 className={styles.colName}>{c.name}</h3>
                    <div className={styles.metrics}>
                      <span>Floor<b>{c.floorWei ? `${formatEthShort(c.floorWei)}` : 'None'}</b></span>
                      <span>Listed<b>{c.count}</b></span>
                      <span>Items<b>{c.maxSupply !== '0' ? Number(c.maxSupply).toLocaleString() : 'None'}</b></span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sell
// ---------------------------------------------------------------------------

function SellTab({ collections }: { collections: Collection[] | null | undefined }) {
  const { address } = useAccount();
  const [owned, setOwned] = useState<OwnedNft[] | null | undefined>(undefined);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [listing, setListing] = useState<{ nft: OwnedNft; replaces?: MarketListing } | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const closeDialog = useCallback(() => setListing(null), []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      const [o, l] = await Promise.all([fetchOwnedNfts(address, nonce > 0), fetchWalletListings(address, nonce > 0)]);
      if (cancelled) return;
      setOwned(o ? o.items.filter(marketCollectionVisible) : null);
      setListings(l?.listings ?? []);
    })();
    return () => { cancelled = true; };
  }, [address, nonce]);

  if (!address) {
    return <div className={styles.empty}><b>Connect a wallet</b>Your NFTs from urufu collections show up here, ready to list.</div>;
  }

  // Any active listing counts, live or paused: a paused one is still signed
  // and can become buyable again, so it must be cancelled or replaced.
  const liveByToken = new Map(
    listings
      .filter((l) => l.status === 'active')
      .map((l) => [`${l.collection.toLowerCase()}:${l.tokenId}`, l]),
  );
  const coverOf = (addr: string) => collections?.find((c) => c.collection.toLowerCase() === addr.toLowerCase());

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle} data-label="Sell">Your NFTs</h2>
          <span className={styles.sectionAside}>Listing is a free signature. You only pay gas once to approve a collection.</span>
        </div>
        {owned === undefined ? (
          <ul className={styles.nftGrid}>{[0, 1, 2, 3].map((i) => <li key={i} className={styles.skeleton} />)}</ul>
        ) : owned === null ? (
          <div className={styles.empty}><b>Couldn&apos;t load your NFTs</b>Try again in a minute.</div>
        ) : owned.length === 0 ? (
          <div className={styles.empty}>
            <b>No urufu NFTs in this wallet</b>
            Mint one or buy one, then list it here.
            <Link href="/market" className="ui-btn">Explore collections</Link>
          </div>
        ) : (
          <ul className={styles.nftGrid}>
            {owned.map((n) => {
              const key = `${n.collection.toLowerCase()}:${n.tokenId}`;
              const live = liveByToken.get(key);
              const href = `/collection/${n.collection}/${n.tokenId}`;
              return (
                <li key={key} className={styles.nftCard}>
                  <Link href={href} className={styles.nftArtLink} aria-label={`${n.name} #${n.tokenId}`}>
                    <TokenArt collection={n.collection as Address} tokenId={n.tokenId} className={styles.art} />
                  </Link>
                  <div className={styles.nftBody}>
                    <Link href={`/market/${n.collection}`} className={styles.nftCollection}>{coverOf(n.collection)?.name ?? n.name}</Link>
                    <Link href={href} className={styles.nftName}>#{n.tokenId}</Link>
                    {live ? (
                      <>
                        <div className={styles.priceRow}>
                          {live.live === false ? (
                            <span className={styles.status}>Paused</span>
                          ) : (
                            <span className={styles.status} data-tone="live">Listed</span>
                          )}
                          <span className={styles.price}>{formatEthShort(live.priceWei)} ETH</span>
                        </div>
                        {live.live === false && (
                          <span className={styles.priceLabel}>
                            {live.hiddenReason === 'not_approved'
                              ? 'Hidden while marketplace approval is off. Approving again makes it buyable at this price.'
                              : 'Hidden for now. Cancel it or change the price.'}
                          </span>
                        )}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button type="button" className="ui-btn" data-size="sm" data-variant="primary" onClick={() => setListing({ nft: n, replaces: live })}>
                            Change price
                          </button>
                          <CancelButton listing={live} onDone={refresh} />
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={styles.status}>Not listed</span>
                        <button type="button" className="ui-btn" data-variant="primary" data-block="true" onClick={() => setListing({ nft: n })}>
                          List for sale
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <MyListings visibleFor={address} />

      <Modal open={listing !== null} onClose={closeDialog} title={listing?.replaces ? 'Change price' : 'List for sale'} width={560}>
        {listing && (
          <div className={styles.dialogBody}>
            <TokenArt collection={listing.nft.collection as Address} tokenId={listing.nft.tokenId} className={styles.dialogArt} />
            <div>
              <p className={styles.dialogName}>{listing.nft.name} #{listing.nft.tokenId}</p>
              <ListForm
                collection={listing.nft.collection as Address}
                tokenId={listing.nft.tokenId}
                lane={listing.nft.lane}
                replaces={listing.replaces}
                pairedToken={(() => {
                  const c = coverOf(listing.nft.collection);
                  return c?.pairedToken && c.pairedToken !== zeroAddress ? c.pairedToken : undefined;
                })()}
                unitWei={(() => {
                  const u = coverOf(listing.nft.collection)?.unitWei;
                  return u ? BigInt(u) : undefined;
                })()}
                onListed={() => { setListing(null); refresh(); }}
              />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
