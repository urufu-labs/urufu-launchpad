/// Multi-gateway IPFS JSON fetcher. `ipfs.io` is often slow or timing out
/// (routinely > 20s on fresh pins), which was leaving NFT tiles image-less
/// even when the metadata was valid. Try a small ordered list of well-known
/// gateways and return the first response that lands.
///
/// Not memoized here — callers (component effects) hold their own state and
/// re-run only when the source URI changes.

/// Ordered by observed CORS + latency reliability. nftstorage / w3s / dweb
/// serve public content without auth and rarely throttle single fetches;
/// Pinata's public gateway ranks lower because unauthenticated cross-account
/// pins increasingly get 403/429ed there. ipfs.io stays last as a
/// desperate fallback (routinely 20s+ timeouts).
const IPFS_GATEWAYS = [
  'https://nftstorage.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
] as const;

const PER_GATEWAY_TIMEOUT_MS = 6_000;

/// Convert ipfs://<cid>/<path> to https://<gateway>/<cid>/<path>. Passes
/// through http(s):// URLs unchanged, returns null on anything else.
export function toGatewayUrl(uri: string | undefined, gateway: string = IPFS_GATEWAYS[0]): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return `${gateway}${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

/// Fetch JSON from an ipfs:// URI (or plain http URL). Tries each gateway
/// with both the raw path AND a `.json`-suffixed path, since some pinners
/// (Pinata via studio.urufulabs.xyz) write files with `.json` extensions
/// while ERC721A's tokenURI concatenates baseURI + tokenId with no suffix.
export async function fetchIpfsJson<T = unknown>(uri: string | undefined): Promise<T | null> {
  if (!uri) return null;
  const gateways = uri.startsWith('ipfs://') ? IPFS_GATEWAYS : ['' as const];
  // Only try the .json variant when the URI doesn't already end in .json
  // AND doesn't have any other extension (e.g. /1.png shouldn't get .json).
  const trailing = uri.split('/').pop() ?? '';
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(trailing);
  const suffixes = hasExt ? ['' as const] : ['', '.json'] as const;
  for (const suffix of suffixes) {
    for (const gateway of gateways) {
      const url = gateway ? toGatewayUrl(uri, gateway) : uri;
      if (!url) continue;
      try {
        const res = await fetch(url + suffix, {
          cache: 'force-cache',
          signal: AbortSignal.timeout(PER_GATEWAY_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        return await res.json() as T;
      } catch {
        // timeout / network / parse — try next
      }
    }
  }
  return null;
}
