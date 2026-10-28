// Phase 3 swarm tools (offline): get_swarm, create_swarm, swarm_action,
// allow_agent_swarm, and the swarm permissions in the agent policy. The on-chain
// behaviour of this calldata with real agent accounts is proven on a Robinhood fork
// by contracts/test/agent/AgentSwarmFork.t.sol.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, getAddress, hexToBigInt, parseEther, toFunctionSelector } from 'viem';

import { AGENT_ROLE_KEY, multiSendAbi, rolesAbi, safeAbi } from './agentPolicy.ts';
import { swarmFactoryAbi } from './swarmTools.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, defaultChain, fakeDeps } from './testFixtures.mjs';

const VAULT = getAddress('0x9999999999999999999999999999999999999999');
const BATCH = getAddress('0x4444444444444444444444444444444444444444');
const TOKEN = getAddress('0x2222222222222222222222222222222222222222');
const CREATOR = getAddress('0x3333333333333333333333333333333333333333');
const MEMBER = getAddress('0x5555555555555555555555555555555555555555');
const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const SAFE = getAddress('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa');
const ROLES = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB');
const NOW = 1_800_000_000;

function setup(over = {}, { book = {}, launched = false, batchClose = NOW + 30, settled = false } = {}) {
  const chain = defaultChain();
  const { deps } = fakeDeps({ chain, now: () => NOW * 1000 });
  deps.book = { ...deps.book, ...book };
  const swarm = {
    isSwarm: true, creator: CREATOR, token: TOKEN, batch: BATCH, name: 'Moon Cat', ticker: 'MCAT',
    joinDeadline: BigInt(NOW + 3600), launchDeadline: BigInt(NOW + 7200), quorumBps: 6000,
    minPool: parseEther('0.1'), maxPool: 0n, minDeposit: parseEther('0.001'),
    pool: parseEther('0.3'), approvedEth: parseEther('0.2'), passed: true, joined: false, batchClaimed: false,
    deposits: parseEther('0.1'), approved: false, withdrawn: false, shareOf: [0n, 0n],
    getOwners: [OWNER], getThreshold: 1n, owner: SAFE, avatar: SAFE, closeTs: BigInt(batchClose), settled,
    ...over,
  };
  const orig = deps.client.readContract;
  deps.client.readContract = async (a) => (a.functionName in swarm ? swarm[a.functionName] : orig(a));
  deps.client.getCode = async ({ address }) => (launched && address === BATCH ? '0x60' : '0x');
  const ctx = { ip: '198.51.100.33', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
  return { chain, deps, run: (tool, input) => runTool(tool, input, ctx) };
}

const sel = (sig) => toFunctionSelector(sig);

describe('swarms not live', () => {
  it('every swarm tool says so while the factory is not deployed', async () => {
    const s = setup({}, { book: { SwarmVaultFactory: null } });
    for (const [tool, input] of [
      ['get_swarm', { vault: VAULT }],
      ['create_swarm', { proposer: MEMBER, creator: CREATOR, name: 'A', ticker: 'A' }],
      ['swarm_action', { vault: VAULT, member: MEMBER, action: 'leave' }],
      ['allow_agent_swarm', { owner: OWNER, safe: SAFE, roles: ROLES, vault: VAULT }],
    ]) {
      const r = await s.run(tool, input);
      assert.equal(r.status, 409, tool);
      assert.match(r.body.error.message, /aren't live yet/);
    }
  });
});

describe('get_swarm', () => {
  it('reads the swarm; name and ticker only under untrusted', async () => {
    const r = await setup().run('get_swarm', { vault: VAULT, member: MEMBER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.creator, CREATOR);
    assert.equal(d.stage, 'joining');
    assert.equal(d.quorumPct, 60);
    assert.equal(d.member.deposit, String(parseEther('0.1')));
    assert.equal(JSON.stringify(d).includes('Moon Cat'), false, 'stranger text never in data');
    assert.equal(r.body.untrusted.fields.name.text, 'Moon Cat');
  });
  it('refuses a vault the factory did not make', async () => {
    const r = await setup({ isSwarm: false }).run('get_swarm', { vault: VAULT });
    assert.equal(r.status, 404);
  });
  it('stages: waiting, ready, failed (missed window), in batch, claimable', async () => {
    const after = NOW - 1;
    const stage = async (over, opts) => (await setup({ joinDeadline: BigInt(after), ...over }, opts).run('get_swarm', { vault: VAULT })).body.data.stage;
    assert.equal(await stage({}), 'waiting_for_launch');
    assert.equal(await stage({}, { launched: true }), 'ready_to_join_batch');
    assert.equal(await stage({}, { launched: true, batchClose: NOW - 1 }), 'failed');
    assert.equal(await stage({ passed: false }), 'failed');
    assert.equal(await stage({ joined: true }), 'in_batch');
    assert.equal(await stage({ joined: true, batchClaimed: true }), 'claimable');
  });
});

describe('create_swarm', () => {
  it('builds createSwarm with the right params and simulates from the proposer', async () => {
    const s = setup();
    const r = await s.run('create_swarm', { proposer: MEMBER, creator: CREATOR, name: 'Moon Cat', ticker: 'mcat', joinHours: 2, launchHours: 3, quorumPct: 70, minPoolEth: '0.5', minDepositEth: '0.01' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tx = r.body.data.transactions[0];
    assert.equal(tx.to, BOOK.SwarmVaultFactory);
    const { args } = decodeFunctionData({ abi: swarmFactoryAbi, data: tx.data });
    assert.equal(args[0].creator, CREATOR);
    assert.equal(args[0].ticker, 'MCAT');
    assert.equal(args[0].joinSeconds, 7200);
    assert.equal(args[0].launchSeconds, 10800);
    assert.equal(args[0].quorumBps, 7000);
    assert.equal(args[0].minPool, parseEther('0.5'));
    assert.equal(args[0].minDeposit, parseEther('0.01'));
    assert.equal(s.chain.calls.at(-1).account, MEMBER);
    assert.match(r.body.data.warnings[0], /AFTER the vote closes/);
  });
});

describe('swarm_action', () => {
  it('join: payable join() with ethIn, checked against min deposit and deadline', async () => {
    const r = await setup().run('swarm_action', { vault: VAULT, member: MEMBER, action: 'join', ethIn: '0.05' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tx = r.body.data.transactions[0];
    assert.equal(tx.to, VAULT);
    assert.equal(tx.value, String(parseEther('0.05')));
    assert.equal(tx.data, sel('function join()'));
    const late = await setup({ joinDeadline: BigInt(NOW) }).run('swarm_action', { vault: VAULT, member: MEMBER, action: 'join', ethIn: '0.05' });
    assert.equal(late.body.data.canBroadcast, false);
    const tiny = await setup().run('swarm_action', { vault: VAULT, member: MEMBER, action: 'join', ethIn: '0.0001' });
    assert.match(tiny.body.data.errors.join(' '), /smallest deposit/);
  });
  it('approve / leave / join_batch / claim build the right calls', async () => {
    const one = async (action, over, opts) => (await setup(over, opts).run('swarm_action', { vault: VAULT, member: MEMBER, action })).body.data;
    assert.equal((await one('approve')).transactions[0].data, sel('function approve()'));
    assert.equal((await one('leave')).transactions[0].data, sel('function leave()'));
    assert.equal((await one('leave', { joined: true })).canBroadcast, false, 'no leaving after the pool joined');
    assert.equal((await one('join_batch', { joinDeadline: BigInt(NOW - 1) }, { launched: true })).transactions[0].data, sel('function joinBatch()'));
    assert.equal((await one('join_batch')).canBroadcast, false, 'not before the vote closes');
    const claim = await one('claim', { joined: true });
    assert.deepEqual(claim.transactions.map((t) => t.purpose), ['claimFromBatch', 'withdrawShare']);
    const claim2 = await one('claim', { joined: true, batchClaimed: true });
    assert.deepEqual(claim2.transactions.map((t) => t.purpose), ['withdrawShare']);
  });
});

/// MultiSendCallOnly packed calls: op(1) to(20) value(32) len(32) data.
function unpack(safeTxData) {
  const exec = decodeFunctionData({ abi: safeAbi, data: safeTxData });
  const packed = decodeFunctionData({ abi: multiSendAbi, data: exec.args[2] }).args[0].slice(2);
  const out = [];
  for (let i = 0; i < packed.length;) {
    const to = getAddress('0x' + packed.slice(i + 2, i + 42));
    const len = Number(hexToBigInt('0x' + packed.slice(i + 106, i + 170)));
    out.push({ to, data: '0x' + packed.slice(i + 170, i + 170 + len * 2) });
    i += 170 + len * 2;
  }
  return out;
}

describe('allow_agent_swarm', () => {
  it('scopes the one vault: join with ETH caps, the rest without ETH, nothing else', async () => {
    const r = await setup().run('allow_agent_swarm', { owner: OWNER, safe: SAFE, roles: ROLES, vault: VAULT });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ops = unpack(r.body.data.transactions[0].data).map((c) => decodeFunctionData({ abi: rolesAbi, data: c.data }));
    assert.ok(ops.every((o) => o.args[0] === AGENT_ROLE_KEY && o.args[1] === VAULT), 'only this vault, only the agent role');
    assert.equal(ops[0].functionName, 'scopeTarget');
    const joinScope = ops.find((o) => o.functionName === 'scopeFunction');
    assert.equal(joinScope.args[2], sel('function join()'));
    assert.equal(joinScope.args[4], 1, 'join may carry ETH (within the allowances)');
    const allowed = ops.filter((o) => o.functionName === 'allowFunction');
    assert.deepEqual(allowed.map((o) => o.args[2]).sort(), ['approve()', 'unapprove()', 'leave()', 'joinBatch()', 'claimFromBatch()', 'withdrawShare()'].map((f) => sel(`function ${f}`)).sort());
    assert.ok(allowed.every((o) => o.args[3] === 0), 'none of them can send ETH');
  });
  it('remove revokes the vault; non-owner refused', async () => {
    const r = await setup().run('allow_agent_swarm', { owner: OWNER, safe: SAFE, roles: ROLES, vault: VAULT, remove: true });
    const ops = unpack(r.body.data.transactions[0].data).map((c) => decodeFunctionData({ abi: rolesAbi, data: c.data }));
    assert.equal(ops[0].functionName, 'revokeTarget');
    assert.equal(ops.filter((o) => o.functionName === 'revokeFunction').length, 7, 'every function scope cleared too');
    assert.ok(ops.every((o) => o.args[1] === VAULT));
    const notOwner = await setup({ getOwners: [MEMBER] }).run('allow_agent_swarm', { owner: OWNER, safe: SAFE, roles: ROLES, vault: VAULT });
    assert.equal(notOwner.status, 403);
  });
});
