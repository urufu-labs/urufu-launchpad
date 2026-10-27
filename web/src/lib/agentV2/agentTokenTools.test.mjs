// Phase 2 agent-token tools (offline): launch_agent_token, get_agent_token,
// get_agent_profile, and the own-token rule in update_agent_account. The on-chain
// behaviour of the launch calldata is proven on a Robinhood fork by
// contracts/test/agent/AgentTokenFork.t.sol.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, getAddress, hexToBigInt, parseEther, toFunctionSelector } from 'viem';

import { erc20TokenAbi, fairLaunchFactoryAbi } from '../abis.ts';
import { AGENT_ACCOUNT_CONTRACTS, AGENT_ROLE_KEY, multiSendAbi, rolesAbi, safeAbi } from './agentPolicy.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, E18, TOKEN, defaultChain, fakeDeps } from './testFixtures.mjs';

const OWNER = '0x1111111111111111111111111111111111111111';
const SAFE = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const ROLES = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const FAIR_CURVE = '0x9999999999999999999999999999999999999999';
const [P_TOKEN, P_CURVE, P_BATCH] = defaultChain().fairPredicted;

function setup(over = {}, chainOver = {}) {
  const chain = { ...defaultChain(), ...chainOver };
  const { deps } = fakeDeps({ chain });
  const reads = {
    getOwners: [OWNER], getThreshold: 1n, owner: SAFE, avatar: SAFE, isModuleEnabled: true,
    getModulesPaginated: [[ROLES], '0x0000000000000000000000000000000000000001'],
    forfeitDropBps: 1000, creatorSold: false, batchSettled: true,
    ...over,
  };
  const orig = deps.client.readContract;
  deps.client.readContract = async (a) => (a.functionName in reads
    ? (reads[a.functionName] instanceof Error ? Promise.reject(reads[a.functionName]) : reads[a.functionName])
    : a.functionName === 'allowances' ? [1n, parseEther('0.25'), 86_400n, 1n, 1n] : orig(a));
  const ctx = { ip: '198.51.100.31', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
  return { chain, deps, run: (tool, input) => runTool(tool, input, ctx) };
}

/// MultiSendCallOnly packed calls: op(1) to(20) value(32) len(32) data.
function unpack(safeTxData) {
  const exec = decodeFunctionData({ abi: safeAbi, data: safeTxData });
  assert.equal(exec.functionName, 'execTransaction');
  assert.equal(exec.args[0], AGENT_ACCOUNT_CONTRACTS.MultiSendCallOnly);
  assert.equal(exec.args[3], 1, 'delegatecall into MultiSendCallOnly');
  const packed = decodeFunctionData({ abi: multiSendAbi, data: exec.args[2] }).args[0];
  const out = [];
  let i = 0;
  const hex = packed.slice(2);
  while (i < hex.length) {
    const to = getAddress('0x' + hex.slice(i + 2, i + 42));
    const value = hexToBigInt('0x' + hex.slice(i + 42, i + 106));
    const len = Number(hexToBigInt('0x' + hex.slice(i + 106, i + 170)));
    const data = '0x' + hex.slice(i + 170, i + 170 + len * 2);
    out.push({ to, value, data });
    i += 170 + len * 2;
  }
  return out;
}

const rolesOps = (calls) => calls.filter((c) => c.to === getAddress(ROLES)).map((c) => decodeFunctionData({ abi: rolesAbi, data: c.data }));
const sel = (sig) => toFunctionSelector(sig);

describe('launch_agent_token', () => {
  it('ETH fee: launch from the Safe, then list the token with selling off and v4 buys rebuilt', async () => {
    const s = setup();
    const r = await s.run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'Agent Coin', ticker: 'agc', depositEth: '0.1', listedTokens: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.deepEqual(d.predicted, { token: P_TOKEN, curve: P_CURVE, batch: P_BATCH });
    assert.equal(d.canBroadcast, true, JSON.stringify(d.errors));
    assert.equal(d.transactions.length, 1);
    assert.equal(d.transactions[0].to, getAddress(SAFE));
    assert.equal(d.transactions[0].value, '0', 'the ETH comes from the Safe, not the owner');
    assert.equal(d.tokenList, `${getAddress(TOKEN)},${getAddress(P_TOKEN)}`);

    const calls = unpack(d.transactions[0].data);
    const launch = decodeFunctionData({ abi: fairLaunchFactoryAbi, data: calls[0].data });
    assert.equal(calls[0].to, getAddress(BOOK.FairLaunchFactory));
    assert.equal(launch.functionName, 'launch');
    assert.deepEqual(launch.args, ['Agent Coin', 'AGC']);
    assert.equal(calls[0].value, parseEther('0.1') + s.chain.fairEthFee);

    const ops = rolesOps(calls);
    const scoped = ops.filter((o) => o.functionName === 'scopeTarget').map((o) => o.args[1]);
    for (const t of [P_CURVE, P_TOKEN, P_BATCH]) assert.ok(scoped.includes(getAddress(t)), `scopeTarget ${t}`);
    const revoked = ops.filter((o) => o.functionName === 'revokeFunction').map((o) => `${o.args[1]}:${o.args[2]}`);
    assert.ok(revoked.includes(`${getAddress(P_CURVE)}:${sel('function sell(uint256,uint256)')}`), 'curve sell revoked');
    assert.ok(revoked.includes(`${getAddress(P_TOKEN)}:${sel('function approve(address,uint256)')}`), 'approve revoked');
    // No sell allowance, no sell or approve scope, no transfer for the own token.
    assert.equal(ops.filter((o) => o.functionName === 'setAllowance').length, 0);
    const fnScopes = ops.filter((o) => o.functionName === 'scopeFunction' || o.functionName === 'allowFunction').map((o) => `${o.args[1]}:${o.args[2]}`);
    assert.ok(!fnScopes.some((f) => f.startsWith(getAddress(P_TOKEN))), 'nothing callable on the own token');
    assert.ok(!fnScopes.includes(`${getAddress(BOOK.V4SwapRouter)}:${sel('function swapExactTokenForETH((address,address,uint24,int24,address),uint256,uint256,address,uint256)')}`), 'v4 sell scope untouched');
    assert.ok(fnScopes.includes(`${getAddress(BOOK.V4SwapRouter)}:${sel('function swapExactETHForToken((address,address,uint24,int24,address),uint256,address,uint256)')}`), 'v4 buy scope rebuilt');
    for (const o of ops) assert.equal(o.args[0], AGENT_ROLE_KEY, `${o.functionName} is on the agent role`);

    // Simulated as the owner sending the Safe tx.
    const sim = s.chain.calls.find((c) => c.to === getAddress(SAFE));
    assert.equal(sim.account, getAddress(OWNER));
    assert.match(d.creatorFeeRule, /10%/);
  });

  it('URU fee: exact approve from the Safe, then launchWithURU with only the deposit attached', async () => {
    const s = setup();
    const r = await s.run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'Agent Coin', ticker: 'AGC', depositEth: '0.05', payWith: 'URU' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const calls = unpack(r.body.data.transactions[0].data);
    const approve = decodeFunctionData({ abi: erc20TokenAbi, data: calls[0].data });
    assert.equal(calls[0].to, getAddress(BOOK.URU));
    assert.deepEqual(approve.args, [getAddress(BOOK.FairLaunchFactory), s.chain.fairMinUru]);
    const launch = decodeFunctionData({ abi: fairLaunchFactoryAbi, data: calls[1].data });
    assert.equal(launch.functionName, 'launchWithURU');
    assert.equal(launch.args[2], s.chain.fairMinUru);
    assert.equal(calls[1].value, parseEther('0.05'));
    assert.equal(r.body.data.tokenList, getAddress(P_TOKEN));
  });

  it('flags a Safe that cannot pay, a zero deposit, closed launches and a taken name', async () => {
    const poor = await setup({}, { ethBalance: 10n ** 15n }).run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A', depositEth: '0.1' });
    assert.equal(poor.body.data.canBroadcast, false);
    assert.match(poor.body.data.errors.join(' '), /Fund the Safe/);
    const noDeposit = await setup().run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A' });
    assert.match(noDeposit.body.data.warnings.join(' '), /forfeited from the start/);
    const closed = await setup({}, { fairOpen: false }).run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A', depositEth: '0.1' });
    assert.match(closed.body.data.errors.join(' '), /closed/);
    const taken = await setup({}, { codeAt: { [P_TOKEN.toLowerCase()]: '0x60' } }).run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A', depositEth: '0.1' });
    assert.match(taken.body.data.errors.join(' '), /already launched/);
  });

  it('refuses a non-owner, and a Roles module the Safe does not own', async () => {
    const notOwner = await setup({ getOwners: ['0x7777777777777777777777777777777777777777'] }).run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A' });
    assert.equal(notOwner.status, 403);
    const foreignRoles = await setup({ owner: OWNER }).run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A' });
    assert.equal(foreignRoles.status, 404);
  });

  it('refuses a listed token that is not an urufu token', async () => {
    const r = await setup().run('launch_agent_token', { owner: OWNER, safe: SAFE, roles: ROLES, name: 'A', ticker: 'A', listedTokens: '0x8888888888888888888888888888888888888888' });
    assert.equal(r.status, 400);
  });
});

describe('own-token rule in update_agent_account', () => {
  it('a Fair token the Safe launched always gets selling off, even with allowSells', async () => {
    const s = setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: SAFE, batchFor: P_BATCH });
    const r = await s.run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN, allowSells: true, dailySellTokens: '1000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.changes.some((c) => /own Fair token: selling stays off/.test(c)));
    const ops = rolesOps(unpack(r.body.data.transactions[0].data));
    assert.equal(ops.filter((o) => o.functionName === 'setAllowance').length, 0, 'no sell allowance for the own token');
    assert.ok(ops.some((o) => o.functionName === 'revokeFunction' && o.args[1] === getAddress(FAIR_CURVE)));
  });
  it('another creator\'s Fair token keeps its sell cap', async () => {
    const s = setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: OWNER, batchFor: P_BATCH });
    const r = await s.run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN, dailySellTokens: '1000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ops = rolesOps(unpack(r.body.data.transactions[0].data));
    assert.ok(ops.some((o) => o.functionName === 'setAllowance' && o.args[1] === 1000n * E18));
  });
});

describe('get_agent_token', () => {
  const POOL = ['0x0', SAFE, 1n, 0, 3000, 60, true, false, 1000n * E18];
  it('graduated: fees, baseline, floor and forfeit state from chain', async () => {
    const s = setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: SAFE, curve: { ...defaultChain().curve, graduated: true }, fairPool: POOL, fairFees: [1n, 2n, 3n, 4n], tokenBalance: 950n * E18 });
    const r = await s.run('get_agent_token', { safe: SAFE, token: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.isAgentToken, true);
    assert.equal(d.stage, 'graduated');
    assert.equal(d.pool.baseline, String(1000n * E18));
    assert.equal(d.pool.floor, String(900n * E18), '10% drop allowed');
    assert.deepEqual(d.pool.fees, { pendingEth: '1', pendingToken: '2', claimableEth: '3', claimableToken: '4' });
    assert.equal(d.pool.forfeited, false);
    assert.match(d.status, /Earning/);
  });
  it('forfeited, and someone else\'s token, and a non-Fair token', async () => {
    const f = await setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: SAFE, curve: { ...defaultChain().curve, graduated: true }, fairPool: POOL, fairForfeited: true }).run('get_agent_token', { safe: SAFE, token: TOKEN });
    assert.equal(f.body.data.pool.forfeited, true);
    assert.match(f.body.data.status, /forfeited/);
    const other = await setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: OWNER }).run('get_agent_token', { safe: SAFE, token: TOKEN });
    assert.equal(other.body.data.isAgentToken, false);
    assert.equal(other.body.data.pool, null);
    const notFair = await setup().run('get_agent_token', { safe: SAFE, token: TOKEN });
    assert.equal(notFair.status, 404);
  });
  it('pre-graduation creator sell is reported', async () => {
    const r = await setup({ creatorSold: true }, { fairCurveFor: FAIR_CURVE, curveLauncher: SAFE }).run('get_agent_token', { safe: SAFE, token: TOKEN });
    assert.match(r.body.data.status, /sold on the curve/);
  });
});

describe('get_agent_profile', () => {
  it('finds the Roles module, caps and only the tokens the Safe really launched', async () => {
    const s = setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: SAFE });
    s.deps.indexer.launchesByCreator = async () => [{ tokenAddress: TOKEN, lane: 'fair' }, { tokenAddress: '0x8888888888888888888888888888888888888888', lane: 'fair' }, { tokenAddress: '0x9999999999999999999999999999999999999999' }];
    const r = await s.run('get_agent_profile', { safe: SAFE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.roles, getAddress(ROLES));
    assert.equal(d.policyActive, true);
    assert.equal(d.caps.perDay, String(parseEther('0.25')));
    // The fake chain says every Fair token's launcher is the Safe; token-lane rows
    // are skipped, so only the two Fair rows the indexer pointed at are listed.
    assert.equal(d.tokens.length, 2);
  });
  it('drops indexer rows the chain does not confirm', async () => {
    const s = setup({}, { fairCurveFor: FAIR_CURVE, curveLauncher: OWNER });
    s.deps.indexer.launchesByCreator = async () => [{ tokenAddress: TOKEN, lane: 'fair' }];
    const r = await s.run('get_agent_profile', { safe: SAFE });
    assert.equal(r.body.data.tokens.length, 0);
  });
  it('no policy module, and not a Safe', async () => {
    const none = await setup({ getModulesPaginated: [[], '0x0000000000000000000000000000000000000001'] }).run('get_agent_profile', { safe: SAFE });
    assert.equal(none.body.data.policyActive, false);
    assert.equal(none.body.data.caps, null);
    const notSafe = await setup({ getOwners: new Error('no code') }).run('get_agent_profile', { safe: SAFE });
    assert.equal(notSafe.status, 404);
  });
});

