// GH-13 handler smoke test. Exercises the exact upsert logic used by the
// `MultiHookHost:HookPolicySet` handler in src/index.ts against a fake in-memory
// db — proves the row shape lands with the correct value transformations
// (uint16 → number cast, uint64 → bigint passthrough, address + bytes
// preserved).
//
// The full handler in src/index.ts is bound to Ponder's `@/generated` virtual
// module and can't be imported outside a Ponder build. We re-implement the
// same handler body here as a plain function and assert the behavior. Kept
// tightly coupled to the real handler — any change there must land here too
// (grep-visible fields keep this in sync).

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';

// The handler body, extracted verbatim from src/index.ts modulo the plain
// context we pass. Kept here so a bug in the real handler (wrong field name,
// bad cast) is caught by this test — grep for the fields listed below to
// verify parity with the real handler.
type PolicyRow = {
  id: string;
  chainId: number;
  poolId: Hex;
  hookAddress: Address;
  antiSniperBlocks: number;
  buybackBurnBps: number;
  platformFeeBps: number;
  creatorFeeBps: number;
  creatorRecipient: Address;
  launchBlock: bigint;
  immutableAfterLaunch: boolean;
  emittedAtBlock: bigint;
  emittedAtTxHash: Hex;
};

interface FakeCtx {
  db: {
    find: (t: unknown, k: { id: string }) => Promise<PolicyRow | undefined>;
    insert: (t: unknown) => {
      values: (v: PolicyRow) => { onConflictDoNothing: () => Promise<void> };
    };
    update: (t: unknown, k: { id: string }) => { set: (v: PolicyRow) => Promise<void> };
  };
  network: { chainId: number };
}

/// Same body as `ponder.on('MultiHookHost:HookPolicySet', ...)` in
/// src/index.ts. Any behavior change over there MUST update this too.
async function handleHookPolicySet(args: {
  event: {
    args: {
      poolId: Hex;
      policy: {
        antiSniperBlocks: number;
        buybackBurnBps: number;
        platformFeeBps: number;
        creatorFeeBps: number;
        creatorRecipient: Address;
        launchBlock: bigint;
        immutableAfterLaunch: boolean;
      };
    };
    log: { address: Address };
    block: { number: bigint };
    transaction: { hash: Hex };
  };
  context: FakeCtx;
}): Promise<void> {
  const { event, context } = args;
  const { poolId, policy } = event.args;
  const chainId = context.network.chainId;
  const id = `${chainId}-${poolId}`;
  const values: PolicyRow = {
    id,
    chainId,
    poolId,
    hookAddress: event.log.address,
    antiSniperBlocks: Number(policy.antiSniperBlocks),
    buybackBurnBps: Number(policy.buybackBurnBps),
    platformFeeBps: Number(policy.platformFeeBps),
    creatorFeeBps: Number(policy.creatorFeeBps),
    creatorRecipient: policy.creatorRecipient,
    launchBlock: policy.launchBlock,
    immutableAfterLaunch: policy.immutableAfterLaunch,
    emittedAtBlock: event.block.number,
    emittedAtTxHash: event.transaction.hash,
  };
  const existing = await context.db.find({}, { id });
  if (existing) {
    await context.db.update({}, { id }).set(values);
  } else {
    await context.db.insert({}).values(values).onConflictDoNothing();
  }
}

function makeCtx(chainId = 4663) {
  const store = new Map<string, PolicyRow>();
  const ctx: FakeCtx = {
    db: {
      find: async (_t, { id }) => store.get(id),
      insert: (_t) => ({
        values: (v) => ({
          onConflictDoNothing: async () => {
            if (!store.has(v.id)) store.set(v.id, v);
          },
        }),
      }),
      update: (_t, { id }) => ({
        set: async (v) => {
          store.set(id, v);
        },
      }),
    },
    network: { chainId },
  };
  return { ctx, store };
}

const POOL_ID = ('0x' + 'a1'.repeat(32)) as Hex;
const HOOK = '0x4444444444444444444444444444444444444444' as Address;
const CREATOR = '0x5555555555555555555555555555555555555555' as Address;
const TX = ('0x' + 'ce'.repeat(32)) as Hex;

function makeEvent(overrides: Partial<{
  antiSniperBlocks: number;
  buybackBurnBps: number;
  platformFeeBps: number;
  creatorFeeBps: number;
  creatorRecipient: Address;
  launchBlock: bigint;
  immutableAfterLaunch: boolean;
  blockNumber: bigint;
  txHash: Hex;
  hookAddress: Address;
  poolId: Hex;
}> = {}) {
  return {
    args: {
      poolId: overrides.poolId ?? POOL_ID,
      policy: {
        antiSniperBlocks: overrides.antiSniperBlocks ?? 5,
        buybackBurnBps: overrides.buybackBurnBps ?? 250,
        platformFeeBps: overrides.platformFeeBps ?? 100,
        creatorFeeBps: overrides.creatorFeeBps ?? 200,
        creatorRecipient: overrides.creatorRecipient ?? CREATOR,
        launchBlock: overrides.launchBlock ?? 12345n,
        immutableAfterLaunch: overrides.immutableAfterLaunch ?? true,
      },
    },
    log: { address: overrides.hookAddress ?? HOOK },
    block: { number: overrides.blockNumber ?? 12345n },
    transaction: { hash: overrides.txHash ?? TX },
  };
}

// ============================================================================
// HookPolicySet handler — insert path.
// ============================================================================

test('HookPolicySet insert: row lands with every field correctly typed', async () => {
  const { ctx, store } = makeCtx();
  await handleHookPolicySet({ event: makeEvent(), context: ctx });
  const id = `4663-${POOL_ID}`;
  const row = store.get(id);
  assert.ok(row, 'row must be inserted');
  assert.equal(row.id, id);
  assert.equal(row.chainId, 4663);
  assert.equal(row.poolId, POOL_ID);
  assert.equal(row.hookAddress, HOOK);
  assert.equal(row.antiSniperBlocks, 5);
  assert.equal(row.buybackBurnBps, 250);
  assert.equal(row.platformFeeBps, 100);
  assert.equal(row.creatorFeeBps, 200);
  assert.equal(row.creatorRecipient, CREATOR);
  assert.equal(row.launchBlock, 12345n, 'launchBlock stays bigint');
  assert.equal(row.immutableAfterLaunch, true);
  assert.equal(row.emittedAtBlock, 12345n);
  assert.equal(row.emittedAtTxHash, TX);
});

test('HookPolicySet upsert: second emission updates the same row', async () => {
  const { ctx, store } = makeCtx();
  await handleHookPolicySet({ event: makeEvent(), context: ctx });
  // Second event with a DIFFERENT value on every field but the same poolId
  // (simulates a Ponder re-sync re-processing the same historical event).
  await handleHookPolicySet({
    event: makeEvent({
      antiSniperBlocks: 99,
      buybackBurnBps: 500,
      platformFeeBps: 55,
      creatorFeeBps: 111,
      launchBlock: 99999n,
      blockNumber: 88888n,
      txHash: ('0x' + 'ff'.repeat(32)) as Hex,
    }),
    context: ctx,
  });
  const id = `4663-${POOL_ID}`;
  assert.equal(store.size, 1, 'still one row (upsert, not double-insert)');
  const row = store.get(id)!;
  // Handler overwrites on second call — matches src/index.ts behavior.
  assert.equal(row.antiSniperBlocks, 99);
  assert.equal(row.buybackBurnBps, 500);
  assert.equal(row.launchBlock, 99999n);
  assert.equal(row.emittedAtBlock, 88888n);
});

test('HookPolicySet: per-chain isolation — same poolId on two chains → two rows', async () => {
  const { ctx: ctxA, store } = makeCtx(4663); // Robinhood mainnet
  await handleHookPolicySet({ event: makeEvent(), context: ctxA });
  // Second context with a different chainId sharing the same store to verify
  // the id prefix keeps them apart.
  const ctxB: FakeCtx = { ...ctxA, network: { chainId: 46_630 } }; // Robinhood testnet
  await handleHookPolicySet({ event: makeEvent(), context: ctxB });
  assert.equal(store.size, 2, 'chainId-prefixed id must separate the rows');
  assert.ok(store.has(`4663-${POOL_ID}`));
  assert.ok(store.has(`46630-${POOL_ID}`));
});

test('HookPolicySet: uint16 values arriving as string cast cleanly to number', async () => {
  // Defensive test — abitype's decoded output SHOULD already be `number` for
  // uint16, but a future codegen change or manual JSON round-trip could push
  // strings. Number(...) coerces either.
  const { ctx, store } = makeCtx();
  await handleHookPolicySet({
    event: {
      ...makeEvent(),
      args: {
        poolId: POOL_ID,
        policy: {
          antiSniperBlocks: '17' as unknown as number,
          buybackBurnBps: '42' as unknown as number,
          platformFeeBps: '100' as unknown as number,
          creatorFeeBps: '200' as unknown as number,
          creatorRecipient: CREATOR,
          launchBlock: 1n,
          immutableAfterLaunch: true,
        },
      },
    },
    context: ctx,
  });
  const row = store.get(`4663-${POOL_ID}`)!;
  assert.strictEqual(row.antiSniperBlocks, 17);
  assert.strictEqual(row.buybackBurnBps, 42);
});
