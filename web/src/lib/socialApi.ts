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
  /// IPFS CID of the pinned whitelist holder list, when the token launched with
  /// a community whitelist. Trade page reads this to fetch the list + build
  /// proofs for WL-eligible buyers. Null on non-WL launches.
  wlListCid: string | null;
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
    /// Set at launch time when a whitelist is applied. Backend persists it so
    /// cross-device viewers can fetch the pinned holder list + build proofs.
    wlListCid?: string | null;
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
  /// Verified X (Twitter) binding — written only by the /api/auth/x/callback
  /// server flow via the compile-service bearer path. The client `saveProfile`
  /// below CANNOT overwrite these fields; the backend ignores them in the
  /// signed-write path.
  xVerifiedHandle: string | null;
  xVerifiedId: string | null;
  xVerifiedAt: number | null;
  xAvatarUrl: string | null;
  /// Privacy toggle. When true the /profile/[addr] page hides the wallet's
  /// holdings + balances from viewers OTHER than the owner. UX-only shield —
  /// the indexer is public. Backend normalizes NULL to false so the client
  /// can trust the shape.
  hideHoldings: boolean;
  updatedAt: string;
}

export async function fetchProfile(address: Address): Promise<RemoteProfile | null> {
  return getJson<RemoteProfile>(`/profile/${address}`);
}

// ---------------------------------------------------------------- profile search

/// Result row from GET /profile/search. Deliberately narrower than
/// `RemoteProfile` — the search endpoint strips bio / socials / verified id
/// so an unauthenticated caller cannot rip a full user directory.
export interface RemoteProfileSearchHit {
  address: Address;
  username: string | null;
  avatarUrl: string | null;
  xVerifiedHandle: string | null;
  xAvatarUrl: string | null;
  /// Legacy self-declared handle. Server sets this to `null` whenever
  /// `xVerifiedHandle` is populated so the client is never asked to pick
  /// between two handles for the same profile.
  twitter: string | null;
  updatedAt: string;
}

/// Distinct error shape from `searchProfiles` so a caller can decide whether
/// to render a toast (rate-limited) vs. a soft empty state (network hiccup).
export type SearchProfilesResult =
  | { ok: true; results: RemoteProfileSearchHit[] }
  | { ok: false; error: 'rate-limited' | 'aborted' | 'network' | 'server' };

/// Query the user directory. Pass an `AbortSignal` from the caller so an
/// in-flight search can be cancelled the moment the user types another
/// character — otherwise stale responses race the current one and land
/// out of order in the modal.
///
/// Returns `{ ok: false, error: 'aborted' }` on cancel so the caller can
/// distinguish "the request was cancelled, do nothing" from "the request
/// completed with no rows". Rate-limit responses (HTTP 429) surface as a
/// distinct code so the UI can render a "too fast" toast instead of the
/// generic empty state.
export async function searchProfiles(
  q: string,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<SearchProfilesResult> {
  const params = new URLSearchParams({ q });
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  try {
    const res = await fetch(`${BASE_URL}/profile/search?${params.toString()}`, {
      signal: opts?.signal,
    });
    if (res.status === 429) return { ok: false, error: 'rate-limited' };
    if (!res.ok) return { ok: false, error: 'server' };
    const data = (await res.json()) as { results: RemoteProfileSearchHit[] };
    return { ok: true, results: data.results ?? [] };
  } catch (err) {
    // AbortController.abort() rejects the fetch with an AbortError DOMException.
    // Both Node undici and browser fetch use `err.name === 'AbortError'`.
    if ((err as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'aborted' };
    }
    return { ok: false, error: 'network' };
  }
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
    /// Privacy toggle for the holdings section on the public profile page.
    /// Optional so callers that don't touch privacy don't have to pass it;
    /// the server treats an omitted value as false at INSERT time.
    hideHoldings?: boolean;
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

// ---------------------------------------------------------------- follows
//
// Server-side social graph. `followUser` / `unfollowUser` are signed writes;
// `fetchFollowers` / `fetchFollowing` are public reads. Backend enriches with
// profile so the modal renders avatars without an N+1 fetch.

export interface RemoteFollowUser {
  address: Address;
  username: string | null;
  avatarUrl: string | null;
  followedAt: string;
}

export async function fetchFollowers(address: Address): Promise<RemoteFollowUser[]> {
  const data = await getJson<{ count: number; items: RemoteFollowUser[] }>(`/followers/${address.toLowerCase()}`);
  return data?.items ?? [];
}

export async function fetchFollowing(address: Address): Promise<RemoteFollowUser[]> {
  const data = await getJson<{ count: number; items: RemoteFollowUser[] }>(`/following/${address.toLowerCase()}`);
  return data?.items ?? [];
}

export async function followUser(
  address: Address,
  target: Address,
  sign: SignFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const targetLower = target.toLowerCase();
  const res = await signedPost(
    `/follows/${targetLower}`,
    'follow:add',
    address,
    { target: targetLower },
    sign,
  );
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: false, error: String(body.code ?? `HTTP ${res.status}`) };
}

export async function unfollowUser(
  address: Address,
  target: Address,
  sign: SignFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const targetLower = target.toLowerCase();
  const res = await signedPost(
    `/follows/${targetLower}/unfollow`,
    'follow:remove',
    address,
    { target: targetLower },
    sign,
  );
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: false, error: String(body.code ?? `HTTP ${res.status}`) };
}
