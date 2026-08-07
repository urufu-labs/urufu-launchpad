/// Pure decision function for the /api/auth/x/callback route.
///
/// Split out from `route.ts` so tests can import it WITHOUT pulling in
/// `next/headers` (which throws under `node --test` because it depends on the
/// Next server runtime being present). The route handler is a thin wrapper
/// that reads cookies + env, then delegates every decision here.
///
/// Every documented error path reduces to
///   `/profile/<wallet>?xVerified=<code>`
/// where <code> is one of: ok / denied / expired / walletMismatch /
/// xUserMismatch / badRequest / error.
///
/// This module deliberately takes ALL side-effect functions as `deps` — even
/// `verifyCookie` / `pickRedirectUri` — so the test file can drive the flow
/// with no module-loader surprises around Next's `@/` path alias or the
/// `next/headers` boundary. The route wrapper injects the real xAuth helpers.

import type { exchangeCode as prodExchangeCode, fetchXUserMe as prodFetchXUserMe, verifyCookie as prodVerifyCookie } from '../../../../../lib/xAuth';

export interface CallbackDecision {
  /// Absolute URL to redirect the browser to.
  redirect: string;
  /// Names of x-oauth-* cookies that must be cleared (Max-Age=0) by the
  /// response. Always a subset of the cookie names the caller found.
  clearCookies: string[];
}

/// Pluggable side-effects so the pure decision function can be tested without
/// hitting the real X endpoints, the compile-service, OR pulling xAuth's
/// path-aliased imports through the test module loader.
export interface CallbackDeps {
  verifyCookie: typeof prodVerifyCookie;
  pickRedirectUri: (requestUrl: string) => string;
  exchangeCode: typeof prodExchangeCode;
  fetchXUserMe: typeof prodFetchXUserMe;
  persistVerified: (input: {
    wallet: string;
    xVerifiedHandle: string;
    xVerifiedId: string;
    xAvatarUrl: string | null;
  }) => Promise<{ ok: true } | { ok: false; code: string }>;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

export async function processCallback(input: {
  requestUrl: string;
  cookies: Array<{ name: string; value: string }>;
  cookieSecret: string;
  deps: CallbackDeps;
}): Promise<CallbackDecision> {
  const base = new URL(input.requestUrl);
  const code = base.searchParams.get('code');
  const state = base.searchParams.get('state');
  const errorParam = base.searchParams.get('error');

  const candidateCookies = input.cookies.filter((c) => c.name.startsWith('x-oauth-'));
  let matched: {
    name: string;
    payload: NonNullable<ReturnType<CallbackDeps['verifyCookie']>>;
  } | null = null;
  for (const c of candidateCookies) {
    const p = input.deps.verifyCookie(c.value, input.cookieSecret);
    if (p) {
      matched = { name: c.name, payload: p };
      break;
    }
  }

  const profileRedirectUrl = (wallet: string | null | undefined, reason: string): string => {
    const target = new URL(
      `/profile/${wallet ?? '0x0000000000000000000000000000000000000000'}`,
      base,
    );
    target.searchParams.set('xVerified', reason);
    return target.toString();
  };

  if (!matched) {
    // Sweep every stale x-oauth-* cookie so future attempts don't blow past
    // the browser's per-domain cookie cap.
    return {
      redirect: profileRedirectUrl(null, 'expired'),
      clearCookies: candidateCookies.map((c) => c.name),
    };
  }

  const wallet = matched.payload.wallet;
  const clearOnlyMatched = [matched.name];

  if (errorParam) {
    // X's ?error=access_denied means the user clicked Cancel on the consent
    // screen — surface distinctly so the UI copy differs from "system error".
    return {
      redirect: profileRedirectUrl(wallet, errorParam === 'access_denied' ? 'denied' : 'error'),
      clearCookies: clearOnlyMatched,
    };
  }

  if (!code || !state) {
    return { redirect: profileRedirectUrl(wallet, 'badRequest'), clearCookies: clearOnlyMatched };
  }
  if (state !== matched.payload.state) {
    // State-param tampering — cookie state is the source of truth. NEVER
    // proceed to the token exchange in this case.
    return { redirect: profileRedirectUrl(wallet, 'badRequest'), clearCookies: clearOnlyMatched };
  }

  const { clientId, clientSecret } = input.deps;
  if (!clientId || !clientSecret) {
    console.error('[x/callback] MISCONFIGURED — client id or secret env unset');
    return { redirect: profileRedirectUrl(wallet, 'error'), clearCookies: clearOnlyMatched };
  }

  const redirectUri = input.deps.pickRedirectUri(input.requestUrl);
  let accessToken: string;
  try {
    const tok = await input.deps.exchangeCode({
      code,
      redirectUri,
      codeVerifier: matched.payload.codeVerifier,
      clientId,
      clientSecret,
    });
    accessToken = tok.access_token;
  } catch (err) {
    // Log the taxonomized error code (never the body).
    console.error('[x/callback] token exchange failed:', (err as Error).message);
    return { redirect: profileRedirectUrl(wallet, 'error'), clearCookies: clearOnlyMatched };
  }

  let me;
  try {
    me = await input.deps.fetchXUserMe(accessToken);
  } catch (err) {
    console.error('[x/callback] users/me failed:', (err as Error).message);
    return { redirect: profileRedirectUrl(wallet, 'error'), clearCookies: clearOnlyMatched };
  }

  const persist = await input.deps.persistVerified({
    wallet,
    xVerifiedHandle: me.username,
    xVerifiedId: me.id,
    xAvatarUrl: me.profile_image_url ?? null,
  });
  if (!persist.ok) {
    return { redirect: profileRedirectUrl(wallet, persist.code), clearCookies: clearOnlyMatched };
  }

  return { redirect: profileRedirectUrl(wallet, 'ok'), clearCookies: clearOnlyMatched };
}
