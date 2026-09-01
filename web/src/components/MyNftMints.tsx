'use client';

/// "Your minted NFTs" for the profile page. Shows every collection the viewed
/// wallet has minted from, grouped, with the current on-chain balance so the
/// display reflects actual holdings (transfers-out already accounted for)
/// while the "you minted" number stays as the historical record.
///
/// Public — anyone can see any wallet's mint history. If we later want a
/// private mode, add an isSelf-gate the way NftLauncherEarnings does.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import { useReadContracts } from 'wagmi';

import type { ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchNftMintsByMinter, fetchNftCollectionsByAddresses } from '@/lib/indexer';

const erc721BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
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

export function MyNftMints({ visibleFor, chain }: Props) {
  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const [rows, setRows] = useState<CollectionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mints = await fetchNftMintsByMinter(visibleFor, 200);
      if (cancelled) return;
      const forChain = (mints ?? []).filter((m) => m.chainId === targetChainId);
      if (forChain.length === 0) {
        setRows([]);
        return;
      }
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

  const balances = useReadContracts({
    contracts: (rows ?? []).map((r) => ({
      abi: erc721BalanceAbi,
      address: r.collectionAddress,
      functionName: 'balanceOf' as const,
      args: [visibleFor] as const,
      chainId: targetChainId,
    })),
    query: { enabled: (rows?.length ?? 0) > 0, refetchInterval: 30_000 },
  });

  const enriched = useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => ({
      ...r,
      currentHeld: (balances.data?.[i]?.result as bigint | undefined) ?? undefined,
    }));
  }, [rows, balances.data]);

  if (rows === null) {
    return (
      <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
        <div className="uru-eyebrow">❁ your nfts</div>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          loading your mints...
        </div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
        <div className="uru-eyebrow">❁ your nfts</div>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          nothing minted here yet.
        </div>
      </section>
    );
  }

  return (
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">❁ your nfts</div>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          あなたのNFT
        </span>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        {enriched.map((r) => {
          // If the row's "name" is a raw 0x hex address, it's the fallback for
          // an unresolved collection metadata lookup. Show a shorter middle-elided
          // label instead of the full 42-char string so nothing overflows.
          const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/.test(r.name);
          const displayName = looksLikeAddress
            ? `${r.name.slice(0, 6)}…${r.name.slice(-4)}`
            : r.name;
          const held = r.currentHeld !== undefined ? r.currentHeld.toString() : '…';
          return (
            <li
              key={r.collectionAddress}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                columnGap: 10,
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--paper, #fff)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Link
                  href={`/collection/${r.collectionAddress}`}
                  title={r.name}
                  style={{
                    fontFamily: 'var(--font-body), sans-serif',
                    fontSize: 13,
                    color: 'var(--anchor)',
                    textDecoration: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'block',
                  }}
                >
                  {displayName}
                </Link>
                {!looksLikeAddress && r.ticker && r.ticker !== '?' && (
                  <span
                    style={{
                      fontFamily: 'var(--font-pixel), monospace',
                      fontSize: 10,
                      color: 'var(--anchor-soft)',
                    }}
                  >
                    {r.ticker}
                  </span>
                )}
              </div>
              <div
                style={{
                  textAlign: 'right',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 11,
                  lineHeight: 1.35,
                  whiteSpace: 'nowrap',
                }}
              >
                <div>hold {held}</div>
                <div style={{ fontSize: 9, color: 'var(--anchor-soft)' }}>
                  minted {r.mintedQty}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
