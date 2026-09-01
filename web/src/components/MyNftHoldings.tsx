'use client';

/// "Your NFTs" gallery. Renders every NFT the wallet actually holds on
/// Robinhood chain as a card grid with the cover image Alchemy resolved.
/// Click a tile → /collection/[address] (opens the mint page if it's a
/// launchpad-launched collection; other RH collections render whatever
/// that route falls back to).
///
/// Uses the compile-service /wallet/:address/nfts endpoint (Alchemy NFT
/// API v3). Advantages over reading tokenURI on-chain:
///   - Image URLs already pre-resolved (Alchemy caches + rewrites ipfs://)
///   - Spam collections filtered server-side
///   - One HTTP call for the whole wallet vs one chain call per collection
///
/// Silently renders nothing on:
///   - error (scanner down / rate limited / no API key)
///   - empty wallet
/// so it never introduces noise on a profile that has no NFTs.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Address } from 'viem';

import type { ChainKey } from '@/lib/config';
import { isHiddenNftCollection } from '@/lib/hiddenNftCollections';
import { fetchWalletNfts, type WalletNftAvatar } from '@/lib/nftAvatarApi';

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

export function MyNftHoldings({ visibleFor, chain }: Props) {
  const [items, setItems] = useState<WalletNftAvatar[] | null>(null);

  useEffect(() => {
    // RH-only for now. Broaden to `undefined` (fan out across every chain
    // Alchemy indexes) once NFT_LAUNCHES goes multi-chain.
    if (chain !== 'robinhood') { setItems([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const scan = await fetchWalletNfts(visibleFor, { chain: 'robinhood' });
        if (cancelled) return;
        const rh = scan.chains.find((c) => c.id === 'robinhood');
        const filtered = (rh?.items ?? []).filter(
          (n) => !isHiddenNftCollection(n.chainId, n.contractAddress),
        );
        setItems(filtered);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [visibleFor, chain]);

  if (items === null) return null;         // pre-first-response, no noise
  if (items.length === 0) return null;      // nothing to show

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div className="uru-eyebrow">❁ your nfts</div>
        <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          あなたのNFT
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 10,
        }}
      >
        {items.map((n) => {
          const key = `${n.contractAddress.toLowerCase()}-${n.tokenId}`;
          const displayName = n.tokenName?.trim() || `${n.collectionName ?? 'Untitled'} #${n.tokenId}`;
          const subtitle = n.collectionName?.trim() || n.contractAddress.slice(0, 10) + '…';
          return (
            <Link
              key={key}
              href={`/collection/${n.contractAddress}`}
              title={displayName}
              style={{
                textDecoration: 'none',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 8,
                overflow: 'hidden',
                background: 'var(--paper, #fff)',
                border: '1.5px solid var(--anchor)',
              }}
            >
              <div
                style={{
                  aspectRatio: '1 / 1',
                  background: n.imageUrl
                    ? `center/cover no-repeat url("${n.imageUrl}")`
                    : `repeating-linear-gradient(45deg, var(--cream) 0 8px, var(--cream-deep) 8px 16px)`,
                }}
              />
              <div style={{ padding: '6px 8px' }}>
                <div
                  style={{
                    fontFamily: 'var(--font-body), sans-serif',
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {displayName}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 9,
                    color: 'var(--anchor-soft)',
                    textTransform: 'uppercase',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {subtitle}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
