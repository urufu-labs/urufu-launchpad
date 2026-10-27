/// Agent link store (routes/agents.ts): owner signature, expiry, replay, on-chain
/// ERC-8004 ownership + wallet checks, re-verification on read.
///
/// Signatures are real EIP-712 signatures from throwaway keys generated per run
/// (verified with viem's local recovery). The registry reads and sql are faked.

import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { registerAgentRoutes, type AgentChain } from './agents.ts';
import type { SqlLike } from './social.ts';
import { AGENT_LINK_DOMAIN, AGENT_LINK_TYPES } from '../../../shared/agent-link.ts';

const NOW = 1_800_000_000_000;
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const AGENT = '0x5555555555555555555555555555555555555555' as Address;

/// In-memory stand-in for the two tables, keyed off the SQL text.
function fakeDb() {
  const nonces = new Set<string>();
  const agents = new Map<string, Record<string, unknown>>();
  const fn = (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!('raw' in (strings as object))) return { __list: strings };
    const text = (strings as TemplateStringsArray).join('?');
    if (text.includes('INSERT INTO app.agent_link_nonces')) {
      const k = `${values[0]}:${values[1]}`;
      if (nonces.has(k)) return [];
      nonces.add(k);
      return [{ nonce: values[1] }];
    }
    if (text.includes('INSERT INTO app.agents')) {
      const row = { agentWallet: values[0], owner: values[1], agentId: values[2], registry: values[3], name: values[5], linkedAt: '2026-10-27T00:00:00Z' };
      agents.set(values[0] as string, row);
      return [row];
    }
    if (text.includes('FROM app.agents')) {
      const list = (values[0] as { __list: string[] }).__list;
      return list.map((w) => agents.get(w)).filter(Boolean);
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return { sql: fn as unknown as SqlLike, nonces, agents };
}

function fakeChain(state: { owner: Address | null; wallet: Address | null }): AgentChain {
  return {
    ownerOf: async () => state.owner,
    agentWalletOf: async () => state.wallet,
    async verifyLink({ owner: o, message, signature }) {
      const rec = await recoverTypedDataAddress({ domain: AGENT_LINK_DOMAIN, types: AGENT_LINK_TYPES, primaryType: 'AgentLink', message: message as never, signature });
      return rec.toLowerCase() === o.toLowerCase();
    },
  };
}

async function makeApp(state = { owner: owner.address as Address | null, wallet: AGENT as Address | null }, now = () => NOW) {
  const db = fakeDb();
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await registerAgentRoutes(app, { sqlOverride: db.sql, chain: fakeChain(state), now });
  return { app, db, state };
}

async function signedBody(over: Partial<{ name: string; expiry: number; nonce: Hex; agentId: string }> = {}, signer = owner) {
  const msg = {
    owner: owner.address,
    agentWallet: AGENT,
    agentId: BigInt(over.agentId ?? '7'),
    name: over.name ?? 'Pond Bot',
    nonce: over.nonce ?? (`0x${'ab'.repeat(32)}` as Hex),
    expiry: BigInt(over.expiry ?? NOW / 1000 + 1800),
  };
  const signature = await signer.signTypedData({ domain: AGENT_LINK_DOMAIN, types: AGENT_LINK_TYPES, primaryType: 'AgentLink', message: msg });
  return { owner: owner.address, agentWallet: AGENT, agentId: msg.agentId.toString(), name: msg.name, nonce: msg.nonce, expiry: Number(msg.expiry), signature };
}

const post = (app: Awaited<ReturnType<typeof makeApp>>['app'], body: unknown) =>
  app.inject({ method: 'POST', url: '/agents/link', payload: body as object });

test('valid link is stored and shows up on read', async () => {
  const { app } = await makeApp();
  const res = await post(app, await signedBody());
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().record.agentWallet, AGENT.toLowerCase());
  const read = await app.inject({ method: 'GET', url: `/agents?wallets=${AGENT},0x6666666666666666666666666666666666666666` });
  assert.equal(read.json().agents.length, 1);
  assert.equal(read.json().agents[0].owner, owner.address.toLowerCase());
});

test('replaying the same signed link is refused', async () => {
  const { app } = await makeApp();
  const body = await signedBody();
  assert.equal((await post(app, body)).statusCode, 200);
  const again = await post(app, body);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'REPLAY');
});

test('signature from someone other than the owner is refused', async () => {
  const { app } = await makeApp();
  const res = await post(app, await signedBody({}, stranger));
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'BAD_SIGNATURE');
});

test('tampered fields break the signature', async () => {
  const { app } = await makeApp();
  const body = await signedBody();
  for (const patch of [{ agentId: '8' }, { name: 'Other Bot' }, { agentWallet: '0x6666666666666666666666666666666666666666' }, { expiry: body.expiry + 1 }]) {
    const res = await post(app, { ...body, ...patch });
    assert.equal(res.statusCode, 401, JSON.stringify(patch));
  }
});

test('expired, too-far, and bad-name links are refused', async () => {
  const { app } = await makeApp();
  assert.equal((await post(app, await signedBody({ expiry: NOW / 1000 - 1 }))).json().code, 'EXPIRED');
  assert.equal((await post(app, await signedBody({ expiry: NOW / 1000 + 7200 }))).json().code, 'EXPIRY_TOO_FAR');
  assert.equal((await post(app, await signedBody({ name: 'bad‮name' }))).json().code, 'BAD_NAME');
  assert.equal((await post(app, await signedBody({ name: '  padded ' }))).json().code, 'BAD_NAME');
});

test('on-chain ownership and wallet must match', async () => {
  let ctx = await makeApp({ owner: stranger.address, wallet: AGENT });
  assert.equal((await post(ctx.app, await signedBody())).json().code, 'NOT_OWNER');
  ctx = await makeApp({ owner: owner.address, wallet: owner.address });
  assert.equal((await post(ctx.app, await signedBody())).json().code, 'WALLET_NOT_SET');
  ctx = await makeApp({ owner: null, wallet: null });
  assert.equal((await post(ctx.app, await signedBody())).json().code, 'NO_AGENT');
});

test('agent wallet equal to owner is refused', async () => {
  const { app } = await makeApp();
  const body = await signedBody();
  const res = await post(app, { ...body, agentWallet: owner.address });
  assert.equal(res.json().code, 'SAME_WALLET');
});

test('unknown fields and private-key-like fields are refused by the strict schema', async () => {
  const { app } = await makeApp();
  const body = await signedBody();
  assert.equal((await post(app, { ...body, privateKey: '0x' + '11'.repeat(32) })).statusCode, 400);
});

test('badge drops on read when the agent NFT moves or its wallet changes', async () => {
  let t = NOW;
  const ctx = await makeApp(undefined, () => t);
  assert.equal((await post(ctx.app, await signedBody())).statusCode, 200);
  const read = () => ctx.app.inject({ method: 'GET', url: `/agents?wallets=${AGENT}` }).then((r) => r.json().agents.length);
  assert.equal(await read(), 1);
  ctx.state.owner = stranger.address; // NFT transferred
  assert.equal(await read(), 1, 'cached for up to a minute');
  t += 61_000;
  assert.equal(await read(), 0);
  ctx.state.owner = owner.address;
  ctx.state.wallet = null; // registry wallet cleared
  t += 61_000;
  assert.equal(await read(), 0);
});

test('wallet list limits', async () => {
  const { app } = await makeApp();
  assert.equal((await app.inject({ method: 'GET', url: '/agents?wallets=nope' })).statusCode, 400);
  const many = Array.from({ length: 101 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`).join(',');
  assert.equal((await app.inject({ method: 'GET', url: `/agents?wallets=${many}` })).statusCode, 400);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/agents' })).json(), { agents: [] });
});
