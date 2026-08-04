/// Holder snapshotting for whitelisted-curve launches.
///
/// Given a source token/NFT contract on Robinhood, fetches the holder set at the
/// latest block, filters by a min-balance threshold, and returns a Merkle root
/// plus the sorted holder list. The frontend embeds the root in the WL launch
/// tx; buyers fetch their proof from `/wl/proof?listId=…&addr=…` at buy time.
///
/// Scope for v1:
///   - Robinhood mainnet only (chainId 4663). Adding other chains = adding an RPC
///     mapping below + testing there.
///   - ERC-20 and ERC-721 supported via Transfer-event replay. ERC-1155 = follow-up
///     (per-tokenId semantics complicate the "holder" abstraction).
///   - Block-range cap of 1_500_000 blocks (~= 30 days on RH) so ancient tokens
///     don't hang the request. Callers can bump this when we have paging.
///   - In-memory cache keyed on (token, blockNumber) — a re-request within a few
///     minutes of the same snapshot returns instantly. Cleared on process restart.
///
/// The Merkle tree uses sorted-pair hashing (Solady + OpenZeppelin convention)
/// with leaves `keccak256(abi.encodePacked(address))` — matches
/// `BondingCurve.buyWithProof`'s `MerkleProofLib.verify` layout exactly.

import { createPublicClient, http, parseAbiItem, parseAbi, type Address, type Hex, keccak256, encodePacked } from 'viem';

/// Chains this snapshot service can read from. Extend when we open beyond RH.
const RPC_URLS: Record<number, string> = {
  4663: process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
};

/// Blockscout v2 API base URLs, keyed by chainId. When set, `snapshotHolders`
/// pulls the holder list from Blockscout instead of replaying Transfer events
/// off the RPC. This is BOTH faster AND correct: event replay is bounded by
/// `MAX_SCAN_BLOCKS` and misses holders whose only Transfers happened before
/// the cutoff — on fast-block chains like RH that cutoff can hide the majority
/// of a token's holder set (URU showed 27/334 via replay).
const EXPLORER_APIS: Record<number, string> = {
  4663: process.env.ROBINHOOD_BLOCKSCOUT_URL ?? 'https://robinhoodchain.blockscout.com/api/v2',
};

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
/// than silently return a moving-target result. Tuned for RH (~1s blocks); on
/// slower chains the caller should pass a smaller `maxBlockDrift`.
export const DEFAULT_MAX_BLOCK_DRIFT = 25n;

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

/// Simple in-memory cache — key is `${chainId}:${token.toLowerCase()}:${block}`.
/// Stored so the SAME snapshot can serve many proof requests without re-scanning.
const cache = new Map<string, SnapshotResult>();

export async function snapshotHolders(req: SnapshotRequest): Promise<SnapshotResult> {
  const rpc = RPC_URLS[req.chainId];
  if (!rpc) {
    throw new Error(`unsupported chainId ${req.chainId} — snapshot service only knows: ${Object.keys(RPC_URLS).join(', ')}`);
  }

  const allowPartial = req.allowPartial === true;
  const maxDrift = req.maxBlockDrift ?? DEFAULT_MAX_BLOCK_DRIFT;
  const maxBlockscoutPages = req.maxBlockscoutPages ?? BLOCKSCOUT_MAX_PAGES;

  const client = createPublicClient({ transport: http(rpc) });
  // Bookend the snapshot with two block-tip reads. The reported `snapshotBlock`
  // is the START read (that's the tip our holder set is "as of"), and the END
  // read is compared against it to detect chain-tip drift while we paginated
  // Blockscout / scanned RPC — see WlSnapshotBlockDrift.
  //
  // `cacheTime: 0` disables viem's default 4s block-number cache — a stale
  // cached tip would make the drift check silently pass and defeat the whole
  // purpose of the bookend.
  const startBlock = await client.getBlockNumber({ cacheTime: 0 });
  const cacheKey = `${req.chainId}:${req.tokenAddress.toLowerCase()}:${startBlock}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const minBal = req.minBalance ?? 1n;

  // Prefer blockscout when available — it has the full holder set indexed and
  // returns current balances directly, sidestepping the event-replay cutoff
  // problem entirely (see `EXPLORER_APIS` note above).
  let eligible: Address[] | null = null;
  let partial = false;
  let pagesFetched: number | undefined;
  let fromRpcFallback = false;
  const explorerApi = EXPLORER_APIS[req.chainId];
  if (explorerApi) {
    let bs: BlockscoutHoldersResult | null = null;
    try {
      bs = await fetchHoldersViaBlockscout(
        explorerApi,
        req.tokenAddress,
        minBal,
        maxBlockscoutPages,
      );
    } catch (err) {
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
    const pinned = await _pinListToIpfs(cacheKey, eligible, root, startBlock);
    if (pinned) {
      result.listCid = pinned.cid;
      result.listGatewayUrl = pinned.gatewayUrl;
    }
  } catch (err) {
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
): Promise<SnapshotResult | null> {
  const url = _gatewayUrl(listCid);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    root?: Hex;
    snapshotBlock?: string | number;
    holders?: string[];
    listId?: string;
  };
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
): Promise<BlockscoutHoldersResult> {
  const eligible: Address[] = [];
  let cursor: URLSearchParams | null = new URLSearchParams();
  let pages = 0;
  while (cursor && pages < maxPages) {
    const url = `${apiBase}/tokens/${token}/holders${cursor.toString() ? '?' + cursor.toString() : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

// -----------------------------------------------------------
// IPFS pin (Pinata) — durable storage for holder lists so trade-time proof
// lookups don't depend on process-local memory.
// -----------------------------------------------------------
const PINATA_JWT = process.env.PINATA_JWT ?? '';
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
): Promise<{ cid: string; gatewayUrl: string } | null> {
  if (!PINATA_JWT) return null;
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
      authorization: `Bearer ${PINATA_JWT}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: { name: `urufu-wl-${listId}` },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { IpfsHash?: string };
  if (!body.IpfsHash) return null;
  return { cid: body.IpfsHash, gatewayUrl: _gatewayUrl(body.IpfsHash) };
}
