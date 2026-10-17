'use client';

/// NFT launch teaser: the empty state shown where NFT collections would
/// render if any existed. Reused by:
///   - /discover NFT tab
///   - Home page NFT rail
///
/// Four dashed placeholder frames shaped like collection cards, so the
/// section reads as "NFTs go here" even before the first launch.

import Link from 'next/link';
import styles from './NftLaunchTeaser.module.css';

interface NftLaunchTeaserProps {
  chainEnabled: boolean;
  variant?: 'discover' | 'home';
}

const PLACEHOLDER_TAGS = ['1/1', 'PFP', 'Whitelist', 'DN404'] as const;

function ImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="1.8" />
      <path d="M21 15.5 16 11 6 20" />
    </svg>
  );
}

export function NftLaunchTeaser({ chainEnabled, variant = 'discover' }: NftLaunchTeaserProps) {
  if (!chainEnabled) {
    return (
      <div className={styles.wrongChain}>
        <b>NFT launches aren&apos;t live on this chain yet.</b>
        Switch to Robinhood Chain to see them.
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.masthead}>
        {variant === 'discover' && <p className={styles.eyebrow}>NFT collections</p>}
        <h3 className={styles.title}>No collections yet</h3>
        <p className={styles.tagline}>
          The first NFT collections launched here will show up in this spot. Bring your own art,
          or make it in chibi studio.
        </p>
      </div>

      <div className={styles.gallery} aria-hidden="true">
        {PLACEHOLDER_TAGS.map((tag, i) => (
          <div key={tag} className={styles.slot}>
            <div className={styles.slotArt}>
              <span className={styles.slotNum}>#{String(i + 1).padStart(3, '0')}</span>
              <span className={styles.slotTag}>{tag}</span>
              <ImageGlyph />
            </div>
            <div className={styles.slotMeta}>
              <span className={styles.slotLine} />
              <span className={styles.slotLine} />
            </div>
          </div>
        ))}
      </div>

      <div className={styles.dealActions}>
        <Link href="/create/nft" className="ui-btn" data-variant="primary" data-size="lg">
          Launch a collection
        </Link>
        <a
          href="https://studio.urufulabs.xyz/"
          target="_blank"
          rel="noopener noreferrer"
          className="ui-btn"
          data-size="lg"
        >
          Make art in chibi studio ↗
        </a>
      </div>
    </div>
  );
}
