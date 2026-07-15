'use client';

import { useEffect, useState } from 'react';

/// Client-only relative-time hook. Returns `null` on SSR + first paint so hydration
/// stays stable, then a formatted string like "12s", "3m", "2h", "5d" that ticks every
/// 30 seconds. Callers should render a placeholder ("—" or "…") when the return is null.
///
/// Why not a static NOW constant: the mock preview uses a frozen timestamp so its "3m ago"
/// labels never shift; live launches use real timestamps that would go negative against a
/// frozen NOW. This hook gives real times without SSR-hydration mismatch.
export function useAgo(timestampSec: number | null | undefined): string | null {
  const [nowSec, setNowSec] = useState<number | null>(null);
  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  if (nowSec == null || timestampSec == null) return null;
  const s = Math.max(0, nowSec - timestampSec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
