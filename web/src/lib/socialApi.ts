/// Client for the compile-service's social/UGC API. Backs token metadata, user
/// profiles, and per-token chat. All mutating calls require a wallet signature; the
/// canonical message format matches `compile-service/src/auth.ts`.
///
/// Reads are public GET. Writes take an unsigned `payload` + the caller's `signAsync`
/// callback (typically wagmi's `useSignMessage().signMessageAsync`).

import type { Address } from 'viem';

const BASE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------- shared helpers

/// Rebuild the canonical string the server expects. Payload key ordering MUST match —
/// stringify with sorted keys.
function canonicalMessage(action: string, payload: Record<string, unknown>, timestamp: number): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  return `urufu:${action}:${JSON.stringify(canonical)}:${timestamp}`;
}

/// Callback shape wagmi's useSignMessage returns. Kept as a plain function type so
/// callers can pass any wallet signer that yields an 0x-prefixed signature.
export type SignFn = (args: { message: string }) => Promise<`0x${string}`>;

async function signedPost(
  path: string,
  action: string,
  address: Address,
  payload: Record<string, unknown>,
  sign: SignFn,
): Promise<Response> {
  const timestamp = Date.now();
  const message = canonicalMessage(action, payload, timestamp);
  const signature = await sign({ message });
  const body = JSON.stringify({ address, signature, timestamp, payload });
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- metadata

export interface RemoteTokenMetadata {
  chainId: number;
  tokenAddress: Address;
  imageUrl: string | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  tiktok: string | null;
  updatedAt: string;
  owner: Address;
}

export async function fetchTokenMetadata(
  chainId: number,
  tokenAddress: Address,
): Promise<RemoteTokenMetadata | null> {
  return getJson<RemoteTokenMetadata>(`/token/${chainId}/${tokenAddress}/metadata`);
}

export async function fetchTokenMetadataBatch(
  chainId: number,
  tokens: Address[],
): Promise<Record<string, RemoteTokenMetadata>> {
  if (tokens.length === 0) return {};
  try {
    const res = await fetch(`${BASE_URL}/token-metadata/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId, tokens }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { items: RemoteTokenMetadata[] };
    const map: Record<string, RemoteTokenMetadata> = {};
    for (const it of data.items ?? []) {
      map[it.tokenAddress.toLowerCase()] = it;
    }
    return map;
  } catch {
    return {};
  }
}

export async function saveTokenMetadata(
  address: Address,
  payload: {
    chainId: number;
    tokenAddress: Address;
    imageUrl?: string | null;
    description?: string | null;
    website?: string | null;
    twitter?: string | null;
    telegram?: string | null;
    discord?: string | null;
    tiktok?: string | null;
  },
  sign: SignFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await signedPost(
    `/token/${payload.chainId}/${payload.tokenAddress}/metadata`,
    'metadata:save',
    address,
    payload,
    sign,
  );
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: false, error: String(body.code ?? `HTTP ${res.status}`) };
}

// ---------------------------------------------------------------- profile

export interface RemoteProfile {
  address: Address;
  username: string | null;
  avatarUrl: string | null;
  bio: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  website: string | null;
  updatedAt: string;
}

export async function fetchProfile(address: Address): Promise<RemoteProfile | null> {
  return getJson<RemoteProfile>(`/profile/${address}`);
}

export async function saveProfile(
  address: Address,
  payload: {
    username?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    twitter?: string | null;
    telegram?: string | null;
    discord?: string | null;
    website?: string | null;
  },
  sign: SignFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await signedPost(`/profile/${address}`, 'profile:save', address, payload, sign);
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: false, error: String(body.code ?? `HTTP ${res.status}`) };
}

// ---------------------------------------------------------------- chat

export interface RemoteChatMessage {
  id: string;
  senderAddress: Address;
  text: string;
  ts: number; // epoch seconds
}

export async function fetchChat(
  chainId: number,
  tokenAddress: Address,
  limit = 100,
): Promise<RemoteChatMessage[]> {
  const data = await getJson<{ items: RemoteChatMessage[] }>(
    `/token/${chainId}/${tokenAddress}/chat?limit=${limit}`,
  );
  return data?.items ?? [];
}

export async function postChat(
  address: Address,
  payload: { chainId: number; tokenAddress: Address; text: string },
  sign: SignFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await signedPost(
    `/token/${payload.chainId}/${payload.tokenAddress}/chat`,
    'chat:post',
    address,
    payload,
    sign,
  );
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: false, error: String(body.code ?? `HTTP ${res.status}`) };
}
