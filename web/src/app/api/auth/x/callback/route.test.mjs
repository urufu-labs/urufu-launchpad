/// Adversarial tests for the /api/auth/x/callback pure decision function.
///
/// We test `processCallback` directly rather than the `GET` route handler,
/// because the route wrapper thinly forwards to it — the wrapper only pulls
/// cookies out of `next/headers` (a Next runtime dependency we can't drive
/// from a plain node --test invocation) and constructs the NextResponse.
///
/// Coverage targets, one test each, mapping to the reason codes documented
/// on the route handler:
///   - expired      : missing cookie + expired (past-expires) cookie + tampered cookie
///   - denied       : X redirected with ?error=access_denied
///   - error        : X redirected with other ?error=…, misconfigured env, token exchange 4xx, users/me 4xx, persist backend failure
///   - xUserMismatch: persist backend returned 409 → decision surfaces "xUserMismatch"
///   - badRequest   : missing code, missing state, tampered state param
///   - ok           : happy path with mocked exchange + users/me + persist
///
/// The cookie is constructed in-test with the real signCookie so the callback
/// verifies against the same HMAC contract production uses.
///
/// Runs with:
///   node --experimental-strip-types --test web/src/app/api/auth/x/callback/route.test.mjs

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Bind to the pure decision function (not the Next route wrapper — the wrapper
// pulls in `next/headers`, which throws under `node --test`).
const callback = await import('./flow.ts');
const xAuth = await import('../../../../../lib/xAuth.ts');

const SECRET = 'test-secret-that-is-at-least-thirty-two-chars-long';
const WALLET = '0xabcdef0123456789abcdef0123456789abcdef01';
const REQUEST_ORIGIN = 'http://localhost:3000';

function buildRequestUrl(query = {}) {
  const u = new URL(`${REQUEST_ORIGIN}/api/auth/x/callback`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

function buildCookie(overrides = {}) {
  const payload = {
    codeVerifier: 'v'.repeat(43),
    wallet: WALLET,
    nonce: 'nonce-abcdef',
    state: 'state-value-1234567890',
    expires: Date.now() + 5 * 60 * 1000,
    cookieName: 'x-oauth-testabc12345',
    ...overrides,
  };
  const value = xAuth.signCookie(payload, SECRET);
  return { name: payload.cookieName, value };
}

/// Assemble deps with sensible defaults. Any override is applied on top —
/// tests overwrite the field they care about (e.g. `exchangeCode: throw`).
///
/// Every real xAuth helper the flow calls into (verifyCookie, pickRedirectUri)
/// is injected via deps — so the pure flow module never runtime-imports xAuth
/// and the test doesn't need to negotiate Next's `@/` path alias.
function makeDeps(overrides = {}) {
  return {
    verifyCookie: xAuth.verifyCookie,
    pickRedirectUri: xAuth.pickRedirectUri,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    exchangeCode: async () => ({
      token_type: 'bearer',
      access_token: 'the-access-token',
      scope: 'users.read tweet.read',
      expires_in: 7200,
    }),
    fetchXUserMe: async () => ({
      id: '1234567890',
      username: 'spoobsV1',
      name: 'spoobs',
      profile_image_url: 'https://pbs.twimg.com/profile.jpg',
    }),
    persistVerified: async () => ({ ok: true }),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// expired
// -----------------------------------------------------------------------------

describe('processCallback: cookie missing / expired / tampered → expired', () => {
  test('no cookies at all → expired + wallet=0x000…', async () => {
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'y' }),
      cookies: [],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    const u = new URL(decision.redirect);
    assert.equal(u.pathname, '/profile/0x0000000000000000000000000000000000000000');
    assert.equal(u.searchParams.get('xVerified'), 'expired');
    assert.deepEqual(decision.clearCookies, []);
  });

  test('expired cookie (past expires) → expired + sweeps the stale cookie', async () => {
    // Sign a cookie whose `expires` is in the past. verifyCookie MUST reject it,
    // so the decision falls through to the "no valid cookie" branch.
    const stale = buildCookie({ expires: Date.now() - 60_000 });
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'y' }),
      cookies: [stale],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'expired');
    assert.deepEqual(decision.clearCookies, [stale.name]);
  });

  test('tampered cookie (bit-flip in body) → expired', async () => {
    const good = buildCookie();
    // Flip one printable char in the base64url body so HMAC no longer matches.
    const [body, sig] = good.value.split('.');
    const tampered = {
      name: good.name,
      value: `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${sig}`,
    };
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'y' }),
      cookies: [tampered],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'expired');
    // Stale cookie must be swept.
    assert.deepEqual(decision.clearCookies, [tampered.name]);
  });
});

// -----------------------------------------------------------------------------
// denied
// -----------------------------------------------------------------------------

describe('processCallback: user cancelled on X → denied', () => {
  test('?error=access_denied → denied, redirect to /profile/<wallet>', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ error: 'access_denied' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    const u = new URL(decision.redirect);
    assert.equal(u.pathname, `/profile/${WALLET}`);
    assert.equal(u.searchParams.get('xVerified'), 'denied');
    assert.deepEqual(decision.clearCookies, [cookie.name]);
  });

  test('?error=other → error (any other X error is not user-cancel)', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ error: 'server_error' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'error');
    assert.deepEqual(decision.clearCookies, [cookie.name]);
  });
});

// -----------------------------------------------------------------------------
// badRequest
// -----------------------------------------------------------------------------

describe('processCallback: malformed query → badRequest', () => {
  test('missing code → badRequest', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'badRequest');
  });

  test('missing state → badRequest', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'badRequest');
  });

  test('tampered state (does not match cookie state) → badRequest and NO token exchange', async () => {
    const cookie = buildCookie();
    let exchangeCalled = false;
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'the-code', state: 'not-the-real-state' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({ exchangeCode: async () => { exchangeCalled = true; throw new Error('should not be called'); } }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'badRequest');
    assert.equal(exchangeCalled, false, 'token exchange MUST NOT run when state mismatches');
  });
});

// -----------------------------------------------------------------------------
// error
// -----------------------------------------------------------------------------

describe('processCallback: server-side failures → error', () => {
  test('missing client id or secret → error', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({ clientId: undefined }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'error');
  });

  test('X token exchange 4xx → error', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({
        exchangeCode: async () => { throw new Error('X_TOKEN_EXCHANGE_FAILED:invalid_grant'); },
      }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'error');
  });

  test('X users/me 5xx → error', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({
        fetchXUserMe: async () => { throw new Error('X_USERS_ME_FAILED:HTTP_503'); },
      }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'error');
  });

  test('backend persist returns non-ok/non-conflict → error', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({
        persistVerified: async () => ({ ok: false, code: 'error' }),
      }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'error');
  });
});

// -----------------------------------------------------------------------------
// xUserMismatch
// -----------------------------------------------------------------------------

describe('processCallback: same X id already bound to a different wallet → xUserMismatch', () => {
  test('persist returns xUserMismatch → decision surfaces the same code', async () => {
    const cookie = buildCookie();
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({
        persistVerified: async () => ({ ok: false, code: 'xUserMismatch' }),
      }),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'xUserMismatch');
  });
});

// -----------------------------------------------------------------------------
// ok
// -----------------------------------------------------------------------------

describe('processCallback: happy path → ok', () => {
  test('valid cookie + state + successful chain → ok, clears the used cookie, wallet in URL', async () => {
    const cookie = buildCookie();
    let persistedWith = null;
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'the-code', state: 'state-value-1234567890' }),
      cookies: [cookie],
      cookieSecret: SECRET,
      deps: makeDeps({
        persistVerified: async (p) => { persistedWith = p; return { ok: true }; },
      }),
    });
    const u = new URL(decision.redirect);
    assert.equal(u.pathname, `/profile/${WALLET}`);
    assert.equal(u.searchParams.get('xVerified'), 'ok');
    assert.deepEqual(decision.clearCookies, [cookie.name]);
    // Bound to the cookie wallet (NOT some other wallet a caller could inject
    // through the query string).
    assert.equal(persistedWith?.wallet, WALLET);
    assert.equal(persistedWith?.xVerifiedHandle, 'spoobsV1');
    assert.equal(persistedWith?.xVerifiedId, '1234567890');
  });

  test('picks the FIRST valid cookie when multiple x-oauth-* cookies exist', async () => {
    // Concurrent flows in different tabs each set a unique cookie. The one
    // whose state matches the query's state is the one we should proceed with,
    // but state check happens AFTER cookie match — verify we accept the first
    // valid cookie and fail with badRequest if its state doesn't match, so a
    // stale sibling cookie doesn't fingerprint through.
    const stale = buildCookie({
      cookieName: 'x-oauth-stalesession',
      state: 'stale-state-9999',
    });
    const fresh = buildCookie({
      cookieName: 'x-oauth-freshsession',
      state: 'state-value-1234567890',
    });
    // Order: stale first, so processCallback picks stale — its state won't match
    // the query, so we expect badRequest (defensive: the app should have swept
    // the stale cookie on the prior attempt; this test locks in the behavior).
    const decision = await callback.processCallback({
      requestUrl: buildRequestUrl({ code: 'x', state: 'state-value-1234567890' }),
      cookies: [stale, fresh],
      cookieSecret: SECRET,
      deps: makeDeps(),
    });
    assert.equal(new URL(decision.redirect).searchParams.get('xVerified'), 'badRequest');
  });
});
