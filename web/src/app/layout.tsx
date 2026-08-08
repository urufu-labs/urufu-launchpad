import type { Metadata, Viewport } from 'next';
import { Yusei_Magic, Klee_One, Pixelify_Sans, DotGothic16, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import Script from 'next/script';
import './globals.css';

import { Providers } from './providers';
import { WalletButton } from '@/components/WalletButton';
import { ChainSwitcher } from '@/components/ChainSwitcher';
import { CursorMascot } from '@/components/CursorMascot';
import { AudioBindings } from '@/components/AudioBindings';
import { AudioToggle } from '@/components/AudioToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TokenTicker } from '@/components/TokenTicker';
import { PriceUnitToggle } from '@/components/PriceUnitToggle';
import { WelcomeModal } from '@/components/WelcomeModal';

const yusei = Yusei_Magic({
  variable: '--font-display',
  weight: '400',
  subsets: ['latin', 'latin-ext'],
});

const klee = Klee_One({
  variable: '--font-round',
  weight: ['400', '600'],
  subsets: ['latin'],
});

const pixel = Pixelify_Sans({
  variable: '--font-pixel',
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
});

// Georgia serif is what the skill mandates for body — declared in globals.css.
// Load DotGothic16 as an inline JP accent font for kanji headings.
const dot = DotGothic16({
  variable: '--font-jp',
  weight: '400',
  subsets: ['latin'],
});

// Monospaced numeric font with tabular figures + slashed zero. Pixel font's
// 5/S and 2/Z were confusable at small sizes; JetBrains Mono has clearer
// digit shapes for market caps, prices, holder counts, everywhere numbers
// need to be read fast without misreading.
const mono = JetBrains_Mono({
  variable: '--font-mono',
  weight: ['400', '500', '600'],
  subsets: ['latin'],
});

// One line, shows in browser tabs + link previews. Slogan-shaped.
const TAGLINE = 'tap tap launch ✿ liquidity locked forever ✿ 好き好き大好き';
const TITLE = 'urufu labs ✿ tap tap launch';
const DESCRIPTION = 'make ur token, hit launch, done ✿ once it takes off the liquidity locks forever, and every trade rewards urufu gemu nft holders ~';

/// Viewport meta — required for mobile so pages render at device width instead of the
/// legacy 980px "desktop" fallback. `viewportFit: cover` lets the paper background bleed
/// under the notch on iOS. `themeColor` matches --paper-base so the address bar tints
/// with the site paint instead of Safari's default white.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5ecda' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a24' },
  ],
};

export const metadata: Metadata = {
  // Absolute URL base for OG image + canonical resolution — Twitter/Facebook/Discord
  // won't fetch relative image paths, so social previews stay blank without this.
  metadataBase: new URL('https://urufulabs.xyz'),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    // JPG at 1024x1024 (square). Twitter, Discord, iMessage, Telegram all
    // render it fine — most auto-crop to 16:9 for their preview cards.
    // Explicit width/height + alt so crawlers don't have to fetch-and-measure
    // to lay out their preview cards (also prevents CLS in embedders).
    // 1200x630 letterboxed variant (mascot on a blurred zoom of itself so
    // there are no hard cream bars). Standard platform aspect ratio, renders
    // uncropped on Twitter / Discord / iMessage / Slack / Bluesky.
    images: [{ url: '/og-1200x630.jpg', width: 1200, height: 630, alt: 'urufu labs launchpad mascot' }],
    type: 'website',
    url: 'https://urufulabs.xyz',
    siteName: 'urufu labs',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: TAGLINE,
    images: [{ url: '/og-1200x630.jpg', width: 1200, height: 630, alt: 'urufu labs launchpad mascot' }],
    // Add site handle so tweets sharing the link show 'via @spoobsV1' style.
    creator: '@spoobsV1',
  },
  // Additional social / bot signals — helps some crawlers (Slack, LinkedIn,
  // Bluesky) build cleaner previews than the OG defaults alone.
  applicationName: 'urufu labs',
  authors: [{ name: 'urufu labs', url: 'https://urufulabs.xyz' }],
  keywords: [
    'urufu labs', 'launchpad', 'memecoin', 'bonding curve', 'uniswap v4',
    'robinhood chain', 'v4 hooks', 'lp locked', 'nft rewards', 'urufu gemu',
  ],
  category: 'DeFi',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${yusei.variable} ${klee.variable} ${pixel.variable} ${dot.variable} ${mono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme bootstrap must run before first paint so dark mode doesn't flash light.
            Use next/script here so React does not warn about raw <script> tags in the
            rendered tree. Source at web/public/theme-bootstrap.js. */}
        <Script src="/theme-bootstrap.js" strategy="beforeInteractive" />

        {/* JSON-LD structured data. Two nodes in one @graph:
             - Organization (who we are, links to social)
             - WebSite (search + canonical URL)
            Google + Bing + LinkedIn use these to build rich results, sitelinks,
            and knowledge-panel entries. Kept minimal — schema.org gets picky
            about unknown properties. Rendered inline (no state, no client
            bundle) via dangerouslySetInnerHTML so the JSON isn't turned into
            react children (would need to escape < / > everywhere). */}
        <Script
          id="urufu-json-ld"
          type="application/ld+json"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@graph': [
                {
                  '@type': 'Organization',
                  '@id': 'https://urufulabs.xyz#organization',
                  name: 'urufu labs',
                  url: 'https://urufulabs.xyz',
                  logo: 'https://urufulabs.xyz/og-1200x630.jpg',
                  sameAs: ['https://x.com/spoobsV1', 'https://github.com/urufu-labs'],
                  description:
                    'launchpad for customizable ERC-20 tokens that graduate onto uniswap v4 with LP locked forever and fees flowing to nft holders',
                },
                {
                  '@type': 'WebSite',
                  '@id': 'https://urufulabs.xyz#website',
                  url: 'https://urufulabs.xyz',
                  name: 'urufu labs',
                  publisher: { '@id': 'https://urufulabs.xyz#organization' },
                  inLanguage: 'en',
                  potentialAction: {
                    '@type': 'SearchAction',
                    target: 'https://urufulabs.xyz/discover?q={search_term_string}',
                    'query-input': 'required name=search_term_string',
                  },
                },
              ],
            }),
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          <CursorMascot />
          <AudioBindings />
          <WelcomeModal />
          <header
            className="px-3 sm:px-4 py-2 flex items-center justify-between gap-2 flex-wrap"
            style={{ borderBottom: '1.5px solid var(--anchor)', background: 'var(--cream)', color: 'var(--anchor)' }}
          >
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <span
                aria-hidden
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm"
                style={{
                  background: 'var(--pink-hot)',
                  color: '#fff',
                  border: '1.5px solid var(--anchor)',
                  boxShadow: '2px 2px 0 var(--anchor)',
                  fontFamily: 'var(--font-jp), "DotGothic16", monospace',
                }}
              >
                ウ
              </span>
              <span
                className="uru-h1"
                style={{ fontSize: 'clamp(16px, 4vw, 22px)' }}
              >
                urufu<span style={{ color: 'var(--pink-hot)' }}>labs</span>
                <sup style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: '10px', marginLeft: 2 }}>®</sup>
              </span>
            </Link>
            {/* Nav: primary links only on ≥sm, chain switcher + wallet stay visible on every size */}
            <nav
              className="flex items-center gap-2 sm:gap-3 text-[12px] sm:text-[13px] flex-wrap justify-end"
              style={{ fontFamily: 'var(--font-round), Klee One, cursive' }}
              aria-label="primary navigation"
            >
              <Link href="/create" className="hover:underline hidden sm:inline" style={{ color: 'var(--anchor)' }}>✿ shop</Link>
              <Link href="/discover" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>❁ launches</Link>
              <Link href="/trade" className="hover:underline hidden sm:inline" style={{ color: 'var(--anchor)' }}>✦ trade</Link>
              <Link href="/feed" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>☆ feed</Link>
              <Link href="/profile" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>♡ profile</Link>
              <a
                href="https://www.urufu.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline hidden md:inline"
                style={{ color: 'var(--pink-hot)' }}
              >
                ❋ urufu gemu ↗
              </a>
              {/* mobile-only compact menu */}
              <Link href="/create" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="shop">✿</Link>
              <Link href="/trade" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="trade">✦</Link>
              <Link href="/profile" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="profile">♡</Link>
              {/* Theme + audio hide under `sm` — the header runs out of room and both are
                  reachable elsewhere (theme toggle re-appears in the footer strip; audio
                  is a nice-to-have that autoplay-blocks anyway on mobile). Chain switcher
                  + wallet are the two non-negotiables since they gate every interaction. */}
              <div className="hidden sm:contents">
                <PriceUnitToggle />
                <ThemeToggle />
                <AudioToggle />
              </div>
              <ChainSwitcher />
              <WalletButton />
            </nav>
          </header>
          <TokenTicker />
          <main className="flex-1">{children}</main>
          <footer
            className="mt-8 px-4 py-4 text-center"
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: '11px',
              color: 'var(--anchor)',
              borderTop: '1.5px dashed var(--anchor)',
              background: 'var(--cream)',
            }}
          >
            {/* Utility + external links. Shelf + docs live down here so the header
                stays focused on the primary launch / trade / discover flow. */}
            <nav
              className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2"
              style={{ fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 12 }}
              aria-label="footer links"
            >
              <Link href="/catalog" className="hover:underline" style={{ color: 'var(--anchor)' }}>❀ shelf</Link>
              <Link href="/docs" className="hover:underline" style={{ color: 'var(--anchor)' }}>❉ docs</Link>
              <Link href="/recover" className="hover:underline" style={{ color: 'var(--anchor)' }}>✿ recover eth</Link>
              <a
                href="https://x.com/urugemu"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: 'var(--anchor)' }}
              >
                ✧ twitter ↗
              </a>
              <a
                href="https://t.me/urugemu"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: 'var(--anchor)' }}
              >
                ✧ telegram ↗
              </a>
              <a
                href="https://www.urufu.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                style={{ color: 'var(--pink-hot)' }}
              >
                ❋ urufu gemu ↗
              </a>
            </nav>
            <div style={{ marginTop: 10 }}>site by ❀ urufu labs ❀ last updated 2026-07-14 ❀ best viewed on desktop lol</div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>a launchpad, not a landing pad (づ｡◕‿‿◕｡)づ</div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>
              powered by{' '}
              <a
                href="https://docs.uniswap.org/contracts/v4/overview"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
              >
                uniswap v4 hooks
              </a>
            </div>
            {/* Mobile-only theme + audio row — the header hides these under sm because
                room is scarce; surface them here so touch users can still flip themes. */}
            <div
              className="sm:hidden"
              style={{ marginTop: 10, display: 'flex', justifyContent: 'center', gap: 12 }}
            >
              <ThemeToggle />
              <AudioToggle />
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
