'use client';

/// "Token value of 1 NFT" for DN404 listings (docs/SPEC-marketplace.md):
/// one NFT is backed by `unit` tokens, so this is what those tokens cost at
/// the current price. Next to a listing's price it tells a buyer how much of
/// the price is trait premium.
///
/// Price source, in order:
///   - on the curve: BondingCurve.priceWeiPerToken() (spot, wei per whole token)
///   - graduated ETH pool: latest v4 swap sqrtPriceX96 (ETH is currency0)
///   - URU-paired (pairCurrency != 0): the pair curve / pair pool price, in URU
/// `unit` is null when the price isn't known yet.

import { useEffect, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import { useReadContract } from 'wagmi';

import { bondingCurveAbi, dn404BondingCurveAbi } from './abis';
import type { MARKET_CHAIN_ID } from './market';
import {
  fetchCurveByToken,
  fetchPairCurveByToken,
  fetchPairV4SummaryForToken,
  fetchV4SummaryForToken,
} from './indexer';

const Q192 = 2n ** 192n;
const ONE = 10n ** 18n;

export interface Dn404TokenValue {
  /// Value of one NFT's tokens, in `unit` wei. Null while loading / unknown.
  value: bigint | null;
  unit: 'ETH' | 'URU' | null;
}

export function useDn404TokenValue(
  pairedToken: Address | undefined,
  unitWei: bigint | undefined,
  chainId: typeof MARKET_CHAIN_ID,
): Dn404TokenValue {
  const enabled = !!pairedToken && pairedToken !== zeroAddress && !!unitWei && unitWei > 0n;
  const [src, setSrc] = useState<
    | { kind: 'curve'; curve: Address; pair: boolean }
    | { kind: 'fixed'; pricePerToken: bigint; pair: boolean }
    | null
  >(null);

  useEffect(() => {
    if (!enabled || !pairedToken) { setSrc(null); return; }
    let cancelled = false;
    (async () => {
      const ethCurve = await fetchCurveByToken(pairedToken);
      if (cancelled) return;
      if (ethCurve) {
        if (!ethCurve.graduated) { setSrc({ kind: 'curve', curve: ethCurve.curveAddress, pair: false }); return; }
        const v4 = await fetchV4SummaryForToken(pairedToken);
        if (cancelled) return;
        if (v4 && v4.latestSqrtPriceX96 > 0n) {
          // amount1/amount0 = sqrtP^2 / 2^192 tokens per ETH, so ETH wei per
          // whole token = 1e18 * 2^192 / sqrtP^2.
          const sq = v4.latestSqrtPriceX96 * v4.latestSqrtPriceX96;
          setSrc({ kind: 'fixed', pricePerToken: (ONE * Q192) / sq, pair: false });
        } else {
          setSrc(null);
        }
        return;
      }
      const pairCurve = await fetchPairCurveByToken(pairedToken);
      if (cancelled || !pairCurve) return;
      if (!pairCurve.graduated) { setSrc({ kind: 'curve', curve: pairCurve.curveAddress, pair: true }); return; }
      const pv4 = await fetchPairV4SummaryForToken(pairedToken);
      if (cancelled) return;
      setSrc(pv4 && pv4.latestPricePairPerToken > 0n ? { kind: 'fixed', pricePerToken: pv4.latestPricePairPerToken, pair: true } : null);
    })();
    return () => { cancelled = true; };
  }, [enabled, pairedToken]);

  const curveAddr = src?.kind === 'curve' ? src.curve : undefined;
  const { data: spot } = useReadContract({
    address: curveAddr,
    abi: src?.kind === 'curve' && src.pair ? dn404BondingCurveAbi : bondingCurveAbi,
    functionName: 'priceWeiPerToken',
    chainId,
    query: { enabled: !!curveAddr, staleTime: 15_000, refetchInterval: 30_000 },
  });

  if (!enabled || !src || !unitWei) return { value: null, unit: null };
  const perToken = src.kind === 'fixed' ? src.pricePerToken : (spot as bigint | undefined);
  if (perToken === undefined) return { value: null, unit: null };
  return { value: (perToken * unitWei) / ONE, unit: src.pair ? 'URU' : 'ETH' };
}
