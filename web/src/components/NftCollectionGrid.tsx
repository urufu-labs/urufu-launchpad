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
import { safeBackgroundImage } from '@/lib/metadata';
import { collectionVisible } from '@/lib/dn404Feed';
import { NftLaunchTeaser } from './NftLaunchTeaser';
import styles from './NftCollectionGrid.module.css';

interface Props {
  chain: ChainKey;
  /// NFT lane flag (NFT_LAUNCHES_ENABLED). Gates plain NFT collections.
  chainEnabled: boolean;
  /// DN404 lane flag (DN404_LAUNCHES_ENABLED). Gates DN404 collections, which
  /// are listed in the same grid but must stay hidden while DN404 is off.
  dn404Enabled?: boolean;
  variant: 'home' | 'discover';
  limit?: number;
}

export function NftCollectionGrid({ chain, chainEnabled, dn404Enabled = false, variant, limit = 12 }: Props) {
  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const [items, setItems] = useState<IndexerNftCollection[] | null>(null);

  useEffect(() => {
    if (!chainEnabled && !dn404Enabled) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      const rows = await fetchRecentNftCollections(limit);
      if (cancelled) return;
      setItems(
        (rows ?? [])
          .filter((r) => r.chainId === targetChainId)
          .filter((r) => collectionVisible(r, { nftEnabled: chainEnabled, dn404Enabled })),
      );
    })();
    return () => { cancelled = true; };
  }, [chainEnabled, dn404Enabled, targetChainId, limit]);

  if ((items?.length ?? 0) === 0) {
    return <NftLaunchTeaser chainEnabled={chainEnabled || dn404Enabled} variant={variant} />;
  }

  // Home matches the launchpad-native tile treatment used by LaunchTile so
  // the NFT rail reads as one product with the token rail. Discover mirrors
  // the ERC-20 releaseCard from discover.module.css (larger, with metrics
  // strip + description) since discover is the deep-scan view.
  if (variant === 'home') {
    return (
      <div className="uru-home-launch-grid">
        {(items ?? []).map((c) =>
          c.lane === 'dn404' && c.pairedToken ? (
            <div key={c.id} style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
              <NftHomeTile row={c} chainId={targetChainId} />
              <Link href={`/trade/${c.pairedToken}`} className="uru-chip" style={{ justifySelf: 'start', textDecoration: 'none' }}>
                trade the token →
              </Link>
            </div>
          ) : (
            <NftHomeTile key={c.id} row={c} chainId={targetChainId} />
          ),
        )}
      </div>
    );
  }

  return (
    <div className={styles.mosaic}>
      {(items ?? []).map((c) =>
        c.lane === 'dn404' && c.pairedToken ? (
          <div key={c.id} className={styles.dn404Wrap}>
            <NftCollectionCard row={c} chainId={targetChainId} />
            <Link href={`/trade/${c.pairedToken}`} className={styles.dn404Trade}>
              trade the token <span className="uru-arrow">→</span>
            </Link>
          </div>
        ) : (
          <NftCollectionCard key={c.id} row={c} chainId={targetChainId} />
        ),
      )}
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

// ============================================================================
// Home tile — mirrors LaunchTile's uru-launch-ticket-* classes so the home
// NFT rail sits shoulder-to-shoulder with the ERC-20 token rail visually.
// ============================================================================

function useCollectionCover(
  collectionAddress: Address,
  chainId: number,
  indexerCover: string | undefined,
): string | null | undefined {
  // Prefer the indexer-resolved cover URL — resolved server-side once and
  // stored, so every viewer gets the same warm response instantly.
  // Chain-read + IPFS-fetch fallback only kicks in when the indexer hasn't
  // filled the field yet (e.g. brand-new launch, indexer still backfilling).
  const cid = chainId as 4663;
  const needFallback = !indexerCover;
  const reads = useReadContracts({
    contracts: [
      { abi: erc721Abi, address: collectionAddress, functionName: 'tokenURI', args: [1n] as const, chainId: cid },
    ] as const,
    query: { enabled: needFallback, staleTime: 60_000 },
  });
  const tokenUri = reads.data?.[0]?.result as string | undefined;
  const [cover, setCover] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!needFallback) return;
    if (!tokenUri) { setCover(null); return; }
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(tokenUri);
      if (!cancelled) setCover(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [needFallback, tokenUri]);
  return toGatewayUrl(indexerCover) || cover;
}

function NftHomeTile({ row, chainId }: { row: IndexerNftCollection; chainId: number }) {
  const cid = chainId as 4663;
  const reads = useReadContracts({
    contracts: [
      { abi: erc721Abi, address: row.collectionAddress, functionName: 'totalSupply', chainId: cid },
      { abi: erc721Abi, address: row.collectionAddress, functionName: 'maxSupply',   chainId: cid },
    ] as const,
    query: { staleTime: 30_000 },
  });
  const totalSupply = reads.data?.[0]?.result as bigint | undefined;
  // Prefer live on-chain maxSupply for accuracy, fall back to what the
  // indexer stored at launch time (immutable, so they'll match).
  const maxSupply   = (reads.data?.[1]?.result as bigint | undefined)
    ?? (row.maxSupply ? BigInt(row.maxSupply) : undefined);

  const cover = useCollectionCover(row.collectionAddress, chainId, row.coverImageUrl);

  const progressPct = totalSupply !== undefined && maxSupply !== undefined && maxSupply > 0n
    ? Math.min(100, Math.max(0, Number((totalSupply * 10_000n) / maxSupply) / 100))
    : 0;
  const isSoldOut = maxSupply !== undefined && maxSupply > 0n && totalSupply === maxSupply;
  const mintedLabel = totalSupply?.toString() ?? '—';
  const capLabel = maxSupply === undefined || maxSupply === 0n ? '∞' : maxSupply.toString();

  return (
    <Link
      href={`/collection/${row.collectionAddress}`}
      className="uru-launch-ticket"
      data-tone="pink"
    >
      <div className="uru-launch-ticket-top">
        <div
          className="uru-launch-ticket-art"
          role="img"
          aria-label={cover ? `${row.name} cover art` : undefined}
          style={{ background: safeBackgroundImage(cover ?? undefined, undefined) }}
        >
          {!cover && '❁'}
        </div>
        <span className="uru-launch-ticket-tag">{row.lane === 'dn404' ? 'dn404' : 'nft'}</span>
      </div>
      <span className="uru-launch-ticket-name">{row.name}</span>
      <span className="uru-launch-ticket-symbol">${row.ticker}</span>
      <div className="uru-launch-ticket-meta">
        <span>minted<b>{mintedLabel}</b></span>
        <span>supply<b>{capLabel}</b></span>
      </div>
      <div
        className="uru-launch-ticket-progress"
        aria-label={`${progressPct.toFixed(0)} percent minted`}
      >
        <span
          className="uru-launch-progress-fill"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className="uru-launch-ticket-foot">
        {shortAddr(row.launchedBy)} · {isSoldOut ? 'sold out' : `${progressPct.toFixed(0)}% minted`}
      </p>
    </Link>
  );
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
  // DN404 mirrors have no maxSupply(); fall back to the collection size the
  // indexer stored at launch.
  const maxSupply   = (c721.data?.[1]?.result as bigint | undefined)
    ?? (row.lane === 'dn404' && row.maxSupply ? BigInt(row.maxSupply) : undefined);
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

  // Cover image — indexer-resolved wins; client-side gateway race only
  // runs when the indexer hasn't stored one yet.
  const [cover, setCover] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (row.coverImageUrl) { setCover(toGatewayUrl(row.coverImageUrl)); return; }
    if (!tokenUri) { setCover(null); return; }
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(tokenUri);
      if (cancelled) return;
      setCover(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [row.coverImageUrl, tokenUri]);

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

  const isDn404 = row.lane === 'dn404';
  const isSoldOut = !isDn404 && maxSupply !== undefined && maxSupply !== 0n && totalSupply === maxSupply;
  const paidLabel = isUru ? 'uru paid' : 'eth paid';
  const dn404Pair = isDn404 && row.pairCurrency && row.pairCurrency !== zeroAddress ? 'URU' : 'ETH';
  const dn404Unit = isDn404 && row.unitWei
    ? Number(formatUnits(BigInt(row.unitWei), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
    : '';

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
          {isDn404 ? (
            <>
              <span>dn404</span>
              <span>{dn404Pair.toLowerCase()} pair</span>
            </>
          ) : (
            <>
              <span>nft</span>
              {isSoldOut && <span>sold out</span>}
              <span>{paidLabel}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.releaseInfo}>
        <div className={styles.nameRow}>
          <h2>{row.name}</h2>
          <span>${row.ticker}</span>
        </div>
        <p>
          {isDn404
            ? `also a token: every ${dn404Unit} ${row.ticker} you hold is 1 NFT. buy the token to get NFTs, sell it and they go away.`
            : `launched ${new Date(Number(row.blockTimestamp) * 1000).toLocaleDateString()} by ${shortAddr(row.launchedBy)}`}
        </p>
      </div>

      <div className={styles.metrics}>
        {isDn404 ? (
          <>
            <div className={styles.metric}>
              <small>1 nft</small>
              <b>{dn404Unit} tokens</b>
            </div>
            <div className={styles.metric}>
              <small>nfts out</small>
              <b>{supplyLabel}</b>
            </div>
            <div className={styles.metric}>
              <small>pay</small>
              <b>{dn404Pair}</b>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>

      <div className={styles.progress}>
        <div>
          <i style={{ width: `${progressPct}%` }} />
        </div>
        <span>{isDn404 ? `${progressPct.toFixed(1)}% of nfts out` : isSoldOut ? 'sold out' : `${progressPct.toFixed(1)}% minted`}</span>
      </div>

      <div className={styles.releaseFoot}>
        <span>
          {shortAddr(row.launchedBy)} · {new Date(Number(row.blockTimestamp) * 1000).toLocaleDateString()}
        </span>
        <b>{isDn404 ? 'view nfts' : 'mint'} <span className="uru-arrow">→</span></b>
      </div>
    </Link>
  );
}
