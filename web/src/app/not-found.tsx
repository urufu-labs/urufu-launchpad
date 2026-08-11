/// 404 page. Next.js App Router auto-mounts this at any URL that doesn't
/// resolve to a route. Kawaii + confused-mascot in urufu voice — the site
/// already has strong brand tokens (cream, pink, tape, polaroid, mascot),
/// so a lost visitor lands somewhere on-brand instead of the browser's
/// default "the requested page was not found on this server" prose.
///
/// Static — no client state, no data fetches. Renders identically for
/// every miss so we don't burn a serverless invocation per 404.

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';

export default function NotFound() {
  return (
    <div
      className="mx-auto max-w-xl px-3 sm:px-4 py-8"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, textAlign: 'center' }}
    >
      {/* Big confused mascot — the whole reason this page has a personality
          instead of being a http-status stub. Bobs on hover like the header
          mascot for continuity. */}
      <Mascot size={96} mood="confused" className="uru-idle-bob" />

      <div>
        <div className="uru-eyebrow" style={{ marginBottom: 4 }}>
          ✿ page not found{' '}
          <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 11, opacity: 0.7 }}>
            迷子
          </span>
        </div>
        <h1 className="uru-h1" style={{ fontSize: 26, lineHeight: 1.15, margin: 0 }}>
          oh no, i couldn't find that ~
        </h1>
        <p style={{ marginTop: 8, fontSize: 13, color: 'var(--anchor-soft)', lineHeight: 1.55 }}>
          the page u're looking for doesn't exist (or maybe it wandered off).
          try one of these instead ✿
        </p>
      </div>

      {/* Wayfinding grid — the most useful destinations someone-who-got-lost
          might want. Kept to five so it stays scannable. */}
      <nav
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 10,
          width: '100%',
          maxWidth: 420,
        }}
        aria-label="Recovery links"
      >
        <NavCard href="/" glyph="✿" jp="家" label="home" />
        <NavCard href="/create" glyph="❋" jp="作成" label="launch a token" />
        <NavCard href="/trade" glyph="✦" jp="取引" label="trade" />
        <NavCard href="/flywheel" glyph="♡" jp="還元" label="flywheel" />
        <NavCard href="/docs" glyph="❉" jp="説明" label="docs" />
      </nav>

      <div
        style={{
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10.5,
          color: 'var(--anchor-soft)',
          marginTop: 6,
        }}
      >
        (◕‿◕✿) urufu labs is on robinhood chain — chainid 4663
      </div>
    </div>
  );
}

function NavCard({ href, glyph, jp, label }: { href: string; glyph: string; jp: string; label: string }) {
  return (
    <Link
      href={href}
      className="uru-polaroid"
      style={{
        padding: 12,
        textDecoration: 'none',
        color: 'var(--anchor)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        background: 'var(--paper-white, #fff)',
      }}
    >
      <span style={{ fontSize: 20 }} aria-hidden>{glyph}</span>
      <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 11, color: 'var(--anchor-soft)' }}>
        {jp}
      </span>
      <span style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 12 }}>{label}</span>
    </Link>
  );
}
