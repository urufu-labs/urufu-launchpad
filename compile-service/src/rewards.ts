/// Flywheel Merkle-drop pipeline.
///
/// A "publish" takes a snapshot of current gemu NFT holders (via the indexer's
/// GraphQL), splits the NftRevenueVault ETH balance proportionally to NFT count,
/// builds a Merkle tree with `keccak256(abi.encodePacked(holder, epochId, amount))`
/// leaves, broadcasts `vault.addEpoch(root, totalAmount)` from the keeper key, and
/// persists the tree in Postgres so the frontend can serve per-holder proofs later.
///
/// Sort-pair ordering matches solady's `MerkleProofLib.verifyCalldata` on-chain so
/// the same proof the frontend fetches from `/rewards/:chain/:epoch/:addr` verifies
/// against the on-chain root without any adapter code.
///
/// The keeper key lives in `KEEPER_PRIVATE_KEY` (server-side env). Same wallet is
/// the vault owner today, so it has permission to call addEpoch. Rotate later by
/// transferring vault ownership + updating the env var.

import { AsyncLocalStorage } from 'node:async_hooks';

import { MerkleTree } from 'merkletreejs';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';

import { sql } from './db.ts';

// ---------------------------------------------------------------- config

export interface ChainConfig {
  slug: 'robinhood';
  chainId: number;
  rpcUrl: string;
  vaultAddress: Address;
  gemuNftAddress: Address;
  // Public Blockscout API root for this chain. When set, the holder snapshot
  // pulls from `/api/v2/tokens/:addr/holders` first because Blockscout's
  // count matches the on-chain reality; the Ponder indexer has been observed
  // to undercount (indexed schema drift on migration blocks).
  blockscoutUrl?: string;
}

/// urufu gemu NFT lives ONLY on Robinhood as of 2026-07 - the Base collection
/// was retired during the RH migration. If the keeper ever needs to publish
/// epochs on another chain, add its slug + env-var block here and widen the
/// union above. Missing env vars → returns null (route responds 501).
export function chainConfigFor(slug: string): ChainConfig | null {
  if (slug !== 'robinhood') return null;
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const vaultAddress = process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS as Address | undefined;
  // Deliberately no fallback to bare GEMU_NFT_ADDRESS — that env var still
  // holds the retired Base collection for reference, and silently reading it
  // here would ship a Base address to a Robinhood-chain RPC call and return
  // zero holders → publishEpoch would credit no one. Fail loud instead.
  const gemuNftAddress = process.env.ROBINHOOD_GEMU_NFT_ADDRESS as Address | undefined;
  if (!rpcUrl || !vaultAddress || !gemuNftAddress) return null;
  return {
    slug: 'robinhood',
    chainId: 4663,
    rpcUrl,
    vaultAddress,
    gemuNftAddress,
    blockscoutUrl: process.env.ROBINHOOD_BLOCKSCOUT_URL ?? 'https://robinhoodchain.blockscout.com',
  };
}

/// Ponder GraphQL endpoint — same URL the frontend uses, wired via env because
/// compile-service and indexer share the same Railway project.
const INDEXER_URL = process.env.INDEXER_URL ?? process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';

// ---------------------------------------------------------------- ABI

const vaultAbi = parseAbi([
  'function nextEpochId() view returns (uint256)',
  'function totalCommitted() view returns (uint256)',
  'function minConfigDelay() view returns (uint256)',
  'function epochs(uint256) view returns (bytes32 merkleRoot, uint256 totalAmount, uint256 unclaimed)',
  // URU-A06: expectedEpochId is now required. A stale publisher reverts.
  'function addEpoch(uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount)',
  // URU-A11: propose/activate path used when the vault's minConfigDelay > 0.
  'function proposeEpoch(uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount)',
  'function activateEpoch()',
  'function cancelPendingEpoch()',
  'function pendingEpoch() view returns (uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint64 readyAt)',
]);

/// URU-A06: postgres advisory lock key. keccak256("URUFU_REWARDS_PUBLICATION")
/// truncated to a stable 64-bit signed integer so pg accepts it. Every
/// publish path (manual HTTP + keeper) must hold this lock; two concurrent
/// publishers cannot race the same nextEpochId.
const REWARDS_PUBLICATION_LOCK = 366_151_460_437n;

// ---------------------------------------------------------------- viem clients

/// Public client for reads (vault balance, holder queries, tx-receipt polling).
function publicClientFor(cfg: ChainConfig): PublicClient {
  return createPublicClient({ transport: http(cfg.rpcUrl) });
}

/// Wallet client for the on-chain publish. Reads keeper key from env; throws if
/// unset because a publish without a signer would silently no-op.
///
/// Returns the LocalAccount object as `account`, not just its address string.
/// Callers pass `account` into `wallet.sendTransaction({ account, … })`; if
/// they get a bare address string back, viem treats it as a json-rpc account
/// (no signing keys) and tries `eth_sendTransaction` on the RPC provider —
/// which Alchemy + every other public node refuses. Passing the LocalAccount
/// routes through local sign + `eth_sendRawTransaction`.
function walletClientFor(cfg: ChainConfig): { wallet: WalletClient; account: LocalAccount } {
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  if (!rawKey) throw new Error('KEEPER_PRIVATE_KEY not set on compile-service');
  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    transport: http(cfg.rpcUrl),
    chain: { id: cfg.chainId, name: cfg.slug, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } },
  });
  return { wallet, account };
}

// ---------------------------------------------------------------- test-only DI

/// Round-2 audit FINDING 1 / FINDING 4 test coverage — some of the dependencies
/// this module reaches for (the pg singleton, viem RPC + wallet clients, the
/// indexer holder fetch) are constructed from env inside the module and cannot
/// be swapped by a caller. The audit acceptance criteria for `publishEpoch`
/// require end-to-end unit coverage of the pendingEpoch state machine (immature
/// vs matured branches) and the journal-column INSERT — both live below the
/// env-driven boundary. Rather than plumb an options bag through every public
/// signature (which would ripple into `server.ts`, `keeper.ts` and every
/// existing route handler), we scope test overrides through an
/// AsyncLocalStorage so parallel test suites cannot clobber each other.
///
/// Round-6 audit H1: the prior implementation used a mutable module-level
/// override slot (`_setTestOverrides`). Under `node:test`'s concurrent runner
/// two overlapping tests could stomp each other's fakes — the second setter
/// would replace the first's sql / wallet / pub, and any resolver call
/// scheduled from the first test after the swap would silently read the
/// wrong fake. Switching to AsyncLocalStorage binds overrides to the
/// callback's async chain, so each `_withTestOverrides` scope sees its own
/// store even when many run in parallel.
///
/// TEST-ONLY. Never call from production code. Guarded only by documentation
/// on purpose — NODE_ENV is not a security boundary; operators legitimately
/// set NODE_ENV=production for CI test runs, so gating on it would either
/// break tests or make the override active in prod. Prod never enters an
/// `_withTestOverrides` scope, so `getStore()` returns undefined and the
/// resolvers fall through to the real bindings.
export interface RewardsTestOverrides {
  sql?: unknown;
  publicClientFor?: (cfg: ChainConfig) => PublicClient;
  walletClientFor?: (cfg: ChainConfig) => { wallet: WalletClient; account: LocalAccount };
  fetchHolders?: (cfg: ChainConfig, pub: PublicClient) => Promise<Holder[]>;
}

const _testOverridesAls = new AsyncLocalStorage<RewardsTestOverrides>();

/// Run `callback` inside an AsyncLocalStorage scope whose store carries
/// `overrides`. Every resolver below reads from `getStore()`, so any async
/// chain descended from `callback` (including deeply-nested awaits inside
/// `publishEpoch`) sees the same overrides — and code running on a sibling
/// scope is completely unaffected. Returns whatever `callback` returns.
export function _withTestOverrides<T>(
  overrides: RewardsTestOverrides,
  callback: () => Promise<T>,
): Promise<T> {
  return _testOverridesAls.run(overrides, callback);
}

function _resolveSql(): unknown {
  return _testOverridesAls.getStore()?.sql ?? sql;
}
function _resolvePublicClientFor(cfg: ChainConfig): PublicClient {
  const store = _testOverridesAls.getStore();
  return (store?.publicClientFor ?? publicClientFor)(cfg);
}
function _resolveWalletClientFor(cfg: ChainConfig): { wallet: WalletClient; account: LocalAccount } {
  const store = _testOverridesAls.getStore();
  return (store?.walletClientFor ?? walletClientFor)(cfg);
}
function _resolveFetchHolders(cfg: ChainConfig, pub: PublicClient): Promise<Holder[]> {
  const store = _testOverridesAls.getStore();
  return (store?.fetchHolders ?? fetchGemuHolders)(cfg, pub);
}

// ---------------------------------------------------------------- snapshot query

/// Read all current gemu NFT holders (balance > 0) from the indexer. Uses Ponder's
/// GraphQL — same source the frontend hits. Returns lowercase-normalized addresses
/// so downstream Merkle-tree hashing is deterministic.
/// Exported so the test override type below can reference it without a duplicate
/// declaration.
export interface Holder {
  address: Address;
  balance: bigint; // NFT count
}

/// Round-2 audit FINDING 4: page size the indexer returns per request. Ponder
/// caps `limit` per page; 500 is well inside every deployment's ceiling and
/// keeps the request/response bodies small enough to not stall the RPC event
/// loop. The paginator loops until a partial page is returned.
const INDEXER_HOLDER_PAGE_SIZE = 500;

/// Round-2 audit FINDING 4: hard ceiling on how many holders the publisher will
/// pull from the indexer in one snapshot. A run above this cap almost certainly
/// signals a schema regression or a malicious cursor loop, not real growth —
/// fail loudly so an operator raises the cap deliberately. Override with
/// `REWARDS_HOLDER_CAP` if the collection genuinely outgrows this.
const REWARDS_HOLDER_CAP_DEFAULT = 100_000;

/// Round-2 audit FINDING 4: thrown when pagination exceeds the sanity ceiling.
/// Exported so callers + tests can identify the failure mode without string
/// matching.
export class IndexerHolderCountExceedsCap extends Error {
  readonly seen: number;
  readonly cap: number;
  constructor(seen: number, cap: number) {
    super(`indexer holder count ${seen} exceeds cap ${cap} — raise REWARDS_HOLDER_CAP deliberately`);
    this.name = 'IndexerHolderCountExceedsCap';
    this.seen = seen;
    this.cap = cap;
  }
}

function holderCap(): number {
  const raw = process.env.REWARDS_HOLDER_CAP;
  if (!raw) return REWARDS_HOLDER_CAP_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : REWARDS_HOLDER_CAP_DEFAULT;
}

/// Test seam: allow the unit tests to inject a fake fetch. Production always
/// uses the global `fetch`.
export interface IndexerFetch {
  (url: string, init: RequestInit): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export async function fetchGemuHoldersFromIndexer(
  cfg: ChainConfig,
  fetchImpl: IndexerFetch = (globalThis as { fetch: IndexerFetch }).fetch,
  cap: number = holderCap(),
): Promise<Holder[]> {
  // Cursor pagination — Ponder GraphQL exposes `pageInfo.endCursor` +
  // `hasNextPage`; passing `endCursor` as `after` continues the walk. `orderBy`
  // must be a total-ordering field (id is the primary key) so pages don't
  // overlap or skip rows when the underlying data changes mid-walk.
  const query = `
    query GemuHolders($chainId: Int!, $token: String!, $limit: Int!, $after: String) {
      holderss(
        where: { chainId: $chainId, tokenAddress: $token }
        orderBy: "id"
        orderDirection: "asc"
        limit: $limit
        after: $after
      ) {
        items { holderAddress balance }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const holders: Holder[] = [];
  let after: string | null = null;
  // Belt-and-suspenders: the pageInfo.hasNextPage flag is the primary loop
  // guard; also break on a partial page so a broken indexer that reports
  // `hasNextPage: true` forever cannot spin us.
  for (;;) {
    const res = await fetchImpl(`${INDEXER_URL.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          chainId: cfg.chainId,
          token: cfg.gemuNftAddress.toLowerCase(),
          limit: INDEXER_HOLDER_PAGE_SIZE,
          after,
        },
      }),
    });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const json = (await res.json()) as {
      data?: {
        holderss: {
          items: Array<{ holderAddress: string; balance: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: unknown;
    };
    if (json.errors) throw new Error(`indexer errors: ${JSON.stringify(json.errors)}`);
    const items = json.data?.holderss.items ?? [];
    for (const row of items) {
      const balance = BigInt(row.balance);
      if (balance <= 0n) continue;
      holders.push({
        address: row.holderAddress.toLowerCase() as Address,
        balance,
      });
      if (holders.length > cap) {
        console.log(
          JSON.stringify({ rewards: 'fetchHolders', error: 'cap-exceeded', seen: holders.length, cap }),
        );
        throw new IndexerHolderCountExceedsCap(holders.length, cap);
      }
    }
    const page = json.data?.holderss.pageInfo;
    // Stop conditions: indexer says no more OR partial page (< requested).
    // Either signals exhaustion; requiring both would loop forever if the
    // indexer reports hasNextPage=true on the last page (Ponder does this
    // occasionally when the underlying rows shift mid-query).
    if (!page?.hasNextPage) break;
    if (items.length < INDEXER_HOLDER_PAGE_SIZE) break;
    if (!page.endCursor) break;
    after = page.endCursor;
  }
  return holders;
}

/// Fallback: enumerate holders directly from on-chain Transfer events. Used
/// when the Ponder indexer returns empty (indexer not caught up, or gemu NFT
/// contract not included in the ponder config). Walks in 9500-block chunks
/// (RH RPC log-range cap). Slower than indexer (~30s for a well-populated
/// collection) but bulletproof — if the NFT contract exists on-chain, this
/// works.
///
/// gemu NFT was deployed at block ~18349728; we start the scan a bit before
/// that as a safety buffer. Increase this constant only if a fresh redeploy
/// bumps the collection to a later block (unlikely).
const GEMU_DEPLOY_BLOCK_HINT: bigint = 18_349_000n;
const TRANSFER_EVT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

async function fetchGemuHoldersFromChain(cfg: ChainConfig, pub: PublicClient): Promise<Holder[]> {
  const head = await pub.getBlockNumber();
  const owner = new Map<string, Address>(); // tokenId (decimal string) → current owner
  const CHUNK = 9_500n;
  let from = GEMU_DEPLOY_BLOCK_HINT;
  while (from <= head) {
    const to = from + CHUNK > head ? head : from + CHUNK;
    const logs = await pub.getLogs({
      address: cfg.gemuNftAddress,
      event: TRANSFER_EVT,
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      const a = l.args as { to?: Address; tokenId?: bigint };
      if (a.tokenId === undefined || a.to === undefined) continue;
      owner.set(a.tokenId.toString(), a.to.toLowerCase() as Address);
    }
    from = to + 1n;
  }
  const ZERO: Address = '0x0000000000000000000000000000000000000000';
  const counts = new Map<Address, bigint>();
  for (const [, o] of owner) {
    if (o === ZERO) continue;
    counts.set(o, (counts.get(o) ?? 0n) + 1n);
  }
  return [...counts.entries()].map(([address, balance]) => ({ address, balance }));
}

/// Prefer the indexer for speed; fall back to on-chain enumeration when the
/// indexer returns empty. Logs which source served so ops can spot silent
/// indexer regressions.
async function fetchGemuHolders(cfg: ChainConfig, pub: PublicClient): Promise<Holder[]> {
  // Priority order:
  //   1. Blockscout — matches on-chain reality (429 holders), fast (~10 pages),
  //      no state to fall out of sync.
  //   2. Ponder indexer — historically undercounted (was reporting 105 while
  //      Blockscout reported 429), likely a schema-migration gap. Kept as
  //      fallback because it's faster than a full Transfer-event walk.
  //   3. On-chain Transfer walk — slowest but the ultimate source of truth.
  //      Only fires if both remote indexers are unavailable.
  if (cfg.blockscoutUrl) {
    try {
      const fromBs = await fetchGemuHoldersFromBlockscout(cfg);
      if (fromBs.length > 0) {
        console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'blockscout', count: fromBs.length }));
        return fromBs;
      }
      console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'blockscout', count: 0, fallback: 'indexer' }));
    } catch (err) {
      console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'blockscout', error: (err as Error).message, fallback: 'indexer' }));
    }
  }
  try {
    const fromIndexer = await fetchGemuHoldersFromIndexer(cfg);
    if (fromIndexer.length > 0) {
      console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', count: fromIndexer.length }));
      return fromIndexer;
    }
    console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', count: 0, fallback: 'chain' }));
  } catch (err) {
    // Round-2 audit FINDING 4: cap-exceeded errors are load-bearing signals —
    // never silently swallow them into a chain fallback. Rethrow so the
    // operator sees the loud message and decides whether to raise the cap.
    if (err instanceof IndexerHolderCountExceedsCap) throw err;
    console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', error: (err as Error).message, fallback: 'chain' }));
  }
  const fromChain = await fetchGemuHoldersFromChain(cfg, pub);
  console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'chain', count: fromChain.length }));
  return fromChain;
}

/// Blockscout `/api/v2/tokens/:addr/holders` — paginated by opaque
/// `next_page_params` object echoed back as query string. Returns each
/// current holder + their NFT count (`value`). Matches the number Blockscout
/// shows on its UI, which is the on-chain truth.
export async function fetchGemuHoldersFromBlockscout(
  cfg: ChainConfig,
  fetchImpl: IndexerFetch = (globalThis as { fetch: IndexerFetch }).fetch,
): Promise<Holder[]> {
  if (!cfg.blockscoutUrl) return [];
  const base = cfg.blockscoutUrl.replace(/\/$/, '');
  const holders: Holder[] = [];
  let params: Record<string, string> | null = null;
  const cap = holderCap();
  // Belt-and-suspenders: hard ceiling on iterations so a broken cursor can't
  // loop forever. A single collection cannot have more than cap holders, and
  // pages are 50 items each.
  for (let i = 0; i < Math.ceil(cap / 50) + 5; i++) {
    const url = new URL(`${base}/api/v2/tokens/${cfg.gemuNftAddress.toLowerCase()}/holders`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`blockscout ${res.status} for ${cfg.slug}`);
    const body = (await res.json()) as {
      items?: Array<{ address?: { hash?: string; is_scam?: boolean }; value?: string }>;
      next_page_params?: Record<string, unknown> | null;
    };
    for (const item of body.items ?? []) {
      const addr = item.address?.hash?.toLowerCase();
      const bal = item.value ? BigInt(item.value) : 0n;
      if (!addr || bal === 0n || item.address?.is_scam) continue;
      holders.push({ address: addr as Address, balance: bal });
      if (holders.length > cap) {
        throw new IndexerHolderCountExceedsCap(holders.length, cap);
      }
    }
    if (!body.next_page_params) break;
    // Blockscout returns the next-page cursor as a bag of {value,address_hash,items_count};
    // it comes back stringified below the network boundary.
    params = Object.fromEntries(
      Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]),
    );
  }
  return holders;
}

// ---------------------------------------------------------------- tree building

/// Build the leaf hash exactly the way the solidity vault does:
///   keccak256(abi.encodePacked(holder, epochId, amount))
/// Returned as a Buffer so merkletreejs can consume it directly.
function leafFor(holder: Address, epochId: bigint, amount: bigint): Buffer {
  const packed = encodePacked(['address', 'uint256', 'uint256'], [holder, epochId, amount]);
  const hash = keccak_256(hexToBytes(packed));
  return Buffer.from(hash);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array | Buffer): Hex {
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/// Compute per-holder allocations: proportional to NFT count. Rounding leftover
/// (totalAmount - sum(perHolder)) is added to the largest holder's share so the
/// on-chain totalAmount matches the sum of all leaf amounts exactly (else the
/// vault's unclaimed counter drifts).
export function splitAllocations(
  holders: Holder[],
  totalAmount: bigint,
): Array<{ holder: Address; amount: bigint }> {
  const totalNfts = holders.reduce((sum, h) => sum + h.balance, 0n);
  if (totalNfts === 0n) return [];
  const allocations = holders.map((h) => ({
    holder: h.address,
    amount: (totalAmount * h.balance) / totalNfts,
  }));
  const distributed = allocations.reduce((sum, a) => sum + a.amount, 0n);
  const dust = totalAmount - distributed;
  if (dust > 0n && allocations.length > 0) {
    // Deterministic tiebreaker: largest NFT count wins; if two holders tie on
    // count, the earlier index (indexer-sorted-by-updatedAt-desc) wins.
    let largest = 0;
    for (let i = 1; i < holders.length; i++) {
      if ((holders[i]?.balance ?? 0n) > (holders[largest]?.balance ?? 0n)) largest = i;
    }
    const target = allocations[largest];
    if (target) target.amount += dust;
  }
  return allocations.filter((a) => a.amount > 0n);
}

/// Build the Merkle tree + a lookup map so we can pull each holder's proof out
/// after the tree is constructed. `sortPairs: true` matches solady's on-chain
/// `MerkleProofLib.verifyCalldata` behavior — proof pairs are sorted before
/// hashing, so leaf order in the input array doesn't affect the root.
export function buildTree(
  allocations: Array<{ holder: Address; amount: bigint }>,
  epochId: bigint,
): { root: Hex; leaves: Array<{ holder: Address; amount: bigint; proof: Hex[] }> } {
  const leafBufs = allocations.map((a) => leafFor(a.holder, epochId, a.amount));
  const tree = new MerkleTree(leafBufs, (data: Buffer) => Buffer.from(keccak_256(data)), {
    sortPairs: true,
  });
  const root = bytesToHex(tree.getRoot());
  const leaves = allocations.map((a, i) => {
    const buf = leafBufs[i];
    if (!buf) throw new Error(`leaf buffer missing at index ${i}`); // impossible: leafBufs.length === allocations.length
    return {
      holder: a.holder,
      amount: a.amount,
      proof: tree.getProof(buf).map((p) => bytesToHex(p.data)),
    };
  });
  return { root, leaves };
}

// ---------------------------------------------------------------- publish flow

export interface PublishResult {
  chainId: number;
  epochId: number;
  merkleRoot: Hex;
  totalAmount: string; // wei, as string (bigint doesn't JSON-serialize)
  holderCount: number;
  txHash: Hex;
  blockNumber: string;
}

/// Round-2 audit FINDING 1: publishEpoch's outcome is now a discriminated
/// union so the keeper + HTTP surface can distinguish an actual new epoch
/// broadcast from an activation of an already-pending proposal, or a skipped
/// cycle because the vault is still inside the timelock window. Prior return
/// type was always a broadcast, which made the caller wedge as soon as the
/// vault had `minConfigDelay > 0`.
export type PublishOutcome =
  | ({ action: 'published' } & PublishResult)
  | ({ action: 'activated' } & PublishResult)
  | {
      action: 'skipped-immature-proposal';
      chainId: number;
      epochId: number;
      readyAt: number;
    };

/// URU-A06: pg advisory-lock wrapper. All publish paths (HTTP + keeper) must
/// hold this before reading `nextEpochId` so two concurrent publishers cannot
/// both build a tree for the same epoch and land at N + N+1 with a stale root.
type ReservedDb = any;
/// Test seam: same lock/unlock ceremony but the `sql` client is injected so
/// the unit test can pass a fake that simulates advisory-lock contention
/// without a live Postgres. Production callers use `withPublicationLock`,
/// which routes to this with the singleton.
export async function withPublicationLockOn<T>(
  sqlClient: any,
  fn: (db: ReservedDb) => Promise<T>,
): Promise<T> {
  if (!sqlClient) throw new Error('DATABASE_URL not set — cannot persist tree');
  const db = await sqlClient.reserve();
  // postgres.js's ReservedSql in v3.4.x exposes tagged-template + .release()
  // but does NOT inherit .begin() from the pool-level Sql. The test doubles in
  // rewards.test.ts add .begin() to their fakes which masked this at test time;
  // production explodes with "db.begin is not a function" when publishEpoch
  // hits its transactional DELETE/INSERT block.
  //
  // Fix: shim .begin() on the reserved connection with manual BEGIN/COMMIT/
  // ROLLBACK. Runs on the SAME connection (so the outer pg_advisory_lock we
  // acquire below still serializes across publishers), and semantics match
  // Sql.begin() closely enough for our usage — single-level, no savepoints.
  if (typeof db.begin !== 'function') {
    db.begin = async (inner: (tx: unknown) => Promise<unknown>) => {
      await db`BEGIN`;
      try {
        const result = await inner(db);
        await db`COMMIT`;
        return result;
      } catch (err) {
        try { await db`ROLLBACK`; } catch { /* rollback failure — surface original */ }
        throw err;
      }
    };
  }
  try {
    await db`SELECT pg_advisory_lock(${REWARDS_PUBLICATION_LOCK.toString()})`;
    return await fn(db);
  } finally {
    try {
      await db`SELECT pg_advisory_unlock(${REWARDS_PUBLICATION_LOCK.toString()})`;
    } finally {
      db.release();
    }
  }
}
async function withPublicationLock<T>(fn: (db: ReservedDb) => Promise<T>): Promise<T> {
  return withPublicationLockOn(sql, fn);
}

/// URU-A07: pure helper that computes the epoch's total distribution amount
/// from the vault's reported balance + prior-epoch commitments. Extracted from
/// `publishEpoch` so the audit tests can cover partial-claim and override
/// guardrails without spinning up a full RPC + Postgres stack.
///
///   available   = max(balance - totalCommitted, 0)
///   totalAmount = override ?? available
///
/// Throws when the resulting amount is zero (nothing to distribute) OR when
/// the caller explicitly passes an override greater than `available` (would
/// revert `OverCommit` on-chain once the vault sees it).
export function resolvePublishAmount(
  vaultBalance: bigint,
  totalCommitted: bigint,
  override?: bigint,
): bigint {
  const available = vaultBalance > totalCommitted ? vaultBalance - totalCommitted : 0n;
  const totalAmount = override ?? available;
  if (totalAmount === 0n) throw new Error('vault available balance is zero — nothing to distribute');
  if (totalAmount > available) {
    throw new Error(
      `totalAmount (${formatEther(totalAmount)}) exceeds uncommitted balance (${formatEther(available)})`,
    );
  }
  return totalAmount;
}

/// URU-A06: promote a pending / broadcast publication row to `confirmed`
/// AND write the corresponding `rewards_epochs` entry. Called both from the
/// happy path (`publishEpoch`) and reconciliation (`reconcilePendingForConfig`)
/// so recovery of a mid-crash tx uses the same journal → epoch table path.
async function finalizePublication(
  db: ReservedDb,
  cfg: ChainConfig,
  row: {
    epoch_id: number;
    merkle_root: string;
    total_amount: string;
    holder_count: number;
    tx_hash: string | null;
    block_number: string | null;
  },
): Promise<void> {
  await db.begin(async (tx: any) => {
    await tx`
      INSERT INTO app.rewards_epochs (
        chain_id, epoch_id, vault_addr, merkle_root, total_amount,
        tx_hash, block_number, holder_count
      ) VALUES (
        ${cfg.chainId}, ${row.epoch_id}, ${cfg.vaultAddress.toLowerCase()},
        ${row.merkle_root}, ${row.total_amount},
        ${row.tx_hash ?? '0x_reconciled'}, ${row.block_number ?? '0'}, ${row.holder_count}
      )
      ON CONFLICT (chain_id, epoch_id) DO UPDATE SET
        merkle_root = EXCLUDED.merkle_root,
        total_amount = EXCLUDED.total_amount,
        tx_hash = EXCLUDED.tx_hash,
        block_number = EXCLUDED.block_number,
        holder_count = EXCLUDED.holder_count
    `;
    await tx`
      UPDATE app.rewards_publications
      SET status = 'confirmed', updated_at = now()
      WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}
    `;
  });
}

/// End-to-end publish. Reads holders, computes split, builds tree, PERSISTS
/// tree BEFORE broadcast (URU-A06 journal), then broadcasts `addEpoch` (or
/// `proposeEpoch` if the vault has a real timelock — URU-A11), waits for
/// receipt, promotes the journal row to `confirmed`.
///
/// Round-2 audit FINDING 1: before proposing a new epoch, checks the vault's
/// on-chain `pendingEpoch()`. A matured proposal is activated in place; an
/// immature one causes the call to return early with a
/// `skipped-immature-proposal` outcome so the caller (keeper loop / HTTP)
/// logs the wait and moves on instead of wedging.
///
/// `totalAmountOverride` is optional. When omitted, uses UNCOMMITTED balance
/// only (URU-A07: `balance - totalCommitted`), not the whole vault balance.
export async function publishEpoch(opts: {
  chainSlug: string;
  totalAmountOverride?: bigint;
}): Promise<PublishOutcome> {
  const cfg = chainConfigFor(opts.chainSlug);
  if (!cfg) throw new Error(`chain "${opts.chainSlug}" not configured for flywheel`);
  const activeSql = _resolveSql();
  if (!activeSql) throw new Error('DATABASE_URL not set — cannot persist tree');

  return withPublicationLockOn(activeSql, async (db) => {
    const pub = _resolvePublicClientFor(cfg);
    // URU-A06: on every publish, first sweep any prior pending / broadcast
    // rows. Recovers a tx that confirmed while the process was down.
    await reconcilePendingForConfig(cfg, pub, db);

    // Round-2 audit FINDING 1 AC #5: if the vault already carries a pending
    // proposal, we MUST NOT try to propose again (contract would revert with
    // `PendingEpochExists`). Instead:
    //   matured  → activate it in place and return the activation result
    //   immature → return early so the caller logs and waits this cycle out
    const pendingOnchain = (await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'pendingEpoch',
    })) as readonly [bigint, Hex, bigint, bigint];
    const [pExpectedId, , , pReadyAt] = pendingOnchain;
    if (pReadyAt !== 0n) {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (nowSec >= pReadyAt) {
        const activated = await _activatePendingProposal(cfg, pub, db, pendingOnchain);
        return { action: 'activated' as const, ...activated };
      }
      return {
        action: 'skipped-immature-proposal' as const,
        chainId: cfg.chainId,
        epochId: Number(pExpectedId),
        readyAt: Number(pReadyAt),
      };
    }

    // 1. Snapshot holders. Indexer preferred (fast); on-chain fallback covers
    //    the case where Ponder isn't indexing the gemu NFT yet. Also capture
    //    the head block so the journal row records the snapshot's provenance
    //    (FINDING 4 AC #2 — needed to reproduce a tree from raw state).
    const snapshotBlock = await pub.getBlockNumber();
    const holders = await _resolveFetchHolders(cfg, pub);
    if (holders.length === 0) {
      throw new Error('no gemu holders found in indexer OR on-chain — check NFT deployment');
    }

    // 2. Determine totalAmount from UNCOMMITTED funds only (URU-A07). The old
    //    default used the whole vault balance which reverted OverCommit as
    //    soon as any prior epoch still had unclaimed funds.
    const [vaultBalance, totalCommitted] = await Promise.all([
      pub.getBalance({ address: cfg.vaultAddress }),
      pub.readContract({ address: cfg.vaultAddress, abi: vaultAbi, functionName: 'totalCommitted' }),
    ]);
    const totalAmount = resolvePublishAmount(vaultBalance, totalCommitted, opts.totalAmountOverride);

    // 3. Fetch nextEpochId + timelock delay. If delay > 0 (production), use
    //    propose path; the caller / keeper runs `activateVaultEpoch` after
    //    maturation. If 0 (test / bootstrap), addEpoch directly.
    const [nextEpochId, minConfigDelay] = await Promise.all([
      pub.readContract({ address: cfg.vaultAddress, abi: vaultAbi, functionName: 'nextEpochId' }),
      pub.readContract({ address: cfg.vaultAddress, abi: vaultAbi, functionName: 'minConfigDelay' }),
    ]);

    // 4. Split + build tree keyed to `nextEpochId`. Leaf format is
    //    `keccak256(abi.encodePacked(holder, epochId, amount))`.
    const allocations = splitAllocations(holders, totalAmount);
    const { root, leaves } = buildTree(allocations, nextEpochId);

    // 5. URU-A06: persist journal + leaves BEFORE broadcasting. If the process
    //    dies after the tx confirms but before the rewards_epochs write,
    //    reconciliation picks up the pending row and promotes it.
    //
    //    Round-2 audit FINDING 1: if reconcile flipped a prior attempt at this
    //    epoch id to 'reverted', its row + leaves are cleaned first so the
    //    fresh INSERT succeeds without a PK conflict. Rows in any other status
    //    (pending/broadcast/confirmed/conflict) are left alone — the INSERT
    //    fails loudly in that case, which is what we want.
    await db.begin(async (tx: any) => {
      await tx`
        DELETE FROM app.rewards_leaves
        WHERE chain_id = ${cfg.chainId} AND epoch_id = ${Number(nextEpochId)}
          AND EXISTS (
            SELECT 1 FROM app.rewards_publications p
            WHERE p.chain_id = ${cfg.chainId}
              AND p.epoch_id = ${Number(nextEpochId)}
              AND p.status = 'reverted'
          )
      `;
      await tx`
        DELETE FROM app.rewards_publications
        WHERE chain_id = ${cfg.chainId}
          AND epoch_id = ${Number(nextEpochId)}
          AND status = 'reverted'
      `;
      await tx`
        INSERT INTO app.rewards_publications (
          chain_id, epoch_id, vault_addr, merkle_root, total_amount, holder_count, status,
          snapshot_block, expected_holder_count
        ) VALUES (
          ${cfg.chainId}, ${Number(nextEpochId)}, ${cfg.vaultAddress.toLowerCase()},
          ${root}, ${totalAmount.toString()}, ${leaves.length}, 'pending',
          ${snapshotBlock.toString()}, ${holders.length}
        )
      `;
      for (const l of leaves) {
        await tx`
          INSERT INTO app.rewards_leaves (chain_id, epoch_id, holder, amount, proof_json)
          VALUES (
            ${cfg.chainId}, ${Number(nextEpochId)}, ${l.holder.toLowerCase()},
            ${l.amount.toString()}, ${JSON.stringify(l.proof)}::jsonb
          )
          ON CONFLICT (chain_id, epoch_id, holder) DO UPDATE SET
            amount = EXCLUDED.amount,
            proof_json = EXCLUDED.proof_json
        `;
      }
    });

    // 6. Broadcast. Route depends on the vault's real timelock config.
    const { wallet, account } = _resolveWalletClientFor(cfg);
    const isProposal = minConfigDelay > 0n;
    const data = isProposal
      ? encodeFunctionData({
        abi: vaultAbi,
        functionName: 'proposeEpoch',
        args: [nextEpochId, root, totalAmount],
      })
      : encodeFunctionData({
        abi: vaultAbi,
        functionName: 'addEpoch',
        args: [nextEpochId, root, totalAmount],
      });
    const txHash = await wallet.sendTransaction({
      account,
      to: cfg.vaultAddress,
      data,
      chain: wallet.chain,
    });
    await db`
      UPDATE app.rewards_publications
      SET status = 'broadcast', tx_hash = ${txHash}, updated_at = now()
      WHERE chain_id = ${cfg.chainId} AND epoch_id = ${Number(nextEpochId)}
    `;
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`${isProposal ? 'proposeEpoch' : 'addEpoch'} tx reverted: ${txHash}`);
    }
    await db`
      UPDATE app.rewards_publications
      SET block_number = ${receipt.blockNumber.toString()}, updated_at = now()
      WHERE chain_id = ${cfg.chainId} AND epoch_id = ${Number(nextEpochId)}
    `;

    // For the proposal path, the epoch isn't LIVE yet — activation happens
    // later via `activateVaultEpoch`. But the journal + leaves are already
    // persisted so `reconcilePending` can promote it once activated on-chain.
    // We DO NOT write rewards_epochs here for proposals; that happens on
    // activation reconciliation. The publication row stays 'broadcast' until
    // then.
    if (!isProposal) {
      await finalizePublication(db, cfg, {
        epoch_id: Number(nextEpochId),
        merkle_root: root,
        total_amount: totalAmount.toString(),
        holder_count: leaves.length,
        tx_hash: txHash,
        block_number: receipt.blockNumber.toString(),
      });
    }

    return {
      action: 'published' as const,
      chainId: cfg.chainId,
      epochId: Number(nextEpochId),
      merkleRoot: root,
      totalAmount: totalAmount.toString(),
      holderCount: leaves.length,
      txHash,
      blockNumber: receipt.blockNumber.toString(),
    };
  });
}

/// Round-6 audit H3: thrown by `_activatePendingProposal` when the local
/// journal row for the on-chain pending proposal is missing, in the wrong
/// status, or disagrees with the on-chain root / total. Exported so callers
/// (keeper loop, tests, ops tooling) can distinguish this fail-closed refusal
/// from a genuine tx failure without string-matching. Carries `reason` in
/// `.reason` so log lines can key on the specific mismatch.
export class EpochActivationJournalMismatch extends Error {
  readonly reason: string;
  readonly epochId: number;
  constructor(epochId: number, reason: string) {
    super(`refusing to activate epoch ${epochId}: ${reason}`);
    this.name = 'EpochActivationJournalMismatch';
    this.reason = reason;
    this.epochId = epochId;
  }
}

/// Round-2 audit FINDING 1: shared activation core. Called by `publishEpoch`
/// (when its opening reconcile finds a matured proposal) and by the keeper's
/// activation loop. Assumes the caller has already read `pendingEpoch()` and
/// confirmed maturity.
///
/// Round-6 audit H3: fail-closed against the local proof journal. Before
/// signing `activateEpoch()` we REQUIRE a journal row for (chainId, epochId)
/// whose status is 'broadcast' AND whose merkle_root + total_amount match the
/// on-chain pending values byte-for-byte. If any check fails we throw
/// `EpochActivationJournalMismatch` and never send a tx — an operator must
/// investigate before we activate a proposal we don't have the proofs for.
/// Prior behaviour tolerated a missing row (proposal was activated first,
/// journal row filled in after), which meant the keeper would happily
/// activate an out-of-band root and then find it had no proofs to serve.
///
/// After a successful activation we UPDATE the journal row's
/// `activation_tx_hash` column so the activation tx is final provenance —
/// prior code only carried the propose tx hash.
async function _activatePendingProposal(
  cfg: ChainConfig,
  pub: PublicClient,
  db: ReservedDb,
  pending: readonly [bigint, Hex, bigint, bigint],
): Promise<PublishResult> {
  const [expectedEpochId, pRoot, pTotal /* readyAt is checked by caller */] = pending;
  const epochIdNum = Number(expectedEpochId);

  // Round-6 audit H3: load + validate the journal row BEFORE signing.
  const rowsPre = (await db`
    SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash, block_number::text, status
    FROM app.rewards_publications
    WHERE chain_id = ${cfg.chainId} AND epoch_id = ${epochIdNum}
  `) as Array<{
    epoch_id: number;
    merkle_root: string;
    total_amount: string;
    holder_count: number;
    tx_hash: string | null;
    block_number: string | null;
    status: 'pending' | 'broadcast' | 'confirmed' | 'conflict' | 'reverted';
  }>;
  const journalRow = rowsPre[0];
  if (!journalRow) {
    throw new EpochActivationJournalMismatch(
      epochIdNum,
      'no journal row for on-chain pending proposal',
    );
  }
  if (journalRow.status !== 'broadcast') {
    throw new EpochActivationJournalMismatch(
      epochIdNum,
      `journal row status is "${journalRow.status}", expected "broadcast"`,
    );
  }
  if (journalRow.merkle_root.toLowerCase() !== pRoot.toLowerCase()) {
    throw new EpochActivationJournalMismatch(
      epochIdNum,
      `merkle_root mismatch: journal=${journalRow.merkle_root}, onchain=${pRoot}`,
    );
  }
  if (journalRow.total_amount !== pTotal.toString()) {
    throw new EpochActivationJournalMismatch(
      epochIdNum,
      `total_amount mismatch: journal=${journalRow.total_amount}, onchain=${pTotal.toString()}`,
    );
  }

  const { wallet, account } = _resolveWalletClientFor(cfg);
  const data = encodeFunctionData({ abi: vaultAbi, functionName: 'activateEpoch', args: [] });
  const txHash = await wallet.sendTransaction({
    account,
    to: cfg.vaultAddress,
    data,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`activateEpoch tx reverted: ${txHash}`);

  // Promote the journal row (its status was 'broadcast' after proposeEpoch)
  // and record the activation tx hash as final provenance (H3 AC #4).
  await finalizePublication(db, cfg, journalRow);
  await db`
    UPDATE app.rewards_publications
    SET activation_tx_hash = ${txHash}, updated_at = now()
    WHERE chain_id = ${cfg.chainId} AND epoch_id = ${epochIdNum}
  `;

  return {
    chainId: cfg.chainId,
    epochId: epochIdNum,
    merkleRoot: pRoot,
    totalAmount: pTotal.toString(),
    holderCount: journalRow.holder_count,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

/// URU-A11 tangent: activate a matured pending epoch. Called by the keeper
/// activation loop / operator after the vault's `minConfigDelay` elapses.
/// Idempotent — no pending epoch is treated as a no-op (returns null) rather
/// than a thrown error so a scheduled loop can call this cheaply every cycle.
export async function activateVaultEpoch(chainSlug: string): Promise<{
  epochId: number;
  txHash: Hex | null;
} | null> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg) throw new Error(`chain "${chainSlug}" not configured for flywheel`);
  const activeSql = _resolveSql();
  if (!activeSql) throw new Error('DATABASE_URL not set — cannot persist tree');

  return withPublicationLockOn(activeSql, async (db) => {
    const pub = _resolvePublicClientFor(cfg);
    const pending = (await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'pendingEpoch',
    })) as readonly [bigint, Hex, bigint, bigint];
    const [expectedEpochId, , , readyAt] = pending;
    if (readyAt === 0n) return null;
    if (BigInt(Math.floor(Date.now() / 1000)) < readyAt) return null;
    const result = await _activatePendingProposal(cfg, pub, db, pending);
    return { epochId: Number(expectedEpochId), txHash: result.txHash };
  });
}

/// URU-A06 reconciliation. Runs on startup + at the top of every `publishEpoch`
/// call so a tx that confirmed while the process was down (or after a race)
/// gets its journal row promoted rather than staying stuck as 'pending'.
///
/// Exported so the audit tests can drive each crash scenario with a fake db +
/// fake public client. Production callers reach it via `publishEpoch` /
/// `reconcilePendingPublications` and never pass their own deps.
///
/// Round-2 audit FINDING 1: `broadcast` rows are no longer treated the same as
/// `pending` rows. A broadcast row means a tx has been sent on-chain; the
/// on-chain state (`epochs[id]` + `pendingEpoch()`) is the source of truth for
/// what happened. Four terminal states are modelled:
///   A. our root is live in `epochs[id]`        → finalize to 'confirmed'
///   B. a different root landed in `epochs[id]` → flag 'conflict' (throws)
///   C. `pendingEpoch()` still holds our root   → log + return (do not throw)
///   D. no on-chain match anywhere              → flip to 'reverted', clear leaves
export async function reconcilePendingForConfig(
  cfg: ChainConfig,
  pub: PublicClient,
  db: ReservedDb,
): Promise<void> {
  const pending = (await db`
    SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash,
           block_number::text, created_at, status
    FROM app.rewards_publications
    WHERE chain_id = ${cfg.chainId} AND status IN ('pending', 'broadcast')
    ORDER BY epoch_id
  `) as Array<{
    epoch_id: number;
    merkle_root: string;
    total_amount: string;
    holder_count: number;
    tx_hash: string | null;
    block_number: string | null;
    created_at: Date;
    status: 'pending' | 'broadcast';
  }>;
  const ZERO_ROOT = '0x' + '00'.repeat(32);
  for (const row of pending) {
    const onchain = (await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'epochs',
      args: [BigInt(row.epoch_id)],
    })) as readonly [Hex, bigint, bigint];
    const [root, total] = onchain;
    // Case A: our root is live on-chain — either addEpoch confirmed, or a
    // proposal already got activated. Finalize the journal row (Round-2
    // audit FINDING 1 AC #3).
    if (
      root.toLowerCase() === row.merkle_root.toLowerCase()
      && total.toString() === row.total_amount
    ) {
      await finalizePublication(db, cfg, row);
      continue;
    }
    // Case B: something non-zero landed at this epoch id but doesn't match
    // us — either a different root, OR our root with a different total. Both
    // are conflicts: we cannot serve proofs against a tree we didn't build.
    // Leaves are DELIBERATELY preserved (Round-6 audit H3 AC #2) so the row
    // stands as forensic evidence of what we intended vs. what landed.
    if (root.toLowerCase() !== ZERO_ROOT) {
      const rootMatches = root.toLowerCase() === row.merkle_root.toLowerCase();
      const reason = rootMatches
        ? `total mismatch: journal=${row.total_amount}, onchain=${total.toString()}`
        : `root mismatch: journal=${row.merkle_root}, onchain=${root}`;
      console.log(
        JSON.stringify({
          rewards: 'reconcile',
          epochId: row.epoch_id,
          state: 'conflict',
          reason,
        }),
      );
      await db`
        UPDATE app.rewards_publications
        SET status = 'conflict', updated_at = now()
        WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}
      `;
      throw new Error(`reward publication conflict at epoch ${row.epoch_id}: ${reason}`);
    }
    // Case C: no on-chain epoch at this id. Interpretation depends on the
    // journal-row status.
    if (row.status === 'pending') {
      // Never-broadcast row (insert-then-crash). If tx_hash is null, the
      // broadcast never happened — nothing on-chain to reconcile against, so
      // we can safely drop the row. We hold `pg_advisory_lock` here and every
      // publish path takes the same lock, so no concurrent publisher can be
      // mid-flight with this same epoch id. Only rows that DID reach broadcast
      // (tx_hash set) get the throw-guard.
      //
      // Previously required both "30 min stale" AND "no tx_hash", which meant
      // any crash inside publishEpoch stuck the boot loop for half an hour.
      // The tx_hash check alone is the real safety signal.
      if (!row.tx_hash) {
        await db.begin(async (tx: any) => {
          await tx`DELETE FROM app.rewards_leaves WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}`;
          await tx`DELETE FROM app.rewards_publications WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}`;
        });
      } else {
        throw new Error(`reward publication ${row.epoch_id} is already pending`);
      }
      continue;
    }
    // row.status === 'broadcast': a propose tx confirmed but the epoch isn't
    // activated yet. Consult on-chain `pendingEpoch()` to decide whether it's
    // still legitimately pending or has been dropped / replaced.
    //
    // Round-2 audit FINDING 1 AC #1 + AC #2 + AC #3 all live in this branch:
    // MUST NOT throw for a live-but-immature proposal, MUST flip to 'reverted'
    // when the on-chain pending is gone / mismatched, and MUST promote to
    // 'confirmed' when activation moved past us (already handled above via
    // Case A: activated proposals land in `epochs[id]`).
    const pendingOnchain = (await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'pendingEpoch',
    })) as readonly [bigint, Hex, bigint, bigint];
    const [pExpectedId, pRoot, , pReadyAt] = pendingOnchain;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const isOurs =
      pReadyAt !== 0n
      && Number(pExpectedId) === row.epoch_id
      && pRoot.toLowerCase() === row.merkle_root.toLowerCase();
    if (isOurs) {
      // Legitimate on-chain pending — the activation loop / next publish tick
      // will activate it when it matures. Log + continue, do NOT throw.
      const matured = nowSec >= pReadyAt;
      console.log(
        JSON.stringify({
          rewards: 'reconcile',
          epochId: row.epoch_id,
          state: matured ? 'proposal-matured-awaiting-activation' : 'proposal-immature',
          readyAt: Number(pReadyAt),
          nowSec: Number(nowSec),
        }),
      );
      continue;
    }
    // No matching on-chain pending — our propose was cancelled, dropped, or a
    // different proposal took its slot. Flip to 'reverted' and clear the
    // leaves; the next publish tick will insert a fresh attempt at this
    // epoch id (Round-2 audit FINDING 1 AC #2).
    console.log(
      JSON.stringify({
        rewards: 'reconcile',
        epochId: row.epoch_id,
        state: 'proposal-orphaned',
        pendingOnchainRoot: pRoot,
        pendingReadyAt: Number(pReadyAt),
      }),
    );
    await db.begin(async (tx: any) => {
      await tx`
        UPDATE app.rewards_publications
        SET status = 'reverted', updated_at = now()
        WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}
      `;
      await tx`DELETE FROM app.rewards_leaves WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}`;
    });
  }
}

/// Exported for `server.ts` startup — walks any pending / broadcast rows and
/// either promotes them (if the on-chain state matches) or flags conflict.
export async function reconcilePendingPublications(): Promise<void> {
  const cfg = chainConfigFor('robinhood');
  if (!cfg || !sql) return;
  await withPublicationLock(async (db) => {
    await reconcilePendingForConfig(cfg, publicClientFor(cfg), db);
  });
}

// ---------------------------------------------------------------- read helpers (routes)

export async function vaultSummary(chainSlug: string): Promise<{
  chainId: number;
  vaultAddress: Address;
  vaultBalance: string;
  nextEpochId: number;
  publishedEpochs: number;
} | null> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg) return null;
  const pub = publicClientFor(cfg);
  const [balance, nextEpochId] = await Promise.all([
    pub.getBalance({ address: cfg.vaultAddress }),
    pub.readContract({ address: cfg.vaultAddress, abi: vaultAbi, functionName: 'nextEpochId' }),
  ]);
  let publishedEpochs = 0;
  if (sql) {
    // Filter by vault_addr so a vault rotation (V8 -> V9 etc.) doesn't
    // surface epochs published against the old vault. Every insert path
    // writes vault_addr = cfg.vaultAddress.toLowerCase() (see rewards.ts
    // line 565 / 700) so the equality here is exact.
    const row = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM app.rewards_epochs
      WHERE chain_id = ${cfg.chainId} AND vault_addr = ${cfg.vaultAddress.toLowerCase()}
    `;
    publishedEpochs = Number(row[0]?.n ?? 0);
  }
  return {
    chainId: cfg.chainId,
    vaultAddress: cfg.vaultAddress,
    vaultBalance: balance.toString(),
    nextEpochId: Number(nextEpochId),
    publishedEpochs,
  };
}

/// Coerce a proof column to a real Hex[]. Postgres.js normally parses jsonb
/// into a JS value automatically, but depending on how the row was inserted
/// (raw SQL vs template literal) the column can occasionally round-trip as a
/// JSON-encoded string — that leaks through to the client as
/// `"[\"0x…\",\"0x…\"]"` and wagmi's writeContract rejects it with "not a
/// valid array". Always normalize here.
function normalizeProof(raw: Hex[] | string | unknown): Hex[] {
  if (Array.isArray(raw)) return raw as Hex[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as Hex[];
    } catch {
      /* fall through */
    }
  }
  return [];
}

export async function proofFor(
  chainSlug: string,
  epochId: number,
  address: Address,
): Promise<{ amount: string; proof: Hex[] } | null> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg || !sql) return null;
  // JOIN through rewards_epochs so we only serve proofs whose epoch was
  // published against the CURRENT vault. Without this filter, a rotation
  // (V8 -> V9 etc.) leaves stale leaves visible to the claim UI even though
  // the new vault has no matching Merkle root -- the claim tx would then
  // revert on chain.
  const rows = await sql<Array<{ amount: string; proof_json: Hex[] | string }>>`
    SELECT l.amount, l.proof_json
    FROM app.rewards_leaves l
    JOIN app.rewards_epochs e
      ON e.chain_id = l.chain_id AND e.epoch_id = l.epoch_id
    WHERE l.chain_id = ${cfg.chainId}
      AND l.epoch_id = ${epochId}
      AND l.holder = ${address.toLowerCase()}
      AND e.vault_addr = ${cfg.vaultAddress.toLowerCase()}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { amount: row.amount, proof: normalizeProof(row.proof_json) };
}

/// All epochs a wallet has ANY allocation in (whether or not claimed on-chain).
/// The frontend cross-checks against `vault.isClaimed(epoch, holder)` to render
/// claim vs. done state.
export async function epochsForHolder(
  chainSlug: string,
  address: Address,
): Promise<Array<{ epochId: number; amount: string; proof: Hex[] }>> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg || !sql) return [];
  // Same JOIN as proofFor -- only serve leaves whose epoch was published
  // against the CURRENT vault. Prevents ghost-rewards from an old vault
  // showing up on the profile page after a NftRevenueVault rotation.
  const rows = await sql<Array<{ epoch_id: number; amount: string; proof_json: Hex[] | string }>>`
    SELECT l.epoch_id, l.amount, l.proof_json
    FROM app.rewards_leaves l
    JOIN app.rewards_epochs e
      ON e.chain_id = l.chain_id AND e.epoch_id = l.epoch_id
    WHERE l.chain_id = ${cfg.chainId}
      AND l.holder = ${address.toLowerCase()}
      AND e.vault_addr = ${cfg.vaultAddress.toLowerCase()}
    ORDER BY l.epoch_id DESC
  `;
  return rows.map((r) => ({ epochId: r.epoch_id, amount: r.amount, proof: normalizeProof(r.proof_json) }));
}
