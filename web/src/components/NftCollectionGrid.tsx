'use client';

/// Grid of launched NFT collections. Renders the recent nftCollections feed
/// from the indexer as clickable cards that route to /collection/[address].
/// Visual language mirrors the ERC-20 discover LaunchCard (art well, badges,
/// metrics strip, progress bar, foot) so the launchpad reads as one product.
///
/// Per-card data path:
///   - indexer: name, ticker, launchedBy, mintModuleAddress
///   - ERC-721 on-chain: totalSupply, maxSupply, tokenURI(1)
///   - mint module on-chain: basePriceWei, paymentToken
///   - tokenURI(1) → JSON → .image → gateway-resolved cover
///
/// Falls back to <NftLaunchTeaser> when the indexer returns no rows so the
/// pre-first-launch experience is unchanged.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits, zeroAddress, type Address } from 'viem';
import { useReadContracts } from 'wagmi';

import type { ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchRecentNftCollections, type IndexerNftCollection } from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { NftLaunchTeaser } from './NftLaunchTeaser';
import styles from './NftCollectionGrid.module.css';

interface Props {
  chain: ChainKey;
  chainEnabled: boolean;
  variant: 'home' | 'discover';
  limit?: number;
}

export function NftCollectionGrid({ chain, chainEnabled, variant, limit = 12 }: Props) {
  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const [items, setItems] = useState<IndexerNftCollection[] | null>(null);

  useEffect(() => {
    if (!chainEnabled) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      const rows = await fetchRecentNftCollections(limit);
      if (cancelled) return;
      setItems((rows ?? []).filter((r) => r.chainId === targetChainId));
    })();
    return () => { cancelled = true; };
  }, [chainEnabled, targetChainId, limit]);

  if ((items?.length ?? 0) === 0) {
    return <NftLaunchTeaser chainEnabled={chainEnabled} variant={variant} />;
  }

  return (
    <div className={styles.mosaic}>
      {(items ?? []).map((c) => (
        <NftCollectionCard key={c.id} row={c} chainId={targetChainId} />
      ))}
    </div>
  );
}

// ============================================================================
// Card — owns its per-collection chain reads so hooks stay stable.
// ============================================================================

const erc721Abi = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxSupply',   stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenURI',    stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const;

const mintModuleAbi = [
  { type: 'function', name: 'basePriceWei',  stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paymentToken',  stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}··${a.slice(-3)}`;
}

function NftCollectionCard({
  row,
  chainId,
}: {
  row: IndexerNftCollection & { mintModuleAddress?: Address };
  chainId: number;
}) {
  // ERC-721 reads (present regardless of mint mode). chainId gets cast to
  // wagmi's narrow chain-id union — the value always originates from
  // CHAIN_KEY_TO_ID so it's always a supported chain.
  const cid = chainId as 4663;
  const c721 = useReadContracts({
    contracts: [
      { abi: erc721Abi, address: row.collectionAddress, functionName: 'totalSupply', chainId: cid },
      { abi: erc721Abi, address: row.collectionAddress, functionName: 'maxSupply',   chainId: cid },
      { abi: erc721Abi, address: row.collectionAddress, functionName: 'tokenURI', args: [1n] as const, chainId: cid },
    ] as const,
    query: { staleTime: 30_000 },
  });
  const totalSupply = c721.data?.[0]?.result as bigint | undefined;
  const maxSupply   = c721.data?.[1]?.result as bigint | undefined;
  const tokenUri    = c721.data?.[2]?.result as string  | undefined;

  // Mint module reads (uses zeroAddress placeholder + enabled: false when
  // the join column is missing so the hook shape stays stable).
  const modAddr = (row.mintModuleAddress && row.mintModuleAddress !== zeroAddress
    ? row.mintModuleAddress
    : zeroAddress) as Address;
  const modKnown = modAddr !== zeroAddress;
  const cMod = useReadContracts({
    contracts: [
      { abi: mintModuleAbi, address: modAddr, functionName: 'basePriceWei', chainId: cid },
      { abi: mintModuleAbi, address: modAddr, functionName: 'paymentToken', chainId: cid },
    ] as const,
    query: { enabled: modKnown, staleTime: 30_000 },
  });
  const basePriceWei = cMod.data?.[0]?.result as bigint  | undefined;
  const paymentToken = cMod.data?.[1]?.result as Address | undefined;
  const isUru = paymentToken && paymentToken !== zeroAddress;

  // Cover image — resolve tokenURI(1) → JSON.image → gateway, racing
  // through multiple IPFS gateways so a single slow one (ipfs.io was
  // routinely timing out at 20s) doesn't leave the tile art-less.
  const [cover, setCover] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!tokenUri) { setCover(null); return; }
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(tokenUri);
      if (cancelled) return;
      setCover(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [tokenUri]);

  const price = useMemo(() => {
    if (basePriceWei === undefined) return '—';
    if (basePriceWei === 0n) return 'free';
    const n = Number(formatUnits(basePriceWei, 18));
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${isUru ? 'URU' : 'Ξ'}`;
  }, [basePriceWei, isUru]);

  const supplyLabel = useMemo(() => {
    const minted = totalSupply?.toString() ?? '—';
    const cap = maxSupply === undefined || maxSupply === 0n ? '∞' : maxSupply.toString();
    return `${minted}/${cap}`;
  }, [totalSupply, maxSupply]);

  const progressPct = useMemo(() => {
    if (totalSupply === undefined || maxSupply === undefined || maxSupply === 0n) return 0;
    const p = Number((totalSupply * 10_000n) / maxSupply) / 100;
    return Math.min(100, Math.max(0, p));
  }, [totalSupply, maxSupply]);

  const isSoldOut = maxSupply !== undefined && maxSupply !== 0n && totalSupply === maxSupply;
  const paidLabel = isUru ? 'uru paid' : 'eth paid';

  return (
    <Link href={`/collection/${row.collectionAddress}`} className={styles.releaseCard}>
      <div className={styles.releaseArtWrap}>
        {cover ? (
          <div
            className={styles.releaseArt}
            role="img"
            aria-label={`${row.name} cover art`}
            style={{ backgroundImage: `url("${cover}")` }}
          />
        ) : (
          <div className={styles.missingArt}>
            <span>{cover === undefined ? 'loading art…' : 'art pending'}</span>
          </div>
        )}
        <div className={styles.badges}>
          <span>nft</span>
          {isSoldOut && <span>sold out</span>}
          <span>{paidLabel}</span>
        </div>
      </div>

      <div className={styles.releaseInfo}>
        <div className={styles.nameRow}>
          <h2>{row.name}</h2>
          <span>${row.ticker}</span>
        </div>
        <p>{`launched ${new Date(Number(row.blockTimestamp) * 1000).toLocaleDateString()} by ${shortAddr(row.launchedBy)}`}</p>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <small>price</small>
          <b>{price}</b>
        </div>
        <div className={styles.metric}>
          <small>minted</small>
          <b>{supplyLabel}</b>
        </div>
        <div className={styles.metric}>
          <small>pay</small>
          <b>{isUru ? 'URU' : 'ETH'}</b>
        </div>
      </div>

      <div className={styles.progress}>
        <div>
          <i style={{ width: `${progressPct}%` }} />
        </div>
        <span>{isSoldOut ? 'sold out' : `${progressPct.toFixed(1)}% minted`}</span>
      </div>

      <div className={styles.releaseFoot}>
        <span>
          {shortAddr(row.launchedBy)} · {new Date(Number(row.blockTimestamp) * 1000).toLocaleDateString()}
        </span>
        <b>mint <span className="uru-arrow">→</span></b>
      </div>
    </Link>
  );
}
