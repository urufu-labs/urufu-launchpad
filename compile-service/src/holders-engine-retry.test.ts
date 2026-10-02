// 429 resilience + incremental progress for the holder engine (2026-10-02).
// Live bug: POST /wl/snapshot for URU failed with "rpc http 429" after ~24 s
// because rpcCall gave up after 6 short retries and the scan discarded all
// progress. Now: jittered backoff with Retry-After, a time budget instead of a
// retry count, and range-by-range commits.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backoffDelay,
  cachedHolderState,
  holdersFromState,
  parseRetryAfter,
  rpcCall,
  scanHolders,
  _resetHolderCache,
  TRANSFER_TOPIC,
  type RawLog,
} from './holders-engine.ts';

const Z = '0x0000000000000000000000000000000000000000';
const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const topicAddr = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const u256 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
let li = 0;
const t20 = (b: number, from: string, to: string, v: bigint): RawLog => ({
  topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)],
  data: `0x${u256(v)}`,
  blockNumber: `0x${b.toString(16)}`,
  logIndex: `0x${(li++).toString(16)}`,
});

function mockRpc(handler: (body: { method: string; params: any[] }) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ method: string; params: any[] }> = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const r = handler(body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchImpl, calls, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

test('parseRetryAfter: seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
});

test('backoffDelay grows with attempts and is capped at 60s', () => {
  assert.equal(backoffDelay(0, () => 0), 500);
  assert.equal(backoffDelay(3, () => 0.999), 3996);
  assert.equal(backoffDelay(30, () => 0.999999), 59999);
});

test('rpcCall honors Retry-After on 429', async () => {
  _resetHolderCache();
  let n = 0;
  const m = mockRpc(() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '3' } } : { json: { jsonrpc: '2.0', id: 1, result: '0x2a' } }));
  const r = await rpcCall<string>('http://x', 'eth_blockNumber', [], m);
  assert.equal(r, '0x2a');
  assert.ok(m.sleeps.some((ms) => ms >= 3000), `expected a >=3000ms wait, got ${m.sleeps.join(',')}`);
});

test('rpcCall survives a long run of 429s (old policy gave up after 6)', async () => {
  _resetHolderCache();
  let n = 0;
  const m = mockRpc(() => (n++ < 25 ? { status: 429 } : { json: { jsonrpc: '2.0', id: 1, result: '0x1' } }));
  assert.equal(await rpcCall<string>('http://x', 'eth_blockNumber', [], m), '0x1');
  assert.equal(m.calls.length, 26);
});

test('rpcCall gives up once the retry budget is spent', async () => {
  _resetHolderCache();
  let clock = 0;
  const m = mockRpc(() => ({ status: 429 }));
  await assert.rejects(
    rpcCall<string>('http://x', 'eth_blockNumber', [], {
      fetchImpl: m.fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      retryBudgetMs: 120_000,
    }),
    /rpc http 429/,
  );
  assert.ok(clock >= 120_000);
});

test('scanHolders keeps committed ranges when a later range fails, and resumes from there', async () => {
  _resetHolderCache();
  const url = 'http://resume';
  let failSecondRange = true;
  const m = mockRpc(({ method, params }) => {
    if (method !== 'eth_getLogs') return { json: { jsonrpc: '2.0', id: 1, result: '0x0' } };
    const from = BigInt(params[0].fromBlock);
    if (from === 0n) return { json: { jsonrpc: '2.0', id: 1, result: [t20(5, Z, A, 7n)] } };
    if (failSecondRange) return { json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } } };
    return { json: { jsonrpc: '2.0', id: 1, result: [t20(1500, Z, B, 3n)] } };
  });
  await assert.rejects(scanHolders({ rpcUrl: url, address: A, toBlock: 1_999n, maxRange: 1_000n, ...m }), /boom/);
  const partial = cachedHolderState(url, A)!;
  assert.equal(partial.lastBlock, 999n, 'first range committed');
  assert.deepEqual(holdersFromState(partial).map((r) => [r.address, r.balance]), [[A, 7n]]);

  failSecondRange = false;
  m.calls.length = 0;
  const done = await scanHolders({ rpcUrl: url, address: A, toBlock: 1_999n, maxRange: 1_000n, ...m });
  const logCalls = m.calls.filter((c) => c.method === 'eth_getLogs');
  assert.equal(logCalls.length, 1, 'only the missing range is fetched on retry');
  assert.equal(BigInt(logCalls[0]!.params[0].fromBlock), 1_000n);
  assert.equal(done.lastBlock, 1_999n);
  assert.deepEqual(holdersFromState(done).map((r) => [r.address, r.balance]), [[A, 7n], [B, 3n]]);

  // A retry after completion makes no log calls at all (cached).
  m.calls.length = 0;
  await scanHolders({ rpcUrl: url, address: A, toBlock: 1_999n, maxRange: 1_000n, ...m });
  assert.equal(m.calls.filter((c) => c.method === 'eth_getLogs').length, 0);
});
