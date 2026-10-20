'use client';

/// "Your NFTs" gallery. Renders NFTs the wallet holds on Robinhood chain
/// that are RELEVANT to this launchpad — the ecosystem's gemu NFT, listed
/// friend collections (birbs, …), and any collection launched through
/// NftLaunchFactory. Everything else the wallet holds on RH stays off the
/// gallery because there's no useful in-app destination.
///
/// Click routing:
///   - urufu gemu / birbs / other friends → external OpenSea page (new tab)
///   - launchpad-launched → /collection/[address]/[tokenId] (NFT page; owner can list it)
///
/// Data path:
///   1. Alchemy scan (`/wallet/:address/nfts`) — one HTTP call, per-token
///      entries with cached image URLs. Spam filtered server-side.
///   2. Indexer nftMints — fallback for freshly-minted launchpad NFTs that
///      Alchemy hasn't picked up yet (Alchemy latency is minutes on new
///      contracts; the indexer sees them within one block). Any launchpad
///      collection the wallet minted from AND still currently holds gets
///      one synthesized tile whose image is lazy-resolved via tokenURI(1).
///
/// Silently renders nothing while sources are loading or when the wallet
/// holds nothing relevant.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type Address, erc721Abi } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';

import type { ChainKey } from '@/lib/config';
import { ECOSYSTEM_TOKENS, DN404_LAUNCHES_ENABLED } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { isHiddenNftCollection } from '@/lib/hiddenNftCollections';
import { fetchWalletNfts, type WalletNftAvatar } from '@/lib/nftAvatarApi';
import { fetchNftCollectionsByAddresses, fetchNftMintsByMinter } from '@/lib/indexer';
import { fetchIpfsJson, toGatewayUrl } from '@/lib/ipfsFetch';
import { safeBackgroundImage } from '@/lib/metadata';
import card from './profile-card.module.css';

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

type Destination =
  | { kind: 'launchpad'; href: string }
  | { kind: 'external'; href: string };

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

interface Tile {
  key: string;
  contractAddress: Address;
  displayName: string;
  subtitle: string;
  imageUrl: string | null;
  dest: Destination;
  chainId: number;
  needsLazyImage: boolean;
  /// Launchpad NFT with a known token id: the tile opens its detail page,
  /// where the owner can list it on the marketplace.
  listable: boolean;
}

export function MyNftHoldings({ visibleFor, chain }: Props) {
  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const { address: connected } = useAccount();
  const isOwnerView = !!connected && connected.toLowerCase() === visibleFor.toLowerCase();
  const [tiles, setTiles] = useState<Tile[] | null>(null);

  useEffect(() => {
    if (chain !== 'robinhood') { setTiles([]); return; }
    let cancelled = false;
    (async () => {
      // Fire both sources in parallel; wait for both before rendering so
      // fresh launchpad mints show up alongside Alchemy-resolved holdings.
      const [scan, mints] = await Promise.all([
        fetchWalletNfts(visibleFor, { chain: 'robinhood' }).catch(() => null),
        fetchNftMintsByMinter(visibleFor, 100).catch(() => null),
      ]);
      if (cancelled) return;

      const rhAlchemy = scan?.chains.find((c) => c.id === 'robinhood')?.items ?? [];
      const alchemyKept = rhAlchemy.filter(
        (n) => !isHiddenNftCollection(n.chainId, n.contractAddress),
      );

      // Distinct launchpad candidates: Alchemy contracts + indexer mint
      // contracts (the fresh-mint set Alchemy hasn't caught yet).
      const alchemyAddrs = alchemyKept.map((n) => n.contractAddress.toLowerCase() as Address);
      const indexerAddrs = (mints ?? [])
        .filter((m) => m.chainId === targetChainId)
        .filter((m) => !isHiddenNftCollection(m.chainId, m.collectionAddress))
        .map((m) => m.collectionAddress.toLowerCase() as Address);
      const distinctAddrs = Array.from(new Set([...alchemyAddrs, ...indexerAddrs]));
      const launchpadRows = await fetchNftCollectionsByAddresses(distinctAddrs);
      if (cancelled) return;
      // DN404 NFTs only count as launchpad collections while the DN404 lane
      // is on; otherwise they are treated like any unknown contract (skipped).
      const dn404On = DN404_LAUNCHES_ENABLED[chain] === true;
      const launchpadByAddr = new Map(
        (launchpadRows ?? [])
          .filter((c) => c.lane !== 'dn404' || dn404On)
          .map((c) => [c.collectionAddress.toLowerCase(), c]),
      );

      const out: Tile[] = [];
      const seen = new Set<string>();

      // First: Alchemy tiles (per-token, images resolved). For launchpad
      // collections, prefer the indexer's collection name over whatever
      // came from tokenURI metadata — studio uploads occasionally omit
      // the collection prefix on per-token JSON, which would leave a
      // wallet full of "#1" tiles.
      for (const n of alchemyKept) {
        const addr = n.contractAddress.toLowerCase();
        const ext = externalDestinationFor(addr);
        const launchpadMeta = launchpadByAddr.get(addr);
        if (!ext && !launchpadMeta) continue;
        const collectionLabel = launchpadMeta?.name?.trim()
          || n.collectionName?.trim()
          || 'Untitled';
        const key = `${addr}-${n.tokenId}`;
        seen.add(key);
        out.push({
          key,
          contractAddress: n.contractAddress as Address,
          displayName: `${collectionLabel} #${n.tokenId}`,
          subtitle: (launchpadMeta?.ticker ? `$${launchpadMeta.ticker}` : addr.slice(0, 10) + '…')
            + (ext ? ' · OpenSea ↗' : ''),
          imageUrl: n.imageUrl || null,
          dest: ext ?? { kind: 'launchpad', href: `/collection/${n.contractAddress}/${n.tokenId}` },
          chainId: n.chainId,
          needsLazyImage: false,
          listable: !ext,
        });
      }

      // Second: launchpad collections from the indexer that Alchemy missed
      // (fresh mints). One synthesized tile per collection.
      for (const addr of indexerAddrs) {
        if (!launchpadByAddr.has(addr)) continue; // hidden or non-launchpad
        // Already covered by Alchemy for at least one tokenId? skip.
        const alreadyShown = out.some((t) => t.contractAddress.toLowerCase() === addr);
        if (alreadyShown) continue;
        const meta = launchpadByAddr.get(addr)!;
        out.push({
          key: `synth-${addr}`,
          contractAddress: addr as Address,
          displayName: meta.name,
          subtitle: `$${meta.ticker}`,
          imageUrl: null,           // resolved lazily via tokenURI(1)
          dest: { kind: 'launchpad', href: `/collection/${addr}` },
          chainId: meta.chainId,
          needsLazyImage: true,
          listable: false,
        });
      }

      setTiles(out);
    })();
    return () => { cancelled = true; };
  }, [visibleFor, chain, targetChainId]);

  if (tiles === null) return null;
  if (tiles.length === 0) return null;

  return (
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Your NFTs</h2>
      </div>
      <div className={card.body}>
        <div className={card.tiles}>
          {tiles.map((t) => (
            <NftTile key={t.key} tile={t} viewer={visibleFor} canList={isOwnerView && t.listable} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

function NftTile({ tile, viewer, canList }: { tile: Tile; viewer: Address; canList: boolean }) {
  const [lazyImage, setLazyImage] = useState<string | null>(null);

  // Read balanceOf + tokenURI(1) so synthesized tiles get a cover and get
  // dropped if the wallet has since transferred out. Alchemy-sourced tiles
  // skip both — Alchemy already resolved the image and confirmed ownership.
  const enabled = tile.needsLazyImage;
  const reads = useReadContracts({
    contracts: enabled ? [
      { abi: erc721Abi, address: tile.contractAddress, functionName: 'balanceOf', args: [viewer] as const, chainId: tile.chainId as 4663 },
      { abi: erc721Abi, address: tile.contractAddress, functionName: 'tokenURI',  args: [1n] as const,       chainId: tile.chainId as 4663 },
    ] as const : [] as const,
    query: { enabled, staleTime: 30_000 },
  });
  const balance = reads.data?.[0]?.result as bigint | undefined;
  const tokenUri = reads.data?.[1]?.result as string | undefined;

  useEffect(() => {
    if (!tile.needsLazyImage || !tokenUri) return;
    let cancelled = false;
    (async () => {
      const meta = await fetchIpfsJson<{ image?: string }>(tokenUri);
      if (!cancelled) setLazyImage(toGatewayUrl(meta?.image));
    })();
    return () => { cancelled = true; };
  }, [tile.needsLazyImage, tokenUri]);

  // Drop the tile if a synthesized entry's balance came back zero (all
  // transferred out). Alchemy tiles never enter this branch.
  if (tile.needsLazyImage && balance !== undefined && balance === 0n) return null;

  const image = tile.imageUrl ?? lazyImage;
  const isExternal = tile.dest.kind === 'external';
  const linkProps = isExternal
    ? { target: '_blank' as const, rel: 'noopener noreferrer' as const }
    : {};

  return (
    <Link
      href={tile.dest.href}
      title={tile.displayName}
      {...linkProps}
      className={card.tile}
    >
      <div
        className={card.tileArt}
        style={{
          background: image
            ? safeBackgroundImage(image, undefined, 'contain')
            : 'var(--surface-3)',
        }}
      />
      <div className={card.tileText}>
        <div className={card.tileName}>{tile.displayName}</div>
        <div className={card.tileSub}>{tile.subtitle}</div>
        {canList && <span className="ui-badge" data-tone="accent">List for sale</span>}
      </div>
    </Link>
  );
}
