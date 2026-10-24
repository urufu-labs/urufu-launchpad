/// Token metadata (name, image, traits) + rarity for the marketplace's Listed
/// tab. Metadata is fetched server-side once per token (tokenURI on chain,
/// JSON through IPFS gateways) and cached in app.market_token_meta.
///
/// Rarity needs every token's traits, so a collection-wide scan runs in the
/// background the first time a collection's listings are requested, only for
/// collections up to MARKET_RARITY_MAX_SUPPLY tokens (default 3000; a big
/// DN404 collection like 80k NFTs would take hours of gateway fetches). The
/// score is the usual statistical one: sum over a token's traits of
/// (tokens scanned / tokens sharing that trait value). Rank 1 = rarest.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Hex } from 'viem';

import { sql as defaultSql } from './db.ts';
import { readTokenUris } from './market-chain.ts';

type Sql = NonNullable<typeof defaultSql>;

export interface TokenTrait {
  trait_type: string;
  value: string;
}

export interface TokenMeta {
  tokenId: bigint;
  name: string | null;
  image: string | null;
  attributes: TokenTrait[];
  /// When it was fetched (ms). Rows older than META_TTL_MS get refetched, so a
  /// collection that reveals its art after mint picks up the real traits.
  fetchedAt?: number;
}

export const META_TTL_MS = 24 * 3600_000;

/// A jsonb column read back through postgres.js. `${JSON.stringify(x)}::jsonb`
/// with `prepare: false` stores a jsonb STRING ("[]"), not the array, so rows
/// written that way come back as text. Parse those; pass real values through.
export function jsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return (raw ?? fallback) as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/// Traits from a stored row, always an array of {trait_type, value}.
export function storedTraits(raw: unknown): TokenTrait[] {
  const v = jsonColumn<unknown>(raw, []);
  return Array.isArray(v) ? parseTokenMeta(0n, { attributes: v }).attributes : [];
}

export interface MetaStore {
  get(collection: Hex, ids: bigint[]): Promise<Map<string, TokenMeta>>;
  put(collection: Hex, rows: TokenMeta[]): Promise<void>;
  all(collection: Hex): Promise<TokenMeta[]>;
}

export function postgresMetaStore(sql: Sql): MetaStore {
  return {
    async get(collection, ids) {
      const out = new Map<string, TokenMeta>();
      if (ids.length === 0) return out;
      const rows = await sql<Array<{ token_id: string; name: string | null; image: string | null; attributes: TokenTrait[]; fetched_at: Date }>>`
        SELECT token_id, name, image, attributes, fetched_at FROM app.market_token_meta
        WHERE collection = ${collection.toLowerCase()} AND ok = true
          AND token_id = ANY(${ids.map((i) => i.toString())}::numeric[])
      `;
      for (const r of rows) {
        out.set(r.token_id, {
          tokenId: BigInt(r.token_id), name: r.name, image: r.image, attributes: storedTraits(r.attributes),
          fetchedAt: new Date(r.fetched_at).getTime(),
        });
      }
      return out;
    },
    async put(collection, rows) {
      for (const m of rows) {
        await sql`
          INSERT INTO app.market_token_meta (collection, token_id, name, image, attributes, ok)
          VALUES (${collection.toLowerCase()}, ${m.tokenId.toString()}, ${m.name}, ${m.image}, ${JSON.stringify(m.attributes)}::text::jsonb, true)
          ON CONFLICT (collection, token_id) DO UPDATE
            SET name = EXCLUDED.name, image = EXCLUDED.image, attributes = EXCLUDED.attributes, ok = true, fetched_at = now()
        `;
      }
    },
    async all(collection) {
      const rows = await sql<Array<{ token_id: string; name: string | null; image: string | null; attributes: TokenTrait[] }>>`
        SELECT token_id, name, image, attributes FROM app.market_token_meta
        WHERE collection = ${collection.toLowerCase()} AND ok = true
      `;
      return rows.map((r) => ({ tokenId: BigInt(r.token_id), name: r.name, image: r.image, attributes: storedTraits(r.attributes) }));
    },
  };
}

export function memoryMetaStore(): MetaStore {
  const rows = new Map<string, TokenMeta>();
  const k = (c: string, id: bigint) => `${c.toLowerCase()}:${id}`;
  return {
    async get(collection, ids) {
      const out = new Map<string, TokenMeta>();
      for (const id of ids) {
        const r = rows.get(k(collection, id));
        if (r) out.set(id.toString(), r);
      }
      return out;
    },
    async put(collection, list) {
      for (const m of list) rows.set(k(collection, m.tokenId), { ...m, fetchedAt: m.fetchedAt ?? Date.now() });
    },
    async all(collection) {
      const p = `${collection.toLowerCase()}:`;
      return [...rows.entries()].filter(([key]) => key.startsWith(p)).map(([, v]) => v);
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
] as const;
const MAX_META_BYTES = 256 * 1024;

/// Pull name / image / attributes out of untrusted metadata JSON.
export function parseTokenMeta(tokenId: bigint, json: unknown): TokenMeta {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  const attrsRaw = Array.isArray(j.attributes) ? j.attributes : Array.isArray(j.traits) ? j.traits : [];
  const attributes: TokenTrait[] = [];
  for (const a of attrsRaw.slice(0, 64)) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const type = str(o.trait_type ?? o.type, 64);
    const value = o.value;
    if (!type || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) continue;
    attributes.push({ trait_type: type, value: String(value).slice(0, 128) });
  }
  return { tokenId, name: str(j.name, 200), image: str(j.image ?? j.image_url, 2048), attributes };
}

/// True for loopback, private, link-local, CGNAT and other non-public ranges.
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
  }
  return true;
}

/// Metadata URLs come from launcher-controlled token URIs, so never let them
/// reach this service's private network (Railway *.railway.internal, Postgres,
/// cloud metadata). https only, public hostnames, every resolved address public.
export async function isSafePublicUrl(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/// fetch with redirects followed by hand (max 3), each hop re-checked.
async function safeFetch(url: string, fetchImpl: typeof fetch, checkUrl: (u: string) => Promise<boolean>): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await checkUrl(current))) return null;
    const res = await fetchImpl(current, { signal: AbortSignal.timeout(8_000), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  return null;
}

export async function fetchMetadataJson(
  uri: string,
  fetchImpl: typeof fetch = fetch,
  checkUrl: (u: string) => Promise<boolean> = isSafePublicUrl,
): Promise<unknown | null> {
  if (uri.startsWith('data:application/json')) {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    const payload = uri.slice(comma + 1);
    try {
      const text = uri.slice(0, comma).includes(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  let urls: string[];
  if (uri.startsWith('ipfs://')) {
    const path = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
    urls = GATEWAYS.map((g) => g + path);
  } else if (uri.startsWith('https://')) {
    urls = [uri];
  } else {
    return null;
  }
  for (const url of urls) {
    try {
      const res = await safeFetch(url, fetchImpl, checkUrl);
      if (!res) continue;
      if (res.status === 404) return null;
      if (!res.ok) continue;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_META_BYTES) return null;
      const text = await res.text();
      if (text.length > MAX_META_BYTES) return null;
      return JSON.parse(text);
    } catch {
      // timeout / 429 / bad JSON: next gateway
    }
  }
  return null;
}

/// Fetch + cache metadata for `ids` (skips ids already cached). Bounded
/// concurrency so a census doesn't hammer the gateways.
export async function fillMeta(
  store: MetaStore,
  collection: Hex,
  ids: bigint[],
  opts: { concurrency?: number; fetchImpl?: typeof fetch; tokenUris?: (c: Hex, ids: bigint[]) => Promise<Array<string | null>> } = {},
): Promise<number> {
  const have = await store.get(collection, ids);
  const now = Date.now();
  const missing = ids.filter((id) => {
    const m = have.get(id.toString());
    return !m || (m.fetchedAt !== undefined && now - m.fetchedAt > META_TTL_MS);
  });
  if (missing.length === 0) return 0;
  const uris = await (opts.tokenUris ?? readTokenUris)(collection, missing);
  const concurrency = opts.concurrency ?? 6;
  let next = 0;
  let stored = 0;
  const worker = async () => {
    while (next < missing.length) {
      const i = next++;
      const uri = uris[i];
      const id = missing[i];
      if (!uri || id === undefined) continue;
      const json = await fetchMetadataJson(uri, opts.fetchImpl);
      if (json === null) continue;
      await store.put(collection, [parseTokenMeta(id, json)]);
      stored++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  return stored;
}

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------

/// tokenId -> rank (1 = rarest). Ties share a rank.
export function rarityRanks(tokens: TokenMeta[]): Map<string, number> {
  const n = tokens.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;
  const counts = new Map<string, number>();
  const key = (t: TokenTrait) => `${t.trait_type}\u0000${t.value}`;
  for (const t of tokens) for (const a of t.attributes) counts.set(key(a), (counts.get(key(a)) ?? 0) + 1);
  const scored = tokens.map((t) => ({
    id: t.tokenId.toString(),
    score: t.attributes.reduce((s, a) => s + n / (counts.get(key(a)) ?? n), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = Number.NaN;
  scored.forEach((s, i) => {
    if (s.score !== prev) rank = i + 1;
    prev = s.score;
    ranks.set(s.id, rank);
  });
  return ranks;
}

export function rarityMaxSupply(): number {
  const raw = Number(process.env.MARKET_RARITY_MAX_SUPPLY ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3000;
}

/// Background collection scans + cached rarity per collection.
export class RarityIndex {
  private running = new Set<string>();
  private done = new Map<string, { at: number; ranks: Map<string, number>; scanned: number }>();
  private store: MetaStore;
  private log: (msg: string, extra?: object) => void;
  constructor(store: MetaStore, log: (msg: string, extra?: object) => void = () => {}) {
    this.store = store;
    this.log = log;
  }

  /// Ranks if a full scan finished in this process, else null (and starts
  /// one when the collection is small enough).
  ranksFor(collection: Hex, maxSupply: bigint): { ranks: Map<string, number>; scanned: number } | null {
    const key = collection.toLowerCase();
    const hit = this.done.get(key);
    // Rescan every 6h so newly minted tokens join the census.
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;
    if (maxSupply > 0n && maxSupply <= BigInt(rarityMaxSupply()) && !this.running.has(key)) {
      this.running.add(key);
      void this.scan(key as Hex, maxSupply).finally(() => this.running.delete(key));
    }
    return hit ?? null;
  }

  private async scan(collection: Hex, maxSupply: bigint): Promise<void> {
    try {
      const ids: bigint[] = [];
      for (let i = 1n; i <= maxSupply; i++) ids.push(i);
      // Token ids start at 1 on both lanes (ERC721ATemplate._startTokenId,
      // DN404). Unminted ids fail tokenURI and are skipped.
      for (let i = 0; i < ids.length; i += 200) {
        await fillMeta(this.store, collection, ids.slice(i, i + 200), { concurrency: 4 });
      }
      const all = await this.store.all(collection);
      this.done.set(collection.toLowerCase(), { at: Date.now(), ranks: rarityRanks(all), scanned: all.length });
      this.log('market: rarity scan done', { collection, scanned: all.length });
    } catch (err) {
      this.log('market: rarity scan failed', { collection, err: err instanceof Error ? err.message : String(err) });
    }
  }
}
