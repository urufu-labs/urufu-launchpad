'use client';

/// One collection in the marketplace: header with floor + listed count, then
/// the full Listed / Activity panel (browse, sort, buy).
/// URL: /market/[address]

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { isAddress, zeroAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { MarketPanel } from '@/components/market/MarketPanel';
import { TokenArt } from '@/components/market/TokenArt';
import { useActiveChain } from '@/components/ChainSwitcher';
import { fetchNftCollectionsByAddresses, type IndexerNftCollection } from '@/lib/indexer';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { fetchMarketCollections, formatEthShort, type MarketCollectionSummary } from '@/lib/market';
import { marketCollectionVisible } from '@/lib/marketVisibility';
import styles from '../market-page.module.css';

export default function MarketCollectionPage({ params }: { params: Promise<{ address: string }> }) {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;
  return <MarketCollectionRoute params={params} />;
}

function MarketCollectionRoute({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const chainKey = useActiveChain();
  const [summary, setSummary] = useState<MarketCollectionSummary | null | undefined>(undefined);
  const [meta, setMeta] = useState<IndexerNftCollection | null>(null);

  useEffect(() => {
    if (!isAddress(address)) { setSummary(null); return; }
    let cancelled = false;
    (async () => {
      const [all, metas] = await Promise.all([
        fetchMarketCollections(),
        fetchNftCollectionsByAddresses([address as Address]),
      ]);
      if (cancelled) return;
      const row = all?.collections.find((c) => c.collection.toLowerCase() === address.toLowerCase());
      setSummary(row && marketCollectionVisible(row) ? row : null);
      setMeta(metas?.[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [address]);

  if (summary === undefined) {
    return <div className={styles.page}><div className={styles.empty}>Loading collection…</div></div>;
  }
  if (summary === null) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <Mascot size={64} mood="sleepy" />
          <p>This collection isn&apos;t on the urufu marketplace.</p>
          <Link href="/market" className="ui-btn" data-size="sm">Back to the marketplace</Link>
        </div>
      </div>
    );
  }

  const collection = summary.collection;
  const pairedToken = summary.pairedToken && summary.pairedToken !== zeroAddress ? summary.pairedToken : undefined;

  return (
    <div className={styles.page}>
      <div>
        <Link href="/market" className="ui-btn" data-size="sm" data-variant="ghost">← Marketplace</Link>
      </div>
      <div className={styles.hero}>
        <TokenArt collection={collection} tokenId="1" image={meta?.coverImageUrl || null} className={styles.heroCover} />
        <div>
          <h1 className={styles.title}>{summary.name}</h1>
          <div className={styles.heroStats}>
            <span>Floor <b>{summary.floorWei ? `${formatEthShort(summary.floorWei)} ETH` : 'none'}</b></span>
            <span>Listed <b>{summary.count}</b></span>
            <span>{summary.lane === 'dn404' ? 'DN404 collection' : 'NFT collection'}</span>
          </div>
          {meta?.description && <p className={styles.lede}>{meta.description}</p>}
          <div className={styles.heroLinks}>
            <Link href="/market?tab=sell" className="ui-btn" data-size="sm" data-variant="primary">Sell yours</Link>
            <Link href={`/collection/${collection}`} className="ui-btn" data-size="sm">
              {summary.lane === 'dn404' ? 'Collection page' : 'Collection and mint page'}
            </Link>
            {pairedToken && (
              <Link href={`/trade/${pairedToken}`} className="ui-btn" data-size="sm">Trade ${summary.ticker}</Link>
            )}
          </div>
        </div>
      </div>
      <MarketPanel
        collection={collection}
        chainKey={chainKey}
        lane={summary.lane}
        pairedToken={pairedToken}
        unitWei={summary.unitWei ? BigInt(summary.unitWei) : undefined}
      />
    </div>
  );
}
