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

/// Fetch JSON from an ipfs:// URI (or plain http URL). Races through the
/// gateway list until one returns a good response; falls through null if
/// every gateway fails.
export async function fetchIpfsJson<T = unknown>(uri: string | undefined): Promise<T | null> {
  if (!uri) return null;
  const gateways = uri.startsWith('ipfs://') ? IPFS_GATEWAYS : ['' as const];
  for (const gateway of gateways) {
    const url = gateway ? toGatewayUrl(uri, gateway) : uri;
    if (!url) continue;
    try {
      const res = await fetch(url, {
        cache: 'force-cache',
        signal: AbortSignal.timeout(PER_GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      return await res.json() as T;
    } catch {
      // timeout / network / parse — try next
    }
  }
  return null;
}
