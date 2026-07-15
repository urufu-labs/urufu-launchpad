import { verifyMessage, isAddress, type Address } from 'viem';

/// Wallet-signed write auth. Every mutating request carries a `signedMessage` field
/// containing a canonical string the client built + signed. The server rebuilds the
/// same canonical string from the request body, verifies the signature recovers to
/// `address`, and rejects anything older than 5 minutes so replay is bounded.
///
/// Canonical shape (client + server MUST agree byte-for-byte):
///   `urufu:${action}:${payloadJson}:${timestampMs}`
/// - action: 'metadata:save' | 'profile:save' | 'chat:post'
/// - payloadJson: JSON.stringify of the request body EXCLUDING the auth fields
/// - timestampMs: Date.now() at the time of signing

const MAX_AGE_MS = 5 * 60 * 1000;

export interface AuthEnvelope {
  address: string;
  signature: `0x${string}`;
  timestamp: number;
}

/// Rebuild the canonical string. Payload MUST be stringified with the same key order
/// on client + server — so we always sort keys.
export function canonicalMessage(action: string, payload: Record<string, unknown>, timestamp: number): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  return `urufu:${action}:${JSON.stringify(canonical)}:${timestamp}`;
}

/// Verifies the signature + timestamp window. Returns the recovered address (lowercased)
/// on success, or a reason string on failure.
export async function verifyEnvelope(
  action: string,
  payload: Record<string, unknown>,
  envelope: AuthEnvelope,
): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  if (!envelope || typeof envelope.address !== 'string' || !isAddress(envelope.address)) {
    return { ok: false, reason: 'BAD_ADDRESS' };
  }
  if (typeof envelope.signature !== 'string' || !envelope.signature.startsWith('0x')) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  if (typeof envelope.timestamp !== 'number' || !Number.isFinite(envelope.timestamp)) {
    return { ok: false, reason: 'BAD_TIMESTAMP' };
  }
  const age = Math.abs(Date.now() - envelope.timestamp);
  if (age > MAX_AGE_MS) return { ok: false, reason: 'EXPIRED' };

  const message = canonicalMessage(action, payload, envelope.timestamp);
  try {
    const valid = await verifyMessage({
      address: envelope.address as Address,
      message,
      signature: envelope.signature,
    });
    if (!valid) return { ok: false, reason: 'SIGNATURE_MISMATCH' };
    return { ok: true, address: envelope.address.toLowerCase() };
  } catch {
    return { ok: false, reason: 'SIGNATURE_VERIFY_ERROR' };
  }
}
