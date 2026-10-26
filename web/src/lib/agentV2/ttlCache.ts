/// Small TTL cache for indexer and chain reads behind the v2 tools. Dedupes
/// concurrent identical calls (one in-flight promise per key) and evicts failures
/// at once so the next call retries. Bounded so a key-spraying client can't grow it.

export class TtlCache {
  private entries = new Map<string, { at: number; promise: Promise<unknown> }>();
  private maxEntries: number;
  private now: () => number;

  constructor(opts: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
    if (this.entries.size >= this.maxEntries) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const promise = load().catch((err) => {
      this.entries.delete(key);
      throw err;
    });
    this.entries.set(key, { at: this.now(), promise });
    return promise;
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}
