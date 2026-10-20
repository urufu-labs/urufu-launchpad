'use client';

/// Profile card: the wallet's marketplace listings, with Cancel for the owner.
/// Renders nothing when the wallet has never listed.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';

import { fetchWalletListings, formatEthShort, type MarketListing } from '@/lib/market';
import { CancelAllButton } from './CancelAllButton';
import { CancelButton } from './CancelButton';
import { TokenArt } from './TokenArt';
import card from '../profile-card.module.css';
import styles from './market.module.css';

const STATUS_LABEL: Record<MarketListing['status'], string> = {
  active: 'Listed',
  filled: 'Sold',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const HIDDEN_LABEL: Record<NonNullable<MarketListing['hiddenReason']>, string> = {
  not_owner: 'Not visible: this wallet no longer holds the NFT',
  not_approved: 'Not visible: marketplace approval was removed',
};

export function MyListings({ visibleFor }: { visibleFor: Address }) {
  const { address } = useAccount();
  const isOwner = !!address && address.toLowerCase() === visibleFor.toLowerCase();
  const [rows, setRows] = useState<MarketListing[] | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchWalletListings(visibleFor, nonce > 0);
      if (!cancelled) setRows(res?.listings ?? []);
    })();
    return () => { cancelled = true; };
  }, [visibleFor, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  if (!rows || rows.length === 0) return null;
  // Visitors see live listings only; the owner also sees ended ones.
  const shown = isOwner ? rows.slice(0, 30) : rows.filter((l) => l.status === 'active' && l.live !== false);
  if (shown.length === 0) return null;

  return (
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>{isOwner ? 'Your listings' : 'Listings'}</h2>
        {isOwner && rows.some((l) => l.status === 'active') && <CancelAllButton onDone={refresh} />}
      </div>
      <div>
        {shown.map((l) => (
          <div key={l.orderHash} className={styles.myRow}>
            <TokenArt collection={l.collection} tokenId={l.tokenId} className={styles.myArt} />
            <div className={styles.myText}>
              <Link className={styles.cardName} href={`/collection/${l.collection}/${l.tokenId}`}>
                #{l.tokenId} · {formatEthShort(l.priceWei)} ETH
              </Link>
              <span className={styles.sub}>
                {l.status === 'active' && l.hiddenReason ? HIDDEN_LABEL[l.hiddenReason] : STATUS_LABEL[l.status]}
                {l.status === 'active' ? ` · ends ${new Date(Number(l.endTime) * 1000).toLocaleDateString()}` : ''}
              </span>
            </div>
            {isOwner && l.status === 'active' ? <CancelButton listing={l} onDone={refresh} /> : <span />}
          </div>
        ))}
      </div>
    </section>
  );
}
