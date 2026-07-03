import type { Metadata } from 'next';
import { Yusei_Magic, Klee_One, Pixelify_Sans, DotGothic16 } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

import { Providers } from './providers';
import { WalletButton } from '@/components/WalletButton';
import { ChainSwitcher } from '@/components/ChainSwitcher';
import { CursorMascot } from '@/components/CursorMascot';
import { AudioBindings } from '@/components/AudioBindings';
import { AudioToggle } from '@/components/AudioToggle';
import { TokenTicker } from '@/components/TokenTicker';

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

// One line, shows in browser tabs + link previews. Slogan-shaped.
const TAGLINE = 'tap tap launch ✿ liquidity locked forever ✿ 好き好き大好き';
const TITLE = 'urufu labs ✿ tap tap launch';
const DESCRIPTION = 'make ur token, hit launch, done ✿ once it takes off the liquidity locks forever, and every trade rewards urufu gemu nft holders ~';

export const metadata: Metadata = {
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
    images: ['/og.svg'],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: TAGLINE,
    images: ['/og.svg'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${yusei.variable} ${klee.variable} ${pixel.variable} ${dot.variable} h-full`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <CursorMascot />
          <AudioBindings />
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
            >
              <Link href="/create" className="hover:underline hidden sm:inline" style={{ color: 'var(--anchor)' }}>✿ shop</Link>
              <Link href="/catalog" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>❀ shelf</Link>
              <Link href="/discover" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>❁ launches</Link>
              <Link href="/trade" className="hover:underline hidden sm:inline" style={{ color: 'var(--anchor)' }}>✦ trade</Link>
              <Link href="/feed" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>☆ feed</Link>
              <Link href="/profile" className="hover:underline hidden md:inline" style={{ color: 'var(--anchor)' }}>♡ profile</Link>
              {/* mobile-only compact menu */}
              <Link href="/create" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="shop">✿</Link>
              <Link href="/trade" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="trade">✦</Link>
              <Link href="/profile" className="hover:underline sm:hidden" style={{ color: 'var(--anchor)' }} aria-label="profile">♡</Link>
              <AudioToggle />
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
            <div>site by ❀ urufu labs ❀ last updated 2026-07-01 ❀ best viewed on desktop lol</div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>a launchpad, not a landing pad (づ｡◕‿‿◕｡)づ</div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
