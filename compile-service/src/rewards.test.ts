/// URU-A06 AC #4 + URU-A07 AC #4 coverage for the rewards publisher.
///
/// URU-A06 crash-recovery scenarios (`reconcilePendingForConfig`):
///   1. crash BEFORE broadcast (fresh row) — must stay pending, retry-able
///   2. crash BEFORE broadcast (stale row) — must be discarded cleanly
///   3. crash AFTER broadcast, tx landed — must promote to `confirmed`
///   4. crash AFTER broadcast, wrong epoch id landed — must flag `conflict`
///   5. advisory-lock contention — two concurrent `withPublicationLockOn`
///      calls must be serialized without corrupting the journal
///
/// URU-A07 partial-claim + override cases (`resolvePublishAmount`):
///   1. fully unclaimed prior epoch — publisher gets only the uncommitted slice
///   2. partially claimed prior epoch — reserves the unclaimed remainder only
///   3. zero available — publisher must refuse
///   4. explicit override above available — publisher must refuse
///
/// Round-2 audit FINDING 1 (proposal-path wedge) additions:
///   6. broadcast row + on-chain matured pending — reconcile logs, doesn't throw
///   7. broadcast row + on-chain immature pending — reconcile logs, doesn't throw
///   8. broadcast row + no matching on-chain pending — reconcile flips to 'reverted'
///      + clears leaves + doesn't throw
///
/// Round-2 audit FINDING 4 (silent 5000-holder cap) additions:
///   9. paginator exhausts a multi-page indexer response
///  10. paginator stops on a short (partial) page
///  11. paginator throws IndexerHolderCountExceedsCap past the sanity ceiling
///
/// Runs under Node's built-in `node:test` runner, matching the pattern in
/// `config-id.test.ts`. Uses a minimal in-memory fake `sql` + fake viem
/// public client rather than a real Postgres / RPC — the reconcile logic is
/// pure orchestration around SQL + a few `readContract(...)` calls, so the
/// fakes cover it without dragging a docker container into CI.

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';

import {
  EpochActivationJournalMismatch,
  IndexerHolderCountExceedsCap,
  _withTestOverrides,
  activateVaultEpoch,
  fetchGemuHoldersFromIndexer,
  publishEpoch,
  reconcilePendingForConfig,
  resolvePublishAmount,
  withPublicationLockOn,
  type ChainConfig,
  type Holder,
} from './rewards.ts';

const ZERO_ROOT = ('0x' + '00'.repeat(32)) as `0x${string}`;
const ROOT_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const ROOT_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

const CFG: ChainConfig = {
  slug: 'robinhood',
  chainId: 4663,
  rpcUrl: 'http://ignored',
  vaultAddress: '0x0000000000000000000000000000000000000042',
  gemuNftAddress: '0x0000000000000000000000000000000000000024',
};

// ---------------------------------------------------------------- fake state

interface PubRow {
  chain_id: number;
  epoch_id: number;
  vault_addr: string;
  merkle_root: string;
  total_amount: string;
  holder_count: number;
  status: 'pending' | 'broadcast' | 'confirmed' | 'conflict' | 'reverted';
  tx_hash: string | null;
  block_number: string | null;
  created_at: Date;
  /// Round-2 audit FINDING 4 provenance columns. Optional so pre-migration
  /// rows (existing reconcile fixtures) can omit them; the new publishEpoch
  /// journal INSERT always populates both.
  snapshot_block?: string | null;
  expected_holder_count?: number | null;
  /// Round-6 audit H3: final provenance for the activation tx of a
  /// propose/activate epoch. Nullable — set once `_activatePendingProposal`
  /// successfully signs + confirms activateEpoch().
  activation_tx_hash?: string | null;
}
interface LeafRow {
  chain_id: number;
  epoch_id: number;
  holder: string;
  amount: string;
  proof: unknown;
}
interface EpochRow {
  chain_id: number;
  epoch_id: number;
  merkle_root: string;
  total_amount: string;
  tx_hash: string;
  block_number: string;
  holder_count: number;
}

/// Simple JS-side mutex modeling pg's advisory lock semantics: acquire blocks
/// while held, release wakes the next waiter. Enough to test that
/// `withPublicationLockOn` correctly serializes concurrent publishers.
class SimpleMutex {
  held = false;
  private queue: Array<() => void> = [];
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.held) {
        this.held = true;
        resolve();
      } else {
        this.queue.push(() => {
          this.held = true;
          resolve();
        });
      }
    });
  }
  release(): void {
    this.held = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

interface FakeState {
  publications: PubRow[];
  leaves: LeafRow[];
  epochs: EpochRow[];
  lock: SimpleMutex;
}

function makeFakeState(): FakeState {
  return { publications: [], leaves: [], epochs: [], lock: new SimpleMutex() };
}

// ---------------------------------------------------------------- fake sql

/// Pattern-match on the first static fragment of each tagged-template query
/// the rewards publisher issues. Each query in `reconcilePendingForConfig` +
/// `finalizePublication` + `withPublicationLockOn` has a distinctive prefix,
/// which is enough to route without a real SQL parser.
async function handleQuery(
  state: FakeState,
  strings: TemplateStringsArray,
  values: unknown[],
): Promise<unknown[]> {
  const firstFragment = (strings[0] ?? '').replace(/\s+/g, ' ').trim();
  const joined = strings.join('?').replace(/\s+/g, ' ').trim();

  if (firstFragment.startsWith('SELECT pg_advisory_lock(')) {
    await state.lock.acquire();
    return [];
  }
  if (firstFragment.startsWith('SELECT pg_advisory_unlock(')) {
    state.lock.release();
    return [];
  }

  // Reconcile row select — has `created_at, status` in the projection.
  if (
    firstFragment.startsWith('SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash')
    && joined.includes('created_at')
  ) {
    const chainId = values[0] as number;
    return state.publications
      .filter((p) => p.chain_id === chainId && (p.status === 'pending' || p.status === 'broadcast'))
      .sort((a, b) => a.epoch_id - b.epoch_id)
      .map((p) => ({
        epoch_id: p.epoch_id,
        merkle_root: p.merkle_root,
        total_amount: p.total_amount,
        holder_count: p.holder_count,
        tx_hash: p.tx_hash,
        block_number: p.block_number,
        created_at: p.created_at,
        status: p.status,
      }));
  }

  // Activation row lookup — same projection minus `created_at`, filters by
  // epoch_id. Round-6 audit H3: `_activatePendingProposal` now also SELECTs
  // `status` so the fail-closed guard can reject anything not in
  // 'broadcast'; return it in the row.
  if (
    firstFragment.startsWith('SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash')
    && !joined.includes('created_at')
  ) {
    const [chainId, epochId] = values as [number, number];
    return state.publications
      .filter((p) => p.chain_id === chainId && p.epoch_id === epochId)
      .map((p) => ({
        epoch_id: p.epoch_id,
        merkle_root: p.merkle_root,
        total_amount: p.total_amount,
        holder_count: p.holder_count,
        tx_hash: p.tx_hash,
        block_number: p.block_number,
        status: p.status,
      }));
  }

  if (firstFragment.startsWith("UPDATE app.rewards_publications SET status = 'conflict'")) {
    const [chainId, epochId] = values as [number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) p.status = 'conflict';
    }
    return [];
  }

  if (firstFragment.startsWith("UPDATE app.rewards_publications SET status = 'confirmed'")) {
    const [chainId, epochId] = values as [number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) p.status = 'confirmed';
    }
    return [];
  }

  if (firstFragment.startsWith("UPDATE app.rewards_publications SET status = 'reverted'")) {
    const [chainId, epochId] = values as [number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) p.status = 'reverted';
    }
    return [];
  }

  if (firstFragment.startsWith('INSERT INTO app.rewards_epochs')) {
    const [chainId, epochId, vault, root, total, txHash, blockNumber, holderCount] = values as [
      number,
      number,
      string,
      string,
      string,
      string,
      string,
      number,
    ];
    void vault;
    const existing = state.epochs.find((e) => e.chain_id === chainId && e.epoch_id === epochId);
    if (existing) {
      existing.merkle_root = root;
      existing.total_amount = total;
      existing.tx_hash = txHash;
      existing.block_number = blockNumber;
      existing.holder_count = holderCount;
    } else {
      state.epochs.push({
        chain_id: chainId,
        epoch_id: epochId,
        merkle_root: root,
        total_amount: total,
        tx_hash: txHash,
        block_number: blockNumber,
        holder_count: holderCount,
      });
    }
    return [];
  }

  if (firstFragment.startsWith('DELETE FROM app.rewards_leaves')) {
    const [chainId, epochId] = values as [number, number];
    state.leaves = state.leaves.filter((l) => !(l.chain_id === chainId && l.epoch_id === epochId));
    return [];
  }

  if (firstFragment.startsWith('DELETE FROM app.rewards_publications')) {
    const [chainId, epochId] = values as [number, number];
    state.publications = state.publications.filter(
      (p) => !(p.chain_id === chainId && p.epoch_id === epochId),
    );
    return [];
  }

  // FINDING 4 AC #2: publishEpoch's journal INSERT — now carries snapshot_block
  // + expected_holder_count. The 'pending' status literal is baked into the SQL
  // template, so it isn't in `values`; that's why status is populated inline.
  if (firstFragment.startsWith('INSERT INTO app.rewards_publications')) {
    const [chainId, epochId, vault, root, total, holderCount, snapshotBlock, expectedHolderCount] =
      values as [number, number, string, string, string, number, string, number];
    if (state.publications.some((p) => p.chain_id === chainId && p.epoch_id === epochId)) {
      throw new Error(`duplicate INSERT into rewards_publications for (${chainId}, ${epochId})`);
    }
    state.publications.push({
      chain_id: chainId,
      epoch_id: epochId,
      vault_addr: vault,
      merkle_root: root,
      total_amount: total,
      holder_count: holderCount,
      status: 'pending',
      tx_hash: null,
      block_number: null,
      created_at: new Date(),
      snapshot_block: snapshotBlock,
      expected_holder_count: expectedHolderCount,
    });
    return [];
  }

  // publishEpoch happy-path: after wallet.sendTransaction, flip status →
  // broadcast + record tx_hash.
  if (firstFragment.startsWith("UPDATE app.rewards_publications SET status = 'broadcast'")) {
    const [txHash, chainId, epochId] = values as [string, number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) {
        p.status = 'broadcast';
        p.tx_hash = txHash;
      }
    }
    return [];
  }

  // publishEpoch happy-path: after waitForTransactionReceipt, stamp
  // block_number onto the journal row.
  if (firstFragment.startsWith('UPDATE app.rewards_publications SET block_number')) {
    const [blockNumber, chainId, epochId] = values as [string, number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) {
        p.block_number = blockNumber;
      }
    }
    return [];
  }

  // Round-6 audit H3: after successful activation, `_activatePendingProposal`
  // stamps the activation tx hash onto the journal row as final provenance.
  if (firstFragment.startsWith('UPDATE app.rewards_publications SET activation_tx_hash')) {
    const [txHash, chainId, epochId] = values as [string, number, number];
    for (const p of state.publications) {
      if (p.chain_id === chainId && p.epoch_id === epochId) {
        p.activation_tx_hash = txHash;
      }
    }
    return [];
  }

  // publishEpoch happy-path: per-leaf INSERT. We don't need to assert on the
  // proof shape in these tests but the fake needs to accept the write so
  // publishEpoch's `db.begin(...)` block completes.
  if (firstFragment.startsWith('INSERT INTO app.rewards_leaves')) {
    const [chainId, epochId, holder, amount, proofJson] = values as [
      number,
      number,
      string,
      string,
      string,
    ];
    const existing = state.leaves.find(
      (l) => l.chain_id === chainId && l.epoch_id === epochId && l.holder === holder,
    );
    if (existing) {
      existing.amount = amount;
      existing.proof = proofJson;
    } else {
      state.leaves.push({ chain_id: chainId, epoch_id: epochId, holder, amount, proof: proofJson });
    }
    return [];
  }

  throw new Error(`unhandled fake sql: ${firstFragment.slice(0, 120)}`);
}

/// A tagged-template callable that also exposes `.begin` (shared state, no
/// rollback since the tests don't need it) and `.release` (no-op).
function makeFakeDb(state: FakeState): any {
  const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    handleQuery(state, strings, values);
  fn.begin = async (inner: (tx: any) => Promise<unknown>) => {
    const tx = makeFakeDb(state);
    return await inner(tx);
  };
  fn.release = () => {};
  return fn;
}

/// Top-level fake `sql` singleton — implements the surface
/// `withPublicationLockOn` touches: `.reserve()` returns a `db` with a
/// `.release()`.
function makeFakeSql(state: FakeState): any {
  const fn: any = (strings: TemplateStringsArray, ...values: unknown[]) =>
    handleQuery(state, strings, values);
  fn.reserve = async () => makeFakeDb(state);
  fn.begin = async (inner: (tx: any) => Promise<unknown>) => await inner(makeFakeDb(state));
  return fn;
}

// ---------------------------------------------------------------- fake pub

/// Reconcile calls `readContract({functionName: 'epochs'})` and (for broadcast
/// rows) `readContract({functionName: 'pendingEpoch'})`. Both are stubbed with
/// per-test data. `epochs[id]` returns `[merkleRoot, totalAmount, unclaimed]`;
/// `pendingEpoch()` returns `[expectedEpochId, merkleRoot, totalAmount, readyAt]`.
function makeFakePub(
  onchainByEpoch: Record<number, readonly [`0x${string}`, bigint, bigint]>,
  pendingEpoch: readonly [bigint, `0x${string}`, bigint, bigint] = [0n, ZERO_ROOT, 0n, 0n],
): any {
  return {
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly [bigint];
    }) => {
      if (functionName === 'epochs') {
        const id = Number((args as readonly [bigint])[0]);
        return onchainByEpoch[id] ?? ([ZERO_ROOT, 0n, 0n] as const);
      }
      if (functionName === 'pendingEpoch') {
        return pendingEpoch;
      }
      throw new Error(`unexpected readContract in reconcile: ${functionName}`);
    },
  };
}

// ---------------------------------------------------------------- publishEpoch fakes

/// Extended fake public client for the publishEpoch end-to-end tests. Serves
/// `pendingEpoch` (state-machine decision), `epochs` (reconcile pass at top of
/// publishEpoch), scalar reads (`totalCommitted`, `nextEpochId`,
/// `minConfigDelay`), plus the ETH-side reads (`getBlockNumber`, `getBalance`)
/// and receipt polling that the happy path funnels through.
interface FakePubOpts {
  pendingEpoch?: readonly [bigint, `0x${string}`, bigint, bigint];
  epochsByEpochId?: Record<number, readonly [`0x${string}`, bigint, bigint]>;
  blockNumber?: bigint;
  vaultBalance?: bigint;
  totalCommitted?: bigint;
  nextEpochId?: bigint;
  minConfigDelay?: bigint;
  receiptBlock?: bigint;
}

function makeFakePubForPublish(opts: FakePubOpts = {}): any {
  const pending = opts.pendingEpoch ?? ([0n, ZERO_ROOT, 0n, 0n] as const);
  const epochsMap = opts.epochsByEpochId ?? {};
  const blockNumber = opts.blockNumber ?? 20_000_000n;
  const balance = opts.vaultBalance ?? 10_000_000_000_000_000_000n; // 10 ETH
  const committed = opts.totalCommitted ?? 0n;
  const nextEpochId = opts.nextEpochId ?? 5n;
  const minConfigDelay = opts.minConfigDelay ?? 0n;
  const receiptBlock = opts.receiptBlock ?? blockNumber + 100n;
  return {
    getBlockNumber: async () => blockNumber,
    getBalance: async (_: { address: Address }) => balance,
    waitForTransactionReceipt: async (_: { hash: Hex }) => ({
      status: 'success' as const,
      blockNumber: receiptBlock,
    }),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (functionName === 'pendingEpoch') return pending;
      if (functionName === 'epochs') {
        const id = Number((args as readonly [bigint])[0]);
        return epochsMap[id] ?? ([ZERO_ROOT, 0n, 0n] as const);
      }
      if (functionName === 'totalCommitted') return committed;
      if (functionName === 'nextEpochId') return nextEpochId;
      if (functionName === 'minConfigDelay') return minConfigDelay;
      throw new Error(`unexpected readContract in publish: ${functionName}`);
    },
  };
}

/// Records every sendTransaction so tests can assert on the encoded calldata
/// (e.g. is the tx an `activateEpoch()` vs `proposeEpoch(...)`?).
interface FakeWalletRecorder {
  wallet: any;
  account: Address;
  calls: Array<{ to: Address; data: Hex }>;
}

function makeFakeWallet(): FakeWalletRecorder {
  const calls: Array<{ to: Address; data: Hex }> = [];
  // A deterministic, well-formed 32-byte tx hash so downstream code that
  // stringifies + updates the journal row sees a normal Hex value.
  const txHash = ('0x' + 'de'.repeat(32)) as Hex;
  const wallet: any = {
    chain: null,
    sendTransaction: async (opts: { to: Address; data: Hex }) => {
      calls.push({ to: opts.to, data: opts.data });
      return txHash;
    },
  };
  return {
    wallet,
    account: '0x000000000000000000000000000000000000dEaD' as Address,
    calls,
  };
}

/// The vault-side ABI subset that publishEpoch's happy path encodes. Kept in
/// this file (rather than imported from rewards.ts) so a signature drift in
/// production code trips the tests' expected-vs-actual encoding assertion.
const publishAbi = parseAbi([
  'function activateEpoch()',
  'function proposeEpoch(uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount)',
  'function addEpoch(uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount)',
]);

/// Sets ROBINHOOD_* env so `chainConfigFor('robinhood')` inside publishEpoch
/// returns a real ChainConfig (values are only used to shape the config; every
/// live RPC / DB / wallet call is intercepted inside a `_withTestOverrides`
/// scope).
function ensureRobinhoodEnv(): void {
  process.env.ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL ?? 'http://ignored';
  process.env.ROBINHOOD_NFT_REVENUE_VAULT_ADDRESS = CFG.vaultAddress;
  process.env.ROBINHOOD_GEMU_NFT_ADDRESS = CFG.gemuNftAddress;
}

// ================================================================
// URU-A06 AC #4: crash-recovery paths
// ================================================================

test('URU-A06 reconcile keeps a fresh pending row retry-able when no tx has landed', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 0,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 2,
    status: 'pending',
    tx_hash: null,
    block_number: null,
    created_at: new Date(), // fresh: reconcile must NOT purge it
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 0, holder: '0xa', amount: '500', proof: [] });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 0, holder: '0xb', amount: '500', proof: [] });

  const pub = makeFakePub({}); // no on-chain landing
  const db = makeFakeDb(state);

  await assert.rejects(
    () => reconcilePendingForConfig(CFG, pub, db),
    /already pending/,
  );

  // Journal + leaves must be preserved so a later publish can retry safely.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'pending');
  assert.equal(state.leaves.length, 2);
  assert.equal(state.epochs.length, 0);
});

test('URU-A06 reconcile discards a stale pending row with no broadcast', async () => {
  const state = makeFakeState();
  const stale = new Date(Date.now() - 60 * 60 * 1000); // 60 min old
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 0,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 1,
    status: 'pending',
    tx_hash: null,
    block_number: null,
    created_at: stale,
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 0, holder: '0xa', amount: '1000', proof: [] });

  const pub = makeFakePub({}); // still no on-chain row
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db);

  // Row was old enough that reconcile deletes it and the leaves cleanly, so a
  // fresh publish can rebuild the tree from scratch without a PK collision.
  assert.equal(state.publications.length, 0);
  assert.equal(state.leaves.length, 0);
  assert.equal(state.epochs.length, 0);
});

test('URU-A06 reconcile promotes a broadcast row whose tx confirmed', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 0,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 2,
    status: 'broadcast',
    tx_hash: '0xdeadbeef',
    block_number: '12345',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 0, holder: '0xa', amount: '500', proof: [] });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 0, holder: '0xb', amount: '500', proof: [] });

  // Simulate: while the process was down, the addEpoch tx confirmed on-chain
  // with the exact root + total we journaled.
  const pub = makeFakePub({ 0: [ROOT_A, 1000n, 1000n] });
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db);

  // Publication row now confirmed.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'confirmed');
  // Tree preserved.
  assert.equal(state.leaves.length, 2);
  // rewards_epochs row seeded with our journaled tx_hash + block_number.
  assert.equal(state.epochs.length, 1);
  assert.equal(state.epochs[0]!.merkle_root, ROOT_A);
  assert.equal(state.epochs[0]!.tx_hash, '0xdeadbeef');
  assert.equal(state.epochs[0]!.holder_count, 2);
});

test('URU-A06 reconcile flags conflict when on-chain root differs, preserves tree', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 5,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 2,
    status: 'broadcast',
    tx_hash: '0xdeadbeef',
    block_number: '12345',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 5, holder: '0xa', amount: '500', proof: [] });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 5, holder: '0xb', amount: '500', proof: [] });

  // A different publisher raced us and landed ROOT_B at epoch 5.
  const pub = makeFakePub({ 5: [ROOT_B, 2000n, 2000n] });
  const db = makeFakeDb(state);

  await assert.rejects(
    () => reconcilePendingForConfig(CFG, pub, db),
    /reward publication conflict at epoch 5/,
  );

  // Row marked conflict; leaves retained for post-mortem so we can compare
  // what we intended vs. what actually landed.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'conflict');
  assert.equal(state.leaves.length, 2);
  // No rewards_epochs row inserted for the conflicted publication.
  assert.equal(state.epochs.length, 0);
});

test('URU-A06 lock: two concurrent publish attempts are serialized by the advisory lock', async () => {
  const state = makeFakeState();
  const fakeSql = makeFakeSql(state);

  const order: string[] = [];
  const barrier: { resolve: (() => void) | null } = { resolve: null };

  const first = withPublicationLockOn(fakeSql, async () => {
    order.push('first-enter');
    await new Promise<void>((resolve) => {
      barrier.resolve = resolve;
    });
    order.push('first-exit');
    return 'first';
  });

  // Let the first call reach the await inside its callback.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const second = withPublicationLockOn(fakeSql, async () => {
    order.push('second-enter');
    return 'second';
  });

  // Give the second call two microtask ticks to attempt lock acquisition.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // First is inside its callback; second must be blocked on the advisory lock.
  assert.deepEqual(order, ['first-enter']);
  assert.equal(state.lock.held, true);

  // Release the first call. Second must now proceed under the same lock.
  assert.ok(barrier.resolve, 'expected first callback to have registered a resolver');
  barrier.resolve!();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, 'first');
  assert.equal(secondResult, 'second');
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
  // Lock fully released after both finished.
  assert.equal(state.lock.held, false);
});

// ================================================================
// URU-A07 AC #4: partial-claim + override guardrails
// ================================================================

test('URU-A07 amount: fully unclaimed prior epoch caps publisher at the uncommitted slice', () => {
  const balance = 10_000_000_000_000_000_000n; // 10 ETH
  const totalCommitted = 5_000_000_000_000_000_000n; // whole prior epoch still owed
  const amount = resolvePublishAmount(balance, totalCommitted);
  assert.equal(amount, 5_000_000_000_000_000_000n); // publisher can only allocate the free 5 ETH
});

test('URU-A07 amount: partially claimed prior epoch only reserves the unclaimed remainder', () => {
  // Prior epoch had 5 ETH committed; 2 ETH already claimed by holders, so the
  // vault reports totalCommitted = 3 ETH (unclaimed remainder). Balance is
  // still 10 ETH here because in this scenario the publisher tops the vault
  // up between epochs. Regardless of provenance, the arithmetic is:
  //   available = balance - totalCommitted = 10 - 3 = 7 ETH.
  const balance = 10_000_000_000_000_000_000n;
  const totalCommitted = 3_000_000_000_000_000_000n;
  const amount = resolvePublishAmount(balance, totalCommitted);
  assert.equal(amount, 7_000_000_000_000_000_000n);
});

test('URU-A07 amount: zero available balance blocks publish with a clear reason', () => {
  const balance = 5_000_000_000_000_000_000n;
  const totalCommitted = 5_000_000_000_000_000_000n; // fully committed already
  assert.throws(
    () => resolvePublishAmount(balance, totalCommitted),
    /vault available balance is zero/,
  );
});

test('URU-A07 amount: explicit override above available balance is rejected', () => {
  const balance = 10_000_000_000_000_000_000n;
  const totalCommitted = 5_000_000_000_000_000_000n; // available = 5 ETH
  // Caller tries to override with the full balance (10 ETH) which exceeds
  // available. Must reject so the vault does not revert OverCommit on-chain.
  assert.throws(
    () => resolvePublishAmount(balance, totalCommitted, balance),
    /exceeds uncommitted balance/,
  );
});

// ================================================================
// Round-2 audit FINDING 1: proposal-path four-state reconcile
// ================================================================

test('FINDING 1 AC #1 reconcile does NOT throw on an immature pending proposal', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 7,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xproposedtx',
    block_number: '9999',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 7, holder: '0xa', amount: '1000', proof: [] });

  // Proposal is on-chain (matches our row) but doesn't mature for another
  // hour. Reconcile must log + continue, NOT throw.
  const futureReadyAt = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const pub = makeFakePub(
    {}, // epochs[7] still empty; the proposal isn't activated
    [7n, ROOT_A, 1000n, futureReadyAt],
  );
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db); // MUST NOT throw

  // Journal preserved exactly — no state changes.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'broadcast');
  assert.equal(state.leaves.length, 1);
  assert.equal(state.epochs.length, 0);
});

test('FINDING 1 AC #1 reconcile does NOT throw on a matured-but-unactivated pending proposal', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 7,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xproposedtx',
    block_number: '9999',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 7, holder: '0xa', amount: '1000', proof: [] });

  // Proposal is on-chain (matches our row) AND matured — the activation loop
  // will pick it up on its next tick. Reconcile stays out of the way.
  const pastReadyAt = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
  const pub = makeFakePub({}, [7n, ROOT_A, 1000n, pastReadyAt]);
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db); // MUST NOT throw

  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'broadcast');
  assert.equal(state.leaves.length, 1);
});

test('FINDING 1 AC #2 reconcile flips broadcast → reverted when on-chain pending is gone', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 3,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xdroppedtx',
    block_number: '5555',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 3, holder: '0xa', amount: '1000', proof: [] });

  // On-chain: epochs[3] empty AND pendingEpoch is empty (proposal was
  // cancelled, or the tx never actually landed). Our broadcast is orphaned.
  const pub = makeFakePub({}, [0n, ZERO_ROOT, 0n, 0n]);
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db); // MUST NOT throw

  // Row flipped to reverted, leaves cleared, so next publish tick can retry
  // at epoch id 3 without a PK collision.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'reverted');
  assert.equal(state.leaves.length, 0);
  assert.equal(state.epochs.length, 0);
});

test('FINDING 1 AC #2 reconcile flips broadcast → reverted when a DIFFERENT proposal is pending', async () => {
  const state = makeFakeState();
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 3,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xoldproposetx',
    block_number: '5555',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 3, holder: '0xa', amount: '1000', proof: [] });

  // On-chain pendingEpoch is for a different root (someone cancelled ours and
  // proposed something else). Our attempt is orphaned.
  const futureReadyAt = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const pub = makeFakePub({}, [3n, ROOT_B, 2000n, futureReadyAt]);
  const db = makeFakeDb(state);

  await reconcilePendingForConfig(CFG, pub, db); // MUST NOT throw

  assert.equal(state.publications[0]!.status, 'reverted');
  assert.equal(state.leaves.length, 0);
});

// ================================================================
// FINDING 1 AC #5 + AC #6 — publishEpoch entry-point state machine
// FINDING 4 AC #2       — journal INSERT carries snapshot_block +
//                          expected_holder_count
// ================================================================
//
// These tests drive `publishEpoch` end-to-end through the injected
// `_withTestOverrides` scope rather than a live pg / RPC / signer. They
// cover the two gaps the reconcile-layer tests above do NOT touch:
//
//   * whether the OPENING pendingEpoch() read gates the propose vs
//     activate branches at the top of publishEpoch (FINDING 1)
//   * whether the journal INSERT actually persists the new provenance
//     columns end-to-end (FINDING 4)
//
// Round-6 audit H1: overrides are AsyncLocalStorage-scoped, so tests are
// isolated even when node:test's runner schedules them concurrently.

test('FINDING 1 AC #5 publishEpoch skips fresh proposal when on-chain pendingEpoch is still immature', async () => {
  ensureRobinhoodEnv();
  const state = makeFakeState();
  const fakeSql = makeFakeSql(state);
  const futureReadyAt = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const fakePub = makeFakePubForPublish({
    pendingEpoch: [7n, ROOT_A, 1000n, futureReadyAt],
  });
  const walletRec = makeFakeWallet();

  const publicationsBefore = state.publications.length;

  const outcome = await _withTestOverrides(
    {
      sql: fakeSql,
      publicClientFor: () => fakePub,
      walletClientFor: () => ({ wallet: walletRec.wallet, account: walletRec.account }),
      fetchHolders: async () => {
        throw new Error('fetchHolders MUST NOT be called on the immature-skip branch');
      },
    },
    () => publishEpoch({ chainSlug: 'robinhood' }),
  );

  assert.equal(outcome.action, 'skipped-immature-proposal');
  // Discriminated-union narrowing so we can assert on the schema-specific
  // fields without an `as` cast.
  if (outcome.action === 'skipped-immature-proposal') {
    assert.equal(outcome.epochId, 7);
    assert.equal(outcome.readyAt, Number(futureReadyAt));
  }
  // No journal INSERT — publisher bailed BEFORE touching state.
  assert.equal(state.publications.length, publicationsBefore);
  // And no tx of any kind was signed.
  assert.equal(walletRec.calls.length, 0);
});

test('FINDING 1 AC #5 + AC #6 publishEpoch activates matured pendingEpoch instead of proposing a fresh one', async () => {
  ensureRobinhoodEnv();
  const state = makeFakeState();
  const fakeSql = makeFakeSql(state);
  const pastReadyAt = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
  const pendingExpectedId = 5n;
  const pendingRoot = ROOT_A;
  const pendingTotal = 1_000_000_000_000_000_000n;
  // Round-6 audit H3: `_activatePendingProposal` now fail-closes on a missing
  // journal row. Seed a matching broadcast row so the activation is legal.
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: Number(pendingExpectedId),
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: pendingRoot,
    total_amount: pendingTotal.toString(),
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xproposedtx',
    block_number: '9999',
    created_at: new Date(),
  });
  state.leaves.push({
    chain_id: CFG.chainId,
    epoch_id: Number(pendingExpectedId),
    holder: '0xa',
    amount: pendingTotal.toString(),
    proof: [],
  });
  const fakePub = makeFakePubForPublish({
    pendingEpoch: [pendingExpectedId, pendingRoot, pendingTotal, pastReadyAt],
    // The reconcile pass at the top of publishEpoch sees `pendingEpoch()`
    // matches our row (`isOurs` branch) and continues without touching state.
  });
  const walletRec = makeFakeWallet();

  const outcome = await _withTestOverrides(
    {
      sql: fakeSql,
      publicClientFor: () => fakePub,
      walletClientFor: () => ({ wallet: walletRec.wallet, account: walletRec.account }),
      fetchHolders: async () => {
        throw new Error('fetchHolders MUST NOT be called on the activate branch');
      },
    },
    () => publishEpoch({ chainSlug: 'robinhood' }),
  );

  assert.equal(outcome.action, 'activated');
  // Exactly one signed tx (the activate) — no propose, no addEpoch.
  assert.equal(walletRec.calls.length, 1);
  const sent = walletRec.calls[0]!;
  assert.equal(sent.to.toLowerCase(), CFG.vaultAddress.toLowerCase());
  // Decode the calldata against the local ABI subset. A drift in production
  // (e.g. selector accidentally swapped to `proposeEpoch`) would either fail
  // to decode as `activateEpoch` or land in the wrong `functionName` bucket.
  const decoded = decodeFunctionData({ abi: publishAbi, data: sent.data });
  assert.equal(decoded.functionName, 'activateEpoch');
  // Belt-and-suspenders: byte-exact match against the expected encoding so a
  // future extra-arg addition to `activateEpoch` in production wouldn't
  // silently pass this test.
  const expectedData = encodeFunctionData({
    abi: publishAbi,
    functionName: 'activateEpoch',
    args: [],
  });
  assert.equal(sent.data, expectedData);
});

test('FINDING 4 AC #2 publishEpoch journal INSERT records snapshot_block and expected_holder_count', async () => {
  ensureRobinhoodEnv();
  const state = makeFakeState();
  const fakeSql = makeFakeSql(state);
  const snapshotBlock = 20_000_000n;
  const fakePub = makeFakePubForPublish({
    // No on-chain pending — publisher takes the fresh-propose / addEpoch path.
    pendingEpoch: [0n, ZERO_ROOT, 0n, 0n],
    blockNumber: snapshotBlock,
    vaultBalance: 10_000_000_000_000_000_000n, // 10 ETH
    totalCommitted: 0n,
    nextEpochId: 12n,
    // minConfigDelay = 0 → addEpoch (single-shot) so finalizePublication runs
    // and the happy-path SQL journey is exercised end-to-end without a
    // separate activation tick.
    minConfigDelay: 0n,
  });
  const walletRec = makeFakeWallet();

  // Two holders → non-zero snapshot, deterministic assertion target.
  const holders: Holder[] = [
    { address: ('0x' + 'a'.padEnd(40, '0')) as Address, balance: 2n },
    { address: ('0x' + 'b'.padEnd(40, '0')) as Address, balance: 3n },
  ];

  const outcome = await _withTestOverrides(
    {
      sql: fakeSql,
      publicClientFor: () => fakePub,
      walletClientFor: () => ({ wallet: walletRec.wallet, account: walletRec.account }),
      fetchHolders: async () => holders,
    },
    () => publishEpoch({ chainSlug: 'robinhood' }),
  );
  assert.equal(outcome.action, 'published');

  // Exactly one journal row landed and it carries both provenance columns.
  assert.equal(state.publications.length, 1);
  const row = state.publications[0]!;
  assert.equal(row.chain_id, CFG.chainId);
  assert.equal(row.epoch_id, 12);
  // Persisted as text (bigint would lose precision at wei scale) — must
  // stringify the head-block bigint the publisher captured.
  assert.equal(row.snapshot_block, snapshotBlock.toString());
  // expected_holder_count is the paginator-observed size BEFORE dust
  // filtering; matches holders.length, not leaves.length (which can drop
  // rows whose allocation rounds to zero).
  assert.equal(row.expected_holder_count, holders.length);
  // Sanity: the rest of the row is filled and the happy path advanced all
  // the way to `confirmed` via finalizePublication (addEpoch path).
  assert.equal(row.status, 'confirmed');
  assert.equal(row.tx_hash, '0x' + 'de'.repeat(32));
  // holder_count reflects the leaf count, distinct from expected_holder_count.
  assert.equal(row.holder_count, holders.length);
  // rewards_epochs mirrored the confirmation.
  assert.equal(state.epochs.length, 1);
  assert.equal(state.epochs[0]!.epoch_id, 12);
  // One tx signed — the addEpoch call.
  assert.equal(walletRec.calls.length, 1);
});

// ================================================================
// Round-2 audit FINDING 4: paginate + sanity ceiling
// ================================================================

interface FakePage {
  items: Array<{ holderAddress: string; balance: string }>;
  hasNextPage: boolean;
  endCursor: string | null;
}

function makeFakeIndexerFetch(pages: FakePage[]) {
  let calls = 0;
  const fetchImpl = async (_url: string, _init: RequestInit) => {
    const page = pages[calls] ?? { items: [], hasNextPage: false, endCursor: null };
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { holderss: { items: page.items, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } } } };
      },
    };
  };
  return { fetchImpl, callCount: () => calls };
}

/// Helper: build a page of N synthetic holders with distinct addresses.
function synthPage(n: number, startIdx: number): Array<{ holderAddress: string; balance: string }> {
  const items: Array<{ holderAddress: string; balance: string }> = [];
  for (let i = 0; i < n; i++) {
    const idx = startIdx + i;
    // Pad to 40 hex chars for a valid-looking address.
    const addr = '0x' + idx.toString(16).padStart(40, '0');
    items.push({ holderAddress: addr, balance: '1' });
  }
  return items;
}

test('FINDING 4 AC #1 + AC #3 paginator exhausts multi-page indexer response and stops on a partial page', async () => {
  // Page size defaults to 500 in production. Simulate 3 pages:
  //   page 1: 500 items, hasNextPage=true
  //   page 2: 500 items, hasNextPage=true
  //   page 3: 137 items, hasNextPage=false  → paginator exits
  const pages: FakePage[] = [
    { items: synthPage(500, 0),    hasNextPage: true,  endCursor: 'c1' },
    { items: synthPage(500, 500),  hasNextPage: true,  endCursor: 'c2' },
    { items: synthPage(137, 1000), hasNextPage: false, endCursor: null },
  ];
  const { fetchImpl, callCount } = makeFakeIndexerFetch(pages);
  const holders = await fetchGemuHoldersFromIndexer(CFG, fetchImpl, 5_000);
  assert.equal(holders.length, 1137);
  // Paginator MUST have stopped after the third page — no extra fetch calls.
  assert.equal(callCount(), 3);
});

test('FINDING 4 AC #3 paginator also stops when a page returns FEWER than the requested limit even if hasNextPage=true', async () => {
  // Some Ponder builds report hasNextPage=true even on the terminal page when
  // the underlying rows shift mid-query. The partial-page break is the
  // belt-and-suspenders that keeps us from looping forever.
  const pages: FakePage[] = [
    { items: synthPage(500, 0), hasNextPage: true, endCursor: 'c1' },
    { items: synthPage(42, 500), hasNextPage: true, endCursor: 'c2' }, // partial → break
    { items: synthPage(500, 542), hasNextPage: true, endCursor: 'c3' }, // never reached
  ];
  const { fetchImpl, callCount } = makeFakeIndexerFetch(pages);
  const holders = await fetchGemuHoldersFromIndexer(CFG, fetchImpl, 5_000);
  assert.equal(holders.length, 542);
  assert.equal(callCount(), 2);
});

test('FINDING 4 AC #4 paginator throws IndexerHolderCountExceedsCap past the sanity ceiling', async () => {
  // Cap is 1000. Feed pages totalling more than that and assert the paginator
  // bails hard, does NOT silently truncate.
  const pages: FakePage[] = [
    { items: synthPage(500, 0),    hasNextPage: true, endCursor: 'c1' },
    { items: synthPage(500, 500),  hasNextPage: true, endCursor: 'c2' },
    { items: synthPage(500, 1000), hasNextPage: true, endCursor: 'c3' }, // overflow lives here
  ];
  const { fetchImpl } = makeFakeIndexerFetch(pages);
  await assert.rejects(
    () => fetchGemuHoldersFromIndexer(CFG, fetchImpl, 1_000),
    (err: unknown) => {
      assert.ok(err instanceof IndexerHolderCountExceedsCap, `expected IndexerHolderCountExceedsCap, got ${(err as Error)?.name}`);
      const cap = err as IndexerHolderCountExceedsCap;
      assert.equal(cap.cap, 1_000);
      assert.ok(cap.seen > 1_000, `expected seen > 1000, got ${cap.seen}`);
      return true;
    },
  );
});

test('FINDING 4 AC #4 paginator does NOT throw when total holders equal the cap exactly', async () => {
  // Boundary check: cap is inclusive, `holders.length > cap` is the trigger.
  // Exactly-at-cap must succeed so a legitimate operator raising the cap to
  // e.g. 10_000 does not immediately hit a spurious ceiling error.
  const pages: FakePage[] = [
    { items: synthPage(500, 0), hasNextPage: true,  endCursor: 'c1' },
    { items: synthPage(500, 500), hasNextPage: false, endCursor: null },
  ];
  const { fetchImpl } = makeFakeIndexerFetch(pages);
  const holders = await fetchGemuHoldersFromIndexer(CFG, fetchImpl, 1_000);
  assert.equal(holders.length, 1_000);
});

// ================================================================
// Round-6 audit H1: AsyncLocalStorage-scoped test override isolation
// ================================================================
//
// Prior code stored overrides in a module-level `let`. Two concurrent
// `node:test` suites that both called `_setTestOverrides` would race — the
// second call would replace the first's fakes, and any resolver invocation
// scheduled from the first suite AFTER the swap would silently read the
// wrong sql / wallet / pub. `_withTestOverrides` binds each scope's store
// to its callback's async chain via AsyncLocalStorage, so parallel scopes
// see independent overrides no matter how the runner interleaves them.
//
// The test drives two concurrent publishEpoch calls under different
// override scopes and asserts each scope observed its OWN state. If the
// AsyncLocalStorage guarantee ever regresses (e.g. someone reintroduces
// a module-level `let`), this test trips.

test('H1 AC #4 concurrent _withTestOverrides scopes see independent overrides', async () => {
  ensureRobinhoodEnv();

  // Two fully-independent fake worlds. If overrides leak between scopes,
  // publishEpoch inside scope A would touch state B (or vice-versa).
  const stateA = makeFakeState();
  const stateB = makeFakeState();
  const fakeSqlA = makeFakeSql(stateA);
  const fakeSqlB = makeFakeSql(stateB);
  const fakePubA = makeFakePubForPublish({
    pendingEpoch: [0n, ZERO_ROOT, 0n, 0n],
    blockNumber: 1_000_000n,
    vaultBalance: 10_000_000_000_000_000_000n,
    totalCommitted: 0n,
    nextEpochId: 100n,
    minConfigDelay: 0n,
  });
  const fakePubB = makeFakePubForPublish({
    pendingEpoch: [0n, ZERO_ROOT, 0n, 0n],
    blockNumber: 2_000_000n,
    vaultBalance: 20_000_000_000_000_000_000n,
    totalCommitted: 0n,
    nextEpochId: 200n,
    minConfigDelay: 0n,
  });
  const walletA = makeFakeWallet();
  const walletB = makeFakeWallet();

  // Distinct holder sets keyed to each scope. If a resolver in scope A ever
  // read scope B's fetchHolders override, its journal row would carry the
  // wrong holder count.
  const holdersA: Holder[] = [
    { address: ('0x' + 'a'.padEnd(40, '1')) as Address, balance: 1n },
    { address: ('0x' + 'a'.padEnd(40, '2')) as Address, balance: 1n },
  ];
  const holdersB: Holder[] = [
    { address: ('0x' + 'b'.padEnd(40, '3')) as Address, balance: 1n },
    { address: ('0x' + 'b'.padEnd(40, '4')) as Address, balance: 1n },
    { address: ('0x' + 'b'.padEnd(40, '5')) as Address, balance: 1n },
  ];

  // Cross-await: each scope's fetchHolders yields to the event loop BEFORE
  // returning so the two publishEpoch pipelines actually interleave. Without
  // ALS isolation, one pipeline's post-await resolver read would see the
  // other scope's fakes.
  const scopeA = _withTestOverrides(
    {
      sql: fakeSqlA,
      publicClientFor: () => fakePubA,
      walletClientFor: () => ({ wallet: walletA.wallet, account: walletA.account }),
      fetchHolders: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        return holdersA;
      },
    },
    () => publishEpoch({ chainSlug: 'robinhood' }),
  );
  const scopeB = _withTestOverrides(
    {
      sql: fakeSqlB,
      publicClientFor: () => fakePubB,
      walletClientFor: () => ({ wallet: walletB.wallet, account: walletB.account }),
      fetchHolders: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return holdersB;
      },
    },
    () => publishEpoch({ chainSlug: 'robinhood' }),
  );

  const [outcomeA, outcomeB] = await Promise.all([scopeA, scopeB]);

  assert.equal(outcomeA.action, 'published');
  assert.equal(outcomeB.action, 'published');
  if (outcomeA.action !== 'published' || outcomeB.action !== 'published') return;

  // Each scope's outcome must match its OWN pub client's nextEpochId +
  // holders. A leak would land B's epoch id on A's outcome (or swap holders).
  assert.equal(outcomeA.epochId, 100, 'scope A must see pubA.nextEpochId (100)');
  assert.equal(outcomeB.epochId, 200, 'scope B must see pubB.nextEpochId (200)');
  assert.equal(outcomeA.holderCount, holdersA.length);
  assert.equal(outcomeB.holderCount, holdersB.length);

  // Each fake sql / wallet must only have observed its own scope's writes.
  assert.equal(stateA.publications.length, 1);
  assert.equal(stateA.publications[0]!.epoch_id, 100);
  assert.equal(stateA.publications[0]!.holder_count, holdersA.length);
  assert.equal(stateB.publications.length, 1);
  assert.equal(stateB.publications[0]!.epoch_id, 200);
  assert.equal(stateB.publications[0]!.holder_count, holdersB.length);

  // Wallet call streams must not have crossed either. One tx per scope.
  assert.equal(walletA.calls.length, 1);
  assert.equal(walletB.calls.length, 1);
});

test('H1 AC #4 nested _withTestOverrides scopes do not leak into sibling scopes', async () => {
  // Complementary micro-test: run a resolver read inside scope A, then
  // enter scope B and confirm B sees B, exit B and confirm A still sees A.
  // This checks that ALS.run() correctly restores the previous store on
  // callback exit (guard against a manual `set` bug).
  const stateA = makeFakeState();
  const stateB = makeFakeState();
  const fakeSqlA = makeFakeSql(stateA);
  const fakeSqlB = makeFakeSql(stateB);

  await _withTestOverrides({ sql: fakeSqlA }, async () => {
    await _withTestOverrides({ sql: fakeSqlB }, async () => {
      // Inside scope B: withPublicationLockOn against the resolved sql
      // (which should be fakeSqlB) must lock stateB, not stateA.
      await withPublicationLockOn(fakeSqlB, async () => {
        assert.equal(stateB.lock.held, true, 'scope B lock must be held');
        assert.equal(stateA.lock.held, false, 'scope A lock must NOT be held');
      });
    });
    // Back in scope A: fakeSqlB's state must be untouched.
    assert.equal(stateB.lock.held, false);
    await withPublicationLockOn(fakeSqlA, async () => {
      assert.equal(stateA.lock.held, true, 'scope A lock re-held after inner scope exit');
      assert.equal(stateB.lock.held, false);
    });
  });
});

// ================================================================
// Round-6 audit H3: activation fail-closed against local proof journal
// ================================================================
//
// The activation loop MUST refuse to sign `activateEpoch()` if it cannot
// prove locally that the on-chain pending root + total were built by us
// (matching journal row in status='broadcast'). Without this, an out-of-band
// proposal — accidental operator tx, a compromised alt-signer, a stale
// standby node — would get activated by the keeper and immediately open
// claims we have no proofs to serve.

/// Build a matching-pending fake pub + wallet + env shared by the H3 tests.
interface H3Fixture {
  state: FakeState;
  fakeSql: any;
  fakePub: any;
  walletRec: FakeWalletRecorder;
  pendingExpectedId: bigint;
  pendingRoot: `0x${string}`;
  pendingTotal: bigint;
}

function makeH3Fixture(): H3Fixture {
  ensureRobinhoodEnv();
  const state = makeFakeState();
  const fakeSql = makeFakeSql(state);
  const pendingExpectedId = 42n;
  const pendingRoot = ROOT_A;
  const pendingTotal = 5_000_000_000_000_000_000n; // 5 ETH
  const pastReadyAt = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
  const fakePub = makeFakePubForPublish({
    pendingEpoch: [pendingExpectedId, pendingRoot, pendingTotal, pastReadyAt],
  });
  const walletRec = makeFakeWallet();
  return { state, fakeSql, fakePub, walletRec, pendingExpectedId, pendingRoot, pendingTotal };
}

test('H3 AC #1 activateVaultEpoch refuses to sign when no journal row exists', async () => {
  const fx = makeH3Fixture();
  // Intentionally NO seed row.

  await assert.rejects(
    () =>
      _withTestOverrides(
        {
          sql: fx.fakeSql,
          publicClientFor: () => fx.fakePub,
          walletClientFor: () => ({ wallet: fx.walletRec.wallet, account: fx.walletRec.account }),
        },
        () => activateVaultEpoch('robinhood'),
      ),
    (err: unknown) => {
      assert.ok(
        err instanceof EpochActivationJournalMismatch,
        `expected EpochActivationJournalMismatch, got ${(err as Error)?.name}`,
      );
      const e = err as EpochActivationJournalMismatch;
      assert.equal(e.epochId, Number(fx.pendingExpectedId));
      assert.match(e.reason, /no journal row/);
      return true;
    },
  );
  // CRITICAL: no tx must have been signed on the fail-closed path.
  assert.equal(fx.walletRec.calls.length, 0);
});

test('H3 AC #1 activateVaultEpoch refuses to sign on merkle_root mismatch', async () => {
  const fx = makeH3Fixture();
  // Seed a broadcast row whose root disagrees with the on-chain pending.
  fx.state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: Number(fx.pendingExpectedId),
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_B, // != pendingRoot (ROOT_A) — mismatch
    total_amount: fx.pendingTotal.toString(),
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xoldpropose',
    block_number: '9999',
    created_at: new Date(),
  });

  await assert.rejects(
    () =>
      _withTestOverrides(
        {
          sql: fx.fakeSql,
          publicClientFor: () => fx.fakePub,
          walletClientFor: () => ({ wallet: fx.walletRec.wallet, account: fx.walletRec.account }),
        },
        () => activateVaultEpoch('robinhood'),
      ),
    (err: unknown) => {
      assert.ok(err instanceof EpochActivationJournalMismatch);
      const e = err as EpochActivationJournalMismatch;
      assert.match(e.reason, /merkle_root mismatch/);
      return true;
    },
  );
  assert.equal(fx.walletRec.calls.length, 0);
});

test('H3 AC #1 activateVaultEpoch refuses to sign on total_amount mismatch', async () => {
  const fx = makeH3Fixture();
  // Seed a broadcast row whose root matches but whose total disagrees.
  fx.state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: Number(fx.pendingExpectedId),
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: fx.pendingRoot,
    total_amount: (fx.pendingTotal + 1n).toString(), // off by one wei
    holder_count: 1,
    status: 'broadcast',
    tx_hash: '0xoldpropose',
    block_number: '9999',
    created_at: new Date(),
  });

  await assert.rejects(
    () =>
      _withTestOverrides(
        {
          sql: fx.fakeSql,
          publicClientFor: () => fx.fakePub,
          walletClientFor: () => ({ wallet: fx.walletRec.wallet, account: fx.walletRec.account }),
        },
        () => activateVaultEpoch('robinhood'),
      ),
    (err: unknown) => {
      assert.ok(err instanceof EpochActivationJournalMismatch);
      const e = err as EpochActivationJournalMismatch;
      assert.match(e.reason, /total_amount mismatch/);
      return true;
    },
  );
  assert.equal(fx.walletRec.calls.length, 0);
});

test('H3 AC #1 activateVaultEpoch refuses to sign when journal row is not in broadcast status', async () => {
  const fx = makeH3Fixture();
  // Seed a matching row but in 'reverted' — a prior orphan the caller must
  // not re-activate without re-broadcast.
  fx.state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: Number(fx.pendingExpectedId),
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: fx.pendingRoot,
    total_amount: fx.pendingTotal.toString(),
    holder_count: 1,
    status: 'reverted',
    tx_hash: '0xdroppedpropose',
    block_number: '9999',
    created_at: new Date(),
  });

  await assert.rejects(
    () =>
      _withTestOverrides(
        {
          sql: fx.fakeSql,
          publicClientFor: () => fx.fakePub,
          walletClientFor: () => ({ wallet: fx.walletRec.wallet, account: fx.walletRec.account }),
        },
        () => activateVaultEpoch('robinhood'),
      ),
    (err: unknown) => {
      assert.ok(err instanceof EpochActivationJournalMismatch);
      const e = err as EpochActivationJournalMismatch;
      assert.match(e.reason, /status is "reverted"/);
      return true;
    },
  );
  assert.equal(fx.walletRec.calls.length, 0);
});

test('H3 AC #3 + AC #4 successful activation populates activation_tx_hash on the journal row', async () => {
  const fx = makeH3Fixture();
  // Seed a matching broadcast row — legal activation path.
  fx.state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: Number(fx.pendingExpectedId),
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: fx.pendingRoot,
    total_amount: fx.pendingTotal.toString(),
    holder_count: 3,
    status: 'broadcast',
    tx_hash: '0xproposedtx',
    block_number: '9999',
    created_at: new Date(),
  });

  const result = await _withTestOverrides(
    {
      sql: fx.fakeSql,
      publicClientFor: () => fx.fakePub,
      walletClientFor: () => ({ wallet: fx.walletRec.wallet, account: fx.walletRec.account }),
    },
    () => activateVaultEpoch('robinhood'),
  );

  assert.ok(result, 'activation must return non-null on successful path');
  assert.equal(result!.epochId, Number(fx.pendingExpectedId));
  // Exactly one signed tx: the activateEpoch call.
  assert.equal(fx.walletRec.calls.length, 1);
  const decoded = decodeFunctionData({ abi: publishAbi, data: fx.walletRec.calls[0]!.data });
  assert.equal(decoded.functionName, 'activateEpoch');
  // The journal row was promoted to 'confirmed' via finalizePublication AND
  // its activation_tx_hash column carries the freshly-signed tx (distinct
  // from the propose tx already in `tx_hash`).
  assert.equal(fx.state.publications.length, 1);
  const row = fx.state.publications[0]!;
  assert.equal(row.status, 'confirmed');
  assert.equal(row.tx_hash, '0xproposedtx', 'propose tx hash preserved');
  assert.equal(
    row.activation_tx_hash,
    '0x' + 'de'.repeat(32),
    'activation tx hash recorded on the row',
  );
  // rewards_epochs mirrored the confirmation.
  assert.equal(fx.state.epochs.length, 1);
  assert.equal(fx.state.epochs[0]!.merkle_root, fx.pendingRoot);
});

test('H3 AC #2 reconcile with mismatched total flags conflict AND preserves leaves', async () => {
  const state = makeFakeState();
  // Seed a broadcast row whose root matches on-chain but whose total disagrees.
  state.publications.push({
    chain_id: CFG.chainId,
    epoch_id: 9,
    vault_addr: CFG.vaultAddress.toLowerCase(),
    merkle_root: ROOT_A,
    total_amount: '1000',
    holder_count: 2,
    status: 'broadcast',
    tx_hash: '0xproposedtx',
    block_number: '9999',
    created_at: new Date(),
  });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 9, holder: '0xa', amount: '500', proof: [] });
  state.leaves.push({ chain_id: CFG.chainId, epoch_id: 9, holder: '0xb', amount: '500', proof: [] });

  // On-chain landed same root but a DIFFERENT total (e.g. someone re-proposed
  // with an inflated amount and it activated). Must trip conflict — cannot
  // serve proofs summing to 1000 against a live 2000 root.
  const pub = makeFakePub({ 9: [ROOT_A, 2000n, 2000n] });
  const db = makeFakeDb(state);

  await assert.rejects(
    () => reconcilePendingForConfig(CFG, pub, db),
    /conflict at epoch 9: total mismatch/,
  );

  // Row flipped to conflict; leaves DELIBERATELY preserved as forensic
  // evidence of what we intended vs. what landed.
  assert.equal(state.publications.length, 1);
  assert.equal(state.publications[0]!.status, 'conflict');
  assert.equal(state.leaves.length, 2, 'leaves must be preserved for post-mortem');
  assert.equal(state.epochs.length, 0, 'no rewards_epochs mirror for a conflicted row');
});
