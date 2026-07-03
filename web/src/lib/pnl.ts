/// Per-position PnL aggregation from a wallet's trade history.
///
/// Given a list of IndexerTrade rows for one address, this groups by token and
/// computes: ETH spent buying, ETH received selling, tokens accumulated, tokens
/// sold, weighted-avg cost basis (ETH per token from buys only), realized PnL
/// (ETH received − cost basis × tokens sold), and remaining position size.
///
/// Unrealized PnL requires a spot price for each held token — the caller can
/// supply it via `spotPrices[tokenAddress]` (wei per token). If missing, the
/// unrealized field is set to null and the UI shows a dash.

import type { IndexerTrade } from './indexer';

export interface Position {
  tokenAddress: `0x${string}`;
  buyCount: number;
  sellCount: number;
  ethSpent: bigint;
  ethReceived: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  /// tokens still held according to trade history (may drift from onchain balance).
  netTokens: bigint;
  /// Weighted-avg cost basis in wei per (18-decimal) token unit. Zero if no buys.
  avgCostBasisWei: bigint;
  /// realized = ETH received - (avgCostBasis × tokensSold)
  realizedPnl: bigint;
  /// unrealized = (spotPrice × netTokens) - (avgCostBasis × netTokens). Null if no spot supplied.
  unrealizedPnl: bigint | null;
  /// Full PnL = realized + unrealized (or realized only if no spot).
  totalPnl: bigint;
  /// Newest trade timestamp (unix seconds) — used for sorting positions "most recent first".
  lastTradeTs: number;
}

/// One-decimal-place ETH percentage helper. Guards against div-by-zero.
export function pctOf(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  // 6-decimal precision then scale to percent for readable numbers.
  const scaled = (numerator * 1_000_000n) / denominator;
  return Number(scaled) / 10_000; // percent with two decimals
}

/// Group + aggregate. Returns positions sorted by most recent trade first.
export function computePositions(
  trades: IndexerTrade[],
  spotPrices?: Record<string, bigint>,
): Position[] {
  const byToken = new Map<string, Position>();

  for (const t of trades) {
    const key = t.tokenAddress.toLowerCase();
    const existing = byToken.get(key) ?? {
      tokenAddress: t.tokenAddress,
      buyCount: 0,
      sellCount: 0,
      ethSpent: 0n,
      ethReceived: 0n,
      tokensBought: 0n,
      tokensSold: 0n,
      netTokens: 0n,
      avgCostBasisWei: 0n,
      realizedPnl: 0n,
      unrealizedPnl: null,
      totalPnl: 0n,
      lastTradeTs: 0,
    };
    const eth = BigInt(t.ethAmount);
    const tok = BigInt(t.tokenAmount);
    if (t.isBuy) {
      existing.buyCount += 1;
      existing.ethSpent += eth;
      existing.tokensBought += tok;
    } else {
      existing.sellCount += 1;
      existing.ethReceived += eth;
      existing.tokensSold += tok;
    }
    const ts = Number(t.blockTimestamp);
    if (ts > existing.lastTradeTs) existing.lastTradeTs = ts;
    byToken.set(key, existing);
  }

  const spotLookup = spotPrices ?? {};
  const out: Position[] = [];
  for (const pos of byToken.values()) {
    pos.netTokens = pos.tokensBought - pos.tokensSold;
    // avg cost basis per whole token (scaled by 1e18 for precision) — buys-only weighted avg
    pos.avgCostBasisWei = pos.tokensBought > 0n
      ? (pos.ethSpent * 10n ** 18n) / pos.tokensBought
      : 0n;
    // realized = eth received - cost basis × tokens sold
    const costBasisSold = (pos.avgCostBasisWei * pos.tokensSold) / 10n ** 18n;
    pos.realizedPnl = pos.ethReceived - costBasisSold;
    // unrealized = (spot × netTokens) - (cost basis × netTokens)
    const spot = spotLookup[pos.tokenAddress.toLowerCase()];
    if (spot !== undefined && pos.netTokens > 0n) {
      const currentValue = (spot * pos.netTokens) / 10n ** 18n;
      const costBasisHeld = (pos.avgCostBasisWei * pos.netTokens) / 10n ** 18n;
      pos.unrealizedPnl = currentValue - costBasisHeld;
    }
    pos.totalPnl = pos.realizedPnl + (pos.unrealizedPnl ?? 0n);
    out.push(pos);
  }
  return out.sort((a, b) => b.lastTradeTs - a.lastTradeTs);
}
