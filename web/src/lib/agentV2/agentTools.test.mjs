// Agent registration (ERC-8004 + owner link) and the Agent badge, end to end over
// the five register_agent steps with real EIP-712 signatures from throwaway keys.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { identityRegistryAbi } from './agentTools.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, CURVE, TOKEN, defaultChain, fakeAgentStore, fakeDeps } from './testFixtures.mjs';

const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

function setup(over = {}) {
  const chain = defaultChain();
  chain.agentOwner = owner.address;
  Object.assign(chain, over);
  const agents = fakeAgentStore();
  const { deps } = fakeDeps({ chain, agents });
  // Real signature checks (EOA recovery) instead of the fake's fixed answer.
  deps.client.verifyTypedData = (args) => verifyTypedData(args);
  const c = { ip: '198.51.100.20', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' };
  const run = (input) => runTool('register_agent', { owner: owner.address, agentWallet: agent.address, ...input }, c);
  return { chain, agents, deps, c, run };
}

/// Sign the typed data a step returned, exactly as a wallet would from the JSON.
async function sign(account, typedData) {
  const message = Object.fromEntries(Object.entries(typedData.message).map(([k, v]) => [k, /^\d+$/.test(String(v)) && ['agentId', 'deadline', 'expiry'].includes(k) ? BigInt(v) : v]));
  return account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message });
}

describe('register_agent', () => {
  it('full flow: register -> wallet_message -> set_wallet -> link_message -> link', async () => {
    const s = setup();
    let r = await s.run({ step: 'register', agentURI: 'https://example.com/agent.json' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const reg = decodeFunctionData({ abi: identityRegistryAbi, data: r.body.data.transactions[0].data });
    assert.equal(reg.functionName, 'register');
    assert.deepEqual(reg.args, ['https://example.com/agent.json']);
    assert.equal(r.body.data.transactions[0].to, BOOK.Erc8004IdentityRegistry);

    r = await s.run({ step: 'wallet_message', agentId: '7' });
    const wm = r.body.data;
    assert.equal(wm.signWith, agent.address);
    assert.equal(wm.typedData.domain.name, 'ERC8004IdentityRegistry');
    assert.equal(wm.typedData.message.owner, owner.address);
    const agentSig = await sign(agent, wm.typedData);

    r = await s.run({ step: 'set_wallet', agentId: '7', deadline: wm.deadline, signature: agentSig });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const set = decodeFunctionData({ abi: identityRegistryAbi, data: r.body.data.transactions[0].data });
    assert.equal(set.functionName, 'setAgentWallet');
    assert.deepEqual(set.args.slice(0, 3), [7n, agent.address, BigInt(wm.deadline)]);

    s.chain.agentWalletOnChain = agent.address; // the setAgentWallet tx landed
    r = await s.run({ step: 'link_message', agentId: '7', name: 'Pond Bot' });
    const lm = r.body.data;
    assert.equal(lm.signWith, owner.address);
    assert.equal(lm.typedData.domain.name, 'urufu agent link');
    const ownerSig = await sign(owner, lm.typedData);

    r = await s.run({ step: 'link', agentId: '7', name: 'Pond Bot', nonce: lm.nonce, expiry: lm.expiry, signature: ownerSig });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.linked, true);
    assert.equal(r.body.untrusted.fields.name.text, 'Pond Bot');
    assert.equal(s.agents.store.links[0].signature, ownerSig);

    const g = await runTool('get_agent', { wallet: agent.address }, s.c);
    assert.equal(g.body.data.isAgent, true);
    assert.equal(g.body.data.owner, owner.address);
  });

  it('set_wallet refuses a signature from the wrong wallet or for another agent id', async () => {
    const s = setup();
    const wm = (await s.run({ step: 'wallet_message', agentId: '7' })).body.data;
    const wrong = await sign(other, wm.typedData);
    let r = await s.run({ step: 'set_wallet', agentId: '7', deadline: wm.deadline, signature: wrong });
    assert.equal(r.body.error.code, 'BAD_SIGNATURE');
    const right = await sign(agent, wm.typedData);
    r = await s.run({ step: 'set_wallet', agentId: '8', deadline: wm.deadline, signature: right });
    assert.equal(r.body.error.code, 'BAD_SIGNATURE');
  });

  it('set_wallet refuses expired and too-far deadlines', async () => {
    const s = setup();
    const t = Number(s.chain.timestamp);
    const sig = '0x' + '11'.repeat(65);
    assert.equal((await s.run({ step: 'set_wallet', agentId: '7', deadline: t - 1, signature: sig })).body.error.code, 'EXPIRED');
    assert.equal((await s.run({ step: 'set_wallet', agentId: '7', deadline: t + 600, signature: sig })).status, 400);
  });

  it('steps after register need the owner to own the agent NFT', async () => {
    const s = setup({ agentOwner: other.address });
    const r = await s.run({ step: 'wallet_message', agentId: '7' });
    assert.equal(r.status, 403);
    const missing = setup({ agentOwner: null });
    assert.equal((await missing.run({ step: 'wallet_message', agentId: '7' })).status, 404);
  });

  it('link steps need the registry wallet set first', async () => {
    const s = setup();
    const r = await s.run({ step: 'link_message', agentId: '7', name: 'Bot' });
    assert.equal(r.body.error.code, 'WALLET_NOT_SET');
  });

  it('input rules: same wallet, missing fields, bad names and URIs, secret fields', async () => {
    const s = setup({ agentWalletOnChain: null });
    assert.equal((await runTool('register_agent', { step: 'register', owner: owner.address, agentWallet: owner.address }, s.c)).status, 400);
    assert.equal((await s.run({ step: 'wallet_message' })).status, 400);
    assert.equal((await s.run({ step: 'register', agentURI: 'javascript:alert(1)' })).status, 400);
    assert.equal((await s.run({ step: 'register', agentURI: 'http://plain.example' })).status, 400);
    assert.equal((await s.run({ step: 'register', agentPrivateKey: '0x' + '22'.repeat(32) })).body.error.code, 'SECRET_FIELD');
    const s2 = setup({ agentWalletOnChain: agent.address });
    assert.equal((await s2.run({ step: 'link_message', agentId: '7', name: 'bad‮name' })).status, 400);
  });

  it('expired link is refused before reaching the store', async () => {
    const s = setup({ agentWalletOnChain: agent.address });
    const r = await s.run({ step: 'link', agentId: '7', name: 'Bot', nonce: '0x' + 'ab'.repeat(32), expiry: Number(s.chain.timestamp) - 5, signature: '0x' + '11'.repeat(65) });
    assert.equal(r.body.error.code, 'EXPIRED');
    assert.equal(s.agents.store.links.length, 0);
  });

  it('store errors come back as tool errors', async () => {
    const s = setup({ agentWalletOnChain: agent.address });
    s.deps.agents.link = async () => ({ ok: false, status: 409, code: 'REPLAY', message: 'this link signature was already used' });
    const r = await s.run({ step: 'link', agentId: '7', name: 'Bot', nonce: '0x' + 'ab'.repeat(32), expiry: Number(s.chain.timestamp) + 100, signature: '0x' + '11'.repeat(65) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'REPLAY');
  });
});

describe('Agent badge in reads', () => {
  it('get_agent: unknown wallet is not an agent; store down is a 502', async () => {
    const s = setup();
    assert.equal((await runTool('get_agent', { wallet: other.address }, s.c)).body.data.isAgent, false);
    s.deps.agents.byWallets = async () => null;
    s.c.cache.clear();
    assert.equal((await runTool('get_agent', { wallet: agent.address }, s.c)).status, 502);
  });

  it('get_trades and get_holders flag agent wallets', async () => {
    const AGENT_TRADER = '0x1111111111111111111111111111111111111111';
    const agents = fakeAgentStore([{ agentWallet: AGENT_TRADER, owner: owner.address, agentId: '7', registry: BOOK.Erc8004IdentityRegistry, name: 'Bot', linkedAt: 'x' }]);
    const { deps } = fakeDeps({ agents });
    const c = { ip: 'b', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' };
    const t = await runTool('get_trades', { address: TOKEN }, c);
    const curveRow = t.body.data.trades.find((r) => r.venue === 'curve');
    assert.equal(curveRow.traderIsAgent, true);
    const h = await runTool('get_holders', { address: TOKEN }, c);
    assert.equal(h.body.data.holders.find((x) => x.holder === CURVE).isAgent, false);
  });

  it('a down agent store never breaks trades or holders', async () => {
    const { deps } = fakeDeps();
    deps.agents.byWallets = async () => { throw new Error('down'); };
    const c = { ip: 'c', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' };
    assert.equal((await runTool('get_trades', { address: TOKEN }, c)).status, 200);
    assert.equal((await runTool('get_holders', { address: TOKEN }, c)).status, 200);
  });
});

describe('verify_tx sees registry events', () => {
  it('Registered and agentWallet MetadataSet from the registry are reported', async () => {
    const { encodeEventTopics, encodeAbiParameters, parseAbi } = await import('viem');
    const ev = parseAbi([
      'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
      'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
    ]);
    const HASH = '0x' + 'cd'.repeat(32);
    const chain = defaultChain();
    chain.receipts[HASH] = {
      status: 'success', blockNumber: 1n, from: owner.address, to: BOOK.Erc8004IdentityRegistry, gasUsed: 1n,
      logs: [
        { address: BOOK.Erc8004IdentityRegistry, topics: encodeEventTopics({ abi: ev, eventName: 'Registered', args: { agentId: 7n, owner: owner.address } }), data: encodeAbiParameters([{ type: 'string' }], ['']) },
        { address: BOOK.Erc8004IdentityRegistry, topics: encodeEventTopics({ abi: ev, eventName: 'MetadataSet', args: { agentId: 7n, indexedMetadataKey: 'agentWallet' } }), data: encodeAbiParameters([{ type: 'string' }, { type: 'bytes' }], ['agentWallet', agent.address.toLowerCase()]) },
      ],
    };
    const { deps } = fakeDeps({ chain });
    const r = await runTool('verify_tx', { txHash: HASH }, { ip: 'v', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' });
    const types = r.body.data.actions.map((a) => a.type);
    assert.deepEqual(types, ['agent_registered', 'agent_wallet_set']);
    assert.equal(r.body.data.actions[0].agentId, '7');
    assert.equal(r.body.data.actions[1].agentWallet, agent.address);
  });
});
