/// Sign links: a urufulabs.xyz/sign#<token> URL that opens the transactions a tool
/// built, ready for the human to send from their own wallet. Chat apps (Claude,
/// ChatGPT, Grok...) can't hand raw calldata to a wallet, so every tool result with
/// transactions also carries `signUrl`.
///
/// The token is the payload (deflated JSON, base64url) plus an HMAC from a server
/// secret, so only this server can mint one: a link someone else crafts with their
/// own `to` / `data` fails verification and the page shows nothing to sign. Links
/// expire (quotes go stale). The token lives in the URL fragment, so it never reaches
/// server logs; the page posts it to /api/sign to be checked.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const SIGN_LINK_TTL_MS = 30 * 60_000;
/// Longer links get cut by some chat apps; past this we just don't offer one.
export const MAX_SIGN_TOKEN = 12_000;
const MAC_BYTES = 16;

export interface SignTx {
  to: string;
  data: string;
  value: string;
  purpose: string;
  summary: string;
}

export interface SignPayload {
  v: 1;
  tool: string;
  chainId: number;
  /// Wallet that must send these, when the tool knows it.
  from: string | null;
  summary: string | null;
  exp: number;
  txs: SignTx[];
}

const b64url = (b: Buffer) => b.toString('base64url');

/// HMAC key, or null when no secret is configured (then no links are offered).
/// SIGN_LINK_SECRET wins; otherwise a key derived from the X cookie secret.
export function signLinkKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const s = env.SIGN_LINK_SECRET ?? env.X_OAUTH_COOKIE_SECRET;
  if (!s || s.length < 32) return null;
  return createHmac('sha256', s).update('urufu-sign-link-v1').digest();
}

const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest().subarray(0, MAC_BYTES);

export function encodeSignToken(p: SignPayload, key: Buffer): string {
  const body = b64url(deflateRawSync(Buffer.from(JSON.stringify(p))));
  return `${body}.${b64url(mac(key, body))}`;
}

export class SignLinkError extends Error {
  code: 'INVALID' | 'EXPIRED';
  constructor(code: 'INVALID' | 'EXPIRED', message: string) {
    super(message);
    this.code = code;
  }
}

export function decodeSignToken(token: string, key: Buffer, now: number): SignPayload {
  if (typeof token !== 'string' || token.length > MAX_SIGN_TOKEN) throw new SignLinkError('INVALID', 'This link is not valid.');
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw new SignLinkError('INVALID', 'This link is not valid.');
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = mac(key, body);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new SignLinkError('INVALID', 'This link was not made by urufu, or it was changed.');
  let p: SignPayload;
  try {
    p = JSON.parse(inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: 256 * 1024 }).toString('utf8')) as SignPayload;
  } catch {
    throw new SignLinkError('INVALID', 'This link is not valid.');
  }
  if (p.v !== 1 || !Array.isArray(p.txs) || p.txs.length === 0) throw new SignLinkError('INVALID', 'This link is not valid.');
  if (now > p.exp) throw new SignLinkError('EXPIRED', 'This link has expired. Ask your AI for a fresh one.');
  return p;
}

export interface SignLinkInput {
  tool: string;
  chainId: number;
  from: string | null;
  summary: string | null;
  txs: SignTx[];
}

/// Full URL for `input`, or null when it would be too long for a chat app.
export function makeSignUrl(site: string, input: SignLinkInput, key: Buffer, now: number): string | null {
  const token = encodeSignToken({ v: 1, ...input, exp: now + SIGN_LINK_TTL_MS }, key);
  if (token.length > MAX_SIGN_TOKEN) return null;
  return `${site}/sign#${token}`;
}
