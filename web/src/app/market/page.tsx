'use client';

/// Marketplace home: every collection launched on urufu (Collections tab),
/// and the connected wallet's NFTs with a List button on each (Sell tab).
/// URL: /market  (?tab=sell opens the Sell tab)

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';

import { NotLiveYet } from '@/components/NotLiveYet';
import { CancelButton } from '@/components/market/CancelButton';
import { ListForm } from '@/components/market/ListForm';
import { MyListings } from '@/components/market/MyListings';
import { TokenArt } from '@/components/market/TokenArt';
import { fetchNftCollectionsByAddresses, type IndexerNftCollection } from '@/lib/indexer';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import {
  NO_FEE_COPY,
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

export default function MarketPage() {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return (
    <Suspense fallback={null}>
      <MarketHome />
    </Suspense>
  );
}

function MarketHome() {
  const params = useSearchParams();
  const [tab, setTab] = useState<'collections' | 'sell'>(params.get('tab') === 'sell' ? 'sell' : 'collections');

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Marketplace</h1>
          <p className={styles.lede}>Buy and sell NFTs from collections launched on urufu. {NO_FEE_COPY}</p>
        </div>
        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'collections'} onClick={() => setTab('collections')}>
            Collections
          </button>
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'sell'} onClick={() => setTab('sell')}>
            Sell
          </button>
        </div>
      </div>
      {tab === 'collections' ? <CollectionsTab /> : <SellTab />}
    </div>
  );
}

function CollectionsTab() {
  const [rows, setRows] = useState<Array<MarketCollectionSummary & { meta?: IndexerNftCollection }> | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchMarketCollections();
      if (cancelled) return;
      if (!res) { setRows(null); return; }
      const visible = res.collections.filter(marketCollectionVisible);
      const metas = await fetchNftCollectionsByAddresses(visible.map((c) => c.collection));
      if (cancelled) return;
      const byAddr = new Map((metas ?? []).map((m) => [m.collectionAddress.toLowerCase(), m]));
      // Listed collections first (cheapest floor first), then the rest.
      const merged = visible.map((c) => ({ ...c, meta: byAddr.get(c.collection.toLowerCase()) }));
      merged.sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0));
      setRows(merged);
    })();
    return () => { cancelled = true; };
  }, []);

  if (rows === undefined) return <div className={styles.empty}>Loading collections…</div>;
  if (rows === null) return <div className={styles.empty}>Couldn&apos;t load the marketplace right now. Try again in a minute.</div>;
  if (rows.length === 0) return <div className={styles.empty}>No collections yet.</div>;

  return (
    <ul className={styles.colGrid}>
      {rows.map((c) => (
        <li key={c.collection}>
          <Link href={`/market/${c.collection}`} className={styles.colCard}>
            {/* No indexer cover yet: token #1's art (ids start at 1 on both lanes). */}
            <TokenArt collection={c.collection} tokenId="1" image={c.meta?.coverImageUrl || null} className={styles.cover} />
            <div className={styles.colName}>
              <span>{c.name}</span>
              <span className="ui-badge">{c.lane === 'dn404' ? 'DN404' : 'NFT'}</span>
            </div>
            <div className={styles.colStats}>
              <span>Floor<b>{c.floorWei ? `${formatEthShort(c.floorWei)} ETH` : 'none'}</b></span>
              <span>Listed<b>{c.count}</b></span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SellTab() {
  const { address } = useAccount();
  const [owned, setOwned] = useState<OwnedNft[] | null | undefined>(undefined);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!address) { setOwned(undefined); return; }
    let cancelled = false;
    setOwned(undefined);
    (async () => {
      const [o, l] = await Promise.all([fetchOwnedNfts(address, nonce > 0), fetchWalletListings(address, nonce > 0)]);
      if (cancelled) return;
      setOwned(o ? o.items.filter(marketCollectionVisible) : null);
      setListings(l?.listings ?? []);
    })();
    return () => { cancelled = true; };
  }, [address, nonce]);

  if (!address) return <div className={styles.empty}>Connect a wallet to see the NFTs you can sell.</div>;
  if (owned === undefined) return <div className={styles.empty}>Finding your NFTs…</div>;
  if (owned === null) return <div className={styles.empty}>Couldn&apos;t load your NFTs right now. Try again in a minute.</div>;

  const liveByToken = new Map(
    listings
      .filter((l) => l.status === 'active' && l.live !== false)
      .map((l) => [`${l.collection.toLowerCase()}:${l.tokenId}`, l]),
  );

  return (
    <>
      {owned.length === 0 ? (
        <div className={styles.empty}>
          This wallet doesn&apos;t hold any NFTs from urufu collections.{' '}
          <Link href="/market" onClick={() => setOpen(null)}>Browse collections</Link>
        </div>
      ) : (
        <ul className={styles.sellGrid}>
          {owned.map((n) => {
            const key = `${n.collection.toLowerCase()}:${n.tokenId}`;
            const listed = liveByToken.get(key);
            const isOpen = open === key;
            return (
              <li key={key} className={styles.sellCard} data-open={isOpen}>
                <Link href={`/collection/${n.collection}/${n.tokenId}`}>
                  <TokenArt collection={n.collection as Address} tokenId={n.tokenId} className={styles.cover} />
                </Link>
                <Link href={`/collection/${n.collection}/${n.tokenId}`} className={styles.sellName}>
                  {n.name} #{n.tokenId}
                </Link>
                {listed ? (
                  <>
                    <span className={styles.sellSub}>Listed for {formatEthShort(listed.priceWei)} ETH</span>
                    <CancelButton listing={listed} onDone={refresh} />
                  </>
                ) : isOpen ? (
                  <>
                    <ListForm
                      collection={n.collection as Address}
                      tokenId={n.tokenId}
                      lane={n.lane}
                      onListed={() => { setOpen(null); refresh(); }}
                    />
                    <button type="button" className="ui-btn" data-size="sm" data-variant="ghost" onClick={() => setOpen(null)}>
                      Close
                    </button>
                  </>
                ) : (
                  <button type="button" className="ui-btn" data-variant="primary" data-block="true" onClick={() => setOpen(key)}>
                    List for sale
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <MyListings visibleFor={address} />
    </>
  );
}
