/// Fair launch rows joining the token feeds (home, explore, feed, profile).
///
/// Fair tokens are indexed into their own `fairLaunches` table, but their curve
/// trades, curves and graduations already share the token lane's tables. This maps
/// a `fairLaunches` row onto the `IndexerLaunch` shape so every list that reads
/// launches can show Fair tokens with no other changes. Pure, no imports, so the
/// node test runner can load it directly.

export type Hex = `0x${string}`;

export const FAIR_LAUNCH_FIELDS =
  'id chainId tokenAddress curveAddress launcher name ticker feePaid feeInUru createdAt blockNumber txHash';

export interface IndexerFairLaunchRow {
  id: string;
  chainId: number;
  tokenAddress: Hex;
  curveAddress: Hex;
  launcher: Hex;
  name: string;
  ticker: string;
  feePaid: string;
  feeInUru: boolean;
  createdAt: string;
  blockNumber: string;
  txHash: Hex;
}

const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function fairRowToLaunch(row: IndexerFairLaunchRow) {
  return {
    id: row.id,
    chainId: row.chainId,
    tokenAddress: row.tokenAddress,
    launchedBy: row.launcher,
    base: 0,
    name: row.name,
    ticker: row.ticker,
    configHash: ZERO_HASH,
    feePaid: row.feeInUru ? '0' : row.feePaid,
    installedHook: false,
    installedGovernance: false,
    installedBondingCurve: true,
    curveAddress: row.curveAddress,
    payToken: row.feeInUru ? ('URU' as const) : ('ETH' as const),
    uruPaid: row.feeInUru ? row.feePaid : null,
    hasWhitelist: false,
    blockNumber: row.blockNumber,
    blockTimestamp: row.createdAt,
    txHash: row.txHash,
    lane: 'fair' as const,
  };
}

/// Merge coin-lane and Fair rows, dedupe by id, newest first.
export function mergeFairLaunches<T extends { id: string; blockTimestamp: string }>(
  routerRows: T[],
  fairRows: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...routerRows, ...fairRows]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => Number(BigInt(b.blockTimestamp) - BigInt(a.blockTimestamp)));
}
