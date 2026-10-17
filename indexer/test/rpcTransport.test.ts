// eth_getLogs router in front of the Robinhood RPC fallback. Every error the
// router throws is fed to the same @ponder/utils getLogsRetryHelper (0.2.3)
// that Ponder 0.7.17's historical sync uses, so "Ponder can act on it" is
// checked against Ponder's real parser, not a copy of its regexes.
//
// Error strings are the exact ones the providers returned on 2026-10-17.
// End-to-end evidence through Ponder's own sync: scripts/replay-getlogs.ts.

import assert from 'node:assert/strict';
import test from 'node:test';

import { getLogsRetryHelper } from '@ponder/utils';
import { custom, fallback, ResponseBodyTooLargeError, RpcRequestError, type Transport } from 'viem';

import { GetLogsRangeHint, maxBlocksFor, withGetLogsRouter } from '../rpcTransport.ts';

const hex = (n: number) => `0x${n.toString(16)}` as const;
const range = (from: number, to: number) => [{ fromBlock: hex(from), toBlock: hex(to), topics: [] }] as const;

type Call = { ep: string; method: string };

/// A fake RPC: `answer` returns a result or throws a JSON-RPC error.
function rpc(name: string, calls: Call[], answer: (method: string, params: unknown) => unknown): Transport {
  return custom({
    async request({ method, params }) {
      calls.push({ ep: name, method });
      const r = answer(method, params);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

const rpcError = (code: number, message: string) =>
  new RpcRequestError({ body: {}, error: { code, message }, url: 'http://fake' });

const OFFICIAL_SPAN = rpcError(-32602, 'query spans 100000 blocks (90356828 to 90456827), but only 30000 are allowed for this request; narrow the block range, or add an address filter');
const OFFICIAL_LOGS = rpcError(-32000, 'logs matched by query exceeds limit of 10000');
const THROTTLED = rpcError(-32005, 'the network is busy, please try again in a moment');
const DRPC = rpcError(35, 'ranges over 10000 blocks are not supported on free plan');

/// Build the router over named fake endpoints (in priority order).
function router(eps: { name: string; maxBlocks: number; answer: (m: string, p: unknown) => unknown }[]) {
  const calls: Call[] = [];
  const transports = eps.map((e) => ({ ...e, transport: rpc(e.name, calls, e.answer) }));
  const inner = fallback(transports.map((e) => e.transport));
  const t = withGetLogsRouter(inner, transports)({ chain: undefined, retryCount: 0 });
  return { t, calls };
}

async function ponderSees(request: Promise<unknown>, params: ReturnType<typeof range>) {
  const err = await request.then(
    () => assert.fail('expected the request to fail'),
    (e) => e as Error & { code?: number },
  );
  return { err, helper: getLogsRetryHelper({ params: params as never, error: err as never }) };
}

const ok = () => ['log'];

test('caps by host: official 30k, Infura 10k (keyed path ignored), ordofi 2k, dRPC off, unknown uncapped', () => {
  assert.equal(maxBlocksFor('https://rpc.mainnet.chain.robinhood.com'), 30_000);
  assert.equal(maxBlocksFor('https://robinhood-mainnet.infura.io/v3/somekey'), 10_000);
  assert.equal(maxBlocksFor('https://rpc.ordofi.network'), 2_000);
  assert.equal(maxBlocksFor('https://robinhood.drpc.org'), 0);
  assert.equal(maxBlocksFor('https://example.com'), Number.POSITIVE_INFINITY);
});

test('the window that crashed prod, official excluded: Ponder gets a parseable 1999-block hint, dRPC is never asked', async () => {
  const { t, calls } = router([
    { name: 'ordofi', maxBlocks: 2_000, answer: ok },
    { name: 'drpc', maxBlocks: 0, answer: () => DRPC },
  ]);
  const params = range(90446315, 90456827);
  const { err, helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.ok(err instanceof GetLogsRangeHint);
  assert.equal(helper.shouldRetry, true);
  assert.equal(helper.shouldRetry && helper.isSuggestedRange, true);
  // Ponder's retry: estimated/confirmed range = to - from of the first chunk.
  assert.equal(helper.shouldRetry && Number(BigInt(helper.ranges[0]!.toBlock) - BigInt(helper.ranges[0]!.fromBlock)), 1999);
  assert.deepEqual(calls, []);
});

test('a range an endpoint can serve goes to it; narrower ones and dRPC are skipped', async () => {
  const { t, calls } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => THROTTLED },
    { name: 'infura', maxBlocks: 10_000, answer: ok },
    { name: 'ordofi', maxBlocks: 2_000, answer: ok },
    { name: 'drpc', maxBlocks: 0, answer: () => DRPC },
  ]);
  assert.deepEqual(await t.request({ method: 'eth_getLogs', params: range(1, 9_999) } as never), ['log']);
  assert.deepEqual(calls.map((c) => c.ep), ['official', 'infura']);
});

test('official throttled on a 25k range: hint drops to the next cap (Infura 10k)', async () => {
  const { t, calls } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => THROTTLED },
    { name: 'infura', maxBlocks: 10_000, answer: ok },
    { name: 'ordofi', maxBlocks: 2_000, answer: ok },
  ]);
  const params = range(1, 25_000);
  const { err, helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.ok(err instanceof GetLogsRangeHint);
  assert.equal(helper.shouldRetry && Number(BigInt(helper.ranges[0]!.toBlock) - BigInt(helper.ranges[0]!.fromBlock)), 9999);
  assert.deepEqual(calls.map((c) => c.ep), ['official']);
});

test('request exactly one block wider than a cap still produces a usable hint', async () => {
  const { t } = router([{ name: 'ordofi', maxBlocks: 2_000, answer: ok }, { name: 'drpc', maxBlocks: 0, answer: ok }]);
  const params = range(100, 2_100); // 2001 blocks
  const { helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(helper.shouldRetry, true);
});

test('every capable endpoint throttled: -32005, which Ponder retries with backoff instead of failing', async () => {
  const { t } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => THROTTLED },
    { name: 'ordofi', maxBlocks: 2_000, answer: () => THROTTLED },
    { name: 'drpc', maxBlocks: 0, answer: () => DRPC },
  ]);
  const params = range(1, 1_000);
  const { err, helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(helper.shouldRetry, false);
  assert.equal(err.code, -32005); // requestQueue.shouldRetry: LimitExceededRpcError.code -> retry
});

test('last error has a code Ponder does not retry (35): still surfaces as -32005', async () => {
  const { t } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => THROTTLED },
    { name: 'odd', maxBlocks: 30_000, answer: () => DRPC },
  ]);
  const params = range(1, 1_000);
  const { err } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(err.code, -32005);
});

test('an error Ponder already parses is passed through (official log-count limit)', async () => {
  const { t } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => OFFICIAL_LOGS },
    { name: 'drpc', maxBlocks: 0, answer: ok },
  ]);
  const params = range(1, 20_000);
  const { err, helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(err.code, -32000);
  assert.equal(helper.shouldRetry, true);
});

test("official's 30k span error is never reached: wider ranges are hinted down before it's asked", async () => {
  const { t, calls } = router([{ name: 'official', maxBlocks: 30_000, answer: () => OFFICIAL_SPAN }]);
  const params = range(1, 100_000);
  const { helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(helper.shouldRetry && Number(BigInt(helper.ranges[0]!.toBlock) - BigInt(helper.ranges[0]!.fromBlock)), 29_999);
  assert.deepEqual(calls, []);
});

test("a reply over viem's 10 MB body cap halves the range", async () => {
  const tooLarge = new ResponseBodyTooLargeError({ maxSize: 10_485_760, size: 10_502_144 });
  const { t } = router([{ name: 'ordofi', maxBlocks: 2_000, answer: () => tooLarge }]);
  const params = range(1, 2_000);
  const { helper } = await ponderSees(t.request({ method: 'eth_getLogs', params } as never), params);
  assert.equal(helper.shouldRetry && Number(BigInt(helper.ranges[0]!.toBlock) - BigInt(helper.ranges[0]!.fromBlock)), 999);
});

test('everything else uses the fallback unchanged: blocks, and getLogs by blockHash', async () => {
  const { t, calls } = router([
    { name: 'official', maxBlocks: 30_000, answer: () => THROTTLED },
    { name: 'drpc', maxBlocks: 0, answer: (m) => (m === 'eth_getLogs' ? ['bylog'] : { number: '0x1' }) },
  ]);
  assert.deepEqual(await t.request({ method: 'eth_getBlockByNumber', params: ['0x1', true] } as never), { number: '0x1' });
  assert.deepEqual(await t.request({ method: 'eth_getLogs', params: [{ blockHash: '0xab' }] } as never), ['bylog']);
  assert.deepEqual(calls.map((c) => c.ep), ['official', 'drpc', 'official', 'drpc']);
});

test('realtime calls rotate across the given fallbacks; ranged getLogs keeps the configured order', async () => {
  const calls: Call[] = [];
  const official = rpc('official', calls, () => ({ number: '0x1' }));
  const ordofi = rpc('ordofi', calls, () => ({ number: '0x1' }));
  const t = withGetLogsRouter(
    [fallback([official, ordofi]), fallback([ordofi, official])],
    [{ name: 'official', transport: official, maxBlocks: 30_000 }, { name: 'ordofi', transport: ordofi, maxBlocks: 2_000 }],
  )({ chain: undefined, retryCount: 0 });
  for (let i = 0; i < 4; i++) await t.request({ method: 'eth_getBlockByNumber', params: ['0x1', true] } as never);
  await t.request({ method: 'eth_getLogs', params: range(1, 100) } as never);
  assert.deepEqual(calls.map((c) => c.ep), ['official', 'ordofi', 'official', 'ordofi', 'official']);
});

test('the router keeps the fallback shape Ponder inspects for its RPC-URL warning', () => {
  const { t } = router([{ name: 'a', maxBlocks: 1, answer: ok }, { name: 'b', maxBlocks: 1, answer: ok }]);
  assert.equal(t.config.type, 'fallback');
  assert.equal((t.value as { transports: unknown[] }).transports.length, 2);
});
