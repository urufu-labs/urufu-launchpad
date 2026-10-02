import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';

import { _resetHolderCache } from './holders-engine.ts';
import { MULTICALL3, verifiedIndexerHolders, verifyHolderSnapshot } from './holders-verify.ts';

const abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

const TOKEN = '0x00000000000000000000000000000000000000ee';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

/// One fake fetch serving both the indexer GraphQL and the RPC (eth_call).
function world(opts: { indexer: Array<{ holderAddress: string; balance: string }>; chain: Record<string, bigint>; totalSupply: bigint }) {
  let rpcCalls = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/graphql')) {
      return new Response(JSON.stringify({ data: { holderss: { items: opts.indexer, pageInfo: { hasNextPage: false, endCursor: null } } } }));
    }
    rpcCalls++;
    const { to, data } = body.params[0] as { to: string; data: Hex };
    let result: Hex;
    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      const { args } = decodeFunctionData({ abi, data });
      const calls = args![0] as ReadonlyArray<{ callData: Hex }>;
      result = encodeFunctionResult({
        abi,
        functionName: 'aggregate3',
        result: calls.map((c) => {
          const who = (decodeFunctionData({ abi, data: c.callData }).args![0] as string).toLowerCase();
          return { success: true, returnData: encodeFunctionResult({ abi, functionName: 'balanceOf', result: opts.chain[who] ?? 0n }) };
        }),
      });
    } else {
      result = encodeFunctionResult({ abi, functionName: 'totalSupply', result: opts.totalSupply });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  return { fetchImpl, rpcCalls: () => rpcCalls };
}

const run = (fetchImpl: typeof fetch) =>
  verifiedIndexerHolders(
    { chainId: 4663, token: TOKEN, rpcUrl: 'http://rpc' },
    { indexerUrl: 'http://idx', fetchImpl, sleep: async () => {} },
  );

test('ERC-20: indexer holders accepted when balances match chain and sum == totalSupply', async () => {
  _resetHolderCache();
  const w = world({ indexer: [{ holderAddress: A, balance: '70' }, { holderAddress: B, balance: '30' }], chain: { [A]: 70n, [B]: 30n }, totalSupply: 100n });
  const r = await run(w.fetchImpl);
  assert.equal(r.verification.ok, true, r.verification.reason);
  assert.equal(r.holders.length, 2);
  assert.match(r.verification.reason, /== totalSupply/);
});

test('ERC-20: a holder missing from the indexer (sum short of totalSupply) is rejected', async () => {
  _resetHolderCache();
  const r = await run(world({ indexer: [{ holderAddress: A, balance: '70' }], chain: { [A]: 70n, [B]: 30n }, totalSupply: 100n }).fetchImpl);
  assert.equal(r.verification.ok, false);
  assert.match(r.verification.reason, /!= totalSupply/);
});

test('ERC-20: a stale indexer balance is rejected', async () => {
  _resetHolderCache();
  const r = await run(world({ indexer: [{ holderAddress: A, balance: '60' }, { holderAddress: B, balance: '40' }], chain: { [A]: 70n, [B]: 30n }, totalSupply: 100n }).fetchImpl);
  assert.equal(r.verification.ok, false);
  assert.match(r.verification.reason, /balance mismatch/);
});

test('token the indexer does not track: rejected without any RPC calls', async () => {
  _resetHolderCache();
  const w = world({ indexer: [], chain: {}, totalSupply: 0n });
  const r = await run(w.fetchImpl);
  assert.equal(r.verification.ok, false);
  assert.match(r.verification.reason, /no holders/);
  assert.equal(w.rpcCalls(), 0);
});

test('verifyHolderSnapshot labels the expected total', () => {
  const v = verifyHolderSnapshot([{ address: A, balance: 1n }], [1n], 2n, 'totalSupply');
  assert.match(v.reason, /!= totalSupply 2/);
});
