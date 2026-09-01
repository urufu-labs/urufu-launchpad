'use client';

/// "Your NFTs" gallery. Shows every launchpad collection this wallet currently
/// holds any tokens from, as a card grid with cover art pulled from the
/// collection's tokenURI(1). Click a card → mint/collection page.
///
/// Data flow:
///   1. Indexer nftMints(minter=wallet) → deduped list of collections that
///      wallet ever minted from, plus historical mint count.
///   2. Indexer nftCollections(addressIn=…) → collection name + ticker.
///   3. On-chain balanceOf(wallet) per collection → current holdings (accounts
///      for transfers-out; "you hold N" is live).
///   4. On-chain tokenURI(1) per collection → metadata URL → JSON.image →
///      cover thumbnail. Fall back to a generic tile when the URI is a
///      placeholder or the fetch fails.
///
/// A tokenURI that starts with `ipfs://` is routed through a public gateway
/// so browsers can render it. Failures are silent — the card renders a
/// pattern placeholder so a broken metadata URL never crashes the widget.
///
/// Rehearsal / test collections are hidden upstream by
/// hiddenNftCollections.notHiddenNft so the operator's own history stays
/// off other viewers' cards.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { type Address } from 'viem';
import { useReadContracts } from 'wagmi';

import type { ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchNftMintsByMinter, fetchNftCollectionsByAddresses } from '@/lib/indexer';

const erc721Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tokenURI',  stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
] as const;

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

interface CollectionRow {
  collectionAddress: Address;
  name: string;
  ticker: string;
  mintedQty: number;
}

interface EnrichedRow extends CollectionRow {
  currentHeld: bigint | undefined;
  coverUrl: string | null;
}

/// Rewrite ipfs://<cid>/<path> → https gateway so <img src> can load it.
/// The gateway choice is deliberately public + no-auth so the page stays
/// working when the launchpad's own gateway (if any) is down.
function resolveMetadataUrl(uri: string | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

export function MyNftHoldings({ visibleFor, chain }: Props) {
  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const [rows, setRows] = useState<CollectionRow[] | null>(null);
  const [covers, setCovers] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mints = await fetchNftMintsByMinter(visibleFor, 200);
      if (cancelled) return;
      const forChain = (mints ?? []).filter((m) => m.chainId === targetChainId);
      if (forChain.length === 0) { setRows([]); return; }
      const totals = new Map<Address, number>();
      for (const m of forChain) {
        const addr = m.collectionAddress.toLowerCase() as Address;
        totals.set(addr, (totals.get(addr) ?? 0) + Number(m.quantity));
      }
      const uniqueAddrs = Array.from(totals.keys());
      const cols = await fetchNftCollectionsByAddresses(uniqueAddrs);
      if (cancelled) return;
      const byAddr = new Map<string, { name: string; ticker: string }>(
        (cols ?? []).map((c) => [c.collectionAddress.toLowerCase(), { name: c.name, ticker: c.ticker }]),
      );
      setRows(
        uniqueAddrs.map((addr) => {
          const meta = byAddr.get(addr) ?? { name: addr, ticker: '?' };
          return {
            collectionAddress: addr,
            name: meta.name,
            ticker: meta.ticker,
            mintedQty: totals.get(addr) ?? 0,
          };
        }),
      );
    })();
    return () => { cancelled = true; };
  }, [visibleFor, targetChainId]);

  // Batch two reads per collection: balanceOf + tokenURI(1).
  const chainReads = useReadContracts({
    contracts: (rows ?? []).flatMap((r) => [
      { abi: erc721Abi, address: r.collectionAddress, functionName: 'balanceOf' as const, args: [visibleFor] as const, chainId: targetChainId },
      { abi: erc721Abi, address: r.collectionAddress, functionName: 'tokenURI'  as const, args: [1n]          as const, chainId: targetChainId },
    ]),
    query: { enabled: (rows?.length ?? 0) > 0, refetchInterval: 60_000 },
  });

  // Resolve tokenURI → metadata JSON → image once per collection. Runs in
  // effect (not render) so a broken/slow gateway never blocks the tiles.
  useEffect(() => {
    if (!rows || !chainReads.data) return;
    let cancelled = false;
    (async () => {
      const next = new Map(covers);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row) continue;
        const addr = row.collectionAddress;
        if (next.has(addr)) continue;
        const uriRaw = chainReads.data?.[i * 2 + 1]?.result as string | undefined;
        const url = resolveMetadataUrl(uriRaw);
        if (!url) { next.set(addr, null); continue; }
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) { next.set(addr, null); continue; }
          const meta = await res.json() as { image?: string };
          next.set(addr, resolveMetadataUrl(meta.image));
        } catch {
          next.set(addr, null);
        }
      }
      if (!cancelled) setCovers(next);
    })();
    return () => { cancelled = true; };
    // covers intentionally omitted — we only add-only above, so re-running
    // when it grows would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, chainReads.data]);

  const enriched: EnrichedRow[] = useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => ({
      ...r,
      currentHeld: (chainReads.data?.[i * 2]?.result as bigint | undefined),
      coverUrl: covers.get(r.collectionAddress) ?? null,
    })).filter((r) => r.currentHeld === undefined || r.currentHeld > 0n);
    // Filter to CURRENTLY held only. Sold-off collections stay hidden until
    // the balanceOf read comes back — undefined stays visible so the tile
    // shows immediately, then drops when the read confirms zero.
  }, [rows, chainReads.data, covers]);

  if (rows === null) return null; // no widget until we know
  if (enriched.length === 0) return null; // nothing to show, don't add noise

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
        {enriched.map((r) => (
          <Link
            key={r.collectionAddress}
            href={`/collection/${r.collectionAddress}`}
            title={r.name}
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
                background: r.coverUrl
                  ? `center/cover no-repeat url("${r.coverUrl}")`
                  : `repeating-linear-gradient(45deg, var(--cream) 0 8px, var(--cream-deep) 8px 16px)`,
                position: 'relative',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'var(--anchor)',
                  color: 'var(--cream)',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  lineHeight: 1.2,
                }}
              >
                x{r.currentHeld !== undefined ? r.currentHeld.toString() : '…'}
              </span>
            </div>
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
                {r.name}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 9,
                  color: 'var(--anchor-soft)',
                  textTransform: 'uppercase',
                }}
              >
                {r.ticker !== '?' ? r.ticker : 'unknown'} · minted {r.mintedQty}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
