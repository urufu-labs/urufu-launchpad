/// Fill `tokenAddress` on v4 swap rows from a poolId -> token map instead of
/// dropping rows where the indexer left it null (graduated / legacy pools whose
/// graduations join failed at ingest). Pure so the node test runner can load it.

export interface PoolTokenPair {
  poolId: string | null;
  tokenAddress: string | null;
}

/// poolId (lowercase) -> token (lowercase). Later sources do not override earlier
/// ones, so pass indexer graduations first and static fallbacks after.
export function buildPoolTokenMap(...sources: PoolTokenPair[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const src of sources) {
    for (const { poolId, tokenAddress } of src) {
      if (!poolId || !tokenAddress) continue;
      const k = poolId.toLowerCase();
      if (!map.has(k)) map.set(k, tokenAddress.toLowerCase());
    }
  }
  return map;
}

/// Rows with a token keep it; rows without one get it from the map; rows the map
/// can't place are dropped (they are not launchpad pools).
export function fillSwapTokens<T extends { poolId: string; tokenAddress: string | null }>(
  rows: T[],
  map: Map<string, string>,
): Array<T & { tokenAddress: string }> {
  const out: Array<T & { tokenAddress: string }> = [];
  for (const r of rows) {
    const token = r.tokenAddress ?? map.get(r.poolId.toLowerCase()) ?? null;
    if (token) out.push({ ...r, tokenAddress: token });
  }
  return out;
}
