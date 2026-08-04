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
/// Runs under Node's built-in `node:test` runner, matching the pattern in
/// `config-id.test.ts`. Uses a minimal in-memory fake `sql` + fake viem
/// public client rather than a real Postgres / RPC — the reconcile logic is
/// pure orchestration around SQL + a single `readContract('epochs', id)`
/// call, so the fakes cover it without dragging a docker container into CI.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcilePendingForConfig,
  resolvePublishAmount,
  withPublicationLockOn,
  type ChainConfig,
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
  status: 'pending' | 'broadcast' | 'confirmed' | 'conflict';
  tx_hash: string | null;
  block_number: string | null;
  created_at: Date;
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

  if (firstFragment.startsWith('SELECT pg_advisory_lock(')) {
    await state.lock.acquire();
    return [];
  }
  if (firstFragment.startsWith('SELECT pg_advisory_unlock(')) {
    state.lock.release();
    return [];
  }

  if (firstFragment.startsWith('SELECT epoch_id, merkle_root, total_amount, holder_count, tx_hash')) {
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

/// Only `readContract({functionName: 'epochs', args: [id]})` is called by
/// reconcile. Returns `[merkleRoot, totalAmount, unclaimed]` per the vault
/// ABI (destructured in rewards.ts as `[root, total]`).
function makeFakePub(
  onchainByEpoch: Record<number, readonly [`0x${string}`, bigint, bigint]>,
): any {
  return {
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly [bigint];
    }) => {
      if (functionName !== 'epochs') {
        throw new Error(`unexpected readContract in reconcile: ${functionName}`);
      }
      const id = Number(args[0]);
      return onchainByEpoch[id] ?? ([ZERO_ROOT, 0n, 0n] as const);
    },
  };
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
