/// IPFS uploads go through the compile-service pin proxy — the Pinata JWT stays
/// server-side so a leaked frontend bundle can't burn our Pinata quota. The client
/// just posts a base64 data URL; the server forwards to Pinata and returns the CID
/// + public gateway URL.
///
/// Env vars:
///   NEXT_PUBLIC_COMPILE_SERVICE_URL  — where /pin/file lives (already used for
///                                       /compile). No PINATA_JWT on the client anymore.
///   NEXT_PUBLIC_PINATA_GATEWAY       — public gateway host. Not a secret — used only
///                                       to construct URLs for reads; the proxy returns
///                                       its own gateway URL anyway.
///
/// Behavior: if the server isn't set up (returns 503 or is unreachable), the caller
/// keeps the localStorage snapshot as a fallback. The image just won't render on
/// other browsers until Pinata is wired.

import type { TokenMetadata } from './metadata';

const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';
const PUBLIC_GATEWAY = process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? 'gateway.pinata.cloud';

/// Ipfs is "enabled" whenever we can reach the pin proxy. We can't know for sure
/// without a probe, so callers should just try — the proxy responds with 503 when
/// PINATA_JWT isn't set server-side and we surface null to the caller.
export function ipfsEnabled(): boolean {
  return typeof COMPILE_SERVICE_URL === 'string' && COMPILE_SERVICE_URL.length > 0;
}

export function ipfsGatewayUrl(cid: string): string {
  return `https://${PUBLIC_GATEWAY.replace(/^https?:\/\//, '')}/ipfs/${cid}`;
}

/// Upload a base64 data URL through the pin proxy. Returns { cid, gatewayUrl } on
/// success, null on any failure — the caller keeps the local snapshot either way.
export async function uploadImageToIpfs(
  dataUrl: string,
): Promise<{ cid: string; gatewayUrl: string } | null> {
  if (!ipfsEnabled()) return null;
  if (!dataUrl.startsWith('data:')) return null;
  try {
    const res = await fetch(`${COMPILE_SERVICE_URL}/pin/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { cid?: string; gatewayUrl?: string };
    if (!json.cid || !json.gatewayUrl) return null;
    return { cid: json.cid, gatewayUrl: json.gatewayUrl };
  } catch {
    return null;
  }
}

/// Legacy shim — the old flow pinned the entire metadata JSON. We now pin just the
/// image (as a file) and store the rest in Postgres via the metadata API, so this
/// helper is preserved only for callers still expecting the old shape. It calls the
/// image pin path and returns the gateway URL — good enough for the compatibility
/// layer, but new call sites should use `uploadImageToIpfs` directly.
export async function uploadMetadataToIpfs(
  metadata: Omit<TokenMetadata, 'savedAt' | 'cid' | 'gatewayUrl'>,
): Promise<{ cid: string; gatewayUrl: string } | null> {
  if (!metadata.logoDataUrl) return null;
  return uploadImageToIpfs(metadata.logoDataUrl);
}

/// Fetch a previously-pinned JSON blob. Left for one-off dev use; the runtime path
/// now hits the metadata API for shared reads.
export async function fetchMetadataFromIpfs(cid: string): Promise<TokenMetadata | null> {
  try {
    const res = await fetch(ipfsGatewayUrl(cid), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as TokenMetadata;
    return json;
  } catch {
    return null;
  }
}
