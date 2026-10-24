/// Link previews (OpenGraph + X card) built from the creator's own images.
///
/// No image is ever *drawn* here: an earlier dynamic opengraph-image (satori)
/// crashed with HTTP 500 on most real uploads and Vercel cached the failures.
/// Instead the preview points straight at the creator's image, served through
/// our /api/ipfs route (or their own https link). If nothing usable is found
/// in time, the static urufu labs image is used, so a preview never breaks.

import type { Metadata } from 'next';

import { fetchNftCollectionsByAddresses } from './indexer';
import { toAbsoluteImageUrl } from './ipfsFetch';
import { fetchCollectionMetadata } from './socialApi';

const SITE = 'https://urufulabs.xyz';
export const STATIC_OG = `${SITE}/og-1200x630.jpg`;
const ROBINHOOD = 4663;

/// Social crawlers give up fast; a preview with the fallback image beats none.
const TIMEOUT_MS = 3_500;

export async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]).catch(() => null);
}

/// An absolute https URL a crawler can fetch, or null.
export function absoluteImage(u: string | null | undefined): string | null {
  return toAbsoluteImageUrl(u, SITE);
}

/// Art of the collection's first NFT: <baseURI>1.json -> image.
async function firstNftImage(baseUri: string | undefined): Promise<string | null> {
  if (!baseUri) return null;
  const metaUrl = absoluteImage(`${baseUri}1.json`);
  if (!metaUrl) return null;
  const res = await withTimeout(fetch(metaUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
  if (!res || !res.ok) return null;
  const json = (await withTimeout(res.json() as Promise<{ image?: string }>)) ?? null;
  return absoluteImage(json?.image);
}

function trimDescription(s: string): string {
  // X shows about 200 characters; cut on a word.
  if (s.length <= 200) return s;
  return `${s.slice(0, 197).replace(/\s+\S*$/, '')}...`;
}

/// Preview for /collection/[address] and /market/[address]. Image order:
/// banner (wide, fits the card best), collection image, first NFT, urufu.
export async function collectionPreview(
  address: string,
  page: 'collection' | 'market',
): Promise<Metadata> {
  const addr = address.toLowerCase() as `0x${string}`;
  const [rows, meta] = await Promise.all([
    withTimeout(fetchNftCollectionsByAddresses([addr])),
    withTimeout(fetchCollectionMetadata(ROBINHOOD, addr)),
  ]);
  const row = rows?.find((r) => r.collectionAddress.toLowerCase() === addr) ?? rows?.[0];
  const name = row?.name || 'NFT collection';

  const image =
    absoluteImage(meta?.bannerUrl) ??
    absoluteImage(meta?.imageUrl) ??
    absoluteImage(row?.coverImageUrl) ??
    (await firstNftImage(row?.baseUri)) ??
    STATIC_OG;

  const own = (meta?.description || row?.description || '').trim();
  const fallback = page === 'market'
    ? `Buy and sell ${name} on urufulabs.xyz. 0% marketplace fee.`
    : `${name}, a collection on urufu labs. Mint and trade on urufulabs.xyz.`;
  const description = trimDescription(own || fallback);
  const title = page === 'market' ? `${name} | Marketplace` : name;
  const url = `${SITE}/${page}/${addr}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: 'website', images: [{ url: image, alt: name }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}
