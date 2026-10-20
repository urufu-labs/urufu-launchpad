// node --experimental-strip-types --disable-warning=ExperimentalWarning --test src/lib/fairFeed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fairRowToLaunch, mergeFairLaunches } from './fairFeed.ts';

const row = {
  id: '4663-0xaaaa',
  chainId: 4663,
  tokenAddress: '0xaaaa',
  curveAddress: '0xcccc',
  launcher: '0xdddd',
  name: 'Fair Coin',
  ticker: 'FAIR',
  feePaid: '1000000000000000',
  feeInUru: false,
  createdAt: '200',
  blockNumber: '93600000',
  txHash: '0x01',
};

test('Fair row maps onto the launch shape', () => {
  const l = fairRowToLaunch(row);
  assert.equal(l.launchedBy, '0xdddd');
  assert.equal(l.blockTimestamp, '200');
  assert.equal(l.curveAddress, '0xcccc');
  assert.equal(l.base, 0);
  assert.equal(l.installedBondingCurve, true);
  assert.equal(l.payToken, 'ETH');
  assert.equal(l.feePaid, '1000000000000000');
  assert.equal(l.uruPaid, null);
  assert.equal(l.lane, 'fair');
});

test('URU-paid Fair launch reports the URU amount, not an ETH fee', () => {
  const l = fairRowToLaunch({ ...row, feeInUru: true, feePaid: '1000000000000000000000' });
  assert.equal(l.payToken, 'URU');
  assert.equal(l.uruPaid, '1000000000000000000000');
  assert.equal(l.feePaid, '0');
});

test('merge dedupes by id and sorts newest first', () => {
  const a = { id: 'a', blockTimestamp: '100' };
  const b = { id: 'b', blockTimestamp: '300' };
  const c = { id: 'c', blockTimestamp: '200' };
  const merged = mergeFairLaunches([a, b], [c, { id: 'a', blockTimestamp: '100' }]);
  assert.deepEqual(merged.map((r) => r.id), ['b', 'c', 'a']);
});
