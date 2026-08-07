/// POST /api/auth/x/start — kicks off the X OAuth 2.0 flow.
///
/// Body: { wallet: 0x…, signature: 0x…, nonce: string, expires: number }
///  - `signature` MUST be a valid personal_sign over `bindingMessage(wallet, nonce, expires)`
///    (see web/src/lib/xAuth.ts::bindingMessage). This binds the OAuth flow to the
///    connected wallet BEFORE we spend an X rate-limit slot.
///  - `expires` MUST be within 10 minutes of now.
///
/// Response 200: { url: string, cookieName: string }
///  - Also sets a Set-Cookie header with the signed OAuth cookie the callback
///    reads back. Cookie is httpOnly + SameSite=Lax so it survives the X →
///    callback redirect, and Secure whenever the request came in over https.

import { NextResponse, type NextRequest } from 'next/server';
import { isAddress, recoverMessageAddress, type Address } from 'viem';

import {
  bindingMessage,
  buildAuthorizeUrl,
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
  pickRedirectUri,
  requireCookieSecret,
  signCookie,
} from '@/lib/xAuth';

/// Force node runtime — `node:crypto`, Buffer, and process.env are all used in
/// the shared xAuth module. Edge would throw at import time.
export const runtime = 'nodejs';

const COOKIE_TTL_MS = 10 * 60 * 1000; // 10 min — matches the wallet-signature `expires` cap.
const CLOCK_SKEW_MS = 60_000;

interface StartBody {
  wallet?: string;
  signature?: string;
  nonce?: string;
  expires?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientId = process.env.NEXT_PUBLIC_X_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ code: 'MISCONFIGURED', message: 'NEXT_PUBLIC_X_CLIENT_ID unset' }, { status: 500 });
  }

  let body: StartBody;
  try {
    body = (await request.json()) as StartBody;
  } catch {
    return NextResponse.json({ code: 'BAD_JSON' }, { status: 400 });
  }

  const wallet = typeof body.wallet === 'string' ? body.wallet : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const expires = typeof body.expires === 'number' ? body.expires : NaN;

  if (!isAddress(wallet)) return NextResponse.json({ code: 'BAD_WALLET' }, { status: 400 });
  if (!signature.startsWith('0x')) return NextResponse.json({ code: 'BAD_SIGNATURE' }, { status: 400 });
  if (nonce.length < 8 || nonce.length > 128) return NextResponse.json({ code: 'BAD_NONCE' }, { status: 400 });
  if (!Number.isFinite(expires)) return NextResponse.json({ code: 'BAD_EXPIRES' }, { status: 400 });

  // Time-window checks: expires must be in the future but not more than the
  // cookie TTL away. Small backwards skew allowed for clock drift.
  const now = Date.now();
  if (expires < now - CLOCK_SKEW_MS) return NextResponse.json({ code: 'EXPIRED' }, { status: 400 });
  if (expires > now + COOKIE_TTL_MS + CLOCK_SKEW_MS) return NextResponse.json({ code: 'EXPIRES_TOO_FAR' }, { status: 400 });

  // Verify the wallet signature.
  const message = bindingMessage(wallet, nonce, expires);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return NextResponse.json({ code: 'SIGNATURE_VERIFY_ERROR' }, { status: 401 });
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return NextResponse.json({ code: 'SIGNATURE_MISMATCH' }, { status: 401 });
  }

  // Mint PKCE material + state + cookie.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = generateState();
  const cookieName = `x-oauth-${generateState().slice(0, 12)}`;
  const cookieExpires = now + COOKIE_TTL_MS;

  const redirectUri = pickRedirectUri(request.url);
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge,
  });

  const cookieValue = signCookie(
    {
      codeVerifier,
      wallet: wallet.toLowerCase(),
      nonce,
      state,
      expires: cookieExpires,
      cookieName,
    },
    requireCookieSecret(),
  );

  const res = NextResponse.json({ url: authorizeUrl, cookieName });
  // httpOnly + SameSite=Lax + Path=/. Secure whenever the caller reached us
  // over https (prod on Vercel always; local dev falls back to insecure).
  const secure = new URL(request.url).protocol === 'https:';
  res.cookies.set({
    name: cookieName,
    value: cookieValue,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(COOKIE_TTL_MS / 1000),
  });
  return res;
}
