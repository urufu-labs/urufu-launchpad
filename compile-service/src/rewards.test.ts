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

import {
  IndexerHolderCountExceedsCap,
  fetchGemuHoldersFromIndexer,
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
  status: 'pending' | 'broadcast' | 'confirmed' | 'conflict' | 'reverted';
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

  // Activation row lookup — same projection minus `created_at, status`, and
  // filters by epoch_id.
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
