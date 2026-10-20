/// Route-level tests for the collection page-details write
/// (`POST /collection/:chainId/:address/metadata`).
///
/// The indexer + RPC lookups are injected, and sql is a fake that records
/// calls, so these cover the auth gate end to end: signature, URL binding,
/// launcher check, on-chain owner cross-check (including the DN404 base-token
/// redirect), and that nothing is written unless every check passes.

import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import type { Address } from 'viem';

import { canonicalMessage } from '../auth.ts';
import { registerCollectionMetadataRoutes, type CollectionRecord } from './collection-metadata.ts';
import type { SqlLike } from './social.ts';

const CHAIN = 4663;
const COLLECTION = '0x5915f1eb528287ce74e181627262f0fb1a7796b5';
const DN404_BASE = '0x26903cc300c81d056051e50c6cdec16054427122';

interface FakeCall { strings: readonly string[]; values: readonly unknown[] }

function makeFakeSql(): { sql: SqlLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const inner = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return [] as unknown as ReturnType<SqlLike>;
  };
  return { sql: inner as unknown as SqlLike, calls };
}

async function makeApp(opts: {
  record: CollectionRecord | null;
  owner: string | null;
}): Promise<{ app: FastifyInstance; calls: FakeCall[]; ownerTargets: string[] }> {
  const { sql, calls } = makeFakeSql();
  const ownerTargets: string[] = [];
  const app = Fastify({ logger: false });
  await registerCollectionMetadataRoutes(app, {
    sqlOverride: sql,
    lookupCollection: async () => opts.record,
    lookupOwner: async (target: Address) => {
      ownerTargets.push(target.toLowerCase());
      return opts.owner;
    },
  });
  return { app, calls, ownerTargets };
}

async function signed(acct: PrivateKeyAccount, payload: Record<string, unknown>, action = 'collection:save') {
  const timestamp = Date.now();
  const signature = await acct.signMessage({ message: canonicalMessage(action, payload, timestamp) });
  return { address: acct.address, signature, timestamp, payload };
}

function post(app: FastifyInstance, body: unknown, address = COLLECTION) {
  return app.inject({
    method: 'POST',
    url: `/collection/${CHAIN}/${address}/metadata`,
    payload: body as Record<string, unknown>,
    headers: { 'content-type': 'application/json' },
  });
}

const basePayload = {
  chainId: CHAIN,
  collectionAddress: COLLECTION,
  imageUrl: 'https://example.com/cover.png',
  description: 'Hand drawn wolves',
  website: 'https://example.com',
  twitter: 'spoobsV1',
  telegram: null,
  discord: null,
};

const inserts = (calls: FakeCall[]) => calls.filter((c) => c.strings.join('').includes('INSERT INTO app.token_metadata'));

test('launcher who is also on-chain owner can save, row keyed on the collection', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls, ownerTargets } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const res = await post(app, await signed(launcher, basePayload));
    assert.equal(res.statusCode, 200, res.body);
    const ins = inserts(calls);
    assert.equal(ins.length, 1);
    assert.ok(ins[0]!.values.includes(COLLECTION));
    assert.ok(ins[0]!.values.includes('Hand drawn wolves'));
    assert.ok(ins[0]!.values.includes(me));
    // NFT lane: owner() is read on the collection itself.
    assert.deepEqual(ownerTargets, [COLLECTION]);
  } finally {
    await app.close();
  }
});

test('wrong signer (not the launcher) is rejected with 403 and nothing is written', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const res = await post(app, await signed(stranger, basePayload));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal((res.json() as { code: string }).code, 'NOT_LAUNCHER');
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('signature that does not match the claimed address is rejected with 401', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    // Stranger signs, but claims to be the launcher.
    const body = await signed(stranger, basePayload);
    const res = await post(app, { ...body, address: launcher.address });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('signature for a different action (ERC-20 metadata:save) does not work here', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const res = await post(app, await signed(launcher, basePayload, 'metadata:save'));
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('launcher who no longer owns the contract on-chain is rejected', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({
    record: { launchedBy: me, lane: 'nft', pairedToken: null },
    owner: '0x000000000000000000000000000000000000dead',
  });
  try {
    const res = await post(app, await signed(launcher, basePayload));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal((res.json() as { code: string }).code, 'NOT_OWNER');
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('DN404: owner is read from the base token, not the mirror', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, ownerTargets } = await makeApp({ record: { launchedBy: me, lane: 'dn404', pairedToken: DN404_BASE }, owner: me });
  try {
    const res = await post(app, await signed(launcher, basePayload));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(ownerTargets, [DN404_BASE]);
  } finally {
    await app.close();
  }
});

test('unindexed collection returns 409 INDEXER_PENDING', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const { app, calls } = await makeApp({ record: null, owner: launcher.address.toLowerCase() });
  try {
    const res = await post(app, await signed(launcher, basePayload));
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('URL naming a different collection than the signed payload is rejected', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const res = await post(app, await signed(launcher, basePayload), '0x9f9e3304c3878f9c62d0b067012ab736301e8d83');
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as { code: string }).code, 'URL_PAYLOAD_MISMATCH');
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('javascript: image or website URLs are refused at the schema', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    for (const bad of [{ imageUrl: 'javascript:alert(1)' }, { website: 'data:text/html,hi' }]) {
      const res = await post(app, await signed(launcher, { ...basePayload, ...bad }));
      assert.equal(res.statusCode, 400, res.body);
      assert.equal((res.json() as { code: string }).code, 'BAD_BODY');
    }
  } finally {
    await app.close();
  }
});

test('non-Robinhood chain is refused', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const payload = { ...basePayload, chainId: 8453 };
    const res = await app.inject({
      method: 'POST',
      url: `/collection/8453/${COLLECTION}/metadata`,
      payload: await signed(launcher, payload),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as { code: string }).code, 'UNSUPPORTED_CHAIN');
  } finally {
    await app.close();
  }
});

test('page look (banner, accent color, background) is saved with the row', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const payload = {
      ...basePayload,
      bannerUrl: 'https://example.com/banner.png',
      accentColor: '#3A7BFF',
      backgroundStyle: 'banner',
    };
    const res = await post(app, await signed(launcher, payload));
    assert.equal(res.statusCode, 200, res.body);
    const ins = inserts(calls)[0]!;
    assert.ok(ins.values.includes('https://example.com/banner.png'));
    // Stored lower-cased so reads are uniform.
    assert.ok(ins.values.includes('#3a7bff'));
    assert.ok(ins.values.includes('banner'));
    const text = ins.strings.join('?');
    assert.match(text, /accent_color = EXCLUDED\.accent_color/);
    assert.match(text, /background_style = EXCLUDED\.background_style/);
    assert.match(text, /banner_url = EXCLUDED\.banner_url/);
  } finally {
    await app.close();
  }
});

test('accent color must be #RRGGBB and background must be a known preset', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    for (const bad of [
      // CSS injection attempts through the color field.
      { accentColor: 'red;background:url(https://evil.example)' },
      { accentColor: '#fff' },
      { backgroundStyle: 'url(https://evil.example)' },
      { bannerUrl: 'javascript:alert(1)' },
    ]) {
      const res = await post(app, await signed(launcher, { ...basePayload, ...bad }));
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} -> ${res.body}`);
    }
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});
