/// Shared rule for shrinking a token name that would blow out its container.
///
/// Every card / header that renders `launch.name` picks its own base font size
/// (home bulletin: 24px, trade header: 22px, discover cards: 16px, etc). Long
/// names like "animemangawaifuurufuhentaikawaii" (32 chars) blow those out and
/// either wrap ugly or overflow. This helper returns a scaled px size that
/// stays inside the container without a container query.
///
/// Curve is intentionally gentle so short names look untouched:
///   - up to 12 chars: full base size
///   - 13-18: -8%
///   - 19-24: -18%
///   - 25-30: -30%
///   - 31+:   -42% (floor)
///
/// Sizes clamp to a minimum of 55% of the base so a 60-char name still reads.
export function sizeForName(name: string, basePx: number): number {
  const len = name.length;
  if (len <= 12) return basePx;
  if (len <= 18) return Math.round(basePx * 0.92);
  if (len <= 24) return Math.round(basePx * 0.82);
  if (len <= 30) return Math.round(basePx * 0.70);
  if (len <= 40) return Math.round(basePx * 0.58);
  return Math.round(basePx * 0.55);
}
