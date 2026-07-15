/// Client for compile-service's /rewards routes. Serves the flywheel claim UI on
/// the profile page: fetches vault state + per-holder proofs.
///
/// All endpoints are public GETs (no signature envelope); publishing happens
/// server-side via the operator, so the frontend only reads.

import type { Address, Hex } from 'viem';

const BASE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/// Chain slugs the compile-service knows about. Adding a new one requires wiring
/// its config in `rewards.ts` server-side; keep the client union in sync.
export type RewardsChain = 'base';

export interface VaultSummary {
  chainId: number;
  vaultAddress: Address;
  vaultBalance: string; // wei
  nextEpochId: number;
  publishedEpochs: number;
}

export async function fetchVaultSummary(chain: RewardsChain): Promise<VaultSummary | null> {
  return getJson<VaultSummary>(`/rewards/${chain}/vault-summary`);
}

export interface EpochAllocation {
  epochId: number;
  amount: string; // wei
  proof: Hex[];
}

export async function fetchEpochsForHolder(
  chain: RewardsChain,
  address: Address,
): Promise<EpochAllocation[]> {
  const data = await getJson<{ items: EpochAllocation[] }>(`/rewards/${chain}/epochs/${address}`);
  return data?.items ?? [];
}

export async function fetchProof(
  chain: RewardsChain,
  epochId: number,
  address: Address,
): Promise<EpochAllocation | null> {
  return getJson<EpochAllocation>(`/rewards/${chain}/${epochId}/${address}`);
}
