/// POST /api/agent/prepare-metadata
///
/// Between /verify (agent knows the token address) and the actual write, the
/// launcher wallet must sign an ownership envelope so the compile-service
/// can prove that whoever set the description + logo is the same wallet
/// that signed the launch tx. This endpoint does the payload-building work
/// so the agent doesn't have to hand-roll the canonical-message format.
///
/// Input: { txHash, description?, imageUrl?, website?, twitter?, telegram?,
///          discord?, tiktok? }
///
/// Output: { message, timestamp, payload, tokenAddress, chainId, launcher }
///
/// The agent then signs `message` with launcher's private key using EIP-191
/// personal_sign (any wallet lib works; cast: `cast wallet sign $MSG`) and
/// POSTs { signature } to /api/agent/attach-metadata along with the payload
/// + timestamp exactly as returned here (any drift in field order breaks
/// signature recovery).

import { NextRequest, NextResponse } from 'next/server';
import type { Address, Hex } from 'viem';

import {
  AGENT_ADDRESSES,
  AGENT_CHAIN_ID,
  LAUNCHED_EVENT_TOPIC,
  agentPublicClient,
} from '@/lib/agentApi';

export const runtime = 'nodejs';

/// Match compile-service's canonical-message shape exactly. The sort +
/// JSON.stringify order MUST agree byte-for-byte with the server's
/// verifyEnvelope call — anything else fails signature recovery.
function canonicalMessage(action: string, payload: Record<string, unknown>, timestamp: number): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  return `urufu:${action}:${JSON.stringify(canonical)}:${timestamp}`;
}

/// Optional text fields — trim + clamp to nullable. Empty strings become
/// null so a "cleared field" is represented consistently.
function nullish(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.slice(0, maxLen);
}

function nullishUrl(v: unknown): string | null {
  const cleaned = nullish(v, 500);
  if (!cleaned) return null;
  try {
    const u = new URL(cleaned);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return cleaned;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: '`txHash` must be a 0x-prefixed 32-byte hex string' }, { status: 400 });
  }

  try {
    const client = agentPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== 'success') {
      return NextResponse.json({ error: 'launch tx did not succeed on chain — cannot attach metadata to a failed launch' }, { status: 400 });
    }

    const launchedLog = receipt.logs.find((log) =>
      log.topics[0] === LAUNCHED_EVENT_TOPIC
      && log.address.toLowerCase() === AGENT_ADDRESSES.Router.toLowerCase(),
    );
    if (!launchedLog || !launchedLog.topics[1] || !launchedLog.topics[2]) {
      return NextResponse.json({ error: 'txHash is not a launch — no Launched event from the Router' }, { status: 400 });
    }

    const tokenAddress = `0x${launchedLog.topics[1]!.slice(-40)}` as Address;
    const launcher = `0x${launchedLog.topics[2]!.slice(-40)}` as Address;

    /// Build the payload the compile-service will re-hash. Field names, types,
    /// nullability, and length caps mirror MetadataSaveBody in
    /// compile-service/src/routes/social.ts. Timestamp is captured now so the
    /// agent doesn't have to guess a valid window (compile-service accepts +/-
    /// 5 min).
    const timestamp = Date.now();
    const payload = {
      chainId: AGENT_CHAIN_ID,
      tokenAddress: tokenAddress.toLowerCase(),
      imageUrl: nullishUrl(body.imageUrl),
      description: nullish(body.description, 500),
      website: nullishUrl(body.website),
      twitter: nullish(body.twitter, 80),
      telegram: nullish(body.telegram, 80),
      discord: nullish(body.discord, 80),
      tiktok: nullish(body.tiktok, 80),
      wlListCid: null,
    };
    const message = canonicalMessage('metadata:save', payload, timestamp);

    return NextResponse.json({
      message,
      timestamp,
      payload,
      tokenAddress: tokenAddress.toLowerCase(),
      chainId: AGENT_CHAIN_ID,
      launcher: launcher.toLowerCase(),
      hints: {
        sign: 'sign `message` with the launcher wallet using EIP-191 personal_sign. cast: cast wallet sign "$MESSAGE" --private-key $KEY',
        next: 'POST { tokenAddress, chainId, timestamp, payload, signature, address: launcher } to /api/agent/attach-metadata. Do NOT edit `payload` or `timestamp` — the signature covers them exactly.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'prepare-metadata failed' }, { status: 500 });
  }
}
