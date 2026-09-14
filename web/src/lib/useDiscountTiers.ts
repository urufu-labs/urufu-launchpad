/**
 * `useDiscountTiers` — read a mint module's discount-tier list, and for
 * every ExternalNft tier the connected wallet might qualify for, fetch a
 * signed attestation from the compile-service.
 *
 * Contract mapping (see `contracts/src/nft/NftMintModule.sol`):
 *   - `tiersCount()` → uint256
 *   - `tierAt(i)`   → DiscountTier { kind, walletListRoot, externalCollection,
 *                                    externalChainId, percentPerNftBps,
 *                                    maxCountedNfts, fixedDiscountBps }
 *   - `TierKind`     0 = WalletList, 1 = ExternalNft
 *
 * The mint call takes `discountProofs: TierProof[]` — one entry per tier
 * the wallet is claiming. This hook returns the array in the exact shape
 * `mint`/`mintWithUru` expects, so the caller just spreads it into the
 * writeContract args.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useAccount, useChainId, useReadContract, useReadContracts } from 'wagmi';
import { nftMintModuleAbi } from './abis';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export const TierKind = { WalletList: 0, ExternalNft: 1 } as const;
export type TierKindValue = (typeof TierKind)[keyof typeof TierKind];

export interface DiscountTier {
  index: number;
  kind: TierKindValue;
  walletListRoot: Hex;
  externalCollection: Address;
  externalChainId: bigint;
  percentPerNftBps: bigint;
  maxCountedNfts: bigint;
  fixedDiscountBps: bigint;
}

/// Shape the mint module accepts on-chain (matches ABI tuple).
export interface TierProof {
  tierId: bigint;
  merkleProof: readonly Hex[];
  count: bigint;
  expiry: bigint;
  sig: Hex;
}

export interface DiscountTiersState {
  loading: boolean;
  tiers: readonly DiscountTier[];
  /// ExternalNft tiers where the caller wallet's on-chain balance was
  /// attested by compile-service. Ready to spread into mint().
  externalProofs: readonly TierProof[];
  /// True while attestation fetches are in-flight; UI shows a spinner.
  fetchingAttestations: boolean;
  /// Any per-tier attestation error. Non-fatal — tier is skipped in the
  /// proof array, mint still fires with whatever proofs succeeded.
  attestationErrors: Readonly<Record<number, string>>;
  /// Sum of discount bps across all claimed tiers, pre-clamp. UI uses
  /// this to preview savings; the on-chain math still clamps at the
  /// module's `discountCeilingBps` regardless of what we send.
  claimedDiscountBps: bigint;
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/// Compile-service host — env-vared so preview / staging can point at
/// their own instance. Defaults to same-origin so a Next.js API rewrite
/// or route handler at /api/nft-discount/attest works out of the box.
const ATTEST_BASE = process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? '';

export function useDiscountTiers(
  mintModule: Address | undefined,
  ourCollection: Address | undefined,
): DiscountTiersState {
  const { address: wallet } = useAccount();
  const chainId = useChainId();

  // ---- 1. Read tiersCount() so we know how many tierAt() reads to fire.
  const countRead = useReadContract({
    address: mintModule,
    abi: nftMintModuleAbi,
    functionName: 'tiersCount',
    query: { enabled: !!mintModule },
  });
  const count = Number(countRead.data ?? 0n);

  // ---- 2. Fan out tierAt(i) for every i in [0, count).
  const tierReads = useReadContracts({
    contracts: mintModule
      ? Array.from({ length: count }, (_, i) => ({
          address: mintModule,
          abi: nftMintModuleAbi,
          functionName: 'tierAt' as const,
          args: [BigInt(i)] as const,
        }))
      : [],
    query: { enabled: !!mintModule && count > 0 },
  });

  const tiers = useMemo<readonly DiscountTier[]>(() => {
    if (!tierReads.data) return [];
    return tierReads.data
      .map((r, i) => {
        if (r.status !== 'success' || !r.result) return null;
        const t = r.result as {
          kind: number;
          walletListRoot: Hex;
          externalCollection: Address;
          externalChainId: bigint;
          percentPerNftBps: bigint;
          maxCountedNfts: bigint;
          fixedDiscountBps: bigint;
        };
        return {
          index: i,
          kind: t.kind as TierKindValue,
          walletListRoot: t.walletListRoot,
          externalCollection: t.externalCollection,
          externalChainId: t.externalChainId,
          percentPerNftBps: t.percentPerNftBps,
          maxCountedNfts: t.maxCountedNfts,
          fixedDiscountBps: t.fixedDiscountBps,
        } as DiscountTier;
      })
      .filter((t): t is DiscountTier => t !== null);
  }, [tierReads.data]);

  // ---- 3. For each ExternalNft tier, fetch a signed attestation. One
  //         request per tier — cached server-side per (wallet, tier)
  //         so re-mounts hit the same 30s cache window.
  const [externalProofs, setExternalProofs] = useState<readonly TierProof[]>([]);
  const [attestationErrors, setAttestationErrors] = useState<Record<number, string>>({});
  const [fetchingAttestations, setFetchingAttestations] = useState(false);

  useEffect(() => {
    if (!wallet || !ourCollection || tiers.length === 0) {
      setExternalProofs([]);
      setAttestationErrors({});
      return;
    }
    const externalTiers = tiers.filter((t) => t.kind === TierKind.ExternalNft);
    if (externalTiers.length === 0) {
      setExternalProofs([]);
      setAttestationErrors({});
      return;
    }

    let cancelled = false;
    setFetchingAttestations(true);
    setAttestationErrors({});

    Promise.all(
      externalTiers.map(async (tier) => {
        try {
          const res = await fetch(`${ATTEST_BASE}/api/nft-discount/attest`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              callerChainId: chainId,
              wallet,
              ourCollection,
              targetCollection: tier.externalCollection,
              targetChainId: Number(tier.externalChainId),
              tierId: tier.index,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            return {
              index: tier.index,
              error: body.error ?? `attest ${res.status}`,
              proof: null as TierProof | null,
            };
          }
          const body = (await res.json()) as { count: string; expiry: string; sig: Hex };
          const count = BigInt(body.count);
          // Zero-balance holders don't qualify — skip the proof so the
          // on-chain call doesn't waste gas on a zero-discount tier.
          if (count === 0n) {
            return { index: tier.index, error: null, proof: null };
          }
          return {
            index: tier.index,
            error: null,
            proof: {
              tierId: BigInt(tier.index),
              merkleProof: [] as readonly Hex[],
              count,
              expiry: BigInt(body.expiry),
              sig: body.sig,
            } satisfies TierProof,
          };
        } catch (err) {
          return {
            index: tier.index,
            error: (err as Error).message,
            proof: null,
          };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const proofs: TierProof[] = [];
      const errors: Record<number, string> = {};
      for (const r of results) {
        if (r.error) errors[r.index] = r.error;
        if (r.proof) proofs.push(r.proof);
      }
      setExternalProofs(proofs);
      setAttestationErrors(errors);
      setFetchingAttestations(false);
    });

    return () => {
      cancelled = true;
      setFetchingAttestations(false);
    };
    // ownCollection changes for each collection page; wallet + chain
    // captured; tiers rebuilt when a fresh read completes.
  }, [wallet, ourCollection, chainId, tiers]);

  // ---- 4. Preview total discount from claimed tiers. Contract clamps
  //         at discountCeilingBps; this is display-only.
  const claimedDiscountBps = useMemo(() => {
    let bps = 0n;
    for (const proof of externalProofs) {
      const tier = tiers[Number(proof.tierId)];
      if (!tier || tier.kind !== TierKind.ExternalNft) continue;
      const counted =
        proof.count > tier.maxCountedNfts ? tier.maxCountedNfts : proof.count;
      bps += counted * tier.percentPerNftBps;
    }
    return bps;
  }, [externalProofs, tiers]);

  return {
    loading: countRead.isLoading || tierReads.isLoading,
    tiers,
    externalProofs,
    fetchingAttestations,
    attestationErrors,
    claimedDiscountBps,
  };
}
