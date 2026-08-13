import type { Metadata, ResolvingMetadata } from 'next';

import { fetchLaunchesByTokens } from '@/lib/indexer';
import { fetchTokenMetadata } from '@/lib/socialApi';

/// Server-side metadata for /trade/:address. The page itself is `'use client'`
/// so we can't put `generateMetadata` there — this layout is the tiniest server
/// wrapper whose only job is to compute per-token OpenGraph + Twitter card tags.
///
/// Without this, share previews inherit the root layout's site-wide title
/// ("urufu labs ✿ tap tap launch") + description, so every shared token looks
/// identical on Discord / Twitter / iMessage. With it, each share card shows
/// the token's real ticker, name, and description.
///
/// The corresponding /trade/[address]/opengraph-image.tsx already generates a
/// dynamic image with the token's logo. Both signals together give the crawler
/// a full preview: image + title + description.

// Same short timeout as the OG image — social crawlers give up fast and we
// prefer a partially-correct card over none. Failures fall through to the
// root layout's defaults via `parent`.
const TIMEOUT_MS = 4_000;

async function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
  ]).catch(() => null);
}

export async function generateMetadata(
  { params }: { params: Promise<{ address: string }> },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { address } = await params;
  const addr = address.toLowerCase() as `0x${string}`;

  const [rows, meta, prev] = await Promise.all([
    withTimeout(fetchLaunchesByTokens([addr])),
    // 4663 = Robinhood. Only live chain right now; broaden when we re-enable
    // additional chains in launchpadStatus.
    withTimeout(fetchTokenMetadata(4663, addr)),
    parent,
  ]);

  const row = rows?.[0];
  const name = row?.name ?? 'Launched Token';
  const ticker = row?.ticker ?? '';
  const displayTitle = ticker ? `$${ticker} ~ ${name}` : name;

  // Description: prefer the launcher's own; fall back to a short branded line.
  const description = meta?.description?.trim()
    ? meta.description.trim()
    : `Trade ${displayTitle} on urufu labs — culture-first token launchpad on Robinhood Chain.`;

  const pageUrl = `https://urufulabs.xyz/trade/${addr}`;

  // Force the static /og-1200x630.jpg for BOTH the OG and Twitter image.
  // The colocated opengraph-image.tsx (dynamic satori) has been unreliable
  // — HTTP 500 for tokens with any real-world uploaded image, and Vercel
  // hard-caches those 500s at the edge. Home page works because it uses
  // the static JPG; matching that pattern unbreaks share cards for every
  // trade page immediately. Per-token image customization can come back
  // later via a build-time bake if we want it.
  const STATIC_OG = 'https://urufulabs.xyz/og-1200x630.jpg';

  return {
    title: displayTitle,
    description,
    alternates: {
      canonical: pageUrl,
    },
    openGraph: {
      ...(prev.openGraph ?? {}),
      title: displayTitle,
      description,
      url: pageUrl,
      type: 'website',
      images: [{ url: STATIC_OG, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: displayTitle,
      description,
      images: [STATIC_OG],
    },
  };
}

export default function TradeAddressLayout({ children }: { children: React.ReactNode }) {
  return children;
}
