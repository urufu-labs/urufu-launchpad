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
import { privateKeyToAccount } from 'viem/accounts';

import { sql, hasDb } from './db.ts';

// ---------------------------------------------------------------- config

export interface ChainConfig {
  slug: 'robinhood';
  chainId: number;
  rpcUrl: string;
  vaultAddress: Address;
  gemuNftAddress: Address;
}

/// urufu gemu NFT lives ONLY on Robinhood as of 2026-07 - the Base collection
/// was retired during the RH migration. If the keeper ever needs to publish
/// epochs on another chain, add its slug + env-var block here and widen the
/// union above. Missing env vars → returns null (route responds 501).
function chainConfigFor(slug: string): ChainConfig | null {
  if (slug !== 'robinhood') return null;
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const vaultAddress = process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS as Address | undefined;
  // Deliberately no fallback to bare GEMU_NFT_ADDRESS — that env var still
  // holds the retired Base collection for reference, and silently reading it
  // here would ship a Base address to a Robinhood-chain RPC call and return
  // zero holders → publishEpoch would credit no one. Fail loud instead.
  const gemuNftAddress = process.env.ROBINHOOD_GEMU_NFT_ADDRESS as Address | undefined;
  if (!rpcUrl || !vaultAddress || !gemuNftAddress) return null;
  return { slug: 'robinhood', chainId: 4663, rpcUrl, vaultAddress, gemuNftAddress };
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
function walletClientFor(cfg: ChainConfig): { wallet: WalletClient; account: Address } {
  const rawKey = process.env.KEEPER_PRIVATE_KEY;
  if (!rawKey) throw new Error('KEEPER_PRIVATE_KEY not set on compile-service');
  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    transport: http(cfg.rpcUrl),
    chain: { id: cfg.chainId, name: cfg.slug, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } },
  });
  return { wallet, account: account.address };
}

// ---------------------------------------------------------------- snapshot query

/// Read all current gemu NFT holders (balance > 0) from the indexer. Uses Ponder's
/// GraphQL — same source the frontend hits. Returns lowercase-normalized addresses
/// so downstream Merkle-tree hashing is deterministic.
interface Holder {
  address: Address;
  balance: bigint; // NFT count
}

async function fetchGemuHoldersFromIndexer(cfg: ChainConfig): Promise<Holder[]> {
  const query = `
    query GemuHolders($chainId: Int!, $token: String!) {
      holderss(
        where: { chainId: $chainId, tokenAddress: $token }
        limit: 5000
      ) {
        items { holderAddress balance }
      }
    }
  `;
  const res = await fetch(`${INDEXER_URL.replace(/\/$/, '')}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { chainId: cfg.chainId, token: cfg.gemuNftAddress.toLowerCase() },
    }),
  });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const json = (await res.json()) as {
    data?: { holderss: { items: Array<{ holderAddress: string; balance: string }> } };
    errors?: unknown;
  };
  if (json.errors) throw new Error(`indexer errors: ${JSON.stringify(json.errors)}`);
  const items = json.data?.holderss.items ?? [];
  return items
    .map((row) => ({
      address: row.holderAddress.toLowerCase() as Address,
      balance: BigInt(row.balance),
    }))
    .filter((h) => h.balance > 0n);
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
  try {
    const fromIndexer = await fetchGemuHoldersFromIndexer(cfg);
    if (fromIndexer.length > 0) {
      console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', count: fromIndexer.length }));
      return fromIndexer;
    }
    console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', count: 0, fallback: 'chain' }));
  } catch (err) {
    console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'indexer', error: (err as Error).message, fallback: 'chain' }));
  }
  const fromChain = await fetchGemuHoldersFromChain(cfg, pub);
  console.log(JSON.stringify({ rewards: 'fetchHolders', source: 'chain', count: fromChain.length }));
  return fromChain;
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
/// `totalAmountOverride` is optional. When omitted, uses UNCOMMITTED balance
/// only (URU-A07: `balance - totalCommitted`), not the whole vault balance.
export async function publishEpoch(opts: {
  chainSlug: string;
  totalAmountOverride?: bigint;
}): Promise<PublishResult> {
  const cfg = chainConfigFor(opts.chainSlug);
  if (!cfg) throw new Error(`chain "${opts.chainSlug}" not configured for flywheel`);
  if (!hasDb() || !sql) throw new Error('DATABASE_URL not set — cannot persist tree');

  return withPublicationLock(async (db) => {
    const pub = publicClientFor(cfg);
    // URU-A06: on every publish, first sweep any prior pending / broadcast
    // rows. Recovers a tx that confirmed while the process was down.
    await reconcilePendingForConfig(cfg, pub, db);

    // 1. Snapshot holders. Indexer preferred (fast); on-chain fallback covers
    //    the case where Ponder isn't indexing the gemu NFT yet.
    const holders = await fetchGemuHolders(cfg, pub);
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
    await db.begin(async (tx: any) => {
      await tx`
        INSERT INTO app.rewards_publications (
          chain_id, epoch_id, vault_addr, merkle_root, total_amount, holder_count, status
        ) VALUES (
          ${cfg.chainId}, ${Number(nextEpochId)}, ${cfg.vaultAddress.toLowerCase()},
          ${root}, ${totalAmount.toString()}, ${leaves.length}, 'pending'
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
    const { wallet, account } = walletClientFor(cfg);
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

/// URU-A11 tangent: activate a matured pending epoch. Called by the keeper /
/// operator after the vault's `minConfigDelay` elapses. Idempotent — if the
/// pending epoch's expected ID matches the vault's `nextEpochId - 1` (i.e.
/// already activated), returns without writing.
export async function activateVaultEpoch(chainSlug: string): Promise<{
  epochId: number;
  txHash: Hex | null;
}> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg) throw new Error(`chain "${chainSlug}" not configured for flywheel`);
  if (!hasDb() || !sql) throw new Error('DATABASE_URL not set — cannot persist tree');

  return withPublicationLock(async (db) => {
    const pub = publicClientFor(cfg);
    const pending = await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'pendingEpoch',
    });
    const [expectedEpochId, , , readyAt] = pending;
    if (readyAt === 0n) throw new Error('no pending epoch to activate');
    if (BigInt(Math.floor(Date.now() / 1000)) < readyAt) {
      throw new Error(`pending epoch not yet ready — matures at ${readyAt}`);
    }
    const { wallet, account } = walletClientFor(cfg);
    const data = encodeFunctionData({ abi: vaultAbi, functionName: 'activateEpoch', args: [] });
    const txHash = await wallet.sendTransaction({
      account,
      to: cfg.vaultAddress,
      data,
      chain: wallet.chain,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`activateEpoch tx reverted: ${txHash}`);

    // Promote the journal row (its status was 'broadcast' after proposeEpoch).
    const row = (await db`
      SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash, block_number::text
      FROM app.rewards_publications
      WHERE chain_id = ${cfg.chainId} AND epoch_id = ${Number(expectedEpochId)}
    `) as Array<{
      epoch_id: number;
      merkle_root: string;
      total_amount: string;
      holder_count: number;
      tx_hash: string | null;
      block_number: string | null;
    }>;
    if (row[0]) await finalizePublication(db, cfg, row[0]);

    return { epochId: Number(expectedEpochId), txHash };
  });
}

/// URU-A06 reconciliation. Runs on startup + at the top of every `publishEpoch`
/// call so a tx that confirmed while the process was down (or after a race)
/// gets its journal row promoted rather than staying stuck as 'pending'.
///
/// Exported so the audit tests can drive each crash scenario with a fake db +
/// fake public client. Production callers reach it via `publishEpoch` /
/// `reconcilePendingPublications` and never pass their own deps.
export async function reconcilePendingForConfig(
  cfg: ChainConfig,
  pub: PublicClient,
  db: ReservedDb,
): Promise<void> {
  const pending = (await db`
    SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash,
           block_number::text, created_at
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
  }>;
  for (const row of pending) {
    const onchain = await pub.readContract({
      address: cfg.vaultAddress,
      abi: vaultAbi,
      functionName: 'epochs',
      args: [BigInt(row.epoch_id)],
    });
    const [root, total] = onchain;
    if (
      root.toLowerCase() === row.merkle_root.toLowerCase()
      && total.toString() === row.total_amount
    ) {
      await finalizePublication(db, cfg, row);
      continue;
    }
    if (root !== ('0x' + '00'.repeat(32))) {
      // On-chain landed a DIFFERENT root at this epoch id. Someone else
      // published first — our journal is stale. Mark conflict; requires
      // manual resolution.
      await db`
        UPDATE app.rewards_publications
        SET status = 'conflict', updated_at = now()
        WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}
      `;
      throw new Error(`reward publication conflict at epoch ${row.epoch_id}`);
    }
    // Stale pending with no on-chain landing after 30 min → assume the tx was
    // dropped / never sent (crash between insert and broadcast). Delete the
    // row so a fresh publish can retry.
    if (Date.now() - new Date(row.created_at).getTime() > 30 * 60 * 1000 && !row.tx_hash) {
      await db.begin(async (tx: any) => {
        await tx`DELETE FROM app.rewards_leaves WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}`;
        await tx`DELETE FROM app.rewards_publications WHERE chain_id = ${cfg.chainId} AND epoch_id = ${row.epoch_id}`;
      });
    } else {
      throw new Error(`reward publication ${row.epoch_id} is already pending`);
    }
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
    const row = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM app.rewards_epochs WHERE chain_id = ${cfg.chainId}
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
  const rows = await sql<Array<{ amount: string; proof_json: Hex[] | string }>>`
    SELECT amount, proof_json FROM app.rewards_leaves
    WHERE chain_id = ${cfg.chainId}
      AND epoch_id = ${epochId}
      AND holder = ${address.toLowerCase()}
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
  const rows = await sql<Array<{ epoch_id: number; amount: string; proof_json: Hex[] | string }>>`
    SELECT epoch_id, amount, proof_json FROM app.rewards_leaves
    WHERE chain_id = ${cfg.chainId} AND holder = ${address.toLowerCase()}
    ORDER BY epoch_id DESC
  `;
  return rows.map((r) => ({ epochId: r.epoch_id, amount: r.amount, proof: normalizeProof(r.proof_json) }));
}
