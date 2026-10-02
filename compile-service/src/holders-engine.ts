/// On-chain holder engine: current holders of an ERC-721 / ERC-20 / ERC-1155
/// contract, computed from its transfer events over a plain JSON-RPC endpoint.
///
/// Why this exists (2026-10-02): the Alchemy account backing the NFT API was
/// suspended over an unpaid bill, and Robinhood's Blockscout API sits behind a
/// Cloudflare challenge. Robinhood's PUBLIC RPC is free and, measured:
///   - eth_getLogs accepts up to 10,000,000 blocks per call (it rejects wider
///     ranges with "only 10000000 are allowed"), so a sparse contract's whole
///     history is ~8 calls. The urufu gemu nft full history (~8.4k transfers)
///     scanned in ~5.5s.
///   - ~20 req/s sustained before HTTP 429; a JSON-RPC batch counts every inner
///     call, so this module never batches.
///   - no archive state (historical eth_getCode errors), so deploy blocks can't
///     be binary-searched; scanning from block 0 is cheap instead.
///
/// One `eth_getLogs` per range fetches all three transfer shapes at once
/// (topic0 OR-list). Results are cached per (rpc, contract) and refreshed
/// incrementally, so repeat calls only scan new blocks.

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

const ZERO = '0x0000000000000000000000000000000000000000';

export type TokenStandard = 'erc721' | 'erc20' | 'erc1155' | 'unknown';

export interface RawLog {
  topics: readonly string[];
  data: string;
  blockNumber: string;
  logIndex: string;
}

export interface HolderRow {
  address: string;
  balance: bigint;
  tokenIds: string[];
}

/// Mutable per-contract state. ERC-721 tracks token -> owner (so token ids per
/// holder are exact); ERC-20 / ERC-1155 track balances.
export interface HolderState {
  standard: TokenStandard;
  owners: Map<string, string>;                 // erc721: tokenId -> owner
  balances: Map<string, bigint>;               // erc20: owner -> amount
  balances1155: Map<string, Map<string, bigint>>; // erc1155: owner -> (id -> amount)
  lastBlock: bigint;                           // inclusive; -1 = nothing scanned
}

export function newState(): HolderState {
  return { standard: 'unknown', owners: new Map(), balances: new Map(), balances1155: new Map(), lastBlock: -1n };
}

const addrFromTopic = (t: string | undefined): string => `0x${(t ?? '').slice(-40)}`.toLowerCase();
const word = (data: string, i: number): bigint => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);

/// Apply transfer logs in chain order. Pure; exported for tests.
export function applyLogs(state: HolderState, logs: readonly RawLog[]): void {
  const sorted = [...logs].sort((a, b) => {
    const bd = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    return bd !== 0n ? (bd < 0n ? -1 : 1) : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
  for (const log of sorted) {
    const t0 = (log.topics[0] ?? '').toLowerCase();
    if (t0 === TRANSFER_TOPIC && log.topics.length === 4) {
      if (state.standard === 'unknown') state.standard = 'erc721';
      if (state.standard !== 'erc721') continue;
      const to = addrFromTopic(log.topics[2]);
      const id = BigInt(log.topics[3] ?? '0x0').toString();
      if (to === ZERO) state.owners.delete(id);
      else state.owners.set(id, to);
    } else if (t0 === TRANSFER_TOPIC && log.topics.length === 3) {
      if (state.standard === 'unknown') state.standard = 'erc20';
      if (state.standard !== 'erc20') continue;
      const from = addrFromTopic(log.topics[1]);
      const to = addrFromTopic(log.topics[2]);
      const value = word(log.data, 0);
      if (from !== ZERO) bump(state.balances, from, -value);
      if (to !== ZERO) bump(state.balances, to, value);
    } else if (t0 === TRANSFER_SINGLE_TOPIC || t0 === TRANSFER_BATCH_TOPIC) {
      if (state.standard === 'unknown') state.standard = 'erc1155';
      if (state.standard !== 'erc1155') continue;
      const from = addrFromTopic(log.topics[2]);
      const to = addrFromTopic(log.topics[3]);
      const pairs: Array<[string, bigint]> = [];
      if (t0 === TRANSFER_SINGLE_TOPIC) {
        pairs.push([word(log.data, 0).toString(), word(log.data, 1)]);
      } else {
        // abi.encode(uint256[] ids, uint256[] values): two offsets, then arrays.
        const idsOff = Number(word(log.data, 0)) / 32;
        const valsOff = Number(word(log.data, 1)) / 32;
        const n = Number(word(log.data, idsOff));
        for (let i = 0; i < n; i++) pairs.push([word(log.data, idsOff + 1 + i).toString(), word(log.data, valsOff + 1 + i)]);
      }
      for (const [id, v] of pairs) {
        if (from !== ZERO) bump1155(state.balances1155, from, id, -v);
        if (to !== ZERO) bump1155(state.balances1155, to, id, v);
      }
    }
  }
}

function bump(m: Map<string, bigint>, k: string, d: bigint): void {
  const v = (m.get(k) ?? 0n) + d;
  if (v === 0n) m.delete(k);
  else m.set(k, v);
}

function bump1155(m: Map<string, Map<string, bigint>>, owner: string, id: string, d: bigint): void {
  const inner = m.get(owner) ?? new Map<string, bigint>();
  bump(inner, id, d);
  if (inner.size === 0) m.delete(owner);
  else m.set(owner, inner);
}

/// Current holders with balance >= minBalance, sorted by balance desc then
/// address. ERC-721 balance = token count; ERC-1155 = summed amounts.
export function holdersFromState(state: HolderState, minBalance = 1n): HolderRow[] {
  const rows: HolderRow[] = [];
  if (state.standard === 'erc721') {
    const byOwner = new Map<string, string[]>();
    for (const [id, owner] of state.owners) {
      const list = byOwner.get(owner) ?? [];
      list.push(id);
      byOwner.set(owner, list);
    }
    for (const [address, ids] of byOwner) {
      ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      rows.push({ address, balance: BigInt(ids.length), tokenIds: ids });
    }
  } else if (state.standard === 'erc20') {
    for (const [address, balance] of state.balances) if (balance > 0n) rows.push({ address, balance, tokenIds: [] });
  } else if (state.standard === 'erc1155') {
    for (const [address, inner] of state.balances1155) {
      let total = 0n;
      const ids: string[] = [];
      for (const [id, v] of inner) if (v > 0n) { total += v; ids.push(id); }
      if (total > 0n) rows.push({ address, balance: total, tokenIds: ids });
    }
  }
  return rows
    .filter((r) => r.balance >= minBalance)
    .sort((a, b) => (a.balance === b.balance ? (a.address < b.address ? -1 : 1) : a.balance > b.balance ? -1 : 1));
}

// ------------------------------------------------------------------ RPC layer

export interface RpcOptions {
  signal?: AbortSignal;
  /// Injectable for tests.
  fetchImpl?: typeof fetch;
  /// Injectable for tests (default: real timers).
  sleep?: (ms: number) => Promise<void>;
  /// Injectable clock for tests (default: Date.now).
  now?: () => number;
  /// Total time budget for retrying rate-limited / transient failures on ONE
  /// call. Default RPC_RETRY_BUDGET_MS (10 min): the official public RPC
  /// throttles hard under load (2026-10-02: a WL snapshot of URU failed with
  /// "rpc http 429" after ~24 s because the old policy gave up after 6 short
  /// retries), and a background scan should outlast a throttle window rather
  /// than throw away its progress.
  retryBudgetMs?: number;
}

const envNum = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
/// Backoff for 429 / 5xx / -32005 / network errors: full-jitter exponential
/// from RPC_BACKOFF_BASE_MS, capped at RPC_BACKOFF_MAX_MS per sleep, honoring
/// Retry-After when the server sends one.
const RPC_BACKOFF_BASE_MS = 500;
const RPC_BACKOFF_MAX_MS = 60_000;
const RPC_RETRY_BUDGET_MS = envNum('HOLDERS_RPC_RETRY_BUDGET_MS', 10 * 60 * 1000);
/// Process-wide cap on concurrent RPC requests from this module. Kept at 2 for
/// the official public RPC, which 429s quickly when pushed.
const MAX_CONCURRENT = envNum('HOLDERS_RPC_CONCURRENCY', 2);
let active = 0;
/// Process-wide cool-down: after a 429, every request from this module waits
/// until this time, so parallel scans back off together instead of hammering.
let throttledUntil = 0;

/// Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds.
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/// Full-jitter exponential backoff delay for `attempt` (0-based).
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RPC_BACKOFF_MAX_MS, RPC_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 20));
  return Math.max(RPC_BACKOFF_BASE_MS, Math.floor(random() * ceiling));
}
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

export class RpcRangeError extends Error {}

// "network is busy": rpc.ordofi.network answers oversized log ranges this way
// (10k blocks OK, 100k busy; measured 2026-10-02), so treat it as a range error.
const RANGE_HINT = /range|spans|too many|response size|limit exceeded|exceed|query returned more than|block range|network is busy/i;

/// One JSON-RPC call. Rate limits (HTTP 429, JSON-RPC -32005 without a range
/// hint), 5xx and network errors are retried with full-jitter exponential
/// backoff (Retry-After honored) until the time budget runs out, so a throttle
/// window never kills a scan. Range-style errors are surfaced immediately as
/// RpcRangeError so the caller can split the range.
export async function rpcCall<T>(url: string, method: string, params: unknown[], opts: RpcOptions = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.retryBudgetMs ?? RPC_RETRY_BUDGET_MS);
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    // Honor the process-wide cool-down set by a recent 429.
    const wait = throttledUntil - now();
    if (wait > 0) await sleep(wait);
    await acquire();
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: opts.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (err) {
      release();
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      lastErr = err;
      if (now() >= deadline) break;
      await sleep(backoffDelay(attempt));
      continue;
    }
    release();
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`rpc http ${res.status}`);
      if (now() >= deadline) break;
      const ra = res.status === 429 ? parseRetryAfter(res.headers?.get?.('retry-after'), now()) : null;
      const delay = Math.min(RPC_BACKOFF_MAX_MS, ra ?? backoffDelay(attempt));
      if (res.status === 429) throttledUntil = Math.max(throttledUntil, now() + delay);
      await sleep(delay);
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) {
      const msg = body.error.message ?? '';
      if (body.error.code === -32005 && !RANGE_HINT.test(msg)) {
        lastErr = new Error(`rpc rate limited: ${msg}`);
        if (now() >= deadline) break;
        const delay = backoffDelay(attempt);
        throttledUntil = Math.max(throttledUntil, now() + delay);
        await sleep(delay);
        continue;
      }
      if (RANGE_HINT.test(msg)) throw new RpcRangeError(msg);
      throw new Error(`rpc error ${body.error.code}: ${msg}`);
    }
    return body.result as T;
  }
  throw lastErr instanceof Error ? lastErr : new Error('rpc failed');
}

export const DEFAULT_MAX_RANGE = 10_000_000n;
const MIN_RANGE = 1_000n;

/// Largest block range each endpoint has accepted, learned from its own
/// "only N are allowed" errors. Robinhood's public RPC has answered both
/// "only 10000000" and "only 100000" on different days, so it is learned per
/// process rather than hard-coded.
const learnedMaxRange = new Map<string, bigint>();
/// Ranges fetched concurrently per scan (still bounded by MAX_CONCURRENT).
const PARALLEL_RANGES = envNum('HOLDERS_RPC_PARALLEL_RANGES', 2);

/// Parse "only N are allowed" style limits out of an RPC range error.
export function parseAllowedRange(message: string): bigint | null {
  const m = /only\s+([\d,_]+)\s+(?:blocks?\s+)?(?:are\s+)?allowed/i.exec(message);
  if (!m) return null;
  try {
    const n = BigInt(m[1]!.replace(/[,_]/g, ''));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/// eth_getLogs over [from, to] for all three transfer shapes, in the largest
/// ranges the endpoint allows (learned from its errors, else halved), with up
/// to PARALLEL_RANGES ranges in flight. Results are only accepted in order up
/// to the first failed range, so a retry never double-counts logs.
export async function getTransferLogs(
  url: string,
  address: string,
  from: bigint,
  to: bigint,
  opts: RpcOptions & {
    maxRange?: bigint;
    /// Called once per completed range, IN BLOCK ORDER, with that range's logs
    /// and its last block. Lets the caller commit progress incrementally so a
    /// later failure doesn't discard ranges already fetched.
    onChunk?: (logs: RawLog[], endBlock: bigint) => void;
  } = {},
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const cap = opts.maxRange ?? DEFAULT_MAX_RANGE;
  const learned = learnedMaxRange.get(url);
  let range = learned !== undefined && learned < cap ? learned : cap;
  let cursor = from;
  while (cursor <= to) {
    const batch: Array<[bigint, bigint]> = [];
    let c = cursor;
    while (batch.length < PARALLEL_RANGES && c <= to) {
      const end = c + range - 1n > to ? to : c + range - 1n;
      batch.push([c, end]);
      c = end + 1n;
    }
    const results = await Promise.allSettled(batch.map(([f, e]) =>
      rpcCall<RawLog[]>(url, 'eth_getLogs', [{
        address,
        topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]],
        fromBlock: `0x${f.toString(16)}`,
        toBlock: `0x${e.toString(16)}`,
      }], opts)));
    let rangeErr: RpcRangeError | null = null;
    for (let k = 0; k < results.length; k++) {
      const r = results[k]!;
      if (r.status === 'fulfilled') {
        out.push(...r.value);
        cursor = batch[k]![1] + 1n;
        opts.onChunk?.(r.value, batch[k]![1]);
        continue;
      }
      if (r.reason instanceof RpcRangeError) {
        rangeErr = r.reason;
        break;
      }
      throw r.reason;
    }
    if (rangeErr) {
      if (range <= MIN_RANGE) throw rangeErr;
      const allowed = parseAllowedRange(rangeErr.message);
      const next = allowed !== null && allowed < range ? allowed : range / 2n;
      range = next < MIN_RANGE ? MIN_RANGE : next;
      learnedMaxRange.set(url, range);
    }
  }
  return out;
}

// ------------------------------------------------------------------ cache + scan

interface Entry { state: HolderState; touchedAt: number }
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<HolderState>>();
const MAX_ENTRIES = 200;
const IDLE_EVICT_MS = 6 * 60 * 60 * 1000;

function evict(): void {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.touchedAt > IDLE_EVICT_MS) cache.delete(k);
  if (cache.size <= MAX_ENTRIES) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [k] of oldest.slice(0, cache.size - MAX_ENTRIES)) cache.delete(k);
}

export async function latestBlock(url: string, opts: RpcOptions = {}): Promise<bigint> {
  return BigInt(await rpcCall<string>(url, 'eth_blockNumber', [], opts));
}

/// Current holder state of `address` as of at least `toBlock` (defaults to the
/// chain tip). First call scans from `startBlock` (default 0); later calls only
/// scan blocks after the cached `lastBlock`. Concurrent calls for the same
/// contract share one scan.
export async function scanHolders(args: {
  rpcUrl: string;
  address: string;
  toBlock?: bigint;
  startBlock?: bigint;
  /// Upper bound on the log range per eth_getLogs (tests; default DEFAULT_MAX_RANGE).
  maxRange?: bigint;
} & RpcOptions): Promise<HolderState> {
  const address = args.address.toLowerCase();
  const key = `${args.rpcUrl}|${address}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const tip = args.toBlock ?? (await latestBlock(args.rpcUrl, args));
    const entry = cache.get(key) ?? { state: newState(), touchedAt: Date.now() };
    // Cache the entry up front so committed progress survives a failure.
    cache.set(key, entry);
    const from = entry.state.lastBlock >= 0n ? entry.state.lastBlock + 1n : (args.startBlock ?? 0n);
    if (from <= tip) {
      // Commit range by range, in block order: after each completed range the
      // state holds exactly every transfer up to `lastBlock`, so a failure or
      // a long 429 throttle mid-scan keeps the progress and a retry resumes
      // from there instead of re-scanning from block 0 (2026-10-02 fix).
      await getTransferLogs(args.rpcUrl, address, from, tip, {
        ...args,
        onChunk: (logs, endBlock) => {
          applyLogs(entry.state, logs);
          entry.state.lastBlock = endBlock;
          entry.touchedAt = Date.now();
        },
      });
      entry.state.lastBlock = tip;
    }
    entry.touchedAt = Date.now();
    evict();
    return entry.state;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/// Test hook.
export function _resetHolderCache(): void {
  cache.clear();
  inflight.clear();
  learnedMaxRange.clear();
  throttledUntil = 0;
}

/// Cached state for a contract without scanning (null if never scanned).
export function cachedHolderState(rpcUrl: string, address: string): HolderState | null {
  return cache.get(`${rpcUrl}|${address.toLowerCase()}`)?.state ?? null;
}

/// Wait for `p`, but reject as soon as `signal` aborts. `p` itself keeps
/// running (its result still lands in the cache), so a timed-out caller's
/// retry is cheap.
export function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
