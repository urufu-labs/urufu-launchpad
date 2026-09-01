'use client';

/// NFT launch teaser — the empty-state panel shown on surfaces where NFT
/// collections would render if any existed. Currently reused by:
///   - /discover NFT tab
///   - Home page NFT rail
///
/// Design language: kawaii scrapbook page. Numbered polaroid slots
/// (#001..#004) with tape strips + rotated stamps hint at how launched
/// collections will present. Shimmer animation on the tinted art wells
/// signals "these are placeholders, real cards will replace them". Copy
/// bar underneath sells the feature set specifically so it reads as
/// "here's what's coming" rather than a blank waiting-room.

import Link from 'next/link';
import styles from './NftLaunchTeaser.module.css';

interface NftLaunchTeaserProps {
  chainEnabled: boolean;
  variant?: 'discover' | 'home';
}

const PLACEHOLDER_SLOTS = [
  { emoji: '❁', tint: 'var(--pink-warm)', tape: 'uru-tape-mint', angle: -3, stamp: 'gen-1' },
  { emoji: '✿', tint: 'var(--mizuiro)', tape: 'uru-tape-yolk', angle: 2, stamp: '10K' },
  { emoji: '❉', tint: 'var(--mint)', tape: 'uru-tape', angle: -2, stamp: 'wl' },
  { emoji: '❋', tint: 'var(--yolk)', tape: 'uru-tape-mizuiro', angle: 3, stamp: 'soon' },
] as const;

export function NftLaunchTeaser({ chainEnabled, variant = 'discover' }: NftLaunchTeaserProps) {
  if (!chainEnabled) {
    return (
      <div className={styles.wrongChain}>
        <div className="uru-h2" style={{ marginBottom: 6 }}>
          nft launches aren&apos;t live on this chain yet ~
        </div>
        <p>switch to robinhood to preview the flow.</p>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      {/* Corner tape decorations — hand-placed for that scrapbook feel */}
      <span className={`uru-tape uru-tape-mint ${styles.tapeTL}`} aria-hidden="true" />
      <span className={`uru-tape uru-tape-yolk ${styles.tapeTR}`} aria-hidden="true" />

      <div className={styles.masthead}>
        <span className="uru-eyebrow">❁ nft collections</span>
        <h2 className={styles.title}>
          the first collections land here <span aria-hidden="true">✿</span>
        </h2>
        <p className={styles.tagline}>
          {variant === 'home'
            ? 'be first in the gallery.'
            : 'be first in the gallery. contracts ship in days, not weeks.'}
        </p>
      </div>

      <div className={styles.gallery}>
        {PLACEHOLDER_SLOTS.map((slot, i) => {
          const num = String(i + 1).padStart(3, '0');
          return (
            <div
              key={i}
              className={styles.slot}
              style={{ ['--slot-tint' as string]: slot.tint, ['--slot-angle' as string]: `${slot.angle}deg` }}
              aria-hidden="true"
            >
              <span className={styles.slotNum}>#{num}</span>
              <div className={styles.slotArt}>
                <span className={styles.slotEmoji}>{slot.emoji}</span>
                <span className={styles.shimmer} aria-hidden="true" />
              </div>
              <span className={`uru-stamp uru-stamp-pink ${styles.slotStamp}`}>{slot.stamp}</span>
              <div className={styles.slotMeta}>
                <span>your name here</span>
                <span>0.0—</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.dealActions}>
        <Link href="/create/nft" className="uru-btn uru-btn-primary">
          ✿ launch a collection
        </Link>
        <a
          href="https://studio.urufulabs.xyz/"
          target="_blank"
          rel="noopener noreferrer"
          className="uru-btn uru-btn-mint"
        >
          build art in chibi studio ↗
        </a>
      </div>
    </div>
  );
}
