import type { Metadata, ResolvingMetadata } from 'next';

import { fetchLaunchesByTokens } from '@/lib/indexer';
import { fetchTokenMetadata } from '@/lib/socialApi';
import { absoluteImage, STATIC_OG } from '@/lib/sharePreview';

/// Server-side metadata for /trade/:address. The page itself is `'use client'`
/// so we can't put `generateMetadata` there — this layout is the tiniest server
/// wrapper whose only job is to compute per-token OpenGraph + Twitter card tags.
///
/// Without this, share previews inherit the root layout's site-wide title
/// ("urufu labs tap tap launch") + description, so every shared token looks
/// identical on Discord / Twitter / iMessage. With it, each share card shows
/// the token's real ticker, name, and description.
///
/// The preview image is the token logo (or the static urufu image), set
/// below, so the crawler gets a full preview: image + title + description.

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

  // Description: wrap the launcher's own description (or a friendly default)
  // in a cute urufu-labs frame so every share card reads playfully.
  const rawDesc = meta?.description?.trim();
  const tickerPart = ticker ? `$${ticker}` : displayTitle;
  const opener = `${tickerPart} launched on urufu labs`;
  const midParts: string[] = [];
  if (rawDesc) midParts.push(rawDesc);
  midParts.push('tap tap trade on urufulabs.xyz ~');
  // Twitter caps descriptions around 200 chars — keep the whole thing tight
  // so the crawler doesn't truncate mid-word.
  const description = `${opener} ~ ${midParts.join(' ~ ')}`.slice(0, 197).replace(/\s+$/, '');

  const pageUrl = `https://urufulabs.xyz/trade/${addr}`;

  // The token's own logo, linked directly (our /api/ipfs route or the
  // launcher's https link), else the static urufu image. Nothing is drawn:
  // the old colocated opengraph-image.tsx (satori) 500'd on real uploads and
  // Vercel cached the failures, and as a file convention it also overrode
  // these tags. It was removed 2026-10-24 (lib/sharePreview.ts).
  const image = absoluteImage(meta?.imageUrl) ?? STATIC_OG;

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
      images: [{ url: image, alt: displayTitle }],
    },
    twitter: {
      card: 'summary_large_image',
      title: displayTitle,
      description,
      images: [image],
    },
  };
}

export default function TradeAddressLayout({ children }: { children: React.ReactNode }) {
  return children;
}
