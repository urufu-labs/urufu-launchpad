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
import { useLoyaltyDiscountReady } from '@/hooks/useLoyaltyDiscountReady';
import card from './profile-card.module.css';

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
  // Layer-3 release gate — never render specific discount %s unless the
  // wiring is verified live on the connected chain. If ready is false we
  // still show the raw URU / NFT balances (those aren't gated on wiring),
  // but the "loyalty tier N% off" row + the "X more URU for +M%" hint
  // are hidden.
  const loyalty = useLoyaltyDiscountReady();

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
    if (hasNft && hasUru) return { pct: 50, label: 'Combined tier' };
    if (hasUru) return { pct: 40, label: 'URU tier' };
    if (hasNft) return { pct: 20, label: 'urufu gemu nft tier' };
    return { pct: 0, label: 'No tier' };
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
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Ecosystem holdings</h2>
      </div>
      <div className={card.body}>
        <div className={card.kv}>
          <span className={card.kvKey}>URU</span>
          <span className={card.kvValue}>{uruShort(uru)}</span>
        </div>
        <div className={card.kv}>
          <span className={card.kvKey}>urufu gemu nft</span>
          <span className={card.kvValue}>{nftCount.toString()}</span>
        </div>
        {loyalty.ready && (
          <div className={`${card.kv} ${card.divider}`}>
            <span className={card.kvKey}>Loyalty tier</span>
            <span>
              <span className={`${card.kvValue} ${loyaltyTier.pct > 0 ? card.accentNum : ''}`}>
                {loyaltyTier.pct}%
              </span>{' '}
              <span className={card.faint}>off · {loyaltyTier.label}</span>
            </span>
          </div>
        )}
        {loyalty.ready && uruRemainingToTier !== null && (
          <p className={card.muted}>
            Hold <span className={card.num}>{uruShort(uruRemainingToTier)}</span> more URU
            to reach the +{nftCount > 0n ? 30 : 40}% tier.
          </p>
        )}
      </div>
    </section>
  );
}
