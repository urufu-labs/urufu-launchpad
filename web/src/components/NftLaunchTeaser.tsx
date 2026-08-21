'use client';

/// NFT launch teaser — the empty-state panel shown on surfaces where NFT
/// collections would render if any existed. Currently reused by:
///   - /discover NFT tab (chain has NFT_LAUNCHES_ENABLED true but no
///     indexer rows yet)
///   - Home page NFT rail (same condition)
///
/// Design goal: replace the earlier generic "coming soon + altar art"
/// panel with something that shows what a collection card is GOING to
/// look like — a 4-tile skeleton grid of kawaii placeholder cards that
/// stack shimmer-anim + emoji + rotated stamp treatments. Buyers see
/// "this is where collections will appear"; deployers see "I can be
/// the first here."

import Link from 'next/link';

interface NftLaunchTeaserProps {
  chainEnabled: boolean;
  variant?: 'discover' | 'home';
}

const PLACEHOLDER_CARDS = [
  { emoji: '❁', tint: 'var(--pink-warm)', stamp: 'gen-1', angle: -3 },
  { emoji: '✿', tint: 'var(--mizuiro)', stamp: '10K', angle: 2 },
  { emoji: '❉', tint: 'var(--mint)', stamp: 'wl', angle: -1 },
  { emoji: '❋', tint: 'var(--yolk)', stamp: 'soon', angle: 3 },
] as const;

export function NftLaunchTeaser({ chainEnabled, variant = 'discover' }: NftLaunchTeaserProps) {
  if (!chainEnabled) {
    return (
      <div
        style={{
          padding: 28,
          border: '2px dashed var(--anchor)',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--pink-warm) 25%, transparent)',
          textAlign: 'center',
          fontFamily: 'var(--font-round), Klee One, cursive',
          color: 'var(--anchor)',
        }}
      >
        <div className="uru-h2" style={{ marginBottom: 6 }}>
          nft launches aren&apos;t live on this chain yet ~
        </div>
        <p style={{ fontSize: 13, opacity: 0.75 }}>switch to robinhood to preview the flow.</p>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
          padding: 16,
          border: '2px double var(--anchor)',
          borderRadius: 12,
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--pink-warm) 30%, transparent), transparent 65%), var(--card)',
          boxShadow: '4px 4px 0 rgba(58, 44, 58, 0.15)',
        }}
      >
        {PLACEHOLDER_CARDS.map((card, i) => (
          <div
            key={i}
            className="uru-polaroid"
            style={{
              padding: 10,
              paddingBottom: 24,
              position: 'relative',
              transform: `rotate(${card.angle}deg)`,
              transition: 'transform 200ms',
              cursor: 'default',
            }}
            aria-hidden="true"
          >
            <div
              style={{
                aspectRatio: '1 / 1',
                width: '100%',
                background: `linear-gradient(135deg, ${card.tint}, color-mix(in srgb, ${card.tint} 40%, var(--cream)))`,
                border: '1.5px solid var(--anchor)',
                borderRadius: 6,
                display: 'grid',
                placeItems: 'center',
                fontFamily: 'var(--font-display), Yusei Magic, cursive',
                fontSize: 48,
                color: 'var(--anchor)',
                boxShadow: 'inset 0 0 0 4px color-mix(in srgb, var(--cream) 40%, transparent)',
                position: 'relative',
              }}
            >
              <span style={{ opacity: 0.55 }}>{card.emoji}</span>
              <span
                className="uru-stamp uru-stamp-cream"
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  transform: `rotate(${card.angle * -3}deg)`,
                  fontSize: 10,
                  padding: '2px 6px',
                }}
              >
                {card.stamp}
              </span>
            </div>
            <div
              style={{
                marginTop: 6,
                display: 'flex',
                justifyContent: 'space-between',
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 10,
                color: 'var(--anchor)',
                opacity: 0.55,
              }}
            >
              <span>your name here</span>
              <span>0.0—</span>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 14,
          padding: '14px 18px',
          border: '1.5px solid var(--anchor)',
          borderRadius: 10,
          background: 'color-mix(in srgb, var(--mint) 25%, var(--cream))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          fontFamily: 'var(--font-round), Klee One, cursive',
          color: 'var(--anchor)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px' }}>
          <span className="uru-h2" style={{ fontSize: 16 }}>
            {variant === 'home' ? 'first nft collection lands here ✿' : 'be the first nft collection on urufulabs ❁'}
          </span>
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            <b>90/10 launcher split</b> · fixed price or step curve ·
            cross-chain holder discounts · WL by wallet list or by holding another nft
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/create/nft" className="uru-btn uru-btn-primary">
            ✿ launch a collection
          </Link>
          <a
            href="https://studio.urufulabs.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            className="uru-btn uru-btn-mint"
          >
            build art ↗
          </a>
        </div>
      </div>
    </div>
  );
}
