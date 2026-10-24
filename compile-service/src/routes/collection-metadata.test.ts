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

const DESIGN = {
  // Key order deliberately differs from the zod schema order: the signature
  // must still verify (it is checked against the payload as sent).
  wallpaper: { blur: 12, type: 'gradient', color2: '#FFC46B', color: '#ff7a59' },
  bodyFont: 'default',
  titleFont: 'caslon',
  theme: 'paper',
};
const LINKS = [
  { title: 'Roadmap', url: 'https://example.com/roadmap', style: 'featured', id: 'a1', thumbnailUrl: 'https://example.com/r.png' },
  { id: 'b2', title: 'Merch', url: 'https://shop.example.com', style: 'classic' },
];

test('page look (banner, accent, theme, fonts, wallpaper) and links are saved with the row', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const payload = {
      ...basePayload,
      bannerUrl: 'https://example.com/banner.png',
      accentColor: '#3A7BFF',
      design: DESIGN,
      links: LINKS,
    };
    const res = await post(app, await signed(launcher, payload));
    assert.equal(res.statusCode, 200, res.body);
    const ins = inserts(calls)[0]!;
    assert.ok(ins.values.includes('https://example.com/banner.png'));
    // Stored lower-cased so reads are uniform.
    assert.ok(ins.values.includes('#3a7bff'));
    const json = ins.values.filter((v): v is string => typeof v === 'string' && v.startsWith('{') || typeof v === 'string' && v.startsWith('['));
    const design = JSON.parse(json.find((v) => v.startsWith('{'))!);
    const links = JSON.parse(json.find((v) => v.startsWith('['))!);
    assert.equal(design.titleFont, 'caslon');
    assert.equal(design.wallpaper.type, 'gradient');
    assert.equal(links.length, 2);
    assert.equal(links[0].title, 'Roadmap');
    const text = ins.strings.join('?');
    assert.match(text, /accent_color = EXCLUDED\.accent_color/);
    assert.match(text, /page_design = EXCLUDED\.page_design/);
    assert.match(text, /page_links = EXCLUDED\.page_links/);
    assert.match(text, /banner_url = EXCLUDED\.banner_url/);
  } finally {
    await app.close();
  }
});

test('signature covers design + links: changing a link after signing is rejected', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const body = await signed(launcher, { ...basePayload, links: LINKS });
    const tampered = {
      ...body,
      payload: { ...body.payload, links: [{ ...LINKS[0], url: 'https://phish.example' }, LINKS[1]] },
    };
    const res = await post(app, tampered);
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('style values that could inject CSS or scripts are refused', async () => {
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    for (const bad of [
      { accentColor: 'red;background:url(https://evil.example)' },
      { accentColor: '#fff' },
      { bannerUrl: 'javascript:alert(1)' },
      { design: { titleFont: 'Comic Sans; } body { display:none' } },
      { design: { wallpaper: { type: 'color', color: 'red' } } },
      { design: { wallpaper: { type: 'image', imageUrl: 'data:image/png;base64,AAAA' } } },
      { design: { wallpaper: { type: 'image', blur: 999 } } },
      { design: { wallpaper: { type: 'video' } } },
      { design: { extra: 'nope' } },
      { links: [{ id: 'x', title: 'Hi', url: 'javascript:alert(1)', style: 'classic' }] },
      { links: [{ id: 'x', title: '', url: 'https://ok.example', style: 'classic' }] },
      { links: [{ id: 'x', title: 'Hi', url: 'https://ok.example', style: 'huge' }] },
      { links: Array.from({ length: 13 }, (_, i) => ({ id: `l${i}`, title: 'Hi', url: 'https://ok.example', style: 'classic' })) },
    ]) {
      const res = await post(app, await signed(launcher, { ...basePayload, ...bad }));
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad).slice(0, 80)} -> ${res.body}`);
    }
    assert.equal(inserts(calls).length, 0);
  } finally {
    await app.close();
  }
});

test('design + links are sent as text and cast ::text::jsonb (never a bare ::jsonb)', async () => {
  // A bare ${json}::jsonb made postgres.js JSON-encode the string again and
  // store a jsonb *string*; the page then ignored the whole design
  // (Visions of Lambro, 2026-10-24).
  const launcher = privateKeyToAccount(generatePrivateKey());
  const me = launcher.address.toLowerCase();
  const { app, calls } = await makeApp({ record: { launchedBy: me, lane: 'nft', pairedToken: null }, owner: me });
  try {
    const res = await post(app, await signed(launcher, { ...basePayload, design: DESIGN, links: LINKS }));
    assert.equal(res.statusCode, 200, res.body);
    const text = inserts(calls)[0]!.strings.join('?').replace(/\s+/g, ' ');
    assert.match(text, /\?::text::jsonb, \?::text::jsonb/);
    assert.doesNotMatch(text, /\?::jsonb/);
  } finally {
    await app.close();
  }
});

test('GET parses a design / links value the database hands back as a JSON string', async () => {
  const { sql } = makeFakeSql();
  const stored = {
    chainId: CHAIN,
    collectionAddress: COLLECTION,
    imageUrl: null,
    design: JSON.stringify(DESIGN),
    links: JSON.stringify(LINKS),
  };
  const fake = ((..._a: unknown[]) => [stored]) as unknown as typeof sql;
  const app = Fastify({ logger: false });
  await registerCollectionMetadataRoutes(app, { sqlOverride: fake, lookupCollection: async () => null, lookupOwner: async () => null });
  try {
    const res = await app.inject({ method: 'GET', url: `/collection/${CHAIN}/${COLLECTION}/metadata` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { design: { wallpaper: { type: string } }; links: { title: string }[] };
    assert.equal(body.design.wallpaper.type, 'gradient');
    assert.equal(body.links[0]!.title, 'Roadmap');
  } finally {
    await app.close();
  }
});
