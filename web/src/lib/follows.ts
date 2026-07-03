/// Local-first follow list. Stores the addresses YOU follow in localStorage under
/// `uru-follows`. Because there's no shared backend yet, "followers" (people who
/// follow YOU) can't be surfaced — only "following" is meaningful in this phase.
///
/// Cross-device sync + true bidirectional followers ships alongside the backend
/// registry (phase 3).

import type { Address } from 'viem';

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

/// Subscribe to change events fired by follow/unfollow. Returns an unsubscribe fn.
export function onFollowsChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
