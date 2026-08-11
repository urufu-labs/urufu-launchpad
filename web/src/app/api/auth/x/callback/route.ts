/// GET /api/auth/x/callback — X redirects the user here after they consent
/// (or cancel). Reads the OAuth cookie set by /start, exchanges the code,
/// fetches the X /users/me profile, and persists the verified fields to
/// the compile-service (via the server-to-server bearer path — the browser
/// never sees the access token or verified-field write payload).
///
/// EVERY error path redirects back to `/profile/{wallet}?xVerified={reason}`
/// so the UI shows a coherent toast. Internal errors are logged (without
/// secrets) and returned as `error`; the user never sees a raw stack trace.
///
/// All decision logic lives in ./flow::processCallback (importable without
/// pulling in `next/headers`, which is what the unit tests bind to). This
/// wrapper is intentionally thin — read cookies + env → delegate → render.

import { cookies as nextCookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import {
  exchangeCode,
  fetchXUserMe,
  pickRedirectUri,
  requireCookieSecret,
  requireVerifySharedSecret,
  verifyCookie,
} from '@/lib/xAuth';

import { processCallback } from './flow';

export const runtime = 'nodejs';

const COMPILE_SERVICE_URL =
  process.env.COMPILE_SERVICE_URL
    ?? process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL
    ?? 'http://localhost:3001';

/// Production persist implementation. Bearer-authed server-to-server call to
/// the compile-service. Compile-service returns 409 when the same X id is
/// already bound to a different wallet → surface as xUserMismatch.
async function persistVerifiedProd(payload: {
  wallet: string;
  xVerifiedHandle: string;
  xVerifiedId: string;
  xAvatarUrl: string | null;
}): Promise<{ ok: true } | { ok: false; code: string }> {
  const url = `${COMPILE_SERVICE_URL.replace(/\/$/, '')}/profile/${payload.wallet}/x-verified`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${requireVerifySharedSecret()}`,
      },
      body: JSON.stringify({
        xVerifiedHandle: payload.xVerifiedHandle,
        xVerifiedId: payload.xVerifiedId,
        xAvatarUrl: payload.xAvatarUrl,
        xVerifiedAt: Date.now(),
      }),
    });
    if (res.status === 409) return { ok: false, code: 'xUserMismatch' };
    if (!res.ok) return { ok: false, code: 'error' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'error' };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const store = await nextCookies();
  const cookies = store.getAll().map((c) => ({ name: c.name, value: c.value }));

  const decision = await processCallback({
    requestUrl: request.url,
    cookies,
    cookieSecret: requireCookieSecret(),
    deps: {
      verifyCookie,
      pickRedirectUri,
      exchangeCode,
      fetchXUserMe,
      persistVerified: persistVerifiedProd,
      clientId: process.env.NEXT_PUBLIC_X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
    },
  });

  const res = NextResponse.redirect(new URL(decision.redirect));
  for (const name of decision.clearCookies) {
    res.cookies.set({ name, value: '', maxAge: 0, path: '/' });
  }
  return res;
}
