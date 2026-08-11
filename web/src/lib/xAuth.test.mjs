// Unit tests for xAuth PKCE + cookie signing + X endpoint helpers + envelope
// construction. Runs with `node --test web/src/lib/xAuth.test.mjs` from the
// repo root, matching the pattern of web/src/smoke.test.mjs.
//
// Test surfaces:
//   1. PKCE code_verifier / code_challenge produce RFC-7636-shaped values.
//   2. Cookie sign + verify round-trips.
//   3. Cookie verify rejects: tampered body, tampered sig, expired payload,
//      malformed strings, wrong secret.
//   4. bindingMessage is deterministic + lowercases the wallet.
//   5. buildAuthorizeUrl emits exactly the query parameters X expects with the
//      correct scope + PKCE method.
//   6. pickRedirectUri only echoes an allow-listed origin.
//
// The two runtime-heavy helpers (`exchangeCode`, `fetchXUserMe`) are covered by
// smoke tests that mock global.fetch — see the second describe block.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

// Node ESM can't import a .ts file directly; the repo already ships tests that
// run against .ts sources via `--experimental-strip-types`. We do the same here
// so the assertions bind to the exact module that Next imports at runtime.
const xAuth = await import('./xAuth.ts');

// ---------------------------------------------------------------
// PKCE + nonce + state
// ---------------------------------------------------------------

describe('xAuth: PKCE + entropy helpers', () => {
  test('generateCodeVerifier returns a 43-char base64url string', () => {
    const v = xAuth.generateCodeVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  });

  test('computeCodeChallenge is deterministic + base64url of sha256(verifier)', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; // RFC 7636 sample
    const c = xAuth.computeCodeChallenge(v);
    assert.equal(c, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('generateNonce + generateState produce base64url strings of sensible length', () => {
    for (let i = 0; i < 10; i += 1) {
      const n = xAuth.generateNonce();
      const s = xAuth.generateState();
      assert.match(n, /^[A-Za-z0-9_-]{20,}$/);
      assert.match(s, /^[A-Za-z0-9_-]{30,}$/);
    }
  });
});

// ---------------------------------------------------------------
// Cookie sign + verify
// ---------------------------------------------------------------

describe('xAuth: cookie sign + verify', () => {
  const secret = 'test-secret-that-is-at-least-thirty-two-chars-long';
  const payload = {
    codeVerifier: 'v'.repeat(43),
    wallet: '0xabcdef0123456789abcdef0123456789abcdef01',
    nonce: 'abcdef1234567890',
    state: 'state-'.repeat(4),
    expires: Date.now() + 5 * 60 * 1000,
    cookieName: 'x-oauth-testtestx',
  };

  test('round-trips a valid payload', () => {
    const signed = xAuth.signCookie(payload, secret);
    const decoded = xAuth.verifyCookie(signed, secret);
    assert.deepEqual(decoded, payload);
  });

  test('rejects tampered body (single byte flip)', () => {
    const signed = xAuth.signCookie(payload, secret);
    const [body, sig] = signed.split('.');
    // Flip a printable byte in the body; leaves the sig intact so HMAC
    // check MUST catch the mismatch.
    const tampered = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A') + '.' + sig;
    assert.equal(xAuth.verifyCookie(tampered, secret), null);
  });

  test('rejects tampered signature', () => {
    const signed = xAuth.signCookie(payload, secret);
    const [body] = signed.split('.');
    const tampered = body + '.' + 'a'.repeat(43);
    assert.equal(xAuth.verifyCookie(tampered, secret), null);
  });

  test('rejects payload past its expires', () => {
    const stale = { ...payload, expires: Date.now() - 1000 };
    const signed = xAuth.signCookie(stale, secret);
    assert.equal(xAuth.verifyCookie(signed, secret), null);
  });

  test('rejects when signed with a different secret', () => {
    const signed = xAuth.signCookie(payload, secret);
    assert.equal(xAuth.verifyCookie(signed, 'wrong-secret-of-adequate-length-so-it-does-not-warn'), null);
  });

  test('rejects malformed inputs', () => {
    assert.equal(xAuth.verifyCookie('', secret), null);
    assert.equal(xAuth.verifyCookie(null, secret), null);
    assert.equal(xAuth.verifyCookie(undefined, secret), null);
    assert.equal(xAuth.verifyCookie('no-dot-at-all', secret), null);
    assert.equal(xAuth.verifyCookie('.', secret), null);
    // Valid HMAC over gibberish JSON — body is decodeable base64url but doesn't
    // parse to a payload shape.
    const bodyRaw = Buffer.from('{"not":"the","right":"shape"}', 'utf8');
    const body = bodyRaw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    // Sign the body ourselves so HMAC passes, then rely on the shape guard.
    const sig = xAuth.base64url(
      createHmac('sha256', secret).update(body).digest(),
    );
    assert.equal(xAuth.verifyCookie(`${body}.${sig}`, secret), null);
  });
});

// ---------------------------------------------------------------
// Binding message
// ---------------------------------------------------------------

describe('xAuth: bindingMessage', () => {
  test('lowercases the wallet + interpolates fields in the documented order', () => {
    const msg = xAuth.bindingMessage('0xABCDEF0123456789ABCDEF0123456789ABCDEF01', 'nonce-xyz', 1_800_000_000_000);
    assert.equal(
      msg,
      [
        'Link my X account to urufulabs.xyz',
        'wallet: 0xabcdef0123456789abcdef0123456789abcdef01',
        'nonce: nonce-xyz',
        'expires: 1800000000',
      ].join('\n'),
    );
  });

  test('is deterministic for the same inputs', () => {
    const a = xAuth.bindingMessage('0x1234567890123456789012345678901234567890', 'n', 1_800_000_000_000);
    const b = xAuth.bindingMessage('0x1234567890123456789012345678901234567890', 'n', 1_800_000_000_000);
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------

describe('xAuth: buildAuthorizeUrl', () => {
  test('emits the exact set of query parameters X expects', () => {
    const url = xAuth.buildAuthorizeUrl({
      clientId: 'the-client-id',
      redirectUri: 'https://urufulabs.xyz/api/auth/x/callback',
      state: 'the-state',
      codeChallenge: 'the-challenge',
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://twitter.com/i/oauth2/authorize');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), 'the-client-id');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://urufulabs.xyz/api/auth/x/callback');
    assert.equal(u.searchParams.get('scope'), 'users.read tweet.read');
    assert.equal(u.searchParams.get('state'), 'the-state');
    assert.equal(u.searchParams.get('code_challenge'), 'the-challenge');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  });
});

// ---------------------------------------------------------------
// Redirect URI allow-list
// ---------------------------------------------------------------

describe('xAuth: pickRedirectUri', () => {
  test('accepts prod origin', () => {
    assert.equal(
      xAuth.pickRedirectUri('https://urufulabs.xyz/api/auth/x/start'),
      'https://urufulabs.xyz/api/auth/x/callback',
    );
  });

  test('accepts localhost dev origin', () => {
    assert.equal(
      xAuth.pickRedirectUri('http://localhost:3000/api/auth/x/start'),
      'http://localhost:3000/api/auth/x/callback',
    );
  });

  test('falls back to prod when origin is unknown + no override', () => {
    // Sanity: without X_OAUTH_REDIRECT_URI set the fallback is the prod URI.
    delete process.env.X_OAUTH_REDIRECT_URI;
    assert.equal(
      xAuth.pickRedirectUri('https://attacker.example/api/auth/x/start'),
      'https://urufulabs.xyz/api/auth/x/callback',
    );
  });

  test('honors X_OAUTH_REDIRECT_URI override when origin isnt in allow-list', () => {
    process.env.X_OAUTH_REDIRECT_URI = 'https://preview-42.vercel.app/api/auth/x/callback';
    try {
      assert.equal(
        xAuth.pickRedirectUri('https://preview-42.vercel.app/api/auth/x/start'),
        'https://preview-42.vercel.app/api/auth/x/callback',
      );
    } finally {
      delete process.env.X_OAUTH_REDIRECT_URI;
    }
  });
});

// ---------------------------------------------------------------
// exchangeCode + fetchXUserMe (fetch mocked)
// ---------------------------------------------------------------

describe('xAuth: X endpoint calls (fetch mocked)', () => {
  let originalFetch;
  before(() => { originalFetch = global.fetch; });
  after(() => { global.fetch = originalFetch; });

  test('exchangeCode sends Basic auth + form body + returns access token', async () => {
    let seenUrl;
    let seenInit;
    global.fetch = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({
          token_type: 'bearer',
          access_token: 'the-access-token',
          scope: 'users.read tweet.read',
          expires_in: 7200,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const tok = await xAuth.exchangeCode({
      code: 'the-code',
      redirectUri: 'https://urufulabs.xyz/api/auth/x/callback',
      codeVerifier: 'v'.repeat(43),
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    assert.equal(tok.access_token, 'the-access-token');
    assert.equal(seenUrl, 'https://api.twitter.com/2/oauth2/token');
    assert.equal(seenInit.method, 'POST');
    assert.equal(seenInit.headers['content-type'], 'application/x-www-form-urlencoded');
    // Basic base64("cid:csecret") — RFC 7617 exact encoding.
    const expectedBasic = 'Basic ' + Buffer.from('cid:csecret', 'utf8').toString('base64');
    assert.equal(seenInit.headers.authorization, expectedBasic);
    // Body carries every required OAuth field.
    const params = new URLSearchParams(seenInit.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), 'the-code');
    assert.equal(params.get('code_verifier'), 'v'.repeat(43));
    assert.equal(params.get('client_id'), 'cid');
    assert.equal(params.get('redirect_uri'), 'https://urufulabs.xyz/api/auth/x/callback');
  });

  test('exchangeCode throws taxonomized error on X 4xx', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'code already used' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    await assert.rejects(
      () => xAuth.exchangeCode({ code: 'x', redirectUri: 'x', codeVerifier: 'x', clientId: 'x', clientSecret: 'x' }),
      /X_TOKEN_EXCHANGE_FAILED:invalid_grant/,
    );
  });

  test('exchangeCode throws when the response body is missing an access_token', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ scope: '...' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    await assert.rejects(
      () => xAuth.exchangeCode({ code: 'x', redirectUri: 'x', codeVerifier: 'x', clientId: 'x', clientSecret: 'x' }),
      /X_TOKEN_EXCHANGE_FAILED:no_access_token/,
    );
  });

  test('fetchXUserMe sends Bearer + returns extracted user', async () => {
    let seenInit;
    global.fetch = async (_url, init) => {
      seenInit = init;
      return new Response(
        JSON.stringify({
          data: {
            id: '1234567890',
            username: 'spoobsV1',
            name: 'spoobs',
            profile_image_url: 'https://pbs.twimg.com/...',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const me = await xAuth.fetchXUserMe('the-token');
    assert.equal(me.id, '1234567890');
    assert.equal(me.username, 'spoobsV1');
    assert.equal(seenInit.headers.authorization, 'Bearer the-token');
  });

  test('fetchXUserMe throws when data shape is wrong', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ data: { id: 123 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    await assert.rejects(() => xAuth.fetchXUserMe('t'), /X_USERS_ME_FAILED:bad_shape/);
  });

  test('fetchXUserMe throws HTTP_<status> on 4xx / 5xx', async () => {
    global.fetch = async () => new Response('rate limited', { status: 429 });
    await assert.rejects(() => xAuth.fetchXUserMe('t'), /X_USERS_ME_FAILED:HTTP_429/);
  });
});

// ---------------------------------------------------------------
// Constant-time equality
// ---------------------------------------------------------------

describe('xAuth: constantTimeEqual', () => {
  test('true for equal strings', () => {
    assert.equal(xAuth.constantTimeEqual('abc123', 'abc123'), true);
  });
  test('false for equal-length differing strings', () => {
    assert.equal(xAuth.constantTimeEqual('abc123', 'abc124'), false);
  });
  test('false for different-length strings (no length leak past the first check)', () => {
    assert.equal(xAuth.constantTimeEqual('abc', 'abcd'), false);
  });
});
