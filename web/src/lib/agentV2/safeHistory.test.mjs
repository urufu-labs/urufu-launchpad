// Agent account money in / out (offline): SafeL2 1.4.1 event decoding, MultiSend
// unpacking, withdrawal totals, the windowed scan and the get_agent_history tool.
// The decoder was also run against real Safes on Robinhood (see the PR).
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, pad, parseAbi, parseEther, toEventSelector } from 'viem';

import { multiSendAbi, multiSendData, rolesAbi, safeAbi, AGENT_ROLE_KEY, AGENT_ACCOUNT_CONTRACTS } from './agentPolicy.ts';
import { classifySafeLogs, HISTORY_WINDOW_BLOCKS, MAX_WINDOWS, scanSafeLogs, unpackMultiSend } from './safeHistory.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, defaultChain, fakeDeps } from './testFixtures.mjs';

const SAFE = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa');
const ROLES = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB');
const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const DEST = getAddress('0x7777777777777777777777777777777777777777');
const TOKEN = getAddress('0x2222222222222222222222222222222222222222');

const T = {
  setup: toEventSelector('SafeSetup(address,address[],uint256,address,address)'),
  received: toEventSelector('SafeReceived(address,uint256)'),
  multisig: toEventSelector('SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)'),
  failure: toEventSelector('ExecutionFailure(bytes32,uint256)'),
  success: toEventSelector('ExecutionSuccess(bytes32,uint256)'),
};

let n = 0;
const meta = (tx) => ({ transactionHash: tx, blockNumber: 1000n + BigInt(n), blockTimestamp: '0x0', logIndex: n++ });
const received = (tx, from, value) => ({ topics: [T.received, pad(from)], data: encodeAbiParameters([{ type: 'uint256' }], [value]), ...meta(tx) });
const multisig = (tx, to, value, data, operation = 0) => ({
  topics: [T.multisig],
  data: encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
    [to, value, data, operation, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x', '0x'],
  ),
  ...meta(tx),
});
const failure = (tx) => ({ topics: [T.failure, pad('0x01')], data: encodeAbiParameters([{ type: 'uint256' }], [0n]), ...meta(tx) });
const success = (tx) => ({ topics: [T.success, pad('0x01')], data: encodeAbiParameters([{ type: 'uint256' }], [0n]), ...meta(tx) });
const tx = (i) => `0x${i.toString(16).padStart(64, '0')}`;
const transfer = (to, amount) => encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [to, amount] });
const known = { safe: SAFE, roles: ROLES, urufu: new Set([BOOK.FairLaunchFactory.toLowerCase()]) };

describe('classifySafeLogs', () => {
  it('funding, ETH and token withdrawals, spending, newest first', () => {
    const logs = [
      received(tx(1), OWNER, parseEther('1')),
      received(tx(2), OWNER, 0n),
      multisig(tx(3), DEST, parseEther('0.4'), '0x'), success(tx(3)),
      multisig(tx(4), TOKEN, 0n, transfer(DEST, parseEther('500'))), success(tx(4)),
      multisig(tx(5), BOOK.FairLaunchFactory, parseEther('0.1'), encodeFunctionData({ abi: parseAbi(['function launch(string,string) payable']), functionName: 'launch', args: ['A', 'A'] })), success(tx(5)),
    ];
    const s = classifySafeLogs(logs, known);
    assert.equal(s.fundedEth, String(parseEther('1')), 'zero-value receive is skipped');
    assert.equal(s.ownerWithdrewEth, String(parseEther('0.4')));
    assert.equal(s.ownerSpentEth, String(parseEther('0.1')));
    assert.deepEqual(s.tokenWithdrawals, [{ token: TOKEN, amount: String(parseEther('500')) }]);
    assert.deepEqual(s.entries.map((e) => e.kind), ['spent', 'withdrew_token', 'withdrew_eth', 'funded']);
    assert.match(s.entries[0].label, /on urufu/);
    assert.match(s.entries[1].label, /500 tokens/);
    assert.equal(s.entries[3].timestamp, null, 'RPC 0x0 timestamps are treated as missing');
  });

  it('dust shows as under 0.000001 ETH, never as 0', () => {
    const s = classifySafeLogs([received(tx(20), OWNER, 5_000n)], known);
    assert.match(s.entries[0].label, /under 0\.000001 ETH/);
  });

  it('a failed owner tx is listed but not counted', () => {
    const s = classifySafeLogs([multisig(tx(6), DEST, parseEther('2'), '0x'), failure(tx(6))], known);
    assert.equal(s.entries[0].failed, true);
    assert.equal(s.ownerWithdrewEth, '0');
  });

  it('MultiSend batches are unpacked; policy edits show once, ETH out inside a batch counts', () => {
    const calls = [
      { to: ROLES, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'scopeTarget', args: [AGENT_ROLE_KEY, TOKEN] }) },
      { to: ROLES, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'revokeTarget', args: [AGENT_ROLE_KEY, TOKEN] }) },
      { to: SAFE, value: 0n, data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [ROLES] }) },
      { to: DEST, value: parseEther('0.3'), data: '0x' },
    ];
    const s = classifySafeLogs([multisig(tx(7), AGENT_ACCOUNT_CONTRACTS.MultiSendCallOnly, 0n, multiSendData(calls), 1), success(tx(7))], known);
    assert.deepEqual(s.entries.map((e) => e.kind), ['withdrew_eth', 'settings', 'changed_limits']);
    assert.equal(s.ownerWithdrewEth, String(parseEther('0.3')));
  });

  it('a delegatecall to anything but MultiSend is flagged, not unpacked', () => {
    const s = classifySafeLogs([multisig(tx(8), DEST, 0n, '0x12345678', 1)], known);
    assert.equal(s.entries[0].kind, 'other');
    assert.match(s.entries[0].label, /delegatecall/);
  });

  it('unpackMultiSend round-trips the builder', () => {
    const calls = [{ to: DEST, value: 5n, data: '0xabcdef' }, { to: TOKEN, value: 0n, data: '0x' }];
    const packed = decodeFunctionData({ abi: multiSendAbi, data: multiSendData(calls) }).args[0];
    assert.deepEqual(unpackMultiSend(packed).map((c) => [c.to, c.value, c.data, c.operation]), [[DEST, 5n, '0xabcdef', 0], [TOKEN, 0n, '0x', 0]]);
  });
});

describe('scanSafeLogs', () => {
  it('stops at the window that holds SafeSetup', async () => {
    const head = 30_000_000n;
    const ranges = [];
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }) => {
        ranges.push([fromBlock, toBlock]);
        return ranges.length === 2 ? [{ topics: [T.setup], data: '0x', transactionHash: tx(9), blockNumber: fromBlock, logIndex: 0 }] : [];
      },
    };
    const scan = await scanSafeLogs({ client }, SAFE);
    assert.equal(scan.complete, true);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0][1], head);
    assert.equal(ranges[1][1], ranges[0][0] - 1n, 'windows are contiguous');
    assert.ok(ranges.every(([f, t]) => t - f + 1n <= HISTORY_WINDOW_BLOCKS), 'each window within the RPC cap');
  });
  it('gives up after MAX_WINDOWS and says the history is partial', async () => {
    let calls = 0;
    const client = { getBlockNumber: async () => 10n ** 9n, getLogs: async () => { calls++; return []; } };
    const scan = await scanSafeLogs({ client }, SAFE);
    assert.equal(scan.complete, false);
    assert.equal(calls, MAX_WINDOWS);
  });
});

describe('get_agent_history', () => {
  function setup(logs, over = {}) {
    const { deps } = fakeDeps({ chain: defaultChain() });
    const orig = deps.client.readContract;
    const reads = { getOwners: [OWNER], getModulesPaginated: [[ROLES], '0x0000000000000000000000000000000000000001'], owner: SAFE, avatar: SAFE, ...over };
    deps.client.readContract = async (a) => (a.functionName in reads ? (reads[a.functionName] instanceof Error ? Promise.reject(reads[a.functionName]) : reads[a.functionName]) : orig(a));
    deps.client.getLogs = async () => logs;
    deps.client.getBlock = async ({ blockNumber }) => ({ timestamp: 1_800_000_000n + (blockNumber ?? 0n), number: blockNumber });
    const ctx = { ip: '198.51.100.32', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
    return (input) => runTool('get_agent_history', input, ctx);
  }
  it('totals, entries with real block times, roles found from the Safe', async () => {
    const logs = [
      { topics: [T.setup], data: '0x', ...meta(tx(10)) },
      received(tx(11), OWNER, parseEther('1')),
      multisig(tx(12), ROLES, 0n, encodeFunctionData({ abi: rolesAbi, functionName: 'scopeTarget', args: [AGENT_ROLE_KEY, TOKEN] })), success(tx(12)),
      multisig(tx(13), DEST, parseEther('0.25'), '0x'), success(tx(13)),
    ];
    const r = await setup(logs)({ safe: SAFE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.complete, true);
    assert.equal(d.fundedEth, String(parseEther('1')));
    assert.equal(d.ownerWithdrewEth, String(parseEther('0.25')));
    assert.deepEqual(d.entries.map((e) => e.kind), ['withdrew_eth', 'changed_limits', 'funded']);
    assert.ok(d.entries.every((e) => e.timestamp > 1_800_000_000), 'block times filled in');
  });
  it('not a Safe', async () => {
    const r = await setup([], { getOwners: new Error('no code') })({ safe: SAFE });
    assert.equal(r.status, 404);
  });
});
