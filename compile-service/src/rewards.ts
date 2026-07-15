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
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { sql, hasDb } from './db.ts';

// ---------------------------------------------------------------- config

interface ChainConfig {
  slug: 'base'; // extend when other chains get a flywheel deploy
  chainId: number;
  rpcUrl: string;
  vaultAddress: Address;
  gemuNftAddress: Address;
}

/// Only `base` is wired today. Add other slugs here as the flywheel lands on new
/// chains — the frontend picks the chain from the URL path so no other change is
/// needed to serve proofs for a new chain.
function chainConfigFor(slug: string): ChainConfig | null {
  if (slug !== 'base') return null;
  const rpcUrl = process.env.BASE_RPC_URL;
  const vaultAddress = process.env.BASE_NFT_REVENUE_VAULT_ADDRESS as Address | undefined;
  const gemuNftAddress = process.env.GEMU_NFT_ADDRESS as Address | undefined;
  if (!rpcUrl || !vaultAddress || !gemuNftAddress) return null;
  return { slug: 'base', chainId: 8453, rpcUrl, vaultAddress, gemuNftAddress };
}

/// Ponder GraphQL endpoint — same URL the frontend uses, wired via env because
/// compile-service and indexer share the same Railway project.
const INDEXER_URL = process.env.INDEXER_URL ?? process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';

// ---------------------------------------------------------------- ABI

const vaultAbi = parseAbi([
  'function nextEpochId() view returns (uint256)',
  'function addEpoch(bytes32 merkleRoot, uint256 totalAmount)',
]);

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

async function fetchGemuHolders(cfg: ChainConfig): Promise<Holder[]> {
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

/// End-to-end publish. Reads holders, computes split, builds tree, broadcasts
/// addEpoch, waits for receipt, persists both the epoch row and all leaves.
/// Throws if any step fails — the caller should surface the error message.
///
/// `totalAmountOverride` is optional. When omitted, the whole current vault
/// balance is drained into this epoch. Provide a smaller amount to reserve some
/// balance for a future epoch.
export async function publishEpoch(opts: {
  chainSlug: string;
  totalAmountOverride?: bigint;
}): Promise<PublishResult> {
  const cfg = chainConfigFor(opts.chainSlug);
  if (!cfg) throw new Error(`chain "${opts.chainSlug}" not configured for flywheel`);
  if (!hasDb() || !sql) throw new Error('DATABASE_URL not set — cannot persist tree');

  const pub = publicClientFor(cfg);

  // 1. Snapshot holders from the indexer.
  const holders = await fetchGemuHolders(cfg);
  if (holders.length === 0) throw new Error('no gemu holders in indexer — is it caught up?');

  // 2. Determine totalAmount. Default: current vault balance.
  const vaultBalance = await pub.getBalance({ address: cfg.vaultAddress });
  const totalAmount = opts.totalAmountOverride ?? vaultBalance;
  if (totalAmount === 0n) throw new Error('vault balance is zero — nothing to distribute');
  if (totalAmount > vaultBalance) {
    throw new Error(`totalAmount (${formatEther(totalAmount)}) exceeds vault balance (${formatEther(vaultBalance)})`);
  }

  // 3. Fetch the next epoch id on-chain so leaf hashes match what the vault
  //    increments to. If we build the tree with the wrong epochId, verify fails.
  const nextEpochId = await pub.readContract({
    address: cfg.vaultAddress,
    abi: vaultAbi,
    functionName: 'nextEpochId',
  });

  // 4. Split + build tree.
  const allocations = splitAllocations(holders, totalAmount);
  const { root, leaves } = buildTree(allocations, nextEpochId);

  // 5. Broadcast addEpoch.
  const { wallet, account } = walletClientFor(cfg);
  const data = encodeFunctionData({ abi: vaultAbi, functionName: 'addEpoch', args: [root, totalAmount] });
  const txHash = await wallet.sendTransaction({
    account,
    to: cfg.vaultAddress,
    data,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`addEpoch tx reverted: ${txHash}`);

  // 6. Persist epoch + leaves. Transactional so a mid-write failure doesn't leave
  //    a half-published epoch that the frontend queries against.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO app.rewards_epochs (
        chain_id, epoch_id, vault_addr, merkle_root, total_amount, tx_hash, block_number, holder_count
      ) VALUES (
        ${cfg.chainId}, ${Number(nextEpochId)}, ${cfg.vaultAddress.toLowerCase()},
        ${root}, ${totalAmount.toString()}, ${txHash}, ${receipt.blockNumber.toString()},
        ${leaves.length}
      )
      ON CONFLICT (chain_id, epoch_id) DO NOTHING
    `;
    // Batch insert leaves. postgres.js unnest() would be faster for huge trees;
    // gemu NFT is capped small so per-row inserts are fine.
    for (const l of leaves) {
      await tx`
        INSERT INTO app.rewards_leaves (chain_id, epoch_id, holder, amount, proof_json)
        VALUES (
          ${cfg.chainId}, ${Number(nextEpochId)}, ${l.holder.toLowerCase()},
          ${l.amount.toString()}, ${JSON.stringify(l.proof)}::jsonb
        )
        ON CONFLICT (chain_id, epoch_id, holder) DO NOTHING
      `;
    }
  });

  return {
    chainId: cfg.chainId,
    epochId: Number(nextEpochId),
    merkleRoot: root,
    totalAmount: totalAmount.toString(),
    holderCount: leaves.length,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
  };
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

export async function proofFor(
  chainSlug: string,
  epochId: number,
  address: Address,
): Promise<{ amount: string; proof: Hex[] } | null> {
  const cfg = chainConfigFor(chainSlug);
  if (!cfg || !sql) return null;
  const rows = await sql<Array<{ amount: string; proof_json: Hex[] }>>`
    SELECT amount, proof_json FROM app.rewards_leaves
    WHERE chain_id = ${cfg.chainId}
      AND epoch_id = ${epochId}
      AND holder = ${address.toLowerCase()}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { amount: row.amount, proof: row.proof_json };
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
  const rows = await sql<Array<{ epoch_id: number; amount: string; proof_json: Hex[] }>>`
    SELECT epoch_id, amount, proof_json FROM app.rewards_leaves
    WHERE chain_id = ${cfg.chainId} AND holder = ${address.toLowerCase()}
    ORDER BY epoch_id DESC
  `;
  return rows.map((r) => ({ epochId: r.epoch_id, amount: r.amount, proof: r.proof_json }));
}
