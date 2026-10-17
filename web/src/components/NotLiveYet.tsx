'use client';

import Link from 'next/link';

import { CultureHeroArt } from './CultureHeroArt';
import styles from './NotLiveYet.module.css';

/// Pre-launch splash rendered by app/page.tsx + app/create/page.tsx when
/// LAUNCHPAD_LIVE is false. Uses the exact same hero shell + video-driven
/// altar art the live home renders, so a flip back to `false` for staging
/// or maintenance reads as "same site, doors closed for a minute" rather
/// than a different product.
///
/// Copy rules from memory:
///   - no em dashes (commas / periods)
///   - plain language, no engineering vocab
///   - warm, playful, doesn't overpromise

export function NotLiveYet() {
  return (
    <main className={styles.main}>
      <section className={styles.frame}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Not open yet</p>
          <h1 className={styles.title}>Come back soon</h1>
          <p className={styles.lede}>
            We&apos;re putting the last few pieces in place. Launching is paused
            for a moment so nothing breaks on the way in.
          </p>
          <div className={styles.actions}>
            <a
              href="https://x.com/urugemu"
              target="_blank"
              rel="noopener noreferrer"
              className="ui-btn"
              data-variant="primary"
              data-size="lg"
            >
              Follow @urugemu
            </a>
            <Link href="/docs" className="ui-btn" data-size="lg">
              Read what we&apos;re building
            </Link>
          </div>
        </div>

        {/* Same video-driven altar the live home uses. Swaps light/dark
            per theme, silent, autoplays after first paint. Reusing the real
            hero art keeps the splash visually indistinguishable from the
            open site instead of falling back to a static placeholder. */}
        <CultureHeroArt />
      </section>
    </main>
  );
}
