/// Stable OpenSea-style metadata for pre-launch NFT gallery smoke tests.
/// Any collection launched with baseURI = `https://urufulabs.xyz/api/nft-test/`
/// will resolve `tokenURI(N)` to this route and serve a real cover image so
/// Alchemy's indexer can cache + surface it in the profile "your nfts" grid.
///
/// Public + cache-friendly; no state, no auth. Image URL is picsum with a
/// per-tokenId seed so each token gets its own deterministic random photo.
/// Never used for a real launch — the /create/nft form always requires the
/// launcher to supply their own baseURI.

import { type NextRequest } from 'next/server';

export const runtime = 'edge';

export function GET(_req: NextRequest, { params }: { params: { tokenId: string } }): Response {
  const tokenId = params.tokenId;
  const numeric = Number.parseInt(tokenId, 10);
  const displayId = Number.isFinite(numeric) ? String(numeric) : 'x';
  return Response.json(
    {
      name: `Launchpad Smoke #${displayId}`,
      description: 'Placeholder metadata used by the gallery smoke test. Not a real launch.',
      image: `https://picsum.photos/seed/urufu-launchpad-smoke-${displayId}/500/500`,
    },
    {
      headers: {
        // Long cache — metadata is deterministic per tokenId.
        'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      },
    },
  );
}
