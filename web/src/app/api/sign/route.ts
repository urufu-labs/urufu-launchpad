/// POST /api/sign { token }: checks a sign link minted by the agent tools (see
/// lib/agentV2/signLink.ts) and returns its transactions for the /sign page. Only
/// links this server signed and that haven't expired come back.

import type { NextRequest } from 'next/server';

import { BodyError, readJsonBody } from '@/lib/agentV2/body';
import { sharedState } from '@/lib/agentV2/http';
import { clientIp } from '@/lib/agentV2/rateLimit';
import { decodeSignToken, MAX_SIGN_TOKEN, SignLinkError, signLinkKey } from '@/lib/agentV2/signLink';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE = { limit: 60, windowMs: 60_000 };

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function POST(req: NextRequest) {
  const gate = sharedState().limiter.check(`sign:${clientIp(req.headers)}`, RATE);
  if (!gate.ok) return json({ ok: false, error: { code: 'RATE_LIMITED', message: `Too many tries. Wait ${gate.retryAfter}s.` } }, 429);
  const key = signLinkKey();
  if (!key) return json({ ok: false, error: { code: 'OFF', message: 'Sign links are not set up on this server.' } }, 503);
  let token: unknown;
  try {
    token = ((await readJsonBody(req, MAX_SIGN_TOKEN + 256)) as { token?: unknown })?.token;
  } catch (err) {
    return json({ ok: false, error: { code: 'INVALID', message: (err as BodyError).message } }, 400);
  }
  try {
    return json({ ok: true, payload: decodeSignToken(String(token ?? ''), key, Date.now()) }, 200);
  } catch (err) {
    if (err instanceof SignLinkError) return json({ ok: false, error: { code: err.code, message: err.message } }, 400);
    throw err;
  }
}
