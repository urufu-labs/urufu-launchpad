import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

import { Providers } from './providers';
import { CursorMascot } from '@/components/CursorMascot';
import { AudioBindings } from '@/components/AudioBindings';
import { TokenTicker } from '@/components/TokenTicker';
import { SiteHeader } from '@/components/shell/SiteHeader';
import { SiteFooter } from '@/components/shell/SiteFooter';
import { MobileTabBar } from '@/components/shell/MobileTabBar';

// v2 type: one UI sans + one mono for numbers (docs/PLAN-ui-revamp.md).
// The legacy font roles (--font-display/round/pixel/jp/body) alias to the sans
// in styles/tokens.css, so existing inline styles pick it up automatically.
const sans = Hanken_Grotesk({
  variable: '--font-hanken',
  weight: ['400', '500', '600', '700', '800'],
  subsets: ['latin', 'latin-ext'],
});

// Display face for big headlines only (hero, page titles). Gives the site its
// voice; everything else stays in the UI sans.
const display = Instrument_Serif({
  variable: '--font-instrument',
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin', 'latin-ext'],
});

// Tabular figures + slashed zero so prices, caps and counts read fast.
const mono = JetBrains_Mono({
  variable: '--font-jetbrains',
  weight: ['400', '500', '600'],
  subsets: ['latin'],
});

// One line, shows in browser tabs + link previews. Slogan-shaped.
const TAGLINE = 'Launch a token in one click. Liquidity locks forever when it graduates.';
const TITLE = 'urufu labs · token launchpad';
const DESCRIPTION = 'Launch a token on Robinhood Chain. When it fills the bonding curve, liquidity moves to Uniswap v4 and locks forever, and trading fees reward urufu gemu nft holders.';

/// Viewport meta — required for mobile so pages render at device width instead of the
/// legacy 980px "desktop" fallback. `viewportFit: cover` lets the paper background bleed
/// under the notch on iOS. `themeColor` matches --bg (styles/tokens.css) so the address
/// bar tints with the site paint instead of Safari's default white.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F3F3F0' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0B0C' },
  ],
};

export const metadata: Metadata = {
  // Absolute URL base for OG image + canonical resolution — Twitter/Facebook/Discord
  // won't fetch relative image paths, so social previews stay blank without this.
  metadataBase: new URL('https://urufulabs.xyz'),
  title: TITLE,
  description: DESCRIPTION,
  // Icons come from the app-router conventions: src/app/favicon.ico, icon.png and
  // apple-icon.png (built by web/scripts/make-brand-icons.py).
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
      className={`${sans.variable} ${display.variable} ${mono.variable} h-full`}
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
          <SiteHeader />
          <TokenTicker />
          <main className="flex-1">{children}</main>
          <SiteFooter />
          <MobileTabBar />
        </Providers>
      </body>
    </html>
  );
}
