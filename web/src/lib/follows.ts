/// Local-first follow list. Stores the addresses YOU follow in localStorage under
/// `uru-follows` for instant UI reads, AND writes through to the compile-service
/// backend when the user has signed at least once. The backend read path
/// (`fetchFollowers` / `fetchFollowing` in socialApi.ts) is what powers the
/// "who follows me" modal — localStorage can't know that.
///
/// Callers that need the wallet's follow list SHOULD hit the backend for cross-
/// device consistency, but the localStorage cache stays as the instant-hydrate
/// source for the "follow button" on/off state.

import type { Address } from 'viem';
import { followUser, unfollowUser, type SignFn } from './socialApi';

const KEY = 'uru-follows';
const EVENT = 'urufu-follows-change';

function normalize(addr: string): string {
  return addr.toLowerCase();
}

export function getFollowing(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').map(normalize);
  } catch { return []; }
}

function setFollowing(next: string[]): void {
  if (typeof window === 'undefined') return;
  const uniq = Array.from(new Set(next.map(normalize)));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(uniq));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch { /* quota — ignore */ }
}

export function isFollowing(address: Address | string): boolean {
  return getFollowing().includes(normalize(address));
}

/// Add to the follow list. No-op if already followed. Returns the new list.
export function follow(address: Address | string): string[] {
  const cur = getFollowing();
  const target = normalize(address);
  if (cur.includes(target)) return cur;
  const next = [...cur, target];
  setFollowing(next);
  return next;
}

export function unfollow(address: Address | string): string[] {
  const target = normalize(address);
  const next = getFollowing().filter((a) => a !== target);
  setFollowing(next);
  return next;
}

/// Toggle. Returns the new "isFollowing" state (true = now following, false = now unfollowed).
export function toggleFollow(address: Address | string): boolean {
  const target = normalize(address);
  if (isFollowing(target)) { unfollow(target); return false; }
  follow(target);
  return true;
}

/// Toggle + write through to backend. Updates localStorage immediately (so the
/// button flips right away) and fires the signed backend call in the background.
/// Backend failure is logged but doesn't reverse the local state — the caller
/// stays optimistic. Returns the new "isFollowing" state.
export async function toggleFollowRemote(
  self: Address,
  target: Address | string,
  sign: SignFn,
): Promise<boolean> {
  const nextState = toggleFollow(target);
  try {
    const result = nextState
      ? await followUser(self, target as Address, sign)
      : await unfollowUser(self, target as Address, sign);
    if (!result.ok) console.warn('follow: backend write failed', result.error);
  } catch (err) {
    console.warn('follow: backend write threw', err);
  }
  return nextState;
}

/// Subscribe to change events fired by follow/unfollow. Returns an unsubscribe fn.
export function onFollowsChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
