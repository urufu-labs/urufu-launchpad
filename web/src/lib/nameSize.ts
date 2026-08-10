/// Shared rule for shrinking a token name that would blow out its container.
///
/// Every card / header that renders `launch.name` picks its own base font size
/// (home bulletin: 34px, trending cards: 24px, discover/trade list: 13px).
/// Only truly long names get scaled — everyday names like "urufu labs",
/// "wojak coin", "cat named tim" (all ≤18 chars) stay at their full base size
/// so the design reads as unchanged 99% of the time. Only oddballs like
/// "animemangawaifuurufuhentaikawaii" (32 chars) trigger the ramp.
///
///   - up to 18 chars: untouched
///   - 19-24: -12%
///   - 25-32: -28%
///   - 33-42: -45%
///   - 43+:   -55% (floor)
export function sizeForName(name: string, basePx: number): number {
  const len = name.length;
  if (len <= 18) return basePx;
  if (len <= 24) return Math.round(basePx * 0.88);
  if (len <= 32) return Math.round(basePx * 0.72);
  if (len <= 42) return Math.round(basePx * 0.55);
  return Math.round(basePx * 0.45);
}

/// True when a name is long enough that `sizeForName` returns something other
/// than the base. Use this in JSX to conditionally apply the inline style so
/// short/normal names inherit whatever the CSS already sets (clamp, media
/// queries, etc.) without a fixed px override wiping that out.
export function isLongName(name: string): boolean {
  return name.length > 18;
}
