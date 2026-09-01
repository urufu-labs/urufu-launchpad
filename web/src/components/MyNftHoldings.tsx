'use client';

/// "Your NFTs" gallery. Renders NFTs the wallet holds on Robinhood chain
/// that are RELEVANT to this launchpad — either the ecosystem's own gemu
/// NFT, or a collection launched through NftLaunchFactory. Everything
/// else the wallet holds on RH (random airdrops, other-app NFTs) stays
/// off this gallery because they have no in-app destination.
///
/// Click routing:
///   - urufu gemu → external OpenSea collection page (opens new tab)
///   - launchpad-launched → /collection/[address] (the mint page)
///
/// Data path:
///   1. compile-service /wallet/:address/nfts (Alchemy NFT API v3)
///        — one HTTP call, images pre-resolved, spam pre-filtered.
///   2. indexer nftCollections(collectionAddress_in: [...])
///        — resolves which contracts in the wallet were launched here.
///
/// Silently renders nothing on:
///   - error (scanner down / rate limited / no API key)
///   - wallet holds nothing relevant
/// so it never introduces noise on a profile that has no such NFTs.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Address } from 'viem';

import type { ChainKey } from '@/lib/config';
import { ECOSYSTEM_TOKENS } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { isHiddenNftCollection } from '@/lib/hiddenNftCollections';
import { fetchWalletNfts, type WalletNftAvatar } from '@/lib/nftAvatarApi';
import { fetchNftCollectionsByAddresses } from '@/lib/indexer';

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

type Destination =
  | { kind: 'launchpad'; href: string }
  | { kind: 'external'; href: string };

/// External destinations for known ecosystem-friend NFTs that aren't
/// launchpad-launched but are worth surfacing on a user's gallery.
/// Anything not listed here AND not a launchpad collection just doesn't
/// appear at all — no useful in-app destination.
///
/// Adding a friend: append a row. The map is address-keyed, so the
/// canonical ecosystem-token address (like gemu from ECOSYSTEM_TOKENS)
/// stays as its own single source of truth further down.
const EXTERNAL_FRIENDS: ReadonlyArray<{ address: string; href: string }> = [
  // birbs — RH-native friend collection.
  { address: '0x94ab280f48fe30cbbb92794a0bf2d51ea07b1164', href: 'https://opensea.io/collection/birbsrh' },
];

function externalDestinationFor(collectionAddress: string): Destination | null {
  const addr = collectionAddress.toLowerCase();
  const gemu = ECOSYSTEM_TOKENS.robinhood?.gemuNft?.toLowerCase();
  if (gemu && addr === gemu) {
    return { kind: 'external', href: 'https://opensea.io/collection/urufugemu' };
  }
  const friend = EXTERNAL_FRIENDS.find((f) => f.address.toLowerCase() === addr);
  if (friend) return { kind: 'external', href: friend.href };
  return null;
}

export function MyNftHoldings({ visibleFor, chain }: Props) {
  const [items, setItems] = useState<Array<WalletNftAvatar & { dest: Destination }> | null>(null);

  useEffect(() => {
    // RH-only for now. Broaden when NFT_LAUNCHES goes multi-chain.
    if (chain !== 'robinhood') { setItems([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const scan = await fetchWalletNfts(visibleFor, { chain: 'robinhood' });
        if (cancelled) return;
        const rh = scan.chains.find((c) => c.id === 'robinhood');
        const raw = (rh?.items ?? []).filter(
          (n) => !isHiddenNftCollection(n.chainId, n.contractAddress),
        );

        // Resolve which distinct contracts are launchpad-launched. One
        // batched indexer call for the whole gallery.
        const distinctAddrs = Array.from(new Set(raw.map((n) => n.contractAddress.toLowerCase() as Address)));
        const launchpad = await fetchNftCollectionsByAddresses(distinctAddrs);
        if (cancelled) return;
        const launchpadSet = new Set((launchpad ?? []).map((c) => c.collectionAddress.toLowerCase()));

        // Keep each item that either matches a known ecosystem destination
        // or is a launchpad-launched collection. Everything else drops.
        const kept: Array<WalletNftAvatar & { dest: Destination }> = [];
        for (const n of raw) {
          const addr = n.contractAddress.toLowerCase();
          const ext = externalDestinationFor(addr);
          if (ext) { kept.push({ ...n, dest: ext }); continue; }
          if (launchpadSet.has(addr)) {
            kept.push({ ...n, dest: { kind: 'launchpad', href: `/collection/${n.contractAddress}` } });
          }
        }
        setItems(kept);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [visibleFor, chain]);

  if (items === null) return null;   // pre-first-response, no noise
  if (items.length === 0) return null; // nothing to show

  // suppress unused-var lint on the chain-id map import — kept for the
  // future multi-chain fan-out described in the effect above.
  void CHAIN_KEY_TO_ID;

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
          const isExternal = n.dest.kind === 'external';
          const linkProps = isExternal
            ? { target: '_blank' as const, rel: 'noopener noreferrer' as const }
            : {};
          return (
            <Link
              key={key}
              href={n.dest.href}
              title={displayName}
              {...linkProps}
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
                  {subtitle}{isExternal ? ' · opensea ↗' : ''}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
