// Unit tests for NftLauncherEarnings render decision logic. Same pattern as
// web/src/components/TokenHolderModules.logic.test.mjs — node --test with .mjs
// so no separate compile step is needed to import the .ts source.
//
// Run:
//   cd web && node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     --test src/components/NftLauncherEarnings.logic.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRows,
  claimButtonState,
  isVisibleForViewer,
  rowKey,
  totalFor,
} from './NftLauncherEarnings.logic.ts';

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB   = '0x2222222222222222222222222222222222222222';
const COL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COL_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const MM_A  = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const MM_B  = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const MM_C  = '0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const URU   = '0xdddddddddddddddddddddddddddddddddddddddd';
const ZERO  = '0x0000000000000000000000000000000000000000';

// ==============================================================
// isVisibleForViewer — the leak-prevention gate. Must render nothing
// on someone else's profile OR when no wallet is connected.
// ==============================================================
test('visibility: hidden when no wallet connected', () => {
  assert.equal(isVisibleForViewer(ALICE, undefined), false);
});

test('visibility: hidden when viewing someone else', () => {
  assert.equal(isVisibleForViewer(ALICE, BOB), false);
});

test('visibility: shown when viewing own profile (case-insensitive)', () => {
  assert.equal(isVisibleForViewer(ALICE, ALICE), true);
  assert.equal(isVisibleForViewer(ALICE.toUpperCase(), ALICE.toLowerCase()), true);
});

// ==============================================================
// buildRows — indexer + on-chain state → renderable rows.
// ==============================================================
test('buildRows: ETH-mode row uses ethBalance, URU-mode uses uruBalance', () => {
  const rows = buildRows([
    { collectionAddress: COL_A, mintModule: MM_A, name: 'chibi', paymentToken: ZERO,
      ethBalance: 100n, uruBalance: 999n },
    { collectionAddress: COL_B, mintModule: MM_B, name: 'gemu',  paymentToken: URU,
      ethBalance: 999n, uruBalance: 200n },
  ]);
  const chibi = rows.find(r => r.name === 'chibi');
  const gemu  = rows.find(r => r.name === 'gemu');
  assert.equal(chibi.mode, 'eth');
  assert.equal(chibi.balance, 100n, 'ETH row ignores uruBalance');
  assert.equal(gemu.mode, 'uru');
  assert.equal(gemu.balance, 200n, 'URU row ignores ethBalance');
});

test('buildRows: rows with balance sort ABOVE zero-balance rows', () => {
  const rows = buildRows([
    { collectionAddress: COL_A, mintModule: MM_A, name: 'aardvark', paymentToken: ZERO,
      ethBalance: 0n, uruBalance: 0n },
    { collectionAddress: COL_B, mintModule: MM_B, name: 'zebra',    paymentToken: ZERO,
      ethBalance: 5n, uruBalance: 0n },
  ]);
  assert.equal(rows[0].name, 'zebra', 'has-balance row first');
  assert.equal(rows[1].name, 'aardvark', 'zero-balance row second even though alphabetically first');
});

test('buildRows: within same has-balance bucket, alphabetical by name', () => {
  const rows = buildRows([
    { collectionAddress: COL_B, mintModule: MM_B, name: 'zebra',    paymentToken: ZERO, ethBalance: 5n, uruBalance: 0n },
    { collectionAddress: COL_A, mintModule: MM_A, name: 'aardvark', paymentToken: ZERO, ethBalance: 5n, uruBalance: 0n },
    { collectionAddress: COL_C, mintModule: MM_C, name: 'moose',    paymentToken: ZERO, ethBalance: 5n, uruBalance: 0n },
  ]);
  assert.deepEqual(rows.map(r => r.name), ['aardvark', 'moose', 'zebra']);
});

test('buildRows: ETH mode detection is case-insensitive on paymentToken', () => {
  const rows = buildRows([
    { collectionAddress: COL_A, mintModule: MM_A, name: 'x', paymentToken: ZERO.toUpperCase(),
      ethBalance: 1n, uruBalance: 0n },
  ]);
  assert.equal(rows[0].mode, 'eth');
});

test('buildRows: empty input → empty output (no crash)', () => {
  assert.deepEqual(buildRows([]), []);
});

// ==============================================================
// totalFor — header aggregation per mode.
// ==============================================================
test('totalFor: sums ETH-mode rows, skips URU', () => {
  const rows = buildRows([
    { collectionAddress: COL_A, mintModule: MM_A, name: 'a', paymentToken: ZERO, ethBalance: 100n, uruBalance: 0n },
    { collectionAddress: COL_B, mintModule: MM_B, name: 'b', paymentToken: ZERO, ethBalance: 50n,  uruBalance: 0n },
    { collectionAddress: COL_C, mintModule: MM_C, name: 'c', paymentToken: URU,  ethBalance: 0n,   uruBalance: 999n },
  ]);
  assert.equal(totalFor('eth', rows), 150n);
  assert.equal(totalFor('uru', rows), 999n);
});

test('totalFor: empty rows → 0', () => {
  assert.equal(totalFor('eth', []), 0n);
  assert.equal(totalFor('uru', []), 0n);
});

// ==============================================================
// claimButtonState — the button-state matrix per row.
// Combines: (balance, chain match, is this row pending?).
// ==============================================================
const ROW_ETH_HAS = {
  collectionAddress: COL_A, mintModule: MM_A, name: 'x', mode: 'eth', balance: 100n,
};
const ROW_ETH_ZERO = { ...ROW_ETH_HAS, balance: 0n };
const ROW_URU_HAS = {
  collectionAddress: COL_B, mintModule: MM_B, name: 'y', mode: 'uru', balance: 100n,
};

test('claimButtonState: zero balance → none (regardless of chain)', () => {
  assert.equal(claimButtonState(ROW_ETH_ZERO, 4663, 4663, null).kind, 'none');
  assert.equal(claimButtonState(ROW_ETH_ZERO, 1,    4663, null).kind, 'none');
  assert.equal(claimButtonState(ROW_ETH_ZERO, undefined, 4663, null).kind, 'none');
});

test('claimButtonState: balance>0 on wrong chain → switch', () => {
  assert.equal(claimButtonState(ROW_ETH_HAS, 1, 4663, null).kind, 'switch');
});

test('claimButtonState: balance>0 wallet disconnected → switch (prompts connect+switch)', () => {
  assert.equal(claimButtonState(ROW_ETH_HAS, undefined, 4663, null).kind, 'switch');
});

test('claimButtonState: balance>0 on correct chain → claim', () => {
  assert.equal(claimButtonState(ROW_ETH_HAS, 4663, 4663, null).kind, 'claim');
});

test('claimButtonState: pending row key matches this row → pending (takes precedence over switch/claim)', () => {
  const k = rowKey(ROW_ETH_HAS);
  assert.equal(claimButtonState(ROW_ETH_HAS, 4663, 4663, k).kind, 'pending');
  // Even on wrong chain, if the tx is in flight for this row, show pending.
  assert.equal(claimButtonState(ROW_ETH_HAS, 1, 4663, k).kind, 'pending');
});

test('claimButtonState: pending key for a DIFFERENT row does not affect this row', () => {
  const otherKey = rowKey(ROW_URU_HAS);
  assert.equal(claimButtonState(ROW_ETH_HAS, 4663, 4663, otherKey).kind, 'claim');
});

test('claimButtonState: pending on zero-balance row still shows none (defensive — shouldnt happen)', () => {
  // If somehow the state raced (tx succeeded, balance zeroed, but pendingKey lingered)
  // we still show none because a zero-balance button would just revert.
  const k = rowKey(ROW_ETH_ZERO);
  assert.equal(claimButtonState(ROW_ETH_ZERO, 4663, 4663, k).kind, 'none');
});

// ==============================================================
// rowKey — stable, mode-aware. Same collection in both modes would produce
// two distinct rows (defensive; contract binds one mode per collection).
// ==============================================================
test('rowKey: same address + different mode → different key', () => {
  const eth = rowKey({ collectionAddress: COL_A, mode: 'eth' });
  const uru = rowKey({ collectionAddress: COL_A, mode: 'uru' });
  assert.notEqual(eth, uru);
});

test('rowKey: case-insensitive on address', () => {
  const lower = rowKey({ collectionAddress: COL_A.toLowerCase(), mode: 'eth' });
  const upper = rowKey({ collectionAddress: COL_A.toUpperCase(), mode: 'eth' });
  assert.equal(lower, upper);
});
