/// Per-IP rate limits for every v2 route and MCP tool (threat T7).
///
/// Fixed-window counters held in memory. On Vercel each function instance keeps its
/// own counters, so the effective ceiling is per instance; Fluid Compute reuses
/// instances, which keeps this close to per-IP in practice. Good enough for read
/// tools; a shared store is a 1c item before autonomous mode.

export interface RateRule {
  /// Max requests per window.
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  ok: boolean;
  remaining: number;
  /// Seconds until the window resets (for Retry-After).
  retryAfter: number;
}

export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private maxKeys: number;
  private now: () => number;

  constructor(opts: { maxKeys?: number; now?: () => number } = {}) {
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  check(key: string, rule: RateRule): RateDecision {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t - e.start >= rule.windowMs) {
      if (!e && this.hits.size >= this.maxKeys) this.evict(t, rule.windowMs);
      e = { start: t, count: 0 };
      this.hits.set(key, e);
    }
    const retryAfter = Math.max(1, Math.ceil((e.start + rule.windowMs - t) / 1000));
    if (e.count >= rule.limit) return { ok: false, remaining: 0, retryAfter };
    e.count++;
    return { ok: true, remaining: rule.limit - e.count, retryAfter };
  }

  /// Drop expired windows; if still full, drop the oldest half so memory stays bounded.
  private evict(t: number, windowMs: number) {
    for (const [k, e] of this.hits) if (t - e.start >= windowMs) this.hits.delete(k);
    if (this.hits.size < this.maxKeys) return;
    const drop = Math.ceil(this.hits.size / 2);
    let i = 0;
    for (const k of this.hits.keys()) {
      if (i++ >= drop) break;
      this.hits.delete(k);
    }
  }

  reset() {
    this.hits.clear();
  }
}

/// Caller IP from proxy headers. On Vercel `x-forwarded-for` is set by the edge
/// (client-supplied values are overwritten), so its first entry is the client.
export function clientIp(headers: { get(name: string): string | null }): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = headers.get('x-real-ip')?.trim();
  return real ? real.slice(0, 64) : 'unknown';
}
