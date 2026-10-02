import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyLogs,
  holdersFromState,
  newState,
  getTransferLogs,
  rpcCall,
  scanHolders,
  _resetHolderCache,
  TRANSFER_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_BATCH_TOPIC,
  type RawLog,
} from './holders-engine.ts';
import { pageHolders } from './routes/nft-holders.ts';
import { toNftAvatar, firstRenderableUrl } from './routes/nft-avatar.ts';

const Z = '0x0000000000000000000000000000000000000000';
const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const C = '0x00000000000000000000000000000000000000cc';
const topicAddr = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const u256 = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
let li = 0;
const log = (block: number, topics: string[], data = '0x'): RawLog => ({
  topics,
  data,
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${(li++).toString(16)}`,
});
const t721 = (b: number, from: string, to: string, id: number) =>
  log(b, [TRANSFER_TOPIC, topicAddr(from), topicAddr(to), `0x${u256(id)}`]);
const t20 = (b: number, from: string, to: string, v: bigint) =>
  log(b, [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], `0x${u256(v)}`);

test('ERC-721: mint, transfer and burn give exact owners and token ids', () => {
  const s = newState();
  applyLogs(s, [
    t721(10, Z, A, 1), t721(10, Z, A, 2), t721(11, Z, B, 3),
    t721(12, A, B, 2),   // A -> B
    t721(13, B, Z, 3),   // burn 3
  ]);
  assert.equal(s.standard, 'erc721');
  const rows = holdersFromState(s);
  assert.deepEqual(rows.map((r) => [r.address, r.balance, r.tokenIds]), [
    [A, 1n, ['1']],
    [B, 1n, ['2']],
  ]);
});

test('logs are applied in chain order even when delivered out of order', () => {
  const s = newState();
  const mint = t721(5, Z, A, 7);
  const move = t721(6, A, B, 7);
  applyLogs(s, [move, mint]);
  assert.deepEqual(holdersFromState(s).map((r) => r.address), [B]);
});

test('ERC-20: balances net out, zero balances drop, minBalance filters, sorted by balance', () => {
  const s = newState();
  applyLogs(s, [
    t20(1, Z, A, 100n), t20(1, Z, B, 50n), t20(2, A, C, 30n), t20(3, B, Z, 50n),
  ]);
  assert.equal(s.standard, 'erc20');
  assert.deepEqual(holdersFromState(s).map((r) => [r.address, r.balance]), [[A, 70n], [C, 30n]]);
  assert.deepEqual(holdersFromState(s, 31n).map((r) => r.address), [A]);
});

test('ERC-1155: TransferSingle and TransferBatch both decode', () => {
  const s = newState();
  const op = topicAddr(C);
  const single = log(1, [TRANSFER_SINGLE_TOPIC, op, topicAddr(Z), topicAddr(A)], `0x${u256(9)}${u256(5)}`);
  // abi.encode(uint256[] ids=[1,2], uint256[] values=[3,4]): offsets 0x40, 0xa0.
  const batchData = `0x${u256(0x40)}${u256(0xa0)}${u256(2)}${u256(1)}${u256(2)}${u256(2)}${u256(3)}${u256(4)}`;
  const batch = log(2, [TRANSFER_BATCH_TOPIC, op, topicAddr(Z), topicAddr(B)], batchData);
  const move = log(3, [TRANSFER_SINGLE_TOPIC, op, topicAddr(A), topicAddr(B)], `0x${u256(9)}${u256(5)}`);
  applyLogs(s, [single, batch, move]);
  assert.equal(s.standard, 'erc1155');
  const rows = holdersFromState(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.address, B);
  assert.equal(rows[0]!.balance, 12n); // 3 + 4 + 5
  assert.deepEqual([...rows[0]!.tokenIds].sort(), ['1', '2', '9']);
});

function mockRpc(handler: (body: { method: string; params: any[] }) => { status?: number; json?: unknown }) {
  const calls: Array<{ method: string; params: any[] }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const r = handler(body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, sleep: async () => {} };
}

test('rpcCall retries on HTTP 429 then succeeds', async () => {
  let n = 0;
  const m = mockRpc(() => (n++ < 2 ? { status: 429 } : { json: { jsonrpc: '2.0', id: 1, result: '0x10' } }));
  const r = await rpcCall<string>('http://x', 'eth_blockNumber', [], m);
  assert.equal(r, '0x10');
  assert.equal(m.calls.length, 3);
});

test('getTransferLogs splits the range when the RPC rejects it, and covers every block once', async () => {
  const m = mockRpc(({ params }) => {
    const from = BigInt(params[0].fromBlock);
    const to = BigInt(params[0].toBlock);
    if (to - from + 1n > 4_000n) {
      return { json: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'query spans too many blocks; narrow the block range' } } };
    }
    return { json: { jsonrpc: '2.0', id: 1, result: [] } };
  });
  await getTransferLogs('http://x', A, 0n, 9_999n, { ...m, maxRange: 10_000n });
  const ranges = m.calls.filter((c) => c.method === 'eth_getLogs').map((c) => [BigInt(c.params[0].fromBlock), BigInt(c.params[0].toBlock)]);
  const ok = ranges.filter(([f, t]) => t! - f! + 1n <= 4_000n);
  // Accepted ranges tile [0, 9999] exactly with no gaps or overlaps.
  let next = 0n;
  for (const [f, t] of ok.sort((a, b) => (a[0]! < b[0]! ? -1 : 1))) {
    assert.equal(f, next);
    next = t! + 1n;
  }
  assert.equal(next, 10_000n);
  // One topic0 OR-list fetches all three transfer shapes.
  assert.deepEqual(m.calls.find((c) => c.method === 'eth_getLogs')!.params[0].topics, [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]]);
});

test('scanHolders caches and only scans new blocks on the next call', async () => {
  _resetHolderCache();
  const m = mockRpc(({ method, params }) => {
    if (method !== 'eth_getLogs') return { json: { jsonrpc: '2.0', id: 1, result: '0x0' } };
    const from = BigInt(params[0].fromBlock);
    const logs = from === 0n ? [t721(5, Z, A, 1)] : [t721(150, A, B, 1)];
    return { json: { jsonrpc: '2.0', id: 1, result: logs } };
  });
  const s1 = await scanHolders({ rpcUrl: 'http://cache-test', address: '0xCC', toBlock: 100n, ...m });
  assert.deepEqual(holdersFromState(s1).map((r) => r.address), [A]);
  const s2 = await scanHolders({ rpcUrl: 'http://cache-test', address: '0xcc', toBlock: 200n, ...m });
  assert.deepEqual(holdersFromState(s2).map((r) => r.address), [B]);
  const ranges = m.calls.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(c.params[0].fromBlock), Number(c.params[0].toBlock)]);
  assert.deepEqual(ranges, [[0, 100], [101, 200]]);
});

test('pageHolders pages with an offset cursor and keeps the web response shape', () => {
  const rows = [A, B, C].map((address, i) => ({ address, balance: BigInt(3 - i), tokenIds: [String(i)] }));
  const p1 = pageHolders(rows, 2, undefined);
  assert.deepEqual(p1, {
    holders: [{ address: A, balance: 3, tokenIds: ['0'] }, { address: B, balance: 2, tokenIds: ['1'] }],
    nextCursor: '2',
  });
  assert.deepEqual(pageHolders(rows, 2, '2'), { holders: [{ address: C, balance: 1, tokenIds: ['2'] }], nextCursor: null });
});

test('toNftAvatar maps OpenSea items and drops disabled / nsfw / imageless ones', () => {
  const chain = { chainId: 4663, label: 'Robinhood' };
  const base = { identifier: '12', collection: 'urufugemu', contract: '0x60CB7082c8c14b4237c6a24c65e7c2e7abe2bd17', name: 'Urufu #12' };
  assert.deepEqual(toNftAvatar(chain, { ...base, display_image_url: 'https://img/x.png', image_url: 'https://img/y.png' }), [{
    chainId: 4663,
    chain: 'Robinhood',
    contractAddress: '0x60cb7082c8c14b4237c6a24c65e7c2e7abe2bd17',
    tokenId: '12',
    collectionName: 'urufugemu',
    tokenName: 'Urufu #12',
    imageUrl: 'https://img/x.png',
  }]);
  assert.equal(toNftAvatar(chain, { ...base, image_url: 'ipfs://cid/1.png' })[0]!.imageUrl, 'https://ipfs.io/ipfs/cid/1.png');
  assert.deepEqual(toNftAvatar(chain, { ...base, image_url: 'https://x', is_disabled: true }), []);
  assert.deepEqual(toNftAvatar(chain, { ...base, image_url: 'https://x', is_nsfw: true }), []);
  assert.deepEqual(toNftAvatar(chain, { ...base }), []);
  assert.equal(firstRenderableUrl(null, 'ar://abc'), 'https://arweave.net/abc');
});

import { parseAllowedRange } from './holders-engine.ts';

test('parseAllowedRange reads the endpoint limit from real Robinhood error text', () => {
  assert.equal(parseAllowedRange('query spans 10000000 blocks (0 to 9999999), but only 100000 are allowed for this request; narrow the block range'), 100000n);
  assert.equal(parseAllowedRange('query spans 77847559 blocks (0 to 77847558), but only 10000000 are allowed for this request'), 10000000n);
  assert.equal(parseAllowedRange('some other error'), null);
});

test('getTransferLogs jumps straight to the allowed range, learns it, and keeps exact in-order coverage with parallel ranges', async () => {
  _resetHolderCache();
  const m = mockRpc(({ params }) => {
    const from = BigInt(params[0].fromBlock);
    const to = BigInt(params[0].toBlock);
    if (to - from + 1n > 2_500n) {
      return { json: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `query spans ${to - from + 1n} blocks (${from} to ${to}), but only 2500 are allowed for this request; narrow the block range` } } };
    }
    // One log per range at its first block, so coverage is checkable from results.
    return { json: { jsonrpc: '2.0', id: 1, result: [t721(Number(from), Z, A, Number(from))] } };
  });
  const logs = await getTransferLogs('http://learn', A, 0n, 9_999n, { ...m, maxRange: 1_000_000n });
  const rejected = m.calls.filter((c) => BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) + 1n > 2_500n).length;
  assert.ok(rejected <= 3, `expected one rejected round (<=3 parallel), got ${rejected}`); // no halving cascade
  const starts = logs.map((l) => Number(l.blockNumber)).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 2500, 5000, 7500]); // each block covered exactly once
  // Second scan on the same endpoint starts at the learned size: zero rejections.
  const before = m.calls.length;
  await getTransferLogs('http://learn', A, 0n, 9_999n, { ...m, maxRange: 1_000_000n });
  const second = m.calls.slice(before);
  assert.ok(second.every((c) => BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) + 1n <= 2_500n));
});
