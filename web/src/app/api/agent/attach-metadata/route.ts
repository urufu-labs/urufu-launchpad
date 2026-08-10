/// POST /api/agent/attach-metadata
///
/// Second half of the metadata pipeline. Agent has signed the `message`
/// returned by /prepare-metadata; POST the signature + envelope here.
///
/// Input: { tokenAddress, chainId, timestamp, payload, signature, address }
///        - payload + timestamp MUST be exactly what /prepare-metadata returned
///        - signature is EIP-191 personal_sign over the `message` field
///        - address is the launcher wallet (also embedded in payload)
///
/// We forward to compile-service /token/:chainId/:address/metadata which
/// re-derives the canonical message, recovers the signer from the signature,
/// looks up the token's launcher in the indexer, and writes iff the two match.
/// The indexer lookup can lag the on-chain launch by ~5-20 seconds; if so we
/// bubble up `INDEXER_PENDING` and the agent should retry.

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL
  ?? process.env.COMPILE_SERVICE_URL
  ?? 'http://localhost:3001';

export async function POST(req: NextRequest) {
  let body: {
    tokenAddress?: string;
    chainId?: number;
    timestamp?: number;
    payload?: Record<string, unknown>;
    signature?: string;
    address?: string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const { tokenAddress, chainId, timestamp, payload, signature, address } = body;
  if (!tokenAddress || !chainId || !timestamp || !payload || !signature || !address) {
    return NextResponse.json(
      { error: 'missing required fields — expected { tokenAddress, chainId, timestamp, payload, signature, address }' },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    return NextResponse.json({ error: 'tokenAddress must be a 0x-prefixed 20-byte address' }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: 'address must be a 0x-prefixed 20-byte address' }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 132) {
    return NextResponse.json({ error: 'signature must be a 0x-prefixed 65-byte hex string (personal_sign / EIP-191)' }, { status: 400 });
  }

  try {
    const forwardUrl = `${COMPILE_SERVICE_URL}/token/${chainId}/${tokenAddress.toLowerCase()}/metadata`;
    const res = await fetch(forwardUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: address.toLowerCase(), signature, timestamp, payload }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text().catch(() => '');
    /// Compile-service returns JSON for every branch (success, UNAUTHORIZED,
    /// INDEXER_PENDING, NOT_LAUNCHER, ...). Passthrough so agents see the
    /// specific reason without us hiding it.
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }

    if (!res.ok) {
      const code = (parsed as { code?: string } | null)?.code ?? `HTTP ${res.status}`;
      const message = (parsed as { message?: string } | null)?.message;
      const hint = code === 'INDEXER_PENDING'
        ? 'indexer has not yet picked up the launch. wait ~10 seconds then POST again with the same body.'
        : code === 'NOT_LAUNCHER'
          ? 'the signer address does not match the tx launcher. sign with the same wallet that broadcast the launch tx.'
          : code === 'URL_PAYLOAD_MISMATCH'
            ? 'tokenAddress in URL vs payload disagreed. re-run /prepare-metadata and use its return values verbatim.'
            : 'see `code` for reason.';
      return NextResponse.json({ code, message, hint }, { status: res.status });
    }

    return NextResponse.json({
      ok: true,
      tokenAddress: tokenAddress.toLowerCase(),
      chainId,
      links: {
        trade: `https://urufulabs.xyz/trade/${tokenAddress.toLowerCase()}`,
      },
      hint: 'metadata now live — trade page will render logo + description + socials.',
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'attach-metadata forward failed' }, { status: 502 });
  }
}
