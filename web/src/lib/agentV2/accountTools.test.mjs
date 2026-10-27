// Phase 1c account tools (offline): setup / update / revoke / status / agent_exec,
// plus the policy encoding helpers. The on-chain behaviour of this exact calldata is
// proven on a Robinhood fork by contracts/test/agent/AgentPolicyFork.t.sol.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, encodeAbiParameters, parseEther } from 'viem';

import {
  AGENT_ACCOUNT_CONTRACTS, AGENT_ROLE_KEY, flatten, moduleProxyFactoryAbi, multiSendAbi, ownerSenderSignature, rolesAbi, safeAbi, safeProxyFactoryAbi,
} from './agentPolicy.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, CURVE, TOKEN, defaultChain, fakeDeps } from './testFixtures.mjs';

const OWNER = '0x1111111111111111111111111111111111111111';
const AGENT = '0x5555555555555555555555555555555555555555';
const SAFE = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const ROLES = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';

function setup(over = {}) {
  const chain = defaultChain();
  const { deps } = fakeDeps({ chain });
  const word = (a) => encodeAbiParameters([{ type: 'address' }], [a]);
  deps.client.call = async (args) => {
    chain.calls.push(args);
    if (chain.callReverts) { const e = new Error(chain.callReverts); e.shortMessage = chain.callReverts; throw e; }
    if (args.to === AGENT_ACCOUNT_CONTRACTS.SafeProxyFactory) return { data: word(SAFE) };
    if (args.to === AGENT_ACCOUNT_CONTRACTS.ModuleProxyFactory) return { data: word(ROLES) };
    return { data: '0x' };
  };
  const reads = { getOwners: [OWNER], getThreshold: 1n, owner: SAFE, avatar: SAFE, isModuleEnabled: true, ...over };
  const orig = deps.client.readContract;
  deps.client.readContract = async (a) => (a.functionName in reads ? (reads[a.functionName] instanceof Error ? Promise.reject(reads[a.functionName]) : reads[a.functionName]) : a.functionName === 'allowances' ? [1n, 1n, 1n, 1n, 1n] : orig(a));
  const ctx = { ip: '198.51.100.30', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
  return { chain, deps, run: (tool, input) => runTool(tool, input, ctx) };
}

describe('policy encoding', () => {
  it('flatten is breadth-first with non-decreasing parents', () => {
    const tree = { paramType: 5, operator: 5, children: [
      { paramType: 3, operator: 5, children: [{ paramType: 1, operator: 16, compValue: '0x01' }, { paramType: 1, operator: 0 }] },
      { paramType: 1, operator: 15 },
      { paramType: 0, operator: 29, compValue: '0x02' },
    ] };
    const flat = flatten(tree);
    assert.deepEqual(flat.map((n) => n.parent), [0, 0, 0, 0, 1, 1]);
    assert.deepEqual(flat.map((n) => n.operator), [5, 5, 15, 29, 16, 0]);
  });
  it('owner signature is r = owner, s = 0, v = 1', () => {
    const sig = ownerSenderSignature(OWNER);
    assert.equal(sig.length, 2 + 65 * 2);
    assert.equal(sig.slice(2, 66), '0'.repeat(24) + OWNER.slice(2));
    assert.equal(sig.slice(66, 130), '0'.repeat(64));
    assert.equal(sig.slice(130), '01');
  });
});

describe('setup_agent_account', () => {
  it('returns create Safe, deploy Roles, arm policy, fund; predicted addresses; caps', async () => {
    const s = setup();
    const r = await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: TOKEN, fundEth: '1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.safe, SAFE);
    assert.equal(d.roles, ROLES);
    assert.deepEqual(d.transactions.map((t) => t.purpose), ['createSafe', 'deployRoles', 'armPolicy', 'fund']);
    const cs = decodeFunctionData({ abi: safeProxyFactoryAbi, data: d.transactions[0].data });
    assert.equal(cs.args[0], AGENT_ACCOUNT_CONTRACTS.SafeL2);
    const init = decodeFunctionData({ abi: safeAbi, data: cs.args[1] });
    assert.deepEqual(init.args[0], [OWNER]);
    assert.equal(init.args[1], 1n);
    const dr = decodeFunctionData({ abi: moduleProxyFactoryAbi, data: d.transactions[1].data });
    assert.equal(dr.args[0], AGENT_ACCOUNT_CONTRACTS.RolesMastercopy);
    // Arm: an owner-sent Safe tx delegatecalling MultiSendCallOnly.
    const arm = decodeFunctionData({ abi: safeAbi, data: d.transactions[2].data });
    assert.equal(arm.functionName, 'execTransaction');
    assert.equal(arm.args[0], AGENT_ACCOUNT_CONTRACTS.MultiSendCallOnly);
    assert.equal(arm.args[3], 1);
    assert.equal(decodeFunctionData({ abi: multiSendAbi, data: arm.args[2] }).functionName, 'multiSend');
    assert.equal(d.transactions[2].to, SAFE);
    assert.equal(d.transactions[3].value, String(parseEther('1')));
    assert.equal(d.policy.caps.perTx, '0.05 ETH');
    assert.equal(d.policy.caps.perDay, '0.25 ETH');
    assert.equal(d.policy.tokens[0].curve, CURVE);
    // Default sell cap = what the daily ETH cap buys now (fake curve quote: 1,000,000 tokens).
    assert.equal(d.policy.tokens[0].dailySellTokens, '1000000');
  });

  it('sell caps: explicit amount, or selling off', async () => {
    let r = await setup().run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: TOKEN, dailySellTokens: '5000' });
    assert.equal(r.body.data.policy.tokens[0].dailySellTokens, '5000');
    r = await setup().run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: TOKEN, allowSells: false });
    assert.equal(r.body.data.policy.tokens[0].dailySellTokens, 'selling off');
  });

  it('a token that cannot be priced needs an explicit sell cap', async () => {
    const s = setup();
    const orig = s.deps.client.readContract;
    s.deps.client.readContract = async (a) => (a.functionName === 'quoteBuy' ? Promise.reject(new Error('x')) : orig(a));
    const r = await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: TOKEN });
    assert.equal(r.body.error.code, 'SELL_CAP_NEEDED');
  });

  it('input rules: agent != owner, per-trade <= daily, daily <= 10 ETH, no zero caps', async () => {
    const s = setup();
    assert.equal((await s.run('setup_agent_account', { owner: OWNER, agent: OWNER })).status, 400);
    assert.equal((await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, dailyEth: '0.1', perTradeEth: '0.2' })).status, 400);
    assert.equal((await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, dailyEth: '11', perTradeEth: '1' })).status, 400);
    assert.equal((await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, dailyEth: '0', perTradeEth: '0' })).status, 400);
    assert.equal((await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: 'not,addresses' })).status, 400);
  });

  it('refuses DN404 and unknown tokens', async () => {
    const s = setup();
    s.deps.indexer.dn404ForBase = async () => ({ collectionAddress: '0x9' });
    const r = await s.run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: TOKEN });
    assert.equal(r.body.error.code, 'BAD_TOKEN');
    const s2 = setup();
    const u = await s2.run('setup_agent_account', { owner: OWNER, agent: AGENT, tokens: '0x9999999999999999999999999999999999999999' });
    assert.equal(u.body.error.code, 'BAD_TOKEN');
  });

  it('no tokens is fine (swaps and claims only); fund 0 adds no fund tx', async () => {
    const r = await setup().run('setup_agent_account', { owner: OWNER, agent: AGENT });
    assert.equal(r.body.data.transactions.length, 3);
  });
});

describe('update / revoke', () => {
  it('update: one Safe tx with new caps and tokens', async () => {
    const r = await setup().run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN, dailyEth: '0.5', perTradeEth: '0.1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.transactions.length, 1);
    assert.deepEqual(r.body.data.changes, ['caps: 0.1 ETH per tx, 0.5 ETH per day', 'token list set to 1 token(s)']);
  });
  it('update: dropping a token from the list revokes its curve, token and batch targets', async () => {
    const OLD = '0x7777777777777777777777777777777777777777';
    const s = setup();
    const orig = s.deps.client.readContract;
    s.deps.client.readContract = async (a) => (a.functionName === 'curveFor' && a.args?.[0] === OLD && a.address === BOOK.CurveFactory ? '0x8888888888888888888888888888888888888888' : orig(a));
    const r = await s.run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: `${TOKEN},${OLD}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.changes.includes(`remove ${OLD}`));
    const batch = r.body.data.transactions[0].data.toLowerCase();
    // revokeTarget(role, curve) and revokeTarget(role, token) are in the batch.
    assert.ok(batch.includes('8888888888888888888888888888888888888888'));
    assert.ok(batch.includes(OLD.slice(2)));
    assert.equal(r.body.data.tokenList, TOKEN);
  });
  it('update: tokens needs previousTokens, and previousTokens alone is refused', async () => {
    assert.equal((await setup().run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN })).status, 400);
    assert.equal((await setup().run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, previousTokens: TOKEN })).status, 400);
  });
  it('update refuses: not owner, multi-sig Safe, foreign Roles, nothing to change, half caps', async () => {
    assert.equal((await setup({ getOwners: ['0x2222222222222222222222222222222222222222'] }).run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN })).status, 403);
    assert.equal((await setup({ getThreshold: 2n }).run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN })).status, 409);
    assert.equal((await setup({ owner: OWNER }).run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, tokens: TOKEN, previousTokens: TOKEN })).status, 404);
    assert.equal((await setup().run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES })).status, 400);
    assert.equal((await setup().run('update_agent_account', { owner: OWNER, safe: SAFE, roles: ROLES, dailyEth: '1' })).status, 400);
  });
  it('revoke: Safe tx that removes the agent from the role', async () => {
    const r = await setup().run('revoke_agent', { owner: OWNER, safe: SAFE, roles: ROLES, agent: AGENT });
    const exec = decodeFunctionData({ abi: safeAbi, data: r.body.data.transactions[0].data });
    // The MultiSend batch carries assignRoles(agent, [role], [false]) to the Roles module.
    const inner = exec.args[2].toLowerCase();
    assert.ok(inner.includes(ROLES.slice(2).toLowerCase()), 'Roles module is the target');
    assert.ok(inner.includes(AGENT.slice(2).toLowerCase()), 'agent in calldata');
    assert.ok(inner.includes(AGENT_ROLE_KEY.slice(2)), 'role key in calldata');
  });
});

describe('get_agent_account / agent_exec', () => {
  it('status reads owners, module, caps, balance', async () => {
    const r = await setup().run('get_agent_account', { safe: SAFE, roles: ROLES });
    assert.equal(r.body.data.policyActive, true);
    assert.deepEqual(r.body.data.owners, [OWNER]);
    assert.ok(r.body.data.caps.daily);
  });
  it('agent_exec wraps the tx in execTransactionWithRole and reports allowedNow', async () => {
    const s = setup();
    const r = await s.run('agent_exec', { safe: SAFE, roles: ROLES, agent: AGENT, to: CURVE, value: String(parseEther('0.01')), data: '0xd96a094a' + '0'.repeat(64) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.allowedNow, true);
    const tx = r.body.data.transactions[0];
    assert.equal(tx.to, ROLES);
    assert.equal(tx.value, '0');
    const dec = decodeFunctionData({ abi: rolesAbi, data: tx.data });
    assert.equal(dec.functionName, 'execTransactionWithRole');
    assert.equal(dec.args[0], CURVE);
    assert.equal(dec.args[1], parseEther('0.01'));
    assert.equal(dec.args[3], 0);
    assert.equal(dec.args[4], AGENT_ROLE_KEY);
    assert.equal(s.chain.calls.at(-1).account, AGENT);
  });
  it('agent_exec: policy refusal means no tx and a reason', async () => {
    const s = setup();
    s.chain.callReverts = 'ConditionViolation(19)';
    const r = await s.run('agent_exec', { safe: SAFE, roles: ROLES, agent: AGENT, to: CURVE, data: '0x' });
    assert.equal(r.body.data.allowedNow, false);
    assert.equal(r.body.data.transactions.length, 0);
    assert.equal(r.body.data.canBroadcast, false);
  });
  it('agent_exec refuses a Roles module that is not this Safe\'s', async () => {
    const r = await setup({ avatar: '0x2222222222222222222222222222222222222222' }).run('agent_exec', { safe: SAFE, roles: ROLES, agent: AGENT, to: CURVE, data: '0x' });
    assert.equal(r.status, 404);
  });
  it('no account tool accepts a key', async () => {
    for (const tool of ['setup_agent_account', 'update_agent_account', 'revoke_agent', 'get_agent_account', 'agent_exec']) {
      const r = await setup().run(tool, { agentPrivateKey: '0x' + '11'.repeat(32) });
      assert.equal(r.body.error.code, 'SECRET_FIELD', tool);
    }
  });
});

void BOOK;

describe('per-wallet rate limit', () => {
  it('agent_exec is limited per agent wallet even across different IPs', async () => {
    const s = setup();
    const limiter = new RateLimiter();
    const cache = new TtlCache();
    let last;
    for (let i = 0; i < 31; i++) {
      last = await runTool('agent_exec', { safe: SAFE, roles: ROLES, agent: AGENT, to: CURVE, data: '0x' }, { ip: `203.0.113.${i}`, deps: s.deps, limiter, cache, source: 'rest' });
    }
    assert.equal(last.status, 429);
    assert.match(last.body.error.message, /this wallet/);
    const other = await runTool('agent_exec', { safe: SAFE, roles: ROLES, agent: OWNER, to: CURVE, data: '0x' }, { ip: '203.0.113.99', deps: s.deps, limiter, cache, source: 'rest' });
    assert.equal(other.status, 200);
  });
});
