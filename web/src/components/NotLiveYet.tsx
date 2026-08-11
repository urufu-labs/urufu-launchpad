'use client';

import Link from 'next/link';

import { CultureHeroArt } from './CultureHeroArt';

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
    <main
      style={{
        minHeight: 'calc(100vh - 60px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(20px, 4vw, 48px)',
      }}
    >
      <section
        className="uru-home-hero-frame"
        style={{
          width: '100%',
          maxWidth: 980,
          overflow: 'hidden',
        }}
      >
        <span className="uru-home-tape uru-home-tape-top" aria-hidden />

        {/* JP eyebrow tag matches the 準備中 / 卒業 / 報酬 pattern used across the
            site's tape-and-polaroid components. Keeps this splash inside the
            same visual grammar as everything the visitor will see later. */}
        <span
          style={{
            position: 'absolute',
            top: 14,
            right: 18,
            zIndex: 4,
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 11,
            color: 'var(--anchor-soft)',
            letterSpacing: '0.05em',
          }}
        >
          準備中
        </span>

        <div className="uru-home-hero">
          <div className="uru-home-hero-copy">
            <p className="uru-home-eyebrow">not open yet</p>
            <h1 className="uru-home-title">
              come <span>back</span> soon ~
            </h1>
            <p className="uru-home-subtitle">
              we&apos;re putting the last few pieces in place. launching is paused
              for a moment so nothing breaks on the way in.
            </p>
            <div className="uru-home-actions">
              <a
                href="https://x.com/urugemu"
                target="_blank"
                rel="noopener noreferrer"
                className="uru-btn uru-btn-primary"
              >
                follow @urugemu <span className="uru-arrow">→</span>
              </a>
              <Link href="/docs" className="uru-btn uru-btn-cream">
                read what we&apos;re building
              </Link>
            </div>
          </div>

          {/* Same video-driven altar the live home uses. Swaps light/dark
              per theme, silent, autoplays after first paint. Reusing the real
              hero art keeps the splash visually indistinguishable from the
              open site instead of falling back to a static placeholder. */}
          <CultureHeroArt />
        </div>
      </section>
    </main>
  );
}
