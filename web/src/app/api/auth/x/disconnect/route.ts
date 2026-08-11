/// POST /api/auth/x/disconnect — clears the verified X binding for a wallet.
///
/// Body: { wallet, signature, timestamp } — envelope shaped like the
/// compile-service `profile:save` envelopes, but signed over the canonical
/// message for action `x:disconnect` with an empty payload. Signature is
/// verified server-side (viem), then we make the bearer-authed call to the
/// compile-service to wipe the verified fields.

import { NextResponse, type NextRequest } from 'next/server';
import { isAddress, recoverMessageAddress, type Address } from 'viem';

import { requireVerifySharedSecret } from '@/lib/xAuth';

export const runtime = 'nodejs';

const MAX_AGE_MS = 5 * 60 * 1000;

const COMPILE_SERVICE_URL =
  process.env.COMPILE_SERVICE_URL
    ?? process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL
    ?? 'http://localhost:3001';

/// Rebuild the canonical string the client signed. Matches the compile-service
/// contract byte-for-byte so the wallet UX (`useSignMessage`) is identical to
/// every other signed write.
function canonicalMessage(action: string, payload: Record<string, unknown>, timestamp: number): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  return `urufu:${action}:${JSON.stringify(canonical)}:${timestamp}`;
}

interface DisconnectBody {
  wallet?: string;
  signature?: string;
  timestamp?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: DisconnectBody;
  try {
    body = (await request.json()) as DisconnectBody;
  } catch {
    return NextResponse.json({ code: 'BAD_JSON' }, { status: 400 });
  }

  const wallet = typeof body.wallet === 'string' ? body.wallet : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : NaN;

  if (!isAddress(wallet)) return NextResponse.json({ code: 'BAD_WALLET' }, { status: 400 });
  if (!signature.startsWith('0x')) return NextResponse.json({ code: 'BAD_SIGNATURE' }, { status: 400 });
  if (!Number.isFinite(timestamp)) return NextResponse.json({ code: 'BAD_TIMESTAMP' }, { status: 400 });
  if (Math.abs(Date.now() - timestamp) > MAX_AGE_MS) {
    return NextResponse.json({ code: 'EXPIRED' }, { status: 400 });
  }

  const message = canonicalMessage('x:disconnect', {}, timestamp);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return NextResponse.json({ code: 'SIGNATURE_VERIFY_ERROR' }, { status: 401 });
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return NextResponse.json({ code: 'SIGNATURE_MISMATCH' }, { status: 401 });
  }

  // Server-to-server call: bearer-auth to compile-service. Body signals a
  // "clear" write.
  const url = `${COMPILE_SERVICE_URL.replace(/\/$/, '')}/profile/${wallet.toLowerCase()}/x-verified`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${requireVerifySharedSecret()}`,
      },
      body: JSON.stringify({ clear: true }),
    });
    if (!res.ok) {
      return NextResponse.json({ code: 'PERSIST_FAILED', status: res.status }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ code: 'PERSIST_UNREACHABLE' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
