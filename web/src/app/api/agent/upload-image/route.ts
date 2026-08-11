/// POST /api/agent/upload-image
/// body: { imageUrl?: string, dataUrl?: string, filename?: string }
///
/// The agent pipes a token logo through this before attaching metadata. Two
/// input modes:
///   - `imageUrl`: any public HTTPS URL. We fetch server-side, size-cap, then
///     pin to Pinata via the compile-service's /pin/file route.
///   - `dataUrl`:  data:image/... base64 URL (agent-generated / user-supplied).
///     Same 512KB cap; forwarded as-is to the pin proxy.
///
/// Returns { cid, gatewayUrl } — the agent stashes gatewayUrl and passes it
/// as `imageUrl` on /api/agent/prepare-metadata.
///
/// Image storage itself is handled by compile-service (which owns the Pinata
/// JWT); this route is a thin server-side wrapper so agents can call one
/// well-known launchpad endpoint instead of two services.

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_BYTES = 512 * 1024;
/// Fetching arbitrary URLs from server-side is an SSRF surface. Block private
/// IP space + localhost host names. Public CDNs are fine; internal metadata
/// services aren't.
const BAD_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^\[::1\]$/,
  /\.internal$/i,
];

const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL
  ?? process.env.COMPILE_SERVICE_URL
  ?? 'http://localhost:3001';

async function fetchImageAsDataUrl(url: string): Promise<{ dataUrl: string; bytes: number } | { error: string; code: number }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'imageUrl must be a valid URL', code: 400 };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'imageUrl must be http(s)', code: 400 };
  }
  if (BAD_HOST_PATTERNS.some((rx) => rx.test(parsed.hostname))) {
    return { error: 'imageUrl cannot reference a private or loopback host', code: 400 };
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  if (!res.ok) return { error: `image fetch failed with HTTP ${res.status}`, code: 502 };

  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png';
  if (!mime.startsWith('image/')) {
    return { error: `unexpected content-type "${mime}" — imageUrl must return an image`, code: 400 };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return { error: `image too large (${buf.byteLength} bytes; max ${MAX_BYTES})`, code: 413 };
  }

  const b64 = Buffer.from(buf).toString('base64');
  return { dataUrl: `data:${mime};base64,${b64}`, bytes: buf.byteLength };
}

export async function POST(req: NextRequest) {
  let body: { imageUrl?: string; dataUrl?: string; filename?: string };
  try {
    body = await req.json() as { imageUrl?: string; dataUrl?: string; filename?: string };
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  let dataUrl: string | null = null;
  if (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:image/')) {
    dataUrl = body.dataUrl;
  } else if (typeof body.imageUrl === 'string' && body.imageUrl.length > 0) {
    const fetched = await fetchImageAsDataUrl(body.imageUrl);
    if ('error' in fetched) return NextResponse.json({ error: fetched.error }, { status: fetched.code });
    dataUrl = fetched.dataUrl;
  } else {
    return NextResponse.json({ error: 'must provide either `imageUrl` (public http/s) or `dataUrl` (data:image/... base64)' }, { status: 400 });
  }

  /// Forward to compile-service /pin/file. It owns the Pinata JWT + rate-limits;
  /// we're just a bridge so agents don't need to learn two service hosts.
  try {
    const pinRes = await fetch(`${COMPILE_SERVICE_URL}/pin/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename: body.filename }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!pinRes.ok) {
      const text = await pinRes.text().catch(() => '');
      return NextResponse.json(
        { error: `pin proxy returned HTTP ${pinRes.status}`, detail: text.slice(0, 300) },
        { status: 502 },
      );
    }
    const pin = await pinRes.json() as { cid?: string; gatewayUrl?: string; code?: string };
    if (!pin.cid || !pin.gatewayUrl) {
      return NextResponse.json(
        { error: 'pin proxy returned unexpected response', code: pin.code },
        { status: 502 },
      );
    }
    return NextResponse.json({
      cid: pin.cid,
      gatewayUrl: pin.gatewayUrl,
      hint: 'pass this gatewayUrl as `imageUrl` when calling /api/agent/prepare-metadata.',
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'pin forward failed' }, { status: 502 });
  }
}
