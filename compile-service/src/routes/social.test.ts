/// Route-level tests for the search endpoint (`GET /profile/search`).
///
/// Coverage:
///   1. Empty q returns { results: [] } without hitting sql (no full-table
///      dump risk).
///   2. Sub-2-char q also returns { results: [] } (enumeration guard).
///   3. Text-search q is passed to sql as the expected ILIKE / exact params
///      and the response payload is shaped correctly (verified handle wins
///      exposure, unverified `twitter` is suppressed when verified is set).
///   4. Address-prefix q takes the address branch (LIKE '<prefix>%') and
///      returns the rows sql yields.
///   5. Per-IP rate limit rejects with 429 past the configured cap.
///
/// The db is injected as a fake `sql` that intercepts the postgres.js
/// tagged-template call and returns a preset row list. That covers the
/// route wiring + payload transformation; the actual ORDER BY clause is
/// something only a real Postgres exercises, so the SQL is documented
/// verbosely in social.ts and this file asserts the params + branch, not
/// the sort itself.

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { registerSocialRoutes, type SqlLike } from './social.ts';

// -----------------------------------------------------------------------------
// Fake sql. postgres.js's tagged-template is invoked as ``sql`SELECT …`(args)``
// or as `sql<T>` for typed rows. Our fake ignores the SQL text and simply logs
// the (strings, ...values) tuple + returns whatever rows the current test
// staged. Type-widen to `SqlLike` at cast time so the route file's `sql!` /
// `sql!<T>` calls still typecheck against the fake.
// -----------------------------------------------------------------------------

interface FakeCall {
  strings: readonly string[];
  values: readonly unknown[];
}

interface FakeSql {
  sql: SqlLike;
  calls: FakeCall[];
  /// Stage the next response row list. Set once per query the route makes.
  setNextRows: (rows: unknown[]) => void;
}

function makeFakeSql(): FakeSql {
  const calls: FakeCall[] = [];
  let nextRows: unknown[] = [];

  // postgres.js sql is a callable that also carries generic type params via
  // TypeScript. At runtime it's just `(strings, ...values) => PendingQuery`.
  // We return a plain array here and let the route await it — Promise.all
  // and `await` both accept a non-thenable and pass it through.
  const inner = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    const rowsForThisCall = nextRows;
    // Reset AFTER capturing so a single-shot staging doesn't leak into the
    // next test. Tests that expect a chained pair of sql calls must stage
    // both — see the search happy-path below (only one call per request).
    nextRows = [];
    return rowsForThisCall as unknown as ReturnType<SqlLike>;
  };

  return {
    sql: inner as unknown as SqlLike,
    calls,
    setNextRows: (rows) => {
      nextRows = rows;
    },
  };
}

// -----------------------------------------------------------------------------
// App factory. Registers a fresh fastify + rate-limit + our routes with the
// fake sql. Kept minimal so a test can `app.close()` and immediately rebuild
// without shared state.
// -----------------------------------------------------------------------------

async function makeApp(env?: Record<string, string>): Promise<{
  app: FastifyInstance;
  fake: FakeSql;
  restoreEnv: () => void;
}> {
  const restore: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    restore.push([k, process.env[k]]);
    process.env[k] = v;
  }
  const fake = makeFakeSql();
  const app = Fastify({ logger: false });
  // App-wide rate limit high so the search-specific cap is what actually
  // fires in the rate-limit test.
  await app.register(rateLimit, { max: 1_000, timeWindow: '1 minute' });
  await registerSocialRoutes(app, { sqlOverride: fake.sql });
  return {
    app,
    fake,
    restoreEnv: () => {
      for (const [k, v] of restore) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// -----------------------------------------------------------------------------
// Reusable fake rows.
// -----------------------------------------------------------------------------

const NOW = new Date('2026-08-07T00:00:00Z');
const OLDER = new Date('2026-01-01T00:00:00Z');

const ROW_VERIFIED_VITALIK = {
  address: '0xdddddddddddddddddddddddddddddddddddddddd',
  username: 'vitalik',
  avatarUrl: 'https://gateway.pinata.cloud/ipfs/QmVerified',
  xVerifiedHandle: 'vitalik',
  xAvatarUrl: 'https://pbs.twimg.com/verified.jpg',
  twitter: 'vitalik',
  updatedAt: NOW,
};
const ROW_UNVERIFIED_VITALIK = {
  address: '0xffffffffffffffffffffffffffffffffffffffff',
  username: 'vitalik',
  avatarUrl: null,
  xVerifiedHandle: null,
  xAvatarUrl: null,
  twitter: 'vitalik',
  updatedAt: OLDER,
};

// -----------------------------------------------------------------------------

beforeEach(() => {
  // Each test flips its own env when needed; nothing global to reset here.
});

// =========================================================================
// 1. Empty q → empty results, no sql call.
// =========================================================================

test('GET /profile/search with missing q returns { results: [] } and does NOT hit sql', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const res = await app.inject({ method: 'GET', url: '/profile/search' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { results: [] });
    // The whole point of the guard: an empty / whitespace-only query must
    // NEVER reach the database. If it does, the endpoint is one bad LIKE
    // pattern away from being a full-table scraper.
    assert.equal(fake.calls.length, 0, 'sql was called for an empty query');
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('GET /profile/search with 1-char q returns empty (enumeration guard)', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const res = await app.inject({ method: 'GET', url: '/profile/search?q=v' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { results: [] });
    assert.equal(fake.calls.length, 0);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 2. Text search happy path — sql called with expected params, payload
//    is shaped correctly, twitter is suppressed on verified rows.
// =========================================================================

test('GET /profile/search?q=vitalik returns rows and passes ILIKE+exact params to sql', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    // Ordering here reflects what a real Postgres would return with our
    // ORDER BY (verified first, exact match next). The fake sql simply
    // echoes them in the given order — the route must NOT re-sort.
    fake.setNextRows([ROW_VERIFIED_VITALIK, ROW_UNVERIFIED_VITALIK]);

    const res = await app.inject({ method: 'GET', url: '/profile/search?q=vitalik' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      results: Array<{
        address: string;
        username: string | null;
        xVerifiedHandle: string | null;
        twitter: string | null;
        avatarUrl: string | null;
        xAvatarUrl: string | null;
        updatedAt: string;
      }>;
    };

    assert.equal(body.results.length, 2);
    // Verified row: xVerifiedHandle is populated, `twitter` MUST be nulled
    // out (the verified handle is the trustworthy display value; showing
    // the unverified one alongside would let a wallet claim two handles).
    assert.equal(body.results[0]?.xVerifiedHandle, 'vitalik');
    assert.equal(body.results[0]?.twitter, null);
    // Unverified row: xVerifiedHandle is null, `twitter` is preserved so
    // the UI can render it with an (unverified) badge.
    assert.equal(body.results[1]?.xVerifiedHandle, null);
    assert.equal(body.results[1]?.twitter, 'vitalik');
    // Timestamps serialized as ISO strings.
    assert.equal(typeof body.results[0]?.updatedAt, 'string');
    assert.ok(body.results[0]?.updatedAt.endsWith('Z'));

    // Params fed to sql: three ILIKE bindings + one exact-match binding
    // for the ORDER BY. The exact query text isn't asserted (that would
    // couple the test to whitespace); we assert the interpolated values.
    assert.equal(fake.calls.length, 1);
    const values = fake.calls[0]?.values ?? [];
    // The ILIKE literal is `%vitalik%` — assert every use of it and that
    // the exact-match literal `vitalik` is present too.
    assert.ok(values.includes('%vitalik%'), `expected '%vitalik%' in sql values, got ${JSON.stringify(values)}`);
    assert.ok(values.includes('vitalik'), `expected exact 'vitalik' in sql values, got ${JSON.stringify(values)}`);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 3. Address-prefix branch — LIKE '<lowercase-prefix>%'.
// =========================================================================

test('GET /profile/search?q=0xdead takes the address-prefix branch (LIKE "<prefix>%")', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    fake.setNextRows([
      {
        address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        username: null,
        avatarUrl: null,
        xVerifiedHandle: null,
        xAvatarUrl: null,
        twitter: null,
        updatedAt: NOW,
      },
    ]);

    // Mixed case in the query — the route must lowercase before matching
    // since addresses are stored lowercased.
    const res = await app.inject({ method: 'GET', url: '/profile/search?q=0xDEAD' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { results: Array<{ address: string }> };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]?.address, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    // The lone parameter passed to sql is the lowercased prefix + '%'.
    assert.equal(fake.calls.length, 1);
    const values = fake.calls[0]?.values ?? [];
    assert.ok(
      values.includes('0xdead%'),
      `expected '0xdead%' address-prefix param, got ${JSON.stringify(values)}`,
    );
    // No `%foo%` ILIKE pattern in the address branch — that would mean the
    // route accidentally fell through into the text-search branch.
    assert.ok(
      !values.some((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%')),
      `address branch leaked into text-search branch; sql params were ${JSON.stringify(values)}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 4. Rate limit fires at the configured cap. Search wide open otherwise.
// =========================================================================

test('GET /profile/search per-IP rate limit fires past PROFILE_SEARCH_RATE_MAX', async () => {
  // Cap = 3 so we can fire ~10 requests and expect several 429s.
  const { app, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '3' });
  try {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        // Use a 1-char q so the handler short-circuits on the empty-response
        // path without needing us to stage 10 fake sql rows. Rate limiter
        // fires BEFORE the handler body runs anyway.
        app.inject({ method: 'GET', url: '/profile/search?q=v' }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    const status429 = statuses.filter((s) => s === 429).length;
    // Cap = 3 → at least 5 rate-limited responses expected in a 10-request burst.
    assert.ok(
      status429 >= 5,
      `expected at least 5 rate-limited 429s (cap=3), got statuses=${JSON.stringify(statuses)}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 5. Payload never carries bio / telegram / discord / website even when
//    the fake sql (bogusly) returns them. Guards against accidental
//    ...spread that would leak fields the search response is supposed to
//    strip for size + privacy.
// =========================================================================

test('GET /profile/search response strips fields the search shape does not expose', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    // Row shape the fake returns has EVERYTHING; the route must project
    // down to (address, username, avatarUrl, xVerifiedHandle, xAvatarUrl,
    // twitter, updatedAt) only.
    fake.setNextRows([
      {
        ...ROW_VERIFIED_VITALIK,
        bio: 'should not leak',
        telegram: 'should not leak',
        discord: 'should not leak',
        website: 'https://leak.example',
        xVerifiedId: 'should not leak',
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/profile/search?q=vitalik' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { results: Array<Record<string, unknown>> };
    const row = body.results[0] ?? {};
    for (const forbidden of ['bio', 'telegram', 'discord', 'website', 'xVerifiedId']) {
      assert.ok(!(forbidden in row), `search leaked ${forbidden}`);
    }
    // The permitted fields are all present (avatarUrl may legitimately be null).
    for (const permitted of ['address', 'username', 'xVerifiedHandle', 'xAvatarUrl', 'twitter', 'updatedAt']) {
      assert.ok(permitted in row, `search omitted ${permitted}`);
    }
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 6. hideHoldings privacy toggle round-trip + write-path integrity.
//
// The signed profile-save endpoint owns this field; the bearer-authed
// X-verification endpoint MUST NOT touch it, otherwise an OAuth flow could
// silently unhide holdings the owner asked to hide.
// =========================================================================

/// Rebuild the canonical string the auth module verifies. Payload keys are
/// sorted so client + server agree byte-for-byte.
function canonicalMessage(
  action: string,
  payload: Record<string, unknown>,
  timestamp: number,
): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  return `urufu:${action}:${JSON.stringify(canonical)}:${timestamp}`;
}

async function signSaveEnvelope(payload: Record<string, unknown>): Promise<{
  address: `0x${string}`;
  signature: `0x${string}`;
  timestamp: number;
}> {
  const acct = privateKeyToAccount(generatePrivateKey());
  const timestamp = Date.now();
  const message = canonicalMessage('profile:save', payload, timestamp);
  const signature = await acct.signMessage({ message });
  return { address: acct.address, signature, timestamp };
}

test('POST /profile with hideHoldings=true writes true and GET returns hideHoldings=true', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const payload = { username: 'privately', hideHoldings: true };
    const env = await signSaveEnvelope(payload);

    const postRes = await app.inject({
      method: 'POST',
      url: `/profile/${env.address.toLowerCase()}`,
      payload: { ...env, payload },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(postRes.statusCode, 200, postRes.body);

    // The INSERT call must have `true` in its interpolated values AND the
    // SQL text must mention hide_holdings in both the column list AND the
    // ON CONFLICT SET clause (so an UPDATE re-writes the flag rather than
    // orphaning it at the previously-stored value).
    const insert = fake.calls.find((c) => c.strings.join('').includes('INSERT INTO app.user_profile'));
    assert.ok(insert, 'expected the profile INSERT');
    const sqlText = insert.strings.join('?').replace(/\s+/g, ' ');
    assert.match(sqlText, /hide_holdings/);
    assert.match(sqlText, /hide_holdings = EXCLUDED\.hide_holdings/);
    assert.equal(insert.values.includes(true), true, 'true must land in the interpolated values');

    // GET path: stage a matching row and confirm the field surfaces.
    fake.setNextRows([
      {
        address: env.address.toLowerCase(),
        username: 'privately',
        avatarUrl: null,
        bio: null,
        twitter: null,
        telegram: null,
        discord: null,
        website: null,
        xVerifiedHandle: null,
        xVerifiedId: null,
        xVerifiedAt: null,
        xAvatarUrl: null,
        hideHoldings: true,
        updatedAt: NOW,
      },
    ]);
    const getRes = await app.inject({
      method: 'GET',
      url: `/profile/${env.address.toLowerCase()}`,
    });
    assert.equal(getRes.statusCode, 200);
    const body = getRes.json() as { hideHoldings: boolean };
    assert.equal(body.hideHoldings, true);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('POST /profile with hideHoldings=false interpolates false (toggle can move BOTH directions)', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const payload = { hideHoldings: false };
    const env = await signSaveEnvelope(payload);
    const res = await app.inject({
      method: 'POST',
      url: `/profile/${env.address.toLowerCase()}`,
      payload: { ...env, payload },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const insert = fake.calls.find((c) => c.strings.join('').includes('INSERT INTO app.user_profile'));
    assert.ok(insert);
    // Must literally interpolate `false` — a `true`/`null`/`undefined` would
    // either fail to clear the flag or crash the NOT NULL column.
    assert.equal(insert.values.includes(false), true, 'false must land in the interpolated values');
    assert.equal(insert.values.includes(true), false, 'true must NOT be in the values for a toggle-off');
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('POST /profile omitting hideHoldings defaults to false at INSERT (backward compat)', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const payload = { username: 'plain' };
    const env = await signSaveEnvelope(payload);
    const res = await app.inject({
      method: 'POST',
      url: `/profile/${env.address.toLowerCase()}`,
      payload: { ...env, payload },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const insert = fake.calls.find((c) => c.strings.join('').includes('INSERT INTO app.user_profile'));
    assert.ok(insert);
    // The route computes `hideHoldings = payload.hideHoldings === true`, so
    // an undefined field must materialize as literal `false` — never
    // undefined or null (the column is NOT NULL).
    assert.equal(insert.values.includes(false), true);
    assert.equal(insert.values.includes(undefined), false);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('GET /profile normalizes a NULL hide_holdings row to false (pre-migration data)', async () => {
  const { app, fake, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    const addr = '0x1111111111111111111111111111111111111111';
    fake.setNextRows([
      {
        address: addr,
        username: 'legacy',
        avatarUrl: null,
        bio: null,
        twitter: null,
        telegram: null,
        discord: null,
        website: null,
        xVerifiedHandle: null,
        xVerifiedId: null,
        xVerifiedAt: null,
        xAvatarUrl: null,
        hideHoldings: null, // pre-migration row
        updatedAt: NOW,
      },
    ]);
    const res = await app.inject({ method: 'GET', url: `/profile/${addr}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { hideHoldings: boolean };
    // Must be a concrete false, not null / undefined. The client relies on
    // the shape being stable for its `hideHoldings === true` gate.
    assert.equal(body.hideHoldings, false);
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('POST /profile/:addr/x-verified NEVER touches hide_holdings', async () => {
  // The bearer-authed X verification path is the sole writer for the
  // x_verified_* columns. It MUST NOT write hide_holdings or the signed
  // profile-save would no longer be the sole owner of the privacy flag —
  // an OAuth redirect could silently reset it.
  const secret = 'x'.repeat(48);
  const { app, fake, restoreEnv } = await makeApp({
    PROFILE_SEARCH_RATE_MAX: '1000',
    X_VERIFY_SHARED_SECRET: secret,
  });
  try {
    const addr = '0x2222222222222222222222222222222222222222';
    const res = await app.inject({
      method: 'POST',
      url: `/profile/${addr}/x-verified`,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      payload: {
        xVerifiedHandle: 'someone',
        xVerifiedId: '999',
        xAvatarUrl: null,
        xVerifiedAt: Date.now(),
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    // Every sql call in this request — SELECT for uniqueness check + INSERT
    // for the upsert — must be free of hide_holdings in its text.
    for (const call of fake.calls) {
      const text = call.strings.join('?');
      assert.equal(
        text.includes('hide_holdings'),
        false,
        `x-verified path leaked hide_holdings in sql: ${text.replace(/\s+/g, ' ').trim()}`,
      );
    }
  } finally {
    await app.close();
    restoreEnv();
  }
});

test('ProfileSaveBody rejects a non-boolean hideHoldings with 400 BAD_BODY', async () => {
  const { app, restoreEnv } = await makeApp({ PROFILE_SEARCH_RATE_MAX: '1000' });
  try {
    // Send a string instead of a boolean — zod must refuse to coerce.
    // Otherwise a malicious client could smuggle a truthy string past a
    // strict-equal check on the server (though the current route uses
    // `=== true`, this test locks the shape guarantee at the schema layer).
    const payload = { hideHoldings: 'yes' as unknown as boolean };
    const env = await signSaveEnvelope(payload);
    const res = await app.inject({
      method: 'POST',
      url: `/profile/${env.address.toLowerCase()}`,
      payload: { ...env, payload },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string };
    assert.equal(body.code, 'BAD_BODY');
  } finally {
    await app.close();
    restoreEnv();
  }
});

// =========================================================================
// 7. Migration surface — the db.ts bootstrap must include the additive
//    column migration for hide_holdings. A grep-style assertion is enough
//    because the migration runs at server start, not from a route.
// =========================================================================

test('db.ts migration adds hide_holdings column additively', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const dbPath = resolve(here, '..', 'db.ts');
  const src = readFileSync(dbPath, 'utf8');
  // Must be additive (IF NOT EXISTS) so redeploys don't blow up, and NOT
  // NULL DEFAULT false so pre-migration reads never observe NULL.
  assert.match(
    src,
    /ALTER TABLE app\.user_profile ADD COLUMN IF NOT EXISTS hide_holdings BOOLEAN NOT NULL DEFAULT false/,
  );
});
