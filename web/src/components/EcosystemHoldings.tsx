'use client';

/// Ecosystem holdings — shows the profile wallet's URU token balance and
/// urufu gemu NFT count. Public: renders for any visitor, not just self,
/// because loyalty tier is a public signal (LoyaltyOracle reads on-chain
/// balances to compute launch-fee discount).
///
/// Only renders on chains where ECOSYSTEM_TOKENS is populated (Robinhood
/// today). Silently returns null on chains without URU/NFT so the profile
/// still looks clean on legacy chains.

import { useMemo } from 'react';
import { formatUnits, type Address } from 'viem';
import { useReadContracts } from 'wagmi';

import { ECOSYSTEM_TOKENS, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

const ERC20_BALANCEOF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ERC721 balanceOf has the same shape as ERC20, so we reuse the tiny ABI.

/// URU threshold for the 40% discount tier (matches on-chain
/// LoyaltyOracle.uruThreshold = 100_000e18). Duplicated here so we can
/// render a "you need X more URU for +20% discount" hint client-side
/// without an extra RPC round-trip. Update if the on-chain threshold
/// ever gets rotated.
const URU_LOYALTY_THRESHOLD_WEI = 100_000n * 10n ** 18n;

export function EcosystemHoldings({ visibleFor, chain }: Props) {
  const tokens = ECOSYSTEM_TOKENS[chain];
  const chainId = CHAIN_KEY_TO_ID[chain];

  const reads = useReadContracts({
    contracts: tokens
      ? [
          {
            address: tokens.uruToken,
            abi: ERC20_BALANCEOF_ABI,
            functionName: 'balanceOf',
            args: [visibleFor],
            chainId,
          },
          {
            address: tokens.gemuNft,
            abi: ERC20_BALANCEOF_ABI,
            functionName: 'balanceOf',
            args: [visibleFor],
            chainId,
          },
        ]
      : [],
    query: { enabled: !!tokens, refetchInterval: 30_000 },
  });

  const uru = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const nftCount = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;

  const loyaltyTier = useMemo(() => {
    const hasNft = nftCount > 0n;
    const hasUru = uru >= URU_LOYALTY_THRESHOLD_WEI;
    if (hasNft && hasUru) return { pct: 50, label: 'both tiers' };
    if (hasUru) return { pct: 40, label: 'URU tier' };
    if (hasNft) return { pct: 20, label: 'NFT tier' };
    return { pct: 0, label: 'no tier' };
  }, [uru, nftCount]);

  const uruShort = (uru: bigint) => {
    const n = Number(formatUnits(uru, 18));
    if (n === 0) return '0';
    if (n < 0.01) return '<0.01';
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const uruRemainingToTier = useMemo(() => {
    if (!tokens || uru >= URU_LOYALTY_THRESHOLD_WEI) return null;
    return URU_LOYALTY_THRESHOLD_WEI - uru;
  }, [tokens, uru]);

  if (!tokens) return null;

  return (
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div className="uru-eyebrow" style={{ marginBottom: 6 }}>
        ✿ ecosystem holdings
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span>URU</span>
          <span className="uru-num" style={{ fontWeight: 600 }}>{uruShort(uru)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span>urufu gemu NFT</span>
          <span className="uru-num" style={{ fontWeight: 600 }}>{nftCount.toString()}</span>
        </div>
        <div
          style={{
            marginTop: 4,
            paddingTop: 6,
            borderTop: '1px dashed var(--cream-shadow)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            alignItems: 'baseline',
            fontSize: 12,
            color: 'var(--anchor-soft)',
          }}
        >
          <span>loyalty tier</span>
          <span>
            <span className="uru-num" style={{ fontWeight: 600, color: loyaltyTier.pct > 0 ? 'var(--pink-hot)' : 'inherit' }}>
              {loyaltyTier.pct}%
            </span>{' '}
            off · {loyaltyTier.label}
          </span>
        </div>
        {uruRemainingToTier !== null && (
          <div style={{ fontSize: 11, color: 'var(--anchor-soft)', fontStyle: 'italic' }}>
            hold <span className="uru-num">{uruShort(uruRemainingToTier)}</span> more URU
            for the +{nftCount > 0n ? 30 : 40}% tier ~
          </div>
        )}
      </div>
    </section>
  );
}
