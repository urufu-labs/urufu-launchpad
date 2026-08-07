/// X (Twitter) OAuth 2.0 verification helpers.
///
/// Free-tier flow: PKCE + confidential client, `users.read tweet.read` scope,
/// single-shot identity binding. We never store the access token past the
/// callback and never request `offline.access` because we never call X on the
/// user's behalf after the initial /users/me lookup.
///
/// State cookie:
///   base64url(JSON({ codeVerifier, wallet, nonce, state, expires })) + '.' + hmacSig
/// signed with `X_OAUTH_COOKIE_SECRET`. HMAC guarantees the payload wasn't
/// tampered with, `expires` bounds replay, `state` re-verifies on the callback
/// leg. `wallet` binds the flow to a wallet so an attacker who steals a
/// callback URL can't relink to a different address.
///
/// NOTHING in this module logs the client secret, access token, or code
/// verifier — all three are lifetime-bound to the module boundary.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// -----------------------------------------------------------------------------
// PKCE
// -----------------------------------------------------------------------------

/// RFC 7636 §4.1: 43-128 chars, `[A-Z / a-z / 0-9 / - . _ ~]`. base64url of
/// 32 random bytes lands at 43 chars — the minimum, but fits comfortably in
/// a cookie and matches every X example.
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/// RFC 7636 §4.2: challenge = base64url(sha256(verifier)). X requires the S256
/// method; `plain` is not accepted.
export function computeCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function generateNonce(): string {
  return base64url(randomBytes(16));
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

// -----------------------------------------------------------------------------
// Cookie state
// -----------------------------------------------------------------------------

export interface OAuthCookiePayload {
  /// PKCE verifier — echoed to X's /oauth2/token endpoint.
  codeVerifier: string;
  /// Lowercased wallet address that started the flow. Callback MUST NOT persist
  /// a different address.
  wallet: string;
  /// One-time nonce, embedded in the message the user signs with their wallet
  /// so the same signature can never be replayed on a second /start call.
  nonce: string;
  /// State parameter echoed by X on the callback. Must match cookie state.
  state: string;
  /// Unix ms after which this cookie is invalid even if the HMAC checks out.
  expires: number;
  /// Cookie name (per-attempt, so concurrent flows in different tabs don't
  /// collide). Callback reads this back to decide which cookie to delete.
  cookieName: string;
}

/// Signs the payload with HMAC-SHA256. Format: `base64url(payload).base64url(sig)`.
export function signCookie(payload: OAuthCookiePayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/// Verifies + decodes the cookie. Returns null for any tamper / expiry / shape
/// failure so callers don't need to distinguish (all failure modes reduce to
/// "redirect with ?xVerified=expired").
export function verifyCookie(raw: string | undefined | null, secret: string): OAuthCookiePayload | null {
  if (!raw || typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = base64url(createHmac('sha256', secret).update(body).digest());
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: OAuthCookiePayload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  if (typeof payload.codeVerifier !== 'string' || typeof payload.wallet !== 'string'
    || typeof payload.state !== 'string' || typeof payload.expires !== 'number'
    || typeof payload.nonce !== 'string' || typeof payload.cookieName !== 'string') {
    return null;
  }
  if (Date.now() > payload.expires) return null;
  return payload;
}

/// The exact string the user signs with their wallet before we start the OAuth
/// flow. Both the client + start-route MUST rebuild this byte-for-byte.
export function bindingMessage(wallet: string, nonce: string, expiresMs: number): string {
  return [
    'Link my X account to urufulabs.xyz',
    `wallet: ${wallet.toLowerCase()}`,
    `nonce: ${nonce}`,
    `expires: ${Math.floor(expiresMs / 1000)}`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// X endpoints
// -----------------------------------------------------------------------------

export const X_SCOPE = 'users.read tweet.read';
export const X_AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
export const X_USERS_ME_URL = 'https://api.twitter.com/2/users/me';

/// Build the authorize URL the browser navigates to. `state` + `code_challenge`
/// come from a freshly-minted cookie payload.
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: X_SCOPE,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${params.toString()}`;
}

export interface XTokenResponse {
  token_type: string;
  access_token: string;
  scope: string;
  expires_in: number;
}

/// POST to /2/oauth2/token with the authorization_code grant + PKCE verifier.
/// Uses HTTP Basic auth as X requires for confidential clients — the client
/// secret NEVER leaves the server.
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<XTokenResponse> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, 'utf8').toString('base64');
  const body = new URLSearchParams({
    code: opts.code,
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Never leak the body wholesale — a well-formed X error is safe but a
    // reflection of our own request could echo the access token if X ever
    // flipped their contract. Take only the top-level `error` code.
    let code = `HTTP_${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      if (typeof j.error === 'string') code = j.error;
    } catch { /* ignore */ }
    throw new Error(`X_TOKEN_EXCHANGE_FAILED:${code}`);
  }
  const json = (await res.json()) as XTokenResponse;
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('X_TOKEN_EXCHANGE_FAILED:no_access_token');
  }
  return json;
}

export interface XUserMe {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

/// GET /2/users/me with `user.fields=profile_image_url`. Bearer auth uses the
/// short-lived access token from `exchangeCode` — never persisted.
export async function fetchXUserMe(accessToken: string): Promise<XUserMe> {
  const url = `${X_USERS_ME_URL}?user.fields=profile_image_url`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`X_USERS_ME_FAILED:HTTP_${res.status}`);
  }
  const json = (await res.json()) as { data?: XUserMe };
  const data = json?.data;
  if (!data || typeof data.id !== 'string' || typeof data.username !== 'string') {
    throw new Error('X_USERS_ME_FAILED:bad_shape');
  }
  return data;
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/// URL-safe base64, no padding — the encoding PKCE + JOSE both use.
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/// Length-safe constant-time compare. Returns false for unequal lengths without
/// leaking the length itself past the initial check.
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/// Env accessor — throws in prod if the required secret is missing (fail-loud
/// instead of silently accepting unsigned cookies). Dev fallback generates a
/// per-process random secret so local iteration works without env setup, at
/// the cost of invalidating cookies on restart.
let devFallbackSecret: string | null = null;
export function requireCookieSecret(): string {
  const s = process.env.X_OAUTH_COOKIE_SECRET;
  if (typeof s === 'string' && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('X_OAUTH_COOKIE_SECRET must be set (≥32 chars) in production');
  }
  if (!devFallbackSecret) {
    devFallbackSecret = base64url(randomBytes(32));
    // eslint-disable-next-line no-console
    console.warn('[xAuth] X_OAUTH_COOKIE_SECRET not set — using ephemeral dev fallback (cookies invalid across restarts)');
  }
  return devFallbackSecret;
}

/// Bearer secret shared with compile-service. Same fail-loud contract.
let devFallbackVerifySecret: string | null = null;
export function requireVerifySharedSecret(): string {
  const s = process.env.X_VERIFY_SHARED_SECRET;
  if (typeof s === 'string' && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('X_VERIFY_SHARED_SECRET must be set (≥32 chars) in production');
  }
  if (!devFallbackVerifySecret) {
    devFallbackVerifySecret = base64url(randomBytes(32));
    // eslint-disable-next-line no-console
    console.warn('[xAuth] X_VERIFY_SHARED_SECRET not set — using ephemeral dev fallback (compile-service will reject)');
  }
  return devFallbackVerifySecret;
}

/// Pick a redirect URI that matches one of the URIs registered on the X dev app.
/// We derive from the incoming request's origin (the only origin X will actually
/// hand a callback back to) and validate it against an allow-list so a spoofed
/// Host header can't repoint the callback.
const ALLOWED_ORIGINS = new Set([
  'https://urufulabs.xyz',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

export function pickRedirectUri(requestUrl: string): string {
  const url = new URL(requestUrl);
  // Trust x-forwarded-* (Vercel sets them) via URL(request.url) — Next already
  // resolves that. Otherwise use the direct origin.
  const origin = `${url.protocol}//${url.host}`;
  if (ALLOWED_ORIGINS.has(origin)) return `${origin}/api/auth/x/callback`;
  // Explicit override wins (useful for preview deployments / staging domains).
  const override = process.env.X_OAUTH_REDIRECT_URI;
  if (override && /^https?:\/\//.test(override)) return override;
  // Fall back to the prod URI. X will still reject if the incoming origin
  // doesn't own the flow, but this keeps us from ever emitting a URI that
  // isn't registered.
  return 'https://urufulabs.xyz/api/auth/x/callback';
}
