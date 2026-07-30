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
export type RewardsChain = 'robinhood';

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

/// The API's `proof` field is stored as a JSONB column server-side. Depending
/// on how a row was inserted (raw SQL vs postgres.js template literal), the
/// column can round-trip as either a real array or a JSON-encoded string.
/// Normalize both shapes into a real array so the claim button always passes
/// wagmi a proper bytes32[] arg (viem rejects strings with "not a valid array").
function normalizeProof(raw: unknown): Hex[] {
  if (Array.isArray(raw)) return raw as Hex[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as Hex[];
    } catch {
      /* fall through */
    }
  }
  return [];
}

function normalizeAllocation(row: unknown): EpochAllocation {
  const r = row as { epochId: number; amount: string; proof: unknown };
  return { epochId: r.epochId, amount: r.amount, proof: normalizeProof(r.proof) };
}

export async function fetchEpochsForHolder(
  chain: RewardsChain,
  address: Address,
): Promise<EpochAllocation[]> {
  const data = await getJson<{ items: EpochAllocation[] }>(`/rewards/${chain}/epochs/${address}`);
  return (data?.items ?? []).map(normalizeAllocation);
}

export async function fetchProof(
  chain: RewardsChain,
  epochId: number,
  address: Address,
): Promise<EpochAllocation | null> {
  const raw = await getJson<EpochAllocation>(`/rewards/${chain}/${epochId}/${address}`);
  return raw ? normalizeAllocation(raw) : null;
}
