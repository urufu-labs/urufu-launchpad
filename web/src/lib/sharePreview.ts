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

/// A token's metadata file that /api/ipfs hasn't cached yet takes 4-5s
/// (measured 2026-10-24), so a single NFT's preview waits a bit longer.
const NFT_META_TIMEOUT_MS = 6_000;

/// One NFT's metadata: <baseURI><tokenId>.json, or null if missing or slow.
async function nftMetadata(
  baseUri: string | undefined,
  tokenId: string,
  ms = TIMEOUT_MS,
): Promise<{ image?: string; name?: string } | null> {
  if (!baseUri) return null;
  const metaUrl = absoluteImage(`${baseUri}${tokenId}.json`);
  if (!metaUrl) return null;
  const res = await withTimeout(fetch(metaUrl, { signal: AbortSignal.timeout(ms) }), ms);
  if (!res || !res.ok) return null;
  return withTimeout(res.json() as Promise<{ image?: string; name?: string }>);
}

/// Art of the collection's first NFT: <baseURI>1.json -> image.
async function firstNftImage(baseUri: string | undefined): Promise<string | null> {
  return absoluteImage((await nftMetadata(baseUri, '1'))?.image);
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

/// Preview for /collection/[address]/[tokenId]: that NFT's own art and name.
/// Anything missing or slow falls back to the collection preview.
export async function nftPreview(address: string, tokenId: string): Promise<Metadata> {
  const addr = address.toLowerCase() as `0x${string}`;
  if (!/^0x[0-9a-f]{40}$/.test(addr) || !/^\d{1,78}$/.test(tokenId)) {
    return collectionPreview(address, 'collection');
  }
  const rows = await withTimeout(fetchNftCollectionsByAddresses([addr]));
  const row = rows?.find((r) => r.collectionAddress.toLowerCase() === addr);
  const meta = await nftMetadata(row?.baseUri, tokenId, NFT_META_TIMEOUT_MS);
  const image = absoluteImage(meta?.image);
  if (!row || !image) return collectionPreview(address, 'collection');

  const collectionName = row.name || 'NFT collection';
  // Many collections name tokens just "1", "2": show those as "#1".
  const ownName = typeof meta?.name === 'string' ? meta.name.trim() : '';
  const nftName = ownName && !/^\d+$/.test(ownName) ? ownName : `#${ownName || tokenId}`;
  const title = `${nftName} | ${collectionName}`;
  const description = trimDescription(
    `${nftName} from ${collectionName}. See it and trade it on urufulabs.xyz. 0% marketplace fee.`,
  );
  const url = `${SITE}/collection/${addr}/${tokenId}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: 'website', images: [{ url: image, alt: nftName }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}
