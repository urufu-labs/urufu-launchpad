// Sign links: only this server's key can mint one, tampering and expiry are caught,
// and the runner adds `signUrl` to results with transactions (with the sender).
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';

import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { decodeSignToken, encodeSignToken, makeSignUrl, MAX_SIGN_TOKEN, SIGN_LINK_TTL_MS, signLinkKey } from './signLink.ts';
import { TtlCache } from './ttlCache.ts';
import { CURVE, TOKEN, fakeDeps } from './testFixtures.mjs';

const KEY = signLinkKey({ SIGN_LINK_SECRET: 'x'.repeat(40) });
const OTHER = signLinkKey({ SIGN_LINK_SECRET: 'y'.repeat(40) });
const NOW = 1_800_000_000_000;
const BUYER = '0x7777777777777777777777777777777777777777';
const tx = { to: CURVE, data: '0xd96a094a' + '00'.repeat(32), value: '1000', purpose: 'buy', summary: 'Buy GOOD' };
const input = { tool: 'quote_buy', chainId: 4663, from: BUYER, summary: 'Buy GOOD with 0.5 ETH', txs: [tx] };
const tokenOf = (url) => url.slice(url.indexOf('#') + 1);

describe('sign link token', () => {
  it('round-trips', () => {
    const url = makeSignUrl('https://urufulabs.xyz', input, KEY, NOW);
    assert.ok(url.startsWith('https://urufulabs.xyz/sign#'));
    const p = decodeSignToken(tokenOf(url), KEY, NOW + 1000);
    assert.deepEqual(p.txs, [tx]);
    assert.equal(p.from, BUYER);
    assert.equal(p.exp, NOW + SIGN_LINK_TTL_MS);
  });

  it('rejects another key, an edited body, a swapped mac, and junk', () => {
    const t = tokenOf(makeSignUrl('https://x', input, KEY, NOW));
    assert.throws(() => decodeSignToken(t, OTHER, NOW), { code: 'INVALID' });
    // A forged payload with an attacker's `to`, signed with the wrong key.
    const forged = encodeSignToken({ v: 1, ...input, txs: [{ ...tx, to: '0x' + '66'.repeat(20) }], exp: NOW + 1e6 }, OTHER);
    assert.throws(() => decodeSignToken(forged, KEY, NOW), { code: 'INVALID' });
    const [body, mac] = t.split('.');
    const flipped = body.slice(0, 10) + (body[10] === 'A' ? 'B' : 'A') + body.slice(11);
    assert.throws(() => decodeSignToken(`${flipped}.${mac}`, KEY, NOW), { code: 'INVALID' });
    assert.throws(() => decodeSignToken(`${body}.`, KEY, NOW), { code: 'INVALID' });
    assert.throws(() => decodeSignToken('nodot', KEY, NOW), { code: 'INVALID' });
    assert.throws(() => decodeSignToken('a'.repeat(MAX_SIGN_TOKEN + 1), KEY, NOW), { code: 'INVALID' });
  });

  it('expires', () => {
    const t = tokenOf(makeSignUrl('https://x', input, KEY, NOW));
    assert.throws(() => decodeSignToken(t, KEY, NOW + SIGN_LINK_TTL_MS + 1), { code: 'EXPIRED' });
  });

  it('no key without a long enough secret; SIGN_LINK_SECRET wins over the X cookie secret', () => {
    assert.equal(signLinkKey({}), null);
    assert.equal(signLinkKey({ SIGN_LINK_SECRET: 'short' }), null);
    const fromCookie = signLinkKey({ X_OAUTH_COOKIE_SECRET: 'z'.repeat(40) });
    assert.ok(fromCookie);
    assert.deepEqual(signLinkKey({ SIGN_LINK_SECRET: 'x'.repeat(40), X_OAUTH_COOKIE_SECRET: 'z'.repeat(40) }), KEY);
  });

  it('too long for a chat app: no link', () => {
    const big = { ...input, txs: Array.from({ length: 10 }, () => ({ ...tx, data: '0x' + randomBytes(2000).toString('hex') })) };
    assert.equal(makeSignUrl('https://x', big, KEY, NOW), null);
  });
});

describe('runner adds signUrl', () => {
  const ctx = (deps) => ({ ip: '203.0.113.9', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' });
  const withLinks = () => {
    const { deps } = fakeDeps();
    deps.signLink = (i) => makeSignUrl('https://urufulabs.xyz', i, KEY, NOW);
    return deps;
  };

  it('on a quote with transactions, bound to the buyer', async () => {
    const r = await runTool('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5' }, ctx(withLinks()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = decodeSignToken(tokenOf(r.body.data.signUrl), KEY, NOW);
    assert.equal(p.tool, 'quote_buy');
    assert.equal(p.from, BUYER);
    assert.equal(p.txs.length, r.body.data.transactions.length);
    assert.equal(p.txs[0].data, r.body.data.transactions[0].data);
  });

  it('not on read tools, and not without a signLink dep', async () => {
    const read = await runTool('get_token', { address: TOKEN }, ctx(withLinks()));
    assert.equal(read.body.data.signUrl, undefined);
    const { deps } = fakeDeps();
    const q = await runTool('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5' }, ctx(deps));
    assert.equal(q.body.data.signUrl, undefined);
  });
});
