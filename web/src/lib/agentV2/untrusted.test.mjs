// Untrusted user text: cleaning, caps, flags, and that every prompt-injection
// fixture lands only under `untrusted` in tool output (offline half of the 6.2 evals).
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { cleanUserText, UNTRUSTED_LIMITS } from './untrusted.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { TOKEN, fakeDeps } from './testFixtures.mjs';

const FIXTURES = JSON.parse(readFileSync(new URL('./evals/injection-fixtures.json', import.meta.url), 'utf8'));

describe('cleanUserText', () => {
  it('strips bidi overrides, zero-width, tag chars and controls', () => {
    const r = cleanUserText('a‮b​c\u0007d󠁁e﻿');
    assert.equal(r.text, 'abcde');
    assert.ok(r.flags.includes('hidden_chars_removed'));
  });
  it('NFKC-folds look-alike forms', () => {
    assert.equal(cleanUserText('ｓｙｓｔｅｍ: hi').text, 'system: hi');
    assert.ok(cleanUserText('ｓｙｓｔｅｍ: hi').flags.includes('role_spoof'));
  });
  it('caps length by code point and marks truncation', () => {
    const r = cleanUserText('😀'.repeat(600), UNTRUSTED_LIMITS.description);
    assert.equal(Array.from(r.text).length, 500);
    assert.equal(r.truncated, true);
  });
  it('null for non-strings', () => {
    assert.equal(cleanUserText(null), null);
    assert.equal(cleanUserText(42), null);
  });
  it('benign text has no flags', () => {
    assert.deepEqual(cleanUserText('A friendly frog coin for pond lovers.').flags, []);
  });
});

describe('injection fixtures through get_token', () => {
  assert.ok(FIXTURES.cases.length >= 20);
  for (const c of FIXTURES.cases) {
    it(`${c.id}: hostile text stays under untrusted`, async () => {
      const { deps } = fakeDeps({
        indexer: { launchByToken: async () => ({ tokenAddress: TOKEN, launchedBy: '0x1111111111111111111111111111111111111111', name: c.token.name, ticker: c.token.ticker, curveAddress: null, payToken: 'ETH', feePaid: '1', uruPaid: null, blockNumber: '1', blockTimestamp: '1', txHash: '0x' }) },
        metadata: { description: c.token.description ?? null, website: c.token.website ?? null, twitter: c.token.twitter ?? null, imageUrl: null, telegram: null, discord: null, tiktok: null },
      });
      const r = await runTool('get_token', { address: TOKEN }, { ip: 'e', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'mcp' });
      assert.equal(r.status, 200);
      const data = JSON.stringify(r.body.data);
      for (const field of ['name', 'ticker', 'description']) {
        const raw = c.token[field];
        if (!raw || raw.length < 6) continue;
        assert.equal(data.includes(raw.slice(0, 24)), false, `${field} leaked into data`);
      }
      const u = r.body.untrusted.fields;
      for (const field of ['name', 'ticker', 'description']) {
        const v = u[field];
        if (!v) continue;
        assert.equal(/[‪-‮​-‏⁦-⁩﻿]/.test(v.text), false, `${field} kept hidden chars`);
        assert.ok(Array.from(v.text).length <= UNTRUSTED_LIMITS[field], `${field} over cap`);
      }
      const allFlags = Object.values(u).flatMap((f) => f?.flags ?? []);
      for (const f of c.expectFlags ?? []) assert.ok(allFlags.includes(f), `expected flag ${f}, got ${allFlags.join(',')}`);
    });
  }
});
