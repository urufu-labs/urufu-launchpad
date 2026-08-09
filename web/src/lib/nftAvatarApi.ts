import type { Address } from 'viem';

const BASE_URL = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

export interface NftAvatarSource {
  chainId: number;
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionName: string | null;
  tokenName: string | null;
}

export interface WalletNftAvatar extends NftAvatarSource {
  imageUrl: string;
}

export interface WalletNftChain {
  id: string;
  label: string;
  chainId: number;
  items: WalletNftAvatar[];
  nextCursor: string | null;
  error?: string;
}

export interface WalletNftScan {
  chains: WalletNftChain[];
}

export class WalletNftScanError extends Error {}

export async function fetchWalletNfts(
  address: Address | string,
  options: { chain?: string; cursor?: string } = {},
): Promise<WalletNftScan> {
  const url = new URL(`${BASE_URL.replace(/\/$/, '')}/wallet/${address.toLowerCase()}/nfts`);
  if (options.chain) url.searchParams.set('chain', options.chain);
  if (options.cursor) url.searchParams.set('cursor', options.cursor);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      throw new WalletNftScanError(body.code === 'NFT_SCANNER_NOT_CONFIGURED'
        ? 'NFT scanner is not configured yet.'
        : 'Could not scan this wallet’s NFTs right now.');
    }
    return await res.json() as WalletNftScan;
  } catch (err) {
    if (err instanceof WalletNftScanError) throw err;
    throw new WalletNftScanError('Could not reach the NFT scanner.');
  }
}
