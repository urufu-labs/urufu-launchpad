'use client';

/// Grid of launched NFT collections. Renders the recent nftCollections feed
/// from the indexer as clickable tiles that route to /collection/[address].
/// Falls back to <NftLaunchTeaser> when no collections exist on the chain
/// so the home / discover surfaces never show empty state alone.
///
/// Cover art comes from Alchemy's cached image for tokenId 1 (fetched via
/// the compile-service /wallet endpoint's per-collection lookup path). For
/// v1 we skip the extra fetch and show a placeholder pattern with the
/// collection name — /collection/[addr] itself does the tokenURI resolve.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import type { ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchRecentNftCollections, type IndexerNftCollection } from '@/lib/indexer';
import { NftLaunchTeaser } from './NftLaunchTeaser';

interface Props {
  chain: ChainKey;
  chainEnabled: boolean;
  variant: 'home' | 'discover';
  limit?: number;
}

const TILE_TINTS = ['var(--pink-warm)', 'var(--mizuiro)', 'var(--mint)', 'var(--yolk)'] as const;

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

  const showTeaser = useMemo(() => (items?.length ?? 0) === 0, [items]);

  // Show the teaser while items load AND when the result is empty. Keeps the
  // "coming soon" copy in front of the launcher until real collections land.
  if (showTeaser) return <NftLaunchTeaser chainEnabled={chainEnabled} variant={variant} />;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 12,
      }}
    >
      {(items ?? []).map((c, i) => {
        const tint = TILE_TINTS[i % TILE_TINTS.length];
        const initial = (c.name || c.ticker || '?').charAt(0).toUpperCase();
        return (
          <Link
            key={c.id}
            href={`/collection/${c.collectionAddress}`}
            title={c.name}
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 10,
              overflow: 'hidden',
              background: 'var(--paper, #fff)',
              border: '1.5px solid var(--anchor)',
            }}
          >
            <div
              style={{
                aspectRatio: '1 / 1',
                background: tint,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--font-round), cursive',
                fontSize: 48,
                fontWeight: 700,
                color: 'var(--anchor)',
              }}
            >
              {initial}
            </div>
            <div style={{ padding: '8px 10px' }}>
              <div
                style={{
                  fontFamily: 'var(--font-body), sans-serif',
                  fontSize: 13,
                  fontWeight: 700,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.name}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--anchor-soft)',
                  textTransform: 'uppercase',
                }}
              >
                {c.ticker}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
