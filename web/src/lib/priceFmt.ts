/// Human-friendly formatters for on-chain prices.
///
/// Curve spot prices are wei-per-token (ETH/token in 18-decimal fixed-point). For a launched
/// memecoin that ends up in the 1e9 to 1e14 wei-per-token range — meaningless as "5.05e-9 ETH"
/// or "0.00000000505 ETH" but perfectly readable as "5.051 gwei/token". Same trick the chart
/// uses for its Y-axis. Consolidated here so /trade and /trade/[address] format identically.

/// Convert wei-per-token → gwei-per-token, formatted with dynamic precision.
///   – small values (< 10 gwei): 4 decimals ("5.0510")
///   – medium (10–1000 gwei):    2 decimals ("152.30")
///   – large (>= 1000 gwei):     0 decimals ("12,340")
export function formatGweiPerToken(weiPerToken: bigint): string {
  if (weiPerToken === 0n) return '0';
  const gwei = Number(weiPerToken) / 1e9;
  if (!Number.isFinite(gwei) || gwei <= 0) return '—';
  if (gwei < 10) return gwei.toFixed(4);
  if (gwei < 1000) return gwei.toFixed(2);
  return gwei.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/// Round trip via toFixed for display but never lose precision when the input is < 1 gwei.
/// Currently exposed only via `formatGweiPerToken` — helper kept for future use (mkt cap,
/// last-trade fills, etc.) if we want the same threshold-based ladder elsewhere.
export function formatWeiAsGwei(wei: bigint, decimalsWhenSmall = 4): string {
  const gwei = Number(wei) / 1e9;
  if (!Number.isFinite(gwei) || gwei <= 0) return '0';
  return gwei.toFixed(decimalsWhenSmall);
}
