import type { Address } from 'viem';

/// Client-side token metadata. Pump.fun-style: every launched token gets logo + description +
/// socials. Stored in localStorage for MVP; a proper Pinata + indexer pipeline lands in Phase 5.
export interface TokenMetadata {
  /// data:image/... URL. Kept inline to avoid an IPFS dep in Phase 1; ceiling ~256KB per token.
  logoDataUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  /// Set when the metadata has been uploaded to IPFS. `gatewayUrl` is the CDN read path.
  cid?: string;
  gatewayUrl?: string;
  savedAt: number;
}

const LOCAL_STORAGE_PREFIX = 'vm:metadata:';
const MAX_LOGO_BYTES = 256 * 1024; // 256 KB — small enough for a data URL, large enough for a decent PNG/SVG.

export function keyFor(chainId: number | string, tokenAddress: Address): string {
  return `${LOCAL_STORAGE_PREFIX}${chainId}:${tokenAddress.toLowerCase()}`;
}

export function saveMetadata(
  chainId: number | string,
  tokenAddress: Address,
  data: Omit<TokenMetadata, 'savedAt'>,
): void {
  if (typeof window === 'undefined') return;
  const record: TokenMetadata = { ...data, savedAt: Date.now() };
  try {
    localStorage.setItem(keyFor(chainId, tokenAddress), JSON.stringify(record));
  } catch (err) {
    // Storage full or blocked — swallow. UI shows a "couldn't save" note if needed.
    console.warn('vm metadata save failed', err);
  }
}

export function loadMetadata(chainId: number | string, tokenAddress: Address): TokenMetadata | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(keyFor(chainId, tokenAddress));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenMetadata;
  } catch {
    return null;
  }
}

/// Persist metadata to BOTH IPFS (when enabled) and localStorage. IPFS is best-effort:
/// the local copy always wins for the immediate post-launch UI, and the CID gets stored
/// alongside once the pin returns so anyone opening the same token page later can
/// hydrate from the gateway. The Pinata JWT lives in NEXT_PUBLIC_PINATA_JWT — see ipfs.ts.
export async function persistMetadata(
  chainId: number | string,
  tokenAddress: Address,
  data: Omit<TokenMetadata, 'savedAt' | 'cid' | 'gatewayUrl'>,
): Promise<TokenMetadata> {
  // Lazy import so bundlers don't drag Pinata into every page.
  const { uploadMetadataToIpfs } = await import('./ipfs');
  const pin = await uploadMetadataToIpfs(data);
  const record: TokenMetadata = {
    ...data,
    ...(pin ? { cid: pin.cid, gatewayUrl: pin.gatewayUrl } : {}),
    savedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(keyFor(chainId, tokenAddress), JSON.stringify(record));
    } catch (err) {
      console.warn('vm metadata local save failed', err);
    }
  }
  return record;
}

/// Read an uploaded file as a data URL. Rejects when the file is too large.
export async function readFileAsDataUrl(file: File): Promise<string> {
  if (file.size > MAX_LOGO_BYTES) {
    throw new Error(`Logo too large — max ${Math.floor(MAX_LOGO_BYTES / 1024)}KB, got ${Math.floor(file.size / 1024)}KB.`);
  }
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
