// Robinhood RPC range errors get a hint Ponder 0.7 understands. The error
// strings are the exact ones the providers returned on 2026-10-17.

import assert from 'node:assert/strict';
import test from 'node:test';

import { rangeHintFor, withRangeHints } from '../rpcRangeHints.ts';

const params = (from: number, to: number) => [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] as const;

// The regex Ponder's getLogsRetryHelper uses for this phrase.
const PONDER_PATTERN = /maximum block range: ([\d,.]+)/;

test('Infura "exceeds limit of 10000" -> 9999 (10000 blocks)', () => {
  assert.equal(rangeHintFor('{"code":-32602,"message":"range 10001 exceeds limit of 10000"}', params(1, 10001)), 9999);
});

test('dRPC "ranges over 10000 blocks" -> 9999', () => {
  assert.equal(rangeHintFor('ranges over 10000 blocks are not supported on free plan', params(1, 10514)), 9999);
});

test('ordofi "busy" on a wide request -> 1999 (2000 blocks)', () => {
  assert.equal(rangeHintFor('the network is busy, please try again in a moment', params(100, 10612)), 1999);
});

test('ordofi "busy" on a narrow request is left alone (real rate limit)', () => {
  assert.equal(rangeHintFor('the network is busy, please try again in a moment', params(100, 1099)), null);
});

test('unrelated errors are left alone', () => {
  assert.equal(rangeHintFor('execution reverted', params(1, 50000)), null);
  assert.equal(rangeHintFor('429 Too Many Requests', params(1, 50000)), null);
});

test('wrapper adds the hint to details for eth_getLogs and rethrows the same error', async () => {
  const original = Object.assign(new Error('RPC Request failed.'), {
    code: -32602,
    details: 'range 10514 exceeds limit of 10000',
  });
  const fake = (() => ({ config: {}, value: undefined, request: async () => { throw original; } })) as never;
  const t = withRangeHints(fake)({} as never);
  await assert.rejects(t.request({ method: 'eth_getLogs', params: params(1, 10514) } as never), (err: unknown) => {
    assert.equal(err, original);
    const m = JSON.stringify(err).match(PONDER_PATTERN);
    assert.ok(m, 'Ponder pattern should match');
    assert.equal(m![1], '9999');
    assert.equal((err as { code: number }).code, -32602);
    return true;
  });
});

test('wrapper leaves non-getLogs calls untouched', async () => {
  const original = Object.assign(new Error('x'), { details: 'range 10514 exceeds limit of 10000' });
  const fake = (() => ({ config: {}, value: undefined, request: async () => { throw original; } })) as never;
  const t = withRangeHints(fake)({} as never);
  await assert.rejects(t.request({ method: 'eth_blockNumber' } as never), (err: unknown) => {
    assert.equal((err as { details: string }).details, 'range 10514 exceeds limit of 10000');
    return true;
  });
});

test('wrapper passes successful results through', async () => {
  const fake = (() => ({ config: {}, value: undefined, request: async () => ['log'] })) as never;
  const t = withRangeHints(fake)({} as never);
  assert.deepEqual(await t.request({ method: 'eth_getLogs', params: params(1, 2) } as never), ['log']);
});
