/// Client for the compile-service /nft/:chain/:contract/holders route.
/// Alchemy's getOwnersForContract behind our own cache + rate limit so the
/// API key stays server-side and repeated views of the same collection
/// don't burn provider quota.

import type { Address } from 'viem';

const BASE_URL = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

export interface NftHolder {
  address: string;
  balance: number;
  tokenIds: string[];
}

export interface NftHoldersScan {
  chainId: number;
  chain: string;
  contractAddress: string;
  holders: NftHolder[];
  nextCursor: string | null;
}

export async function fetchNftHolders(
  chain: string,
  contract: Address | string,
  options: { cursor?: string; limit?: number } = {},
): Promise<NftHoldersScan | null> {
  const url = new URL(`${BASE_URL.replace(/\/$/, '')}/nft/${chain}/${contract.toString().toLowerCase()}/holders`);
  if (options.cursor) url.searchParams.set('cursor', options.cursor);
  if (options.limit) url.searchParams.set('limit', String(options.limit));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return await res.json() as NftHoldersScan;
  } catch {
    return null;
  }
}
