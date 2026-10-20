'use client';

/// Square NFT image. Uses the server-cached metadata image when the
/// marketplace already has it, otherwise reads tokenURI on chain and
/// resolves the JSON through our /api/ipfs route.

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useReadContract } from 'wagmi';

import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { ERC721_MARKET_ABI, MARKET_CHAIN_ID } from '@/lib/market';
import { safeBackgroundImage } from '@/lib/metadata';

export function useTokenImage(collection: Address, tokenId: string, known: string | null | undefined): string | null {
  const { data: uri } = useReadContract({
    address: collection,
    abi: ERC721_MARKET_ABI,
    functionName: 'tokenURI',
    args: [BigInt(tokenId)],
    chainId: MARKET_CHAIN_ID,
    query: { enabled: !known, staleTime: 300_000, retry: false },
  });
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    if (known || !uri) return;
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(uri);
      if (!cancelled) setImg(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [known, uri]);
  return known ? toGatewayUrl(known) : img;
}

export function TokenArt({
  collection,
  tokenId,
  image,
  className,
}: {
  collection: Address;
  tokenId: string;
  image?: string | null;
  className?: string;
}) {
  const src = useTokenImage(collection, tokenId, image);
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ background: safeBackgroundImage(src, undefined, 'contain') }}
    />
  );
}
