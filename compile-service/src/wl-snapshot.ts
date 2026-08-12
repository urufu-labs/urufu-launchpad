/// Holder snapshotting for whitelisted-curve launches.
///
/// Given a source token/NFT contract on ANY supported EVM chain, fetches the
/// current holder set, filters by a min-balance threshold, and returns a Merkle
/// root plus the sorted holder list. The frontend embeds the root in the WL
/// launch tx (which lands on Robinhood); buyers fetch their proof from
/// `/wl/proof?listId=…&addr=…` at buy time.
///
/// Multi-chain by design: the WL source doesn't have to live on Robinhood.
/// A launcher can gate their new curve on holders of any Ethereum / Base /
/// Arbitrum / Optimism / Polygon / BNB / Avalanche / Gnosis / Linea NFT
/// (via Alchemy's NFT API — see ALCHEMY_NETWORKS below). Blockscout + RPC
/// event-replay fallbacks remain for chains Alchemy doesn't cover or for
/// ERC-20 sources where Alchemy's NFT endpoint doesn't apply.
///
/// Source priority (first success wins):
///   1. Alchemy NFT API `getOwnersForContract` — one credential, uniform
///      shape across every supported chain, returns full owner set + balances
///      in one paginated call.
///   2. Blockscout `/tokens/:addr/holders` — per-chain URL, NFT + ERC-20.
///   3. RPC Transfer-event replay — bounded window, last-resort fallback.
///
/// The Merkle tree uses sorted-pair hashing (Solady + OpenZeppelin convention)
/// with leaves `keccak256(abi.encodePacked(address))` — matches
/// `BondingCurve.buyWithProof`'s `MerkleProofLib.verify` layout exactly.
/// In-memory cache keyed on the FULL policy tuple (see `_computeCacheKey`) so
/// a stricter same-block caller never gets a permissive cached result.

import { createPublicClient, http, parseAbiItem, parseAbi, type Address, type Hex, keccak256, encodePacked } from 'viem';

/// Alchemy network slugs, keyed by chainId. When the ALCHEMY_API_KEY env is
/// set AND the source token's chain is here, `snapshotHolders` uses Alchemy's
/// NFT API `getOwnersForContract` as its PRIMARY source. Rationale:
///   - Works uniformly across every major EVM chain (WL sources on the
///     launchpad don't have to live on Robinhood).
///   - Blockscout-per-chain plumbing broke down as we added chains; Alchemy
///     is one credential + one base URL pattern.
///   - Returns the FULL holder set with balances in a paginated call, no
///     event-replay math, no drift-window fudge.
/// Non-Alchemy chains still fall through to Blockscout + RPC-event-replay.
const ALCHEMY_NETWORKS: Record<number, string> = {
  1: 'eth-mainnet',
  10: 'opt-mainnet',
  56: 'bnb-mainnet',
  100: 'gnosis-mainnet',
  137: 'polygon-mainnet',
  4663: 'robinhood-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  43114: 'avax-mainnet',
  59144: 'linea-mainnet',
};

/// Chains this snapshot service can read from (secondary RPC + Alchemy paths).
/// Robinhood explicit because we control its RPC URL directly; every other
/// chain is only reachable via Alchemy (needs ALCHEMY_API_KEY on the compile
/// service).
const RPC_URLS: Record<number, string> = {
  4663: process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
};

/// Blockscout v2 API base URLs, keyed by chainId. Fallback source. Kept for
/// chains where Alchemy is unavailable or fails. On chains served by both,
/// Alchemy is tried first because it doesn't require the drift-window
/// gymnastics blockscout does.
const EXPLORER_APIS: Record<number, string> = {
  4663: process.env.ROBINHOOD_BLOCKSCOUT_URL ?? 'https://robinhoodchain.blockscout.com/api/v2',
};

function alchemyBase(chainId: number): string | null {
  const slug = ALCHEMY_NETWORKS[chainId];
  const key = process.env.ALCHEMY_API_KEY;
  if (!slug || !key) return null;
  return `https://${slug}.g.alchemy.com/nft/v3/${key}`;
}

/// Hard-cap the RPC event-replay range (fallback path only). Bumped from 1.5M to
/// something that covers most token lifetimes on chains where blockscout isn't
/// available. On RH we hit blockscout first so this cap is effectively unused.
const MAX_SCAN_BLOCKS = 25_000_000n;
/// getLogs chunk size — RH's public RPC caps individual eth_getLogs calls in the
/// low-tens-of-thousands. 10k is safe and still fast enough for the whole scan.
const LOG_CHUNK_BLOCKS = 10_000n;
/// Blockscout `holders` endpoint page size (default 50, max 100 as of 2026).
const BLOCKSCOUT_PAGE_SIZE = 100;
/// Safety-cap the number of holder-page fetches so a broken pagination loop
/// can't stall the request forever. 100 pages × 100 holders = 10k holders max
/// per snapshot — well above any realistic launch WL.
export const BLOCKSCOUT_MAX_PAGES = 100;
/// Default max acceptable block delta between the "read latest at snapshot
/// START" and "read latest at snapshot END" reads. If the chain tip moves more
/// than this while we're fetching the holder list, the snapshot may already be
/// stale relative to Blockscout's current-holder truth, so we reject rather
/// than silently return a moving-target result.
///
/// Tuned for Robinhood Chain's ~100ms block cadence: walking Blockscout for a
/// typical WL source (400-2000 holders) takes ~10-30s, i.e. ~100-300 blocks.
/// Cap at 600 (60s of wall-clock drift) so we still catch pathological
/// slow snapshots but don't false-positive on normal ones. On chains with
/// slower blocks (12s Ethereum) 600 blocks is ~2 hours — safe upper bound.
///
/// Overridable per-call via `SnapshotRequest.maxBlockDrift` and process-wide
/// via `WL_MAX_BLOCK_DRIFT` env var.
export const DEFAULT_MAX_BLOCK_DRIFT = 600n;
/// Env override so operators can tune drift tolerance without a redeploy.
export function defaultMaxBlockDrift(): bigint {
  const raw = process.env.WL_MAX_BLOCK_DRIFT;
  if (!raw) return DEFAULT_MAX_BLOCK_DRIFT;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : DEFAULT_MAX_BLOCK_DRIFT;
  } catch {
    return DEFAULT_MAX_BLOCK_DRIFT;
  }
}
/// FINDING 3 (HIGH): hard-cap the number of holders a single snapshot will
/// process. Above this we throw `WlHolderCountExceedsCap` rather than silently
/// truncate — the Merkle build is O(N log N) and the eligible list gets pinned
/// to IPFS, so an unbounded holder set is both a compute + storage pressure
/// vector. 50k is generous for any realistic WL (URU launched with ~334).
export const DEFAULT_MAX_HOLDER_COUNT = 50_000;
/// Env override for the holder-count ceiling. Non-numeric / non-positive
/// values fall back to `DEFAULT_MAX_HOLDER_COUNT` so a mis-configured deploy
/// never accidentally lifts the cap.
export function defaultMaxHolderCount(): number {
  const raw = process.env.WL_MAX_HOLDER_COUNT;
  if (!raw) return DEFAULT_MAX_HOLDER_COUNT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_MAX_HOLDER_COUNT;
}
/// FINDING 3 (HIGH): hard-cap the number of bytes we buffer from an IPFS pin
/// on `/wl/proof` lookups. A pinned snapshot is a compact self-describing JSON
/// (address list + root + block); 50k lowercased addresses + JSON overhead
/// tops out below 3 MB. The default 8 MB gives headroom while blocking a
/// hostile gateway from streaming gigabytes at us. Overridable per-call and
/// via `WL_MAX_IPFS_BYTES` for operators who need to change it.
export const DEFAULT_MAX_IPFS_BYTES = 8 * 1024 * 1024;
export function defaultMaxIpfsBytes(): number {
  const raw = process.env.WL_MAX_IPFS_BYTES;
  if (!raw) return DEFAULT_MAX_IPFS_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_MAX_IPFS_BYTES;
}

/// Common ABI item — Transfer's signature is identical between ERC-20 and ERC-721;
/// only ERC-721's third arg is indexed. viem's decoder handles both when we pass
/// `strict: false` on the getLogs call.
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface SnapshotRequest {
  chainId: number;
  tokenAddress: Address;
  /// Minimum balance / NFT count to include in the whitelist. Absolute units
  /// (raw balance for ERC-20 — caller applies decimals off-chain; token count for ERC-721).
  minBalance?: bigint;
  /// Opt into partial (incomplete) snapshots. When `false` (default), a
  /// snapshot that couldn't fetch the entire holder set — Blockscout paginated
  /// past `maxBlockscoutPages`, or the RPC fallback couldn't scan from block 0
  /// — REJECTS with `WlSnapshotTruncated`. Callers who explicitly want a best-
  /// effort result must set this to `true`, in which case the returned result
  /// carries `partial: true` so downstream consumers can see the caveat.
  allowPartial?: boolean;
  /// Max acceptable delta between the "latest block at snapshot start" and
  /// "latest block at snapshot end" reads. Defaults to `DEFAULT_MAX_BLOCK_DRIFT`.
  /// If the chain tip drifts more than this while we're paginating holders,
  /// we reject with `WlSnapshotBlockDrift` — Blockscout's per-page holder set
  /// may already be reflecting a newer tip than our reported `snapshotBlock`.
  maxBlockDrift?: bigint;
  /// Overrides `BLOCKSCOUT_MAX_PAGES` for a single call. Primarily an escape
  /// hatch for tests — production callers should leave this unset and rely on
  /// the module-level cap.
  maxBlockscoutPages?: number;
  /// FINDING 3 (HIGH): overrides the module-level `defaultMaxHolderCount()`
  /// ceiling. When the eligible holder set exceeds this the snapshot rejects
  /// with `WlHolderCountExceedsCap` (carrying the observed count) rather than
  /// silently truncating. Primarily a test hook — production callers should
  /// leave this unset and rely on `WL_MAX_HOLDER_COUNT`.
  maxHolderCount?: number;
  /// FINDING 3 (HIGH): cancels the snapshot when fired. Propagated into every
  /// downstream fetch (Blockscout pagination, viem RPC calls, IPFS pin write)
  /// so a client disconnect at the /wl/snapshot route immediately kills the
  /// expensive tail rather than waiting for it to complete unobserved. Also
  /// fires when the route-level wall-clock timeout elapses.
  signal?: AbortSignal;
}

export interface SnapshotResult {
  /// Bytes32 Merkle root ready to hand to `BondingCurve.WhitelistInit.root`.
  root: Hex;
  /// Block number the snapshot was taken at (same as `snapshotStartBlock`; kept
  /// for backwards-compatible consumers that only read this field).
  snapshotBlock: bigint;
  /// Block-tip read at the START of the snapshot. Cache key + returned
  /// `snapshotBlock` are derived from this.
  snapshotStartBlock: bigint;
  /// Block-tip read at the END of the snapshot. Consumers can compare
  /// `snapshotEndBlock - snapshotStartBlock` to gauge staleness of the
  /// Blockscout-reported holder set.
  snapshotEndBlock: bigint;
  /// Number of unique addresses in the tree after min-balance filtering.
  holderCount: number;
  /// Sorted list of holder addresses (lowercased). Frontend can pin this to IPFS
  /// or store server-side; needed to construct proofs at buy time.
  holders: Address[];
  /// Cache key clients can hand back to /wl/proof to retrieve a proof for one holder.
  listId: string;
  /// IPFS CID of the pinned holder list, when the pin succeeded (Pinata JWT set).
  /// Trade-time proof lookups fall back to this when the in-memory cache misses.
  listCid?: string;
  /// Public gateway URL for the pinned list.
  listGatewayUrl?: string;
  /// `true` when the snapshot may be INCOMPLETE (Blockscout had more pages than
  /// we fetched, OR the RPC fallback couldn't scan from block 0). Only ever set
  /// when the caller passed `allowPartial: true` — strict mode rejects instead.
  partial: boolean;
  /// Number of holder pages fetched from Blockscout, when Blockscout was used.
  /// Undefined when the RPC fallback path served the snapshot.
  pagesFetched?: number;
  /// `true` if the holder set was derived from RPC event replay (Blockscout
  /// was unavailable / errored). Consumers should treat this path as best-
  /// effort — see `MAX_SCAN_BLOCKS`.
  fromRpcFallback: boolean;
}

/// Return shape from `fetchHoldersViaBlockscout`. Exposes the truncation
/// signal so the orchestrator can decide whether to reject or flag as partial.
export interface BlockscoutHoldersResult {
  holders: Address[];
  pagesFetched: number;
  /// `true` when we exited the pagination loop with `next_page_params` still
  /// set — i.e. we hit `maxPages` before Blockscout ran out of holders. The
  /// caller must NOT treat `holders` as a complete set when this is `true`.
  hadMorePages: boolean;
}

/// Thrown when a snapshot couldn't fetch a complete holder set and the caller
/// didn't opt into partial results. Carries the actual page count / range so
/// operators can decide whether to bump `maxBlockscoutPages`, expand the RPC
/// scan window, or accept partial data via `allowPartial: true`.
export class WlSnapshotTruncated extends Error {
  readonly pagesFetched: number;
  readonly maxPages: number;
  readonly source: 'blockscout' | 'rpc';
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  constructor(
    pagesFetched: number,
    maxPages: number,
    source: 'blockscout' | 'rpc',
    extra?: { fromBlock?: bigint; toBlock?: bigint },
  ) {
    const detail =
      source === 'blockscout'
        ? `blockscout returned more pages than the ${maxPages}-page cap (fetched ${pagesFetched})`
        : `rpc fallback scanned only blocks ${extra?.fromBlock ?? 0n}..${extra?.toBlock ?? 0n}, may miss older holders`;
    super(`wl snapshot truncated: ${detail}. Pass allowPartial:true to accept incomplete results.`);
    this.name = 'WlSnapshotTruncated';
    this.pagesFetched = pagesFetched;
    this.maxPages = maxPages;
    this.source = source;
    this.fromBlock = extra?.fromBlock;
    this.toBlock = extra?.toBlock;
  }
}

/// FINDING 3 (HIGH): thrown when a snapshot's eligible holder count exceeds
/// the module-level (or per-call) cap. Silent truncation is unacceptable — a
/// Merkle root computed over the truncated slice would permanently exclude
/// the rest of the launch's WL, and downstream callers have no signal that
/// anything is missing. The observed count + configured cap are both
/// carried on the error so operators can decide whether to raise the cap
/// (via `WL_MAX_HOLDER_COUNT`) or reject the launch.
export class WlHolderCountExceedsCap extends Error {
  readonly holderCount: number;
  readonly maxHolderCount: number;
  readonly source: 'blockscout' | 'rpc';
  constructor(holderCount: number, maxHolderCount: number, source: 'blockscout' | 'rpc') {
    super(
      `wl snapshot holder count ${holderCount} exceeds cap ${maxHolderCount} ` +
        `(source=${source}). Refusing to build Merkle tree — raise WL_MAX_HOLDER_COUNT ` +
        `or narrow the source token before retrying.`,
    );
    this.name = 'WlHolderCountExceedsCap';
    this.holderCount = holderCount;
    this.maxHolderCount = maxHolderCount;
    this.source = source;
  }
}

/// FINDING 3 (HIGH): thrown when a size-capped IPFS fetch reads more bytes
/// than the configured ceiling. Carries the byte counts so operators know
/// whether to raise the cap or investigate a hostile gateway. The gateway
/// URL is included for triage — a compromised third-party gateway would
/// stand out here.
export class WlIpfsResponseTooLarge extends Error {
  readonly bytesRead: number;
  readonly maxBytes: number;
  readonly url: string;
  constructor(bytesRead: number, maxBytes: number, url: string) {
    super(
      `ipfs response exceeded ${maxBytes}-byte cap (read >=${bytesRead} bytes from ${url}). ` +
        `Aborted fetch to prevent memory pressure.`,
    );
    this.name = 'WlIpfsResponseTooLarge';
    this.bytesRead = bytesRead;
    this.maxBytes = maxBytes;
    this.url = url;
  }
}

/// Thrown when the chain tip drifted more than `maxBlockDrift` blocks between
/// the start and end of a snapshot. Signals that the Blockscout holder set we
/// paginated may already reflect a newer tip than we're reporting, so the
/// snapshot is stale by definition. Carries both block numbers + the drift
/// budget so operators can either bump `maxBlockDrift` or retry.
export class WlSnapshotBlockDrift extends Error {
  readonly startBlock: bigint;
  readonly endBlock: bigint;
  readonly drift: bigint;
  readonly maxDrift: bigint;
  constructor(startBlock: bigint, endBlock: bigint, maxDrift: bigint) {
    const drift = endBlock > startBlock ? endBlock - startBlock : 0n;
    super(
      `wl snapshot block-drift ${drift} exceeds max ${maxDrift} ` +
        `(startBlock=${startBlock}, endBlock=${endBlock}). Holder set may be stale.`,
    );
    this.name = 'WlSnapshotBlockDrift';
    this.startBlock = startBlock;
    this.endBlock = endBlock;
    this.drift = drift;
    this.maxDrift = maxDrift;
  }
}

/// Simple in-memory cache. Key is derived from EVERY policy input that
/// changes the output set — see `_computeCacheKey`. Stored so the SAME
/// snapshot can serve many proof requests without re-scanning.
///
/// AUDIT H2 (Round 6, HIGH): the pre-fix key was `chainId:token:block` only,
/// which meant a permissive request (e.g. `minBalance=0`) at the same
/// startBlock as a stricter request (`minBalance=1e18`) would hand the
/// stricter caller the permissive holder set + Merkle root — the wrong root
/// for their policy. The key now includes chainId, tokenAddress, startBlock,
/// minBalance, allowPartial, maxBlockscoutPages, maxBlockDrift, maxHolderCount,
/// and blockscoutPageSize. Two identical requests share a slot; anything else
/// misses cache and re-fetches.
const cache = new Map<string, SnapshotResult>();

/// Bump when the set of policy fields in the cache key changes so stale
/// clients holding an old-shape listId don't accidentally collide with a
/// new-shape slot. Purely defensive — the cache is process-local and cleared
/// on restart, so a redeploy already invalidates old keys.
const CACHE_KEY_SCHEMA = 'v2';

/// AUDIT H2: build the cache key from every input that affects the output set.
/// A `:` delimited string is safe here because every field serialises to a
/// value with no colons (numbers, bigints, lowercased 0x-prefixed hex, and
/// `0|1` for the boolean). If a future field can contain `:` this must
/// switch to a hashed JSON serialisation.
function _computeCacheKey(k: {
  chainId: number;
  tokenAddress: Address;
  startBlock: bigint;
  minBalance: bigint;
  allowPartial: boolean;
  maxBlockscoutPages: number;
  maxBlockDrift: bigint;
  maxHolderCount: number;
  blockscoutPageSize: number;
}): string {
  return [
    'wl',
    CACHE_KEY_SCHEMA,
    k.chainId,
    k.tokenAddress.toLowerCase(),
    k.startBlock.toString(),
    k.minBalance.toString(),
    k.allowPartial ? '1' : '0',
    k.maxBlockscoutPages,
    k.maxBlockDrift.toString(),
    k.maxHolderCount,
    k.blockscoutPageSize,
  ].join(':');
}

/// AUDIT H2: distinguish an AbortError from a general fetch/network error.
/// Node's `fetch` rejects aborted requests with a `DOMException` whose `.name`
/// is `'AbortError'`; some wrappers (viem, undici) surface the original in
/// `.cause`. A raw `controller.abort(new Error('…'))` may propagate whatever
/// reason the caller attached, so this helper also treats
/// `.code === 'ABORT_ERR'` as an abort. Walks `.cause` recursively so a
/// wrapping layer can't hide the abort signal from us.
function _isAbortError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object' && typeof err !== 'function') return false;
  const e = err as { name?: string; code?: string; cause?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 'ABORT_ERR') return true;
  if (e.cause !== undefined && e.cause !== err) {
    return _isAbortError(e.cause);
  }
  return false;
}

export async function snapshotHolders(req: SnapshotRequest): Promise<SnapshotResult> {
  const rpc = RPC_URLS[req.chainId];
  if (!rpc) {
    throw new Error(`unsupported chainId ${req.chainId} — snapshot service only knows: ${Object.keys(RPC_URLS).join(', ')}`);
  }

  const allowPartial = req.allowPartial === true;
  const maxDrift = req.maxBlockDrift ?? DEFAULT_MAX_BLOCK_DRIFT;
  const maxBlockscoutPages = req.maxBlockscoutPages ?? BLOCKSCOUT_MAX_PAGES;
  // FINDING 3 (HIGH): resolve the holder cap ONCE at the top of the request so
  // an operator flipping WL_MAX_HOLDER_COUNT mid-flight can't have a fetch
  // race the check. Per-call `maxHolderCount` overrides the env for tests.
  const maxHolderCount = req.maxHolderCount ?? defaultMaxHolderCount();
  const signal = req.signal;
  // Early-abort: if the caller already cancelled before we did any work,
  // fail fast instead of firing off an RPC + Blockscout burst.
  if (signal?.aborted) throw signal.reason ?? new Error('wl snapshot aborted');

  // FINDING 3 (HIGH): thread the caller's AbortSignal into every fetch viem
  // makes so a client disconnect / route timeout kills in-flight RPC work.
  // A fresh client per request keeps the signal scoped correctly (viem's
  // http transport applies fetchOptions to every request the client makes).
  const client = createPublicClient({
    transport: http(rpc, signal ? { fetchOptions: { signal } } : undefined),
  });
  // Bookend the snapshot with two block-tip reads. The reported `snapshotBlock`
  // is the START read (that's the tip our holder set is "as of"), and the END
  // read is compared against it to detect chain-tip drift while we paginated
  // Blockscout / scanned RPC — see WlSnapshotBlockDrift.
  //
  // `cacheTime: 0` disables viem's default 4s block-number cache — a stale
  // cached tip would make the drift check silently pass and defeat the whole
  // purpose of the bookend.
  const startBlock = await client.getBlockNumber({ cacheTime: 0 });
  // Resolve minBalance BEFORE building the cache key — it's a policy input
  // that changes the eligible holder set and therefore the returned root.
  const minBal = req.minBalance ?? 1n;
  // AUDIT H2 (Round 6, HIGH): cache key includes EVERY policy input that
  // changes the output set. See `_computeCacheKey` for the rationale — the
  // pre-fix key was `chainId:token:startBlock` only, which let a permissive
  // request's result be handed to a stricter same-block caller.
  const cacheKey = _computeCacheKey({
    chainId: req.chainId,
    tokenAddress: req.tokenAddress,
    startBlock,
    minBalance: minBal,
    allowPartial,
    maxBlockscoutPages,
    maxBlockDrift: maxDrift,
    maxHolderCount,
    blockscoutPageSize: BLOCKSCOUT_PAGE_SIZE,
  });
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Source priority (first success wins):
  //   1. Alchemy NFT API `getOwnersForContract` — works on every chain we
  //      list in ALCHEMY_NETWORKS with one credential; returns the full
  //      current holder set with per-address balances; no event-replay math;
  //      no drift-window fudge; NFT-only.
  //   2. Blockscout /tokens/:addr/holders — per-chain URL; NFT + ERC-20; drift
  //      window applies here.
  //   3. RPC event replay — bounded by MAX_SCAN_BLOCKS; may miss holders
  //      whose only Transfers landed pre-cutoff; last-resort fallback.
  let eligible: Address[] | null = null;
  let partial = false;
  let pagesFetched: number | undefined;
  let fromRpcFallback = false;

  const alchemy = alchemyBase(req.chainId);
  if (alchemy) {
    try {
      const holders = await fetchHoldersViaAlchemyNft(
        alchemy, req.tokenAddress, minBal, { signal, maxHolderCount },
      );
      if (holders !== null) {
        eligible = holders;
      }
    } catch (err) {
      if (err instanceof WlHolderCountExceedsCap) throw err;
      if (signal?.aborted) throw signal.reason ?? err;
      if ((err as { name?: string }).name === 'AbortError') throw err;
      // eslint-disable-next-line no-console
      console.warn(`wl-snapshot: alchemy NFT fetch failed for ${req.tokenAddress} on chain ${req.chainId}, falling back to blockscout/rpc`, err);
    }
  }

  const explorerApi = EXPLORER_APIS[req.chainId];
  if (!eligible && explorerApi) {
    let bs: BlockscoutHoldersResult | null = null;
    try {
      bs = await fetchHoldersViaBlockscout(
        explorerApi,
        req.tokenAddress,
        minBal,
        maxBlockscoutPages,
        // FINDING 3: pass the same signal so a client abort mid-pagination
        // stops fetching more pages instead of finishing the walk unobserved.
        // Also stop early if we've already exceeded the holder cap — no
        // point paying for more pages when the snapshot will reject anyway.
        { signal, maxHolderCount },
      );
    } catch (err) {
      // FINDING 3: WlHolderCountExceedsCap is NOT recoverable — the raw
      // count already crossed the ceiling, and continuing to the RPC
      // replay would just re-derive the same too-many-holders answer with
      // extra cost. Surface it directly.
      if (err instanceof WlHolderCountExceedsCap) throw err;
      // FINDING 3: abort propagation. If the caller cancelled, do NOT fall
      // through to a fresh RPC replay — the whole point of the signal is
      // that no more work happens. We check the SIGNAL rather than the
      // error name because `controller.abort(reason)` propagates `reason`
      // as-is (may be a plain Error, DOMException, string, etc.). Prefer
      // the signal's own `reason` for the throw so callers get whatever
      // hint the aborter attached.
      if (signal?.aborted) throw signal.reason ?? err;
      if ((err as { name?: string }).name === 'AbortError') throw err;
      // Blockscout HTTP / decode errors are recoverable — fall through to RPC
      // replay. Truncation is NOT an error here (fetchHoldersViaBlockscout
      // returns a result with `hadMorePages: true`); that decision is made
      // below so operators see a distinct error class from a generic 5xx.
      // eslint-disable-next-line no-console
      console.warn(`wl-snapshot: blockscout fetch failed for ${req.tokenAddress}, falling back to event replay`, err);
    }
    if (bs) {
      pagesFetched = bs.pagesFetched;
      if (bs.hadMorePages) {
        if (!allowPartial) {
          throw new WlSnapshotTruncated(bs.pagesFetched, maxBlockscoutPages, 'blockscout');
        }
        partial = true;
      }
      eligible = bs.holders;
    }
  }

  // RPC event-replay fallback path — used when blockscout is not configured or
  // returns an error. Bounded by MAX_SCAN_BLOCKS; may miss holders on very
  // long-lived tokens (see cap note above).
  if (!eligible) {
    const fromBlock = startBlock > MAX_SCAN_BLOCKS ? startBlock - MAX_SCAN_BLOCKS : 0n;
    // If we couldn't scan back to genesis, we may have missed pre-cutoff holders
    // whose only Transfers happened outside our window. Reject unless the caller
    // explicitly opted into partial data.
    if (fromBlock > 0n) {
      if (!allowPartial) {
        throw new WlSnapshotTruncated(0, 0, 'rpc', { fromBlock, toBlock: startBlock });
      }
      partial = true;
    }
    fromRpcFallback = true;
    const isErc721 = await _detectIsErc721(client, req.tokenAddress);
    const balances = await _replayBalances(client, req.tokenAddress, fromBlock, startBlock, isErc721);
    eligible = [];
    for (const [addr, bal] of balances) {
      if (bal >= minBal) eligible.push(addr as Address);
    }
  }

  // Re-read the tip and reject if it drifted too far — Blockscout's per-page
  // reads may have already been reflecting a newer tip than we're reporting
  // in `snapshotBlock`, and we don't want silent freshness bugs. Same
  // `cacheTime: 0` reason as the start read.
  const endBlock = await client.getBlockNumber({ cacheTime: 0 });
  if (endBlock > startBlock + maxDrift) {
    throw new WlSnapshotBlockDrift(startBlock, endBlock, maxDrift);
  }

  // FINDING 3 (HIGH): reject if the eligible holder count is over the cap.
  // Runs BEFORE the Merkle build — that step is O(N log N) and the pinned
  // JSON grows linearly with N, so blocking here is where we stop the abuse.
  // Explicit error class + observed count so operators triage instead of
  // guessing which stage silently truncated. Applies to both Blockscout and
  // RPC-replay paths (source recorded on the error for post-mortem).
  if (eligible.length > maxHolderCount) {
    throw new WlHolderCountExceedsCap(
      eligible.length,
      maxHolderCount,
      fromRpcFallback ? 'rpc' : 'blockscout',
    );
  }

  // Sort in canonical form — lowercased addresses ordered lexically match how
  // leaves are computed for the Merkle root.
  eligible.sort();

  const root = _buildMerkleRoot(eligible);

  const result: SnapshotResult = {
    root,
    snapshotBlock: startBlock,
    snapshotStartBlock: startBlock,
    snapshotEndBlock: endBlock,
    holderCount: eligible.length,
    holders: eligible,
    listId: cacheKey,
    partial,
    pagesFetched,
    fromRpcFallback,
  };

  // Best-effort IPFS pin of the sorted holder list. Skipped silently if PINATA_JWT
  // isn't configured — the in-memory cache still serves proof requests, just with
  // a shorter durability window (process restart evicts it). When pinning succeeds
  // the CID is durable and buyers can fetch the list directly from IPFS.
  try {
    const pinned = await _pinListToIpfs(cacheKey, eligible, root, startBlock, signal);
    if (pinned) {
      result.listCid = pinned.cid;
      result.listGatewayUrl = pinned.gatewayUrl;
    }
  } catch (err) {
    // AUDIT H2 (Round 6, HIGH): a client abort DURING the pin used to be
    // swallowed here — control fell through to `cache.set` and the caller
    // never saw the result they're now caching. That means:
    //   1. The client can't verify the pinned root exists off-server (they
    //      cancelled mid-pin and don't hold the listId).
    //   2. Any future request with the same policy at this block hits the
    //      cached slot, returning a listId + gatewayUrl the caller can't
    //      independently confirm the pin state of.
    // Fix: if the caller cancelled OR the underlying error is an AbortError
    // (or wraps one), rethrow — do NOT populate the cache. A retry will
    // re-snapshot and re-pin cleanly. See `_isAbortError`.
    if (signal?.aborted) throw signal.reason ?? err;
    if (_isAbortError(err)) throw err;
    // Non-fatal — snapshot still usable via in-memory cache.
    // eslint-disable-next-line no-console
    console.warn('wl-snapshot: IPFS pin failed, falling back to in-memory cache only', err);
  }

  cache.set(cacheKey, result);
  return result;
}

/// Look up a snapshot by cacheKey / listId. Used by /wl/proof so cache hits skip
/// re-snapshotting. Returns null when the cache has been evicted (process restart)
/// — caller can fall back to re-snapshotting the same (chain, token) tuple.
export function snapshotByListId(listId: string): SnapshotResult | null {
  return cache.get(listId) ?? null;
}

/// Rebuild a snapshot from a pinned IPFS list. Useful when the in-memory cache
/// has been evicted but the client still has the listCid. Content-addressed —
/// what comes back from IPFS is exactly what was pinned, so the derived root
/// matches what's on the launch curve.
export async function snapshotFromIpfs(
  listCid: string,
  opts?: {
    /// FINDING 3 (HIGH): caller-supplied cancel (route disconnect / wall-clock
    /// timeout). Composed with a 15s per-request timeout so BOTH bound the
    /// fetch lifetime.
    signal?: AbortSignal;
    /// FINDING 3 (HIGH): hard cap on response body bytes. A pinned snapshot
    /// is a compact JSON blob — a hostile gateway must not be able to make
    /// us buffer arbitrary bytes just because it stayed under the timeout.
    maxBytes?: number;
  },
): Promise<SnapshotResult | null> {
  const url = _gatewayUrl(listCid);
  const maxBytes = opts?.maxBytes ?? defaultMaxIpfsBytes();
  const res = await fetch(url, {
    signal: _composeSignals([opts?.signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) return null;
  // FINDING 3 (HIGH): manual streamed read with a size accumulator. We do NOT
  // trust `Content-Length` — a hostile / mis-configured gateway can advertise
  // any value or omit the header entirely, and then dribble bytes forever.
  // The stream reader gives us the actual byte count as it arrives; the
  // moment we cross the ceiling we cancel the reader (which under fetch's
  // semantics also aborts the underlying network stream) and reject.
  const bodyText = await _readBodyWithCap(res, maxBytes, url);
  let body: {
    root?: Hex;
    snapshotBlock?: string | number;
    holders?: string[];
    listId?: string;
  };
  try {
    body = JSON.parse(bodyText);
  } catch {
    // Malformed JSON is treated the same as a 4xx from the gateway —
    // caller can retry via a fresh snapshot.
    return null;
  }
  if (!body.root || !body.holders) return null;
  const holders = body.holders.map((a) => a.toLowerCase() as Address);
  // Content-integrity check: rebuild the Merkle root from the pinned holders
  // and reject the pin if it doesn't match `body.root`. Blocks the attack
  // where a malicious IPFS pin claims one root + declares an attacker-picked
  // `listId` matching a real launch's cache key -- without this check, the
  // pin's holders would silently overwrite the legitimate snapshot in cache
  // and every subsequent proof request for that launch would return
  // attacker-controlled data (root mismatch on-chain -> DoS every WL buy).
  const recomputedRoot = _buildMerkleRoot([...holders].sort());
  if (recomputedRoot.toLowerCase() !== body.root.toLowerCase()) {
    // eslint-disable-next-line no-console
    console.warn(
      `wl-snapshot: ipfs pin ${listCid} failed integrity check - claimed root ${body.root} but holders hash to ${recomputedRoot}`,
    );
    return null;
  }
  const pinnedBlock = BigInt(body.snapshotBlock ?? 0);
  const snap: SnapshotResult = {
    root: body.root,
    snapshotBlock: pinnedBlock,
    // Pins predate the start/end distinction, so there's only one block value
    // to attribute to both bookends. Downstream consumers that care about
    // drift should snapshot fresh instead of relying on a pin.
    snapshotStartBlock: pinnedBlock,
    snapshotEndBlock: pinnedBlock,
    holderCount: holders.length,
    holders,
    // Cache ONLY under the content-addressed CID. The old code also cached
    // under `body.listId` (attacker-supplied), which was the poison vector -
    // an attacker's pin could claim any listId and hijack lookups by that key.
    listId: listCid,
    listCid,
    listGatewayUrl: url,
    // The pin format doesn't carry `partial` — pins were always assumed
    // complete. Preserve that assumption for existing pins.
    partial: false,
    fromRpcFallback: false,
  };
  cache.set(listCid, snap);
  return snap;
}

/// Look up a proof for `holder` in a previously-snapshotted list. Returns null if
/// the list has been evicted from cache (client should re-snapshot) or the holder
/// isn't in it.
export function proofFor(listId: string, holder: Address): Hex[] | null {
  const snap = cache.get(listId);
  if (!snap) return null;
  const idx = snap.holders.indexOf(holder.toLowerCase() as Address);
  if (idx === -1) return null;
  return _buildMerkleProof(snap.holders, idx);
}

// -----------------------------------------------------------
// Internals — event replay + Merkle math
// -----------------------------------------------------------

/// Chunk through getLogs, replay net balances by walking Transfer events. For
/// ERC-20 the event's third arg is `value` (delta). For ERC-721 it's a `tokenId`
/// (each transfer moves exactly one token, so the delta per address is +/- 1).
/// `isErc721` is detected upstream via `_detectIsErc721`.
async function _replayBalances(
  client: ReturnType<typeof createPublicClient>,
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  isErc721: boolean,
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : start + LOG_CHUNK_BLOCKS - 1n;
    const logs = await client.getLogs({
      address: token,
      event: TRANSFER_EVENT,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const from = (log.args.from ?? '0x0000000000000000000000000000000000000000').toLowerCase();
      const to = (log.args.to ?? '0x0000000000000000000000000000000000000000').toLowerCase();
      // For ERC-721 each transfer is one token; the `value` field decodes as the
      // tokenId which isn't the delta we want. Force +/- 1 instead.
      const delta = isErc721 ? 1n : (log.args.value ?? 0n);
      if (from !== '0x0000000000000000000000000000000000000000') {
        balances.set(from, (balances.get(from) ?? 0n) - delta);
      }
      if (to !== '0x0000000000000000000000000000000000000000') {
        balances.set(to, (balances.get(to) ?? 0n) + delta);
      }
    }
  }
  return balances;
}

/// Fetch the current NFT owner set from Alchemy NFT API v3. Returns lowercased
/// addresses whose ownership count meets `minBalance`. Uses `getOwnersForContract`
/// with `withTokenBalances=true` and paginates through `pageKey`.
///
/// Returns `null` (not throws) when the contract isn't an NFT — signaling to
/// the caller that this source can't handle it and it should fall through to
/// the next path. Any real error (network, cap-exceeded, timeout) throws.
///
/// Alchemy's `getOwnersForContract` returns the CURRENT owner set with balances
/// in one paginated call — no Transfer-event replay, no block-drift window, no
/// blockscout coverage variance. Works uniformly on every chain in
/// `ALCHEMY_NETWORKS`.
async function fetchHoldersViaAlchemyNft(
  alchemyBase: string,
  token: Address,
  minBalance: bigint,
  opts?: { signal?: AbortSignal; maxHolderCount?: number },
): Promise<Address[] | null> {
  const cap = opts?.maxHolderCount ?? defaultMaxHolderCount();
  const holders = new Map<string, bigint>();
  let pageKey: string | undefined;
  // Alchemy caps pageSize at 50k for this endpoint; 100 keeps memory tight
  // and matches the pagination step we use everywhere else.
  const pageSize = 100;
  for (let page = 0; page < 2000; page++) {
    const url = new URL(`${alchemyBase}/getOwnersForContract`);
    url.searchParams.set('contractAddress', token);
    url.searchParams.set('withTokenBalances', 'true');
    url.searchParams.set('pageSize', String(pageSize));
    if (pageKey) url.searchParams.set('pageKey', pageKey);
    const res = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: opts?.signal,
    });
    if (!res.ok) {
      // 400 on a non-NFT contract — Alchemy returns something like
      // `{ error: 'Contract is not an NFT contract' }`. Signal "not our job"
      // by returning null so caller falls through to Blockscout/RPC.
      if (res.status === 400) {
        try {
          const body = await res.json() as { error?: string };
          const msg = (body?.error ?? '').toLowerCase();
          if (msg.includes('not an nft') || msg.includes('erc-721') || msg.includes('erc-1155')) {
            return null;
          }
        } catch { /* fall through to error */ }
      }
      throw new Error(`alchemy nft api ${res.status} for ${token}`);
    }
    const body = await res.json() as {
      owners?: Array<{ ownerAddress?: string; tokenBalances?: Array<{ balance?: string | number }> }>;
      pageKey?: string | null;
    };
    for (const o of body.owners ?? []) {
      const addr = o.ownerAddress?.toLowerCase();
      if (!addr) continue;
      // Sum balances across tokenBalances (an owner can hold multiple tokenIds).
      let bal = 0n;
      for (const b of o.tokenBalances ?? []) {
        try { bal += BigInt(b.balance ?? '0'); } catch { /* skip garbage */ }
      }
      if (bal >= minBalance) holders.set(addr, bal);
    }
    if (holders.size > cap) {
      throw new WlHolderCountExceedsCap(holders.size, cap, 'blockscout');
    }
    if (!body.pageKey) break;
    pageKey = body.pageKey;
  }
  // Sorted for determinism — matches blockscout path so the same holder set
  // produces the same Merkle root across sources.
  return [...holders.keys()].sort() as Address[];
}

/// Fetch the current holder set from Blockscout, paginated. Returns lowercased
/// addresses whose reported balance (`value`) meets `minBalance`. Works for both
/// ERC-20 (value = raw balance) and ERC-721 (value = NFT count) since blockscout's
/// `holders` endpoint reports the same field for both token types.
///
/// Exposed (rather than kept internal) so the orchestrator can inspect
/// `hadMorePages` and decide whether to reject with `WlSnapshotTruncated` or
/// mark the result as `partial`. Tests can also drive this function directly
/// by mocking global `fetch`.
export async function fetchHoldersViaBlockscout(
  apiBase: string,
  token: Address,
  minBalance: bigint,
  maxPages: number = BLOCKSCOUT_MAX_PAGES,
  opts?: {
    /// FINDING 3 (HIGH): caller-supplied cancel. Combined with the per-fetch
    /// 15s timeout so an outer route disconnect stops mid-pagination.
    signal?: AbortSignal;
    /// FINDING 3 (HIGH): abort pagination once the running eligible count
    /// crosses this ceiling. Avoids paying for the rest of the page walk
    /// when the snapshot will reject anyway.
    maxHolderCount?: number;
  },
): Promise<BlockscoutHoldersResult> {
  const eligible: Address[] = [];
  let cursor: URLSearchParams | null = new URLSearchParams();
  let pages = 0;
  const maxHolders = opts?.maxHolderCount ?? Number.POSITIVE_INFINITY;
  while (cursor && pages < maxPages) {
    // Bail immediately if the caller cancelled between pages. The per-fetch
    // timeout below only covers ONE page — a burst of small-and-fast pages
    // would otherwise ignore the outer signal until the next network hop.
    if (opts?.signal?.aborted) {
      throw opts.signal.reason ?? new Error('wl snapshot aborted');
    }
    const url = `${apiBase}/tokens/${token}/holders${cursor.toString() ? '?' + cursor.toString() : ''}`;
    const res = await fetch(url, {
      // Compose the per-fetch 15s timeout with the outer request signal
      // (via `AbortSignal.any`, Node 22+) so EITHER firing kills the fetch.
      signal: _composeSignals([opts?.signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) {
      throw new Error(`blockscout ${res.status} ${res.statusText}: ${url}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ address?: { hash?: string }; value?: string }>;
      next_page_params?: Record<string, string | number> | null;
    };
    for (const it of body.items ?? []) {
      const addr = it.address?.hash?.toLowerCase();
      const raw = it.value;
      if (!addr || !raw) continue;
      if (BigInt(raw) >= minBalance) eligible.push(addr as Address);
    }
    // FINDING 3: hard-stop pagination as soon as we exceed the ceiling.
    // Throwing the dedicated error here (rather than at the caller) means we
    // never spend more RPC + Merkle time on a snapshot we know will reject.
    if (eligible.length > maxHolders) {
      throw new WlHolderCountExceedsCap(eligible.length, maxHolders, 'blockscout');
    }
    if (body.next_page_params) {
      cursor = new URLSearchParams();
      // Pass next_page_params through verbatim — blockscout is strict about
      // unrecognized keys (returns 422). Do NOT nudge page size here.
      for (const [k, v] of Object.entries(body.next_page_params)) {
        cursor.set(k, String(v));
      }
    } else {
      cursor = null;
    }
    pages += 1;
  }
  // `cursor` is still a URLSearchParams here iff we exited because we hit the
  // `maxPages` cap while `next_page_params` was set on the last response — i.e.
  // Blockscout has more holders than we fetched.
  return { holders: eligible, pagesFetched: pages, hadMorePages: cursor !== null };
}

/// FINDING 3 (HIGH): combine an optional caller signal with a per-fetch
/// timeout signal so a fetch dies on EITHER. Falls back to just the timeout
/// when the caller didn't pass one, and to just the caller signal if the
/// timeout is undefined — never returns undefined so the fetch always has a
/// bounded lifetime. Uses `AbortSignal.any` when available (Node 20+) and
/// falls back to a manual wiring on older runtimes.
function _composeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return AbortSignal.timeout(15_000);
  if (live.length === 1) return live[0]!;
  // Prefer the standard API when the runtime has it.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, live);
  // Manual polyfill — mirror abort onto a fresh controller. `once` so we
  // don't leak listeners if the merged signal aborts more than once.
  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/// ERC-20 tokens implement `decimals()`; ERC-721 collections don't. Best-effort
/// detection — if the call reverts or the token has neither shape, defaults to
/// ERC-20 semantics (value = delta) which is the safer fallback for our use case
/// (using tokenIds as ERC-20 values would sum oddly and inflate balances).
async function _detectIsErc721(
  client: ReturnType<typeof createPublicClient>,
  token: Address,
): Promise<boolean> {
  try {
    await client.readContract({
      address: token,
      abi: parseAbi(['function decimals() view returns (uint8)']),
      functionName: 'decimals',
    });
    return false; // has decimals → ERC-20
  } catch {
    return true; // no decimals → assume ERC-721
  }
}

/// Build a sorted-pair Merkle root from a list of addresses. Empty list → 0x0.
function _buildMerkleRoot(sortedHolders: Address[]): Hex {
  if (sortedHolders.length === 0) return `0x${'0'.repeat(64)}` as Hex;
  let layer: Hex[] = sortedHolders.map((a) => _leaf(a));
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const l = layer[i] as Hex;
      const r = (i + 1 < layer.length ? layer[i + 1] : layer[i]) as Hex; // duplicate odd tail
      next.push(_hashPair(l, r));
    }
    layer = next;
  }
  return layer[0] as Hex;
}

function _buildMerkleProof(sortedHolders: Address[], leafIdx: number): Hex[] {
  if (sortedHolders.length === 0) return [];
  let layer: Hex[] = sortedHolders.map((a) => _leaf(a));
  const proof: Hex[] = [];
  let idx = leafIdx;
  while (layer.length > 1) {
    const pairIdx = idx ^ 1; // sibling in the layer
    if (pairIdx < layer.length) proof.push(layer[pairIdx] as Hex);
    // Else: the tail was self-duplicated → no sibling to add.
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const l = layer[i] as Hex;
      const r = (i + 1 < layer.length ? layer[i + 1] : layer[i]) as Hex;
      next.push(_hashPair(l, r));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function _leaf(addr: Address): Hex {
  return keccak256(encodePacked(['address'], [addr]));
}

function _hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return keccak256(encodePacked(['bytes32', 'bytes32'], [lo, hi]));
}

/// FINDING 3 (HIGH): stream a `fetch` Response body into memory with a hard
/// byte ceiling. `Content-Length` is deliberately NOT consulted — the header
/// is caller-declared and a hostile gateway can lie or omit it. We tally
/// bytes as they arrive from the reader and abort the moment the ceiling is
/// crossed, then throw `WlIpfsResponseTooLarge` so /wl/proof can return a
/// 413. Cancelling the reader closes the underlying network stream (per the
/// fetch spec), so the caller isn't racing an unbounded background download.
async function _readBodyWithCap(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  // Some runtimes may hand back a body without `getReader()` (a rare shim
  // path). Falling back to `.text()` for those is fine — the runtime is
  // responsible for buffering, and we still validate the resulting size
  // before returning.
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      throw new WlIpfsResponseTooLarge(bytes, maxBytes, url);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Kill the underlying network read so we stop paying for bytes
        // we're about to discard. `cancel` returns a Promise but we don't
        // need to await it before throwing — the caller wants the error
        // immediately, and the reader releases resources either way.
        await reader.cancel().catch(() => { /* best-effort */ });
        throw new WlIpfsResponseTooLarge(total, maxBytes, url);
      }
      chunks.push(value);
    }
  } finally {
    // Idempotent — releaseLock is a no-op once cancel/done has fired.
    try { reader.releaseLock(); } catch { /* best-effort */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// -----------------------------------------------------------
// IPFS pin (Pinata) — durable storage for holder lists so trade-time proof
// lookups don't depend on process-local memory.
// -----------------------------------------------------------
/// AUDIT H2: read the pinata JWT at CALL time (not module-load time) so the
/// abort-during-pin test suite can toggle it per-test. Prod behaviour is
/// unchanged — the env is set before the process starts and doesn't change
/// mid-run, so the per-call `process.env` read has no meaningful cost.
function _pinataJwt(): string {
  return process.env.PINATA_JWT ?? '';
}
const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY ?? process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? 'gateway.pinata.cloud';
const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

function _gatewayUrl(cid: string): string {
  return `https://${PINATA_GATEWAY.replace(/^https?:\/\//, '')}/ipfs/${cid}`;
}

async function _pinListToIpfs(
  listId: string,
  holders: Address[],
  root: Hex,
  snapshotBlock: bigint,
  signal?: AbortSignal,
): Promise<{ cid: string; gatewayUrl: string } | null> {
  const jwt = _pinataJwt();
  if (!jwt) return null;
  // Pin a compact self-describing JSON — enough to reconstruct the tree client-side
  // and verify against the on-chain root. Keeps addresses lowercased (canonical form
  // used for leaf hashing) so no re-normalization is needed at proof-build time.
  const payload = {
    version: 1,
    listId,
    root,
    snapshotBlock: snapshotBlock.toString(),
    holderCount: holders.length,
    holders,
  };
  const res = await fetch(PINATA_PIN_JSON_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: { name: `urufu-wl-${listId}` },
    }),
    // FINDING 3: compose caller signal + per-fetch 15s timeout so a route
    // disconnect kills the pin write, not just the block/holder reads.
    signal: _composeSignals([signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { IpfsHash?: string };
  if (!body.IpfsHash) return null;
  return { cid: body.IpfsHash, gatewayUrl: _gatewayUrl(body.IpfsHash) };
}
