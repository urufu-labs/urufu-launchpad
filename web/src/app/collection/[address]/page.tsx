'use client';

/// Per-collection page (phase-0 scaffolding).
///
/// Route: /collection/[address]. Renders a placeholder mint page + stats
/// shell for any address in the kawaii scrapbook idiom that matches the
/// rest of the site. Real data (cover art, mint state, holders, recent
/// mints) wires up once the indexer's nftCollections / nftMints tables
/// are populated and NftMintModule exposes on-chain reads.

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { isAddress, type Address } from 'viem';

import { Mascot } from '@/components/Mascot';
import { NotLiveYet } from '@/components/NotLiveYet';
import { NFT_LAUNCHES_ENABLED } from '@/lib/config';
import { useActiveChain } from '@/components/ChainSwitcher';
import { LAUNCHPAD_LIVE } from '@/lib/launchpadStatus';
import { explorerAddressUrl } from '@/lib/wagmi';
import styles from './collection.module.css';

export default function CollectionPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  if (!LAUNCHPAD_LIVE) return <NotLiveYet />;

  const resolved = use(params);
  const activeChain = useActiveChain();
  const chainEnabled = NFT_LAUNCHES_ENABLED[activeChain] === true;

  if (!isAddress(resolved.address)) {
    return (
      <div className={styles.page}>
        <div className={styles.notFound}>
          <Mascot size={72} mood="sleepy" />
          <div className="uru-h1" style={{ fontSize: 22 }}>
            that&apos;s not a valid collection address ~
          </div>
          <p style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13, opacity: 0.75 }}>
            try browsing <Link href="/discover" style={{ textDecoration: 'underline', color: 'var(--pink-hot)' }}>launches</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <CollectionView
      address={resolved.address as Address}
      chainEnabled={chainEnabled}
      chainKey={activeChain}
    />
  );
}

function CollectionView({
  address,
  chainEnabled,
  chainKey,
}: {
  address: Address;
  chainEnabled: boolean;
  chainKey: string;
}) {
  const [mintQty, setMintQty] = useState(1);
  const shortAddr = useMemo(
    () => `${address.slice(0, 6)}…${address.slice(-4)}`,
    [address],
  );

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Mascot size={44} mood="happy" />
        <h1 className={styles.heroTitle}>❁ collection</h1>
        <a
          className={styles.addressChip}
          href={explorerAddressUrl('robinhood', address)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddr} ↗
        </a>
        <span className="uru-stamp uru-stamp-mint" style={{ transform: 'rotate(-4deg)' }}>
          phase-0
        </span>
      </header>

      {!chainEnabled && (
        <div className={styles.warnPane}>
          <b>nft collections aren&apos;t live on this chain yet.</b> switch to robinhood to preview.
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.mainStack}>
          <section className={styles.artShell}>
            <span className={`uru-stamp uru-stamp-pink ${styles.artStamp}`} aria-hidden="true">
              new ✿
            </span>
            <div className={styles.artFrame}>
              <span>cover art pending</span>
            </div>
          </section>

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">♡ holders</span>
              <span className={styles.sectionEye}>who&apos;s in the collection</span>
            </div>
            <div className={styles.emptyRow}>
              holder list wires from indexer ~
            </div>
          </section>

          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">❉ recent mints</span>
              <span className={styles.sectionEye}>the live mint feed</span>
            </div>
            <div className={styles.emptyRow}>
              mint feed wires from indexer ~
            </div>
          </section>
        </div>

        <aside className={styles.rail}>
          <section className="uru-shell">
            <div className={styles.sectionHead}>
              <span className="uru-eyebrow">✦ mint</span>
              <span className={styles.sectionEye}>{chainKey}</span>
            </div>

            <div className={styles.mintPanel}>
              <dl className={styles.statRow}>
                <dt>price</dt>
                <dd style={{ opacity: 0.5 }}>pending ~</dd>
                <dt>supply</dt>
                <dd style={{ opacity: 0.5 }}>—/—</dd>
                <dt>minted</dt>
                <dd style={{ opacity: 0.5 }}>—</dd>
              </dl>

              <div className={styles.qtyRow}>
                <span className={styles.qtyLabel}>qty</span>
                <div className={styles.qtyControls}>
                  <button
                    type="button"
                    className={styles.qtyBtn}
                    onClick={() => setMintQty(Math.max(1, mintQty - 1))}
                    aria-label="Decrease quantity"
                  >
                    −
                  </button>
                  <span className={styles.qtyNum}>{mintQty}</span>
                  <button
                    type="button"
                    className={styles.qtyBtn}
                    onClick={() => setMintQty(Math.min(20, mintQty + 1))}
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
              </div>

              <button
                type="button"
                className="uru-btn"
                disabled
                style={{ width: '100%', justifyContent: 'center' }}
              >
                ❁ mint (soon)
              </button>
              <p
                style={{
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 11,
                  color: 'var(--anchor)',
                  opacity: 0.7,
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}
              >
                mint unlocks once NftMintModule broadcasts.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
