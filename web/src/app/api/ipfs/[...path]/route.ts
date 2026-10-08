/// GET /api/ipfs/<cid>/<path...>
///
/// Server-side IPFS reader for NFT metadata and art. Browsers fetching public
/// gateways directly kept breaking: nftstorage.link and w3s.link now just
/// redirect to ipfs.io / dweb.link, those two rate-limit (429, Retry-After 900),
/// and cloudflare-ipfs.com is gone. Here we try a few gateways in order and
/// return the first real answer. IPFS content never changes for a given CID,
/// so successful responses are cached by the CDN forever and each file is
/// pulled from a gateway roughly once.

import { type NextRequest } from 'next/server';

export const runtime = 'nodejs';

const GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
] as const;

const PER_GATEWAY_TIMEOUT_MS = 8_000;
const MAX_BYTES = 25 * 1024 * 1024;

// CIDv0 (Qm...) or CIDv1 base32 (b...). Anything else is not an IPFS path.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const SEGMENT_RE = /^[A-Za-z0-9._~%-]+$/;

const ALLOWED_TYPE_RE = /^(image\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/json|text\/plain|application\/octet-stream)$/;

const FOREVER ='public, max-age=31536000, immutable';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  if (!path?.length || !CID_RE.test(path[0]) || !path.every((s) => SEGMENT_RE.test(s) && s !== '..')) {
    return new Response('not an ipfs path', { status: 400 });
  }
  const ipfsPath = path.join('/');

  let sawNotFound = false;
  for (const gw of GATEWAYS) {
    try {
      const res = await fetch(gw + ipfsPath, {
        signal: AbortSignal.timeout(PER_GATEWAY_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (res.status === 404) { sawNotFound = true; continue; }
      if (!res.ok || !res.body) continue;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) return new Response('file too large', { status: 413 });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      // Only metadata and media. Anything else (html, js, ...) would be served
      // from our own origin, so refuse it rather than proxy it.
      if (!ALLOWED_TYPE_RE.test(type)) {
        return new Response('unsupported file type', { status: 415, headers: { 'cache-control': FOREVER } });
      }
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES) return new Response('file too large', { status: 413 });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          'cache-control': FOREVER,
          'cdn-cache-control': FOREVER,
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
          // SVGs can carry script; if one is opened directly it runs with no powers.
          'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        },
      });
    } catch {
      // timeout / network: try the next gateway
    }
  }
  // A short cache on misses so a file pinned a minute later still shows up soon.
  return new Response(sawNotFound ? 'not found' : 'ipfs gateways unavailable', {
    status: sawNotFound ? 404 : 502,
    headers: { 'cache-control': 'public, max-age=60' },
  });
}
