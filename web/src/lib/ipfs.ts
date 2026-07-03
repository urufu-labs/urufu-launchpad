/// Pinata (or any IPFS pinning service) uploads for token metadata. Wired defensively:
/// if no JWT is set, or the upload fails, callers fall back to the localStorage-only path
/// so preview + broadcast day both work. The launched-token metadata payload is a small
/// JSON blob + a data-URL logo — <10KB most of the time — so we upload the JSON directly.
///
/// Env vars (all client-safe; add them to `.env` under NEXT_PUBLIC_):
///   NEXT_PUBLIC_PINATA_JWT       — Pinata gateway JWT with pinFileToIPFS scope.
///   NEXT_PUBLIC_PINATA_GATEWAY   — Public gateway URL, e.g. `mypinata.mypinata.cloud`.
///                                  Defaults to the shared cloudflare-ipfs gateway.
///
/// Alternate providers (NFT.Storage, Web3.Storage, self-hosted Kubo) can swap the fetch
/// URL and Bearer scheme — this file is the only place that needs to change.

import type { TokenMetadata } from './metadata';

const PINATA_JWT = process.env.NEXT_PUBLIC_PINATA_JWT ?? '';
const PINATA_GATEWAY = process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? 'gateway.pinata.cloud';
const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

export function ipfsEnabled(): boolean {
  return PINATA_JWT.length > 0;
}

export function ipfsGatewayUrl(cid: string): string {
  return `https://${PINATA_GATEWAY.replace(/^https?:\/\//, '')}/ipfs/${cid}`;
}

/// Upload a token metadata payload to IPFS. Returns the CID + a public gateway URL, or
/// `null` if IPFS isn't configured / the upload failed. The caller keeps the localStorage
/// copy as a fallback either way.
export async function uploadMetadataToIpfs(
  metadata: Omit<TokenMetadata, 'savedAt' | 'cid' | 'gatewayUrl'>,
): Promise<{ cid: string; gatewayUrl: string } | null> {
  if (!ipfsEnabled()) return null;

  const body = {
    pinataContent: metadata,
    pinataMetadata: {
      name: `urufu-labs-token-${Date.now()}`,
    },
  };

  try {
    const res = await fetch(PINATA_PIN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn('pinata pin failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = (await res.json()) as { IpfsHash?: string };
    const cid = json.IpfsHash;
    if (!cid) return null;
    return { cid, gatewayUrl: ipfsGatewayUrl(cid) };
  } catch (err) {
    console.warn('pinata upload error', err);
    return null;
  }
}

/// Fetch a previously-pinned metadata blob from IPFS. Returns null on any failure so the
/// caller can fall back to loadMetadata (localStorage).
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
