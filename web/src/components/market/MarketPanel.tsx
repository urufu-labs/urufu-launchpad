'use client';

/// Collection page marketplace: "Listed" (live listings, floor, count, sort
/// by price or rarity, Buy) and "Activity" (sales from the indexer).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { zeroAddress, type Address } from 'viem';

import type { ChainKey } from '@/lib/config';
import { fetchMarketSalesByCollection, type IndexerMarketSale } from '@/lib/indexer';
import {
  MARKET_CHAIN_ID,
  NO_FEE_COPY,
  fetchCollectionListings,
  formatEthShort,
  shortAddr,
  type CollectionListings,
  type MarketListing,
} from '@/lib/market';
import { useDn404TokenValue, type Dn404TokenValue } from '@/lib/useDn404TokenValue';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/wagmi';
import { BuyButton } from './BuyButton';
import { TokenArt } from './TokenArt';
import styles from './market.module.css';

type Tab = 'listed' | 'activity';

export function MarketPanel({
  collection,
  chainKey,
  lane,
  pairedToken,
  unitWei,
}: {
  collection: Address;
  chainKey: ChainKey;
  lane: 'nft' | 'dn404';
  pairedToken?: Address;
  unitWei?: bigint;
}) {
  const [tab, setTab] = useState<Tab>('listed');
  const [sort, setSort] = useState<'price' | 'rarity'>('price');
  const [data, setData] = useState<CollectionListings | null | undefined>(undefined);
  const [sales, setSales] = useState<IndexerMarketSale[] | null | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const isDn404 = lane === 'dn404' && !!pairedToken && pairedToken !== zeroAddress;
  const tokenValue = useDn404TokenValue(isDn404 ? pairedToken : undefined, unitWei, MARKET_CHAIN_ID);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchCollectionListings(collection, { sort, fresh: nonce > 0 });
      if (!cancelled) setData(res);
    })();
    return () => { cancelled = true; };
  }, [collection, sort, nonce]);

  useEffect(() => {
    if (tab !== 'activity') return;
    let cancelled = false;
    (async () => {
      const rows = await fetchMarketSalesByCollection(collection, 50);
      if (!cancelled) setSales(rows);
    })();
    return () => { cancelled = true; };
  }, [collection, tab, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <section className="ui-panel">
      <div className="ui-panel-head">
        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'listed'} onClick={() => setTab('listed')}>
            Listed
          </button>
          <button type="button" role="tab" className={styles.tab} data-active={tab === 'activity'} onClick={() => setTab('activity')}>
            Activity
          </button>
        </div>
        <span className="ui-badge" data-tone="accent">0% fee</span>
      </div>

      {tab === 'listed' ? (
        <>
          <div className={styles.statsRow}>
            <span>Floor <b>{data?.floorWei ? `${formatEthShort(data.floorWei)} ETH` : 'none'}</b></span>
            <span>Listed <b>{data?.count ?? 0}</b></span>
            {isDn404 && tokenValue.value !== null && (
              <span>Token value of 1 NFT <b>{formatEthShort(tokenValue.value)} {tokenValue.unit}</b></span>
            )}
            <select
              className={`ui-input ${styles.sortSelect}`}
              data-size="sm"
              value={sort}
              onChange={(e) => setSort(e.target.value === 'rarity' ? 'rarity' : 'price')}
              aria-label="Sort listings"
            >
              <option value="price">Price: low to high</option>
              <option value="rarity" disabled={data !== undefined && data !== null && !data.rarityReady}>
                Rarity{data && !data.rarityReady ? ' (not ready yet)' : ''}
              </option>
            </select>
          </div>
          <p className={styles.noFee}>{NO_FEE_COPY}</p>
          {data === undefined ? (
            <div className={styles.empty}>Loading listings…</div>
          ) : data === null ? (
            <div className={styles.empty}>Couldn&apos;t load listings right now.</div>
          ) : data.listings.length === 0 ? (
            <div className={styles.empty}>
              Nothing listed yet. Own one? <Link className={styles.link} href="/market?tab=sell">List it on the Sell page</Link>.
            </div>
          ) : (
            <ul className={styles.grid}>
              {data.listings.map((l) => (
                <ListingCard key={l.orderHash} listing={l} pairedToken={pairedToken} tokenValue={isDn404 ? tokenValue : null} onDone={refresh} />
              ))}
            </ul>
          )}
        </>
      ) : sales === undefined ? (
        <div className={styles.empty}>Loading sales…</div>
      ) : !sales || sales.length === 0 ? (
        <div className={styles.empty}>No sales yet.</div>
      ) : (
        <div className="ui-table-wrap">
          <table className={`ui-table ${styles.activityTable}`}>
            <thead>
              <tr>
                <th>NFT</th>
                <th data-align="right">Price</th>
                <th>From</th>
                <th>To</th>
                <th data-align="right">When</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className={styles.link} href={`/collection/${collection}/${s.tokenId}`}>#{s.tokenId}</Link>
                  </td>
                  <td data-align="right" className="ui-num">{formatEthShort(s.priceWei)} ETH</td>
                  <td>
                    <a className={styles.link} href={explorerAddressUrl(chainKey, s.seller)} target="_blank" rel="noopener noreferrer">{shortAddr(s.seller)}</a>
                  </td>
                  <td>
                    <a className={styles.link} href={explorerAddressUrl(chainKey, s.buyer)} target="_blank" rel="noopener noreferrer">{shortAddr(s.buyer)}</a>
                  </td>
                  <td data-align="right">
                    <a className={styles.link} href={explorerTxUrl(chainKey, s.txHash)} target="_blank" rel="noopener noreferrer">
                      {new Date(Number(s.blockTimestamp) * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ListingCard({
  listing,
  pairedToken,
  tokenValue,
  onDone,
}: {
  listing: MarketListing;
  pairedToken?: Address;
  tokenValue: Dn404TokenValue | null;
  onDone: () => void;
}) {
  const metaName = listing.meta?.name?.trim();
  const name = metaName && !/^#?\d+$/.test(metaName) ? metaName : `#${listing.tokenId}`;
  const href = `/collection/${listing.collection}/${listing.tokenId}`;
  return (
    <li className={styles.card}>
      <Link href={href} aria-label={name}>
        <TokenArt collection={listing.collection} tokenId={listing.tokenId} image={listing.meta?.image} className={styles.art} />
      </Link>
      <div className={styles.cardHead}>
        <Link href={href} className={styles.cardName}>{name}</Link>
        {listing.rarityRank ? <span className={styles.rank}>Rank {listing.rarityRank}</span> : null}
      </div>
      <div className={styles.price}>{formatEthShort(listing.priceWei)} ETH</div>
      {tokenValue && <TokenValueLine value={tokenValue} priceWei={BigInt(listing.priceWei)} />}
      <BuyButton listing={listing} pairedToken={pairedToken} onDone={onDone} />
    </li>
  );
}

/// "Token value of 1 NFT" plus how far the price sits above it (ETH only;
/// a URU-paired value can't be compared to an ETH price directly).
export function TokenValueLine({ value, priceWei }: { value: Dn404TokenValue; priceWei: bigint }) {
  if (value.value === null) return <div className={styles.tokenValue}>Token value of 1 NFT: loading…</div>;
  let premium: string | null = null;
  if (value.unit === 'ETH' && value.value > 0n) {
    const pct = Number(((priceWei - value.value) * 10_000n) / value.value) / 100;
    premium = pct >= 0 ? `${pct.toFixed(1)}% above token value` : `${Math.abs(pct).toFixed(1)}% below token value`;
  }
  return (
    <div className={styles.tokenValue}>
      Token value of 1 NFT <b>{formatEthShort(value.value)} {value.unit}</b>
      {premium && <span className={styles.premium}> ({premium})</span>}
    </div>
  );
}
