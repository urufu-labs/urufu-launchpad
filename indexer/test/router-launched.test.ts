// GH-13 dual-write test for `Router:Launched` — the new `requestedHook` /
// `requestedGovernance` columns must mirror the launcher-requested flags on
// insert AND the legacy `installedHook` / `installedGovernance` columns must
// carry the same value (backward compat with existing GraphQL consumers in
// web/src/lib/indexer.ts).
//
// The real handler in src/index.ts is bound to '@/generated' and can't be
// imported outside a Ponder build, so we re-implement the insert here as a
// plain function and assert the row shape. Any change to the real handler's
// dual-write must land here too.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';

// Mirror of the exact insert payload built inside `ponder.on('Router:Launched',
// ...)` — grep for `requestedHook: installedHook,` in src/index.ts to verify
// parity.
interface LaunchRow {
  id: string;
  chainId: number;
  tokenAddress: Address;
  launchedBy: Address;
  base: number;
  nameHash: Hex;
  tickerHash: Hex;
  name: string;
  ticker: string;
  configHash: Hex;
  impl: Address | null;
  feePaid: bigint;
  installedHook: boolean;
  installedGovernance: boolean;
  requestedHook: boolean;
  requestedGovernance: boolean;
  installedBondingCurve: boolean;
  curveAddress: Address | null;
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: Hex;
}

function buildInsertPayload(args: {
  event: {
    args: {
      token: Address;
      launchedBy: Address;
      base: bigint;
      nameHash: Hex;
      tickerHash: Hex;
      feePaid: bigint;
      installedHook: boolean;
      installedGovernance: boolean;
    };
    block: { number: bigint; timestamp: bigint };
    transaction: { hash: Hex };
  };
  chainId: number;
  reserved?: { name: string; ticker: string };
  deployed?: { configHash: Hex; impl: Address };
  curve?: { curveAddress: Address };
}): LaunchRow {
  const { event, chainId, reserved, deployed, curve } = args;
  const { token, launchedBy, base, nameHash, tickerHash, feePaid, installedHook, installedGovernance } =
    event.args;
  return {
    id: `${chainId}-${token.toLowerCase()}`,
    chainId,
    tokenAddress: token,
    launchedBy,
    base: Number(base),
    nameHash,
    tickerHash,
    name: reserved?.name ?? '',
    ticker: reserved?.ticker ?? '',
    configHash: deployed?.configHash ?? ('0x' as Hex),
    impl: deployed?.impl ?? null,
    feePaid,
    installedHook,
    installedGovernance,
    requestedHook: installedHook,
    requestedGovernance: installedGovernance,
    installedBondingCurve: curve !== undefined,
    curveAddress: curve?.curveAddress ?? null,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  };
}

const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01' as Address;
const LAUNCHER = '0x1111111111111111111111111111111111111111' as Address;
const TX = ('0x' + 'ab'.repeat(32)) as Hex;
const NAME_HASH = ('0x' + '11'.repeat(32)) as Hex;
const TICKER_HASH = ('0x' + '22'.repeat(32)) as Hex;

function baseEvent(hook = false, gov = false) {
  return {
    args: {
      token: TOKEN,
      launchedBy: LAUNCHER,
      base: 0n,
      nameHash: NAME_HASH,
      tickerHash: TICKER_HASH,
      feePaid: 100n,
      installedHook: hook,
      installedGovernance: gov,
    },
    block: { number: 1n, timestamp: 1000n },
    transaction: { hash: TX },
  };
}

test('dual-write: requestedHook and installedHook both true when launcher asked', () => {
  const row = buildInsertPayload({ event: baseEvent(true, false), chainId: 4663 });
  assert.equal(row.installedHook, true, 'legacy column keeps original value');
  assert.equal(row.requestedHook, true, 'new honest-named column carries same value');
  assert.equal(row.installedGovernance, false);
  assert.equal(row.requestedGovernance, false);
});

test('dual-write: requestedGovernance and installedGovernance both true when asked', () => {
  const row = buildInsertPayload({ event: baseEvent(false, true), chainId: 4663 });
  assert.equal(row.installedGovernance, true);
  assert.equal(row.requestedGovernance, true);
  assert.equal(row.installedHook, false);
  assert.equal(row.requestedHook, false);
});

test('dual-write: neither requested → both pairs false', () => {
  const row = buildInsertPayload({ event: baseEvent(false, false), chainId: 4663 });
  assert.equal(row.installedHook, false);
  assert.equal(row.requestedHook, false);
  assert.equal(row.installedGovernance, false);
  assert.equal(row.requestedGovernance, false);
});

test('dual-write: both requested → all four fields true', () => {
  const row = buildInsertPayload({ event: baseEvent(true, true), chainId: 4663 });
  assert.equal(row.installedHook, true);
  assert.equal(row.requestedHook, true);
  assert.equal(row.installedGovernance, true);
  assert.equal(row.requestedGovernance, true);
});

test('dual-write: requested* columns exist on the payload (schema shape lock)', () => {
  const row = buildInsertPayload({ event: baseEvent(true, false), chainId: 4663 });
  // A refactor that accidentally dropped either column would fail this
  // test — the schema requires both.
  assert.ok('requestedHook' in row, 'requestedHook must be in the insert payload');
  assert.ok('requestedGovernance' in row, 'requestedGovernance must be in the insert payload');
  assert.ok('installedHook' in row, 'installedHook (legacy) must still be present');
  assert.ok('installedGovernance' in row, 'installedGovernance (legacy) must still be present');
});
