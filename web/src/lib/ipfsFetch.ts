/// IPFS reads for NFT metadata and art.
///
/// Not memoized here — callers (component effects) hold their own state and
/// re-run only when the source URI changes.

/// All IPFS reads go through our own /api/ipfs route, which tries Pinata first
/// and then other public gateways server-side, and caches each file forever.
/// Reading public gateways straight from the browser broke in 2026-10:
/// nftstorage.link and w3s.link now only redirect to ipfs.io / dweb.link,
/// which rate-limit, and cloudflare-ipfs.com is gone.
const IPFS_PROXY = '/api/ipfs/';

// The route tries up to four gateways server-side, so allow it some time.
const FETCH_TIMEOUT_MS = 30_000;

// Any gateway link like https://<host>/ipfs/<cid>/..., so links saved
// earlier (the indexer stored nftstorage.link URLs) still load.
const GATEWAY_LINK_RE = /^https?:\/\/[^/]+\/ipfs\/(.+)$/;

/// Convert ipfs://<cid>/<path> (or an old gateway link) to our /api/ipfs route.
/// Passes through other http(s):// URLs unchanged, returns null on anything else.
export function toGatewayUrl(uri: string | undefined | null): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    return `${IPFS_PROXY}${uri.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }
  const m = GATEWAY_LINK_RE.exec(uri);
  if (m) return `${IPFS_PROXY}${m[1]}`;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

/// Fetch JSON from an ipfs:// URI (or plain http URL). Tries the raw path AND
/// a `.json`-suffixed path, since some pinners (Pinata via studio.urufulabs.xyz)
/// write files with `.json` extensions while ERC721A's tokenURI concatenates
/// baseURI + tokenId with no suffix.
export async function fetchIpfsJson<T = unknown>(uri: string | undefined): Promise<T | null> {
  const url = toGatewayUrl(uri);
  if (!url) return null;
  // Only try the .json variant when the URI doesn't already end in .json
  // AND doesn't have any other extension (e.g. /1.png shouldn't get .json).
  const trailing = url.split('/').pop() ?? '';
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(trailing);
  const suffixes = hasExt ? [''] : ['', '.json'];
  // Ask for both names at once: a missing name makes the route wait on every
  // gateway before answering 404, which used to delay covers ~30s.
  const attempts = suffixes.map(async (suffix) => {
    const res = await fetch(url + suffix, {
      cache: 'force-cache',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as T;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}
