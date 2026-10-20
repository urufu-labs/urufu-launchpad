import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, toHex } from 'viem';

import {
  BANK_BURN_THRESHOLD_WEI,
  FAIR_POOL_INITIALIZED,
  chunkRanges,
  fairBankConfig,
  poolsToBurn,
} from './fairBank.ts';

test('fairBankConfig needs every env var and a numeric start block', () => {
  const full = {
    ROBINHOOD_RPC_URL: 'http://x',
    KEEPER_PRIVATE_KEY: 'ab'.repeat(32),
    ROBINHOOD_FAIR_HOOK_HOST_ADDRESS: '0x00000000000000000000000000000000000028C4',
    ROBINHOOD_FAIR_HOOK_START_BLOCK: '123',
  };
  const cfg = fairBankConfig(full);
  assert.ok(cfg);
  assert.equal(cfg.startBlock, 123n);
  assert.ok(cfg.keeperKey.startsWith('0x'));
  for (const k of Object.keys(full)) {
    assert.equal(fairBankConfig({ ...full, [k]: '' }), null, `${k} missing should disable the loop`);
  }
  assert.equal(fairBankConfig({ ...full, ROBINHOOD_FAIR_HOOK_START_BLOCK: 'abc' }), null);
});

test('chunkRanges covers the range exactly in 50k chunks', () => {
  assert.deepEqual(chunkRanges(10n, 9n), []);
  assert.deepEqual(chunkRanges(1n, 1n), [[1n, 1n]]);
  const r = chunkRanges(100n, 120_000n);
  assert.deepEqual(r[0], [100n, 50_099n]);
  assert.deepEqual(r[r.length - 1], [100_100n, 120_000n]);
  for (let i = 1; i < r.length; i++) assert.equal(r[i]![0], r[i - 1]![1] + 1n);
});

test('poolsToBurn skips banks under the threshold', () => {
  const a = '0x' + '1'.repeat(64);
  const b = '0x' + '2'.repeat(64);
  const out = poolsToBurn([
    { poolId: a as `0x${string}`, banked: BANK_BURN_THRESHOLD_WEI },
    { poolId: b as `0x${string}`, banked: BANK_BURN_THRESHOLD_WEI - 1n },
  ]);
  assert.deepEqual(out, [a]);
});

test('FairPoolInitialized ABI matches the Solidity event signature', () => {
  const sig =
    'FairPoolInitialized(bytes32,address,address,uint256,bool,uint64,uint16,uint32,uint16)';
  assert.equal(FAIR_POOL_INITIALIZED.name, 'FairPoolInitialized');
  assert.equal(
    keccak256(toHex(sig)),
    keccak256(toHex(`FairPoolInitialized(${FAIR_POOL_INITIALIZED.inputs.map((i) => i.type).join(',')})`)),
  );
});
