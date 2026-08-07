/// Local-first user profile store. Keyed by lowercase wallet address in localStorage.
///
/// This is the phase-1 MVP: each browser has its own view of profiles. Cross-user visibility
/// waits for either IPFS pinning (phase 2) or a backend / onchain registry (phase 3). The
/// PROFILE_MAX_BYTES cap keeps a large avatar from blowing localStorage quota.

import type { Address } from 'viem';

export interface UserProfile {
  /// Wallet address (lowercase hex) — the primary key.
  address: string;
  /// Display name shown on profile + hover cards. 1–24 chars.
  username?: string;
  /// Base64 data URL for the avatar image. Kept inline until an IPFS pipeline lands.
  avatarDataUrl?: string;
  /// Free-form bio, 0–200 chars.
  bio?: string;
  /// Social links.
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  /// Verified X (Twitter) binding — populated ONLY by the /api/auth/x/callback
  /// server-side flow. Never editable from the profile modal. If set, the UI
  /// renders a checkmark next to the handle + links out to twitter.com; if
  /// unset, `twitter` above is treated as unverified (grayed, no link).
  xVerifiedHandle?: string;
  /// X user id (numeric string). Persisted so a handle rename on X doesn't
  /// silently transfer the badge to a squatter.
  xVerifiedId?: string;
  /// ms since epoch — timestamp of the last successful X verification.
  xVerifiedAt?: number;
  /// X profile avatar URL — cached for search results / hover cards.
  xAvatarUrl?: string;
  /// When true, viewers OTHER than the owner do not see the holdings +
  /// balances section on this profile. UX-only shield — the indexer is public
  /// and anyone querying it by address can still see balances. Default false
  /// so every pre-existing profile keeps its current visibility.
  hideHoldings?: boolean;
  /// ms since epoch — last save.
  savedAt: number;
}

/// Small pure helper — kept next to the type so any surface that renders
/// holdings on a profile page can share the same rule. Own profile always
/// wins: even with the toggle ON, the owner sees their own holdings so they
/// can act on them. Only viewers OTHER than the owner get the placeholder.
export function shouldHideHoldingsFromView({
  isOwn,
  hideHoldings,
}: {
  isOwn: boolean;
  hideHoldings: boolean | undefined;
}): boolean {
  return !isOwn && hideHoldings === true;
}

const KEY_PREFIX = 'uru-profile-';
const PROFILE_MAX_BYTES = 512_000; // 500 KB — avatars up to ~400 KB safely fit
const USERNAME_MAX = 24;
const BIO_MAX = 200;

export function profileKey(address: string): string {
  return `${KEY_PREFIX}${address.toLowerCase()}`;
}

/// Load a stored profile, or a stub containing just the address if none exists yet.
export function loadProfile(address: Address | string): UserProfile {
  const lower = address.toLowerCase();
  if (typeof window === 'undefined') return { address: lower, savedAt: 0 };
  try {
    const raw = window.localStorage.getItem(profileKey(lower));
    if (!raw) return { address: lower, savedAt: 0 };
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    return { ...parsed, address: lower, savedAt: parsed.savedAt ?? 0 };
  } catch {
    return { address: lower, savedAt: 0 };
  }
}

/// Persist a profile. Trims strings, validates lengths, refuses if the resulting JSON blows
/// past PROFILE_MAX_BYTES so the caller can surface a "shrink your avatar" error.
export function saveProfile(profile: UserProfile): { ok: true } | { ok: false; error: string } {
  if (typeof window === 'undefined') return { ok: false, error: 'no window' };
  const trimmed: UserProfile = {
    address: profile.address.toLowerCase(),
    username: profile.username?.trim().slice(0, USERNAME_MAX) || undefined,
    avatarDataUrl: profile.avatarDataUrl?.trim() || undefined,
    bio: profile.bio?.trim().slice(0, BIO_MAX) || undefined,
    twitter: profile.twitter?.trim() || undefined,
    telegram: profile.telegram?.trim() || undefined,
    discord: profile.discord?.trim() || undefined,
    website: profile.website?.trim() || undefined,
    // Verified X fields are server-authoritative; preserve verbatim if the
    // caller passed them in (e.g. the modal re-saves after a hydrate). NEVER
    // mint or edit them here — the /api/auth/x/callback flow is the only
    // legitimate writer.
    xVerifiedHandle: profile.xVerifiedHandle,
    xVerifiedId: profile.xVerifiedId,
    xVerifiedAt: profile.xVerifiedAt,
    xAvatarUrl: profile.xAvatarUrl,
    // Coerce to a strict boolean or drop the key entirely so we don't
    // persist `false` verbosely in every localStorage snapshot.
    hideHoldings: profile.hideHoldings === true ? true : undefined,
    savedAt: Date.now(),
  };
  const json = JSON.stringify(trimmed);
  if (json.length > PROFILE_MAX_BYTES) {
    return { ok: false, error: `profile too big (${Math.round(json.length / 1024)}KB) — shrink ur avatar ~` };
  }
  try {
    window.localStorage.setItem(profileKey(trimmed.address), json);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'localStorage save failed' };
  }
}

/// Read a file input as a data URL for use as the avatar. Errors on non-image files.
export async function readAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('avatar must be an image file');
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { reject(new Error('read failed')); return; }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/// Best-effort display name for an address — the stored username if set, otherwise a
/// short "0x1234…abcd" so headers + list rows always have something.
export function displayNameFor(profile: UserProfile | null | undefined, address?: string): string {
  if (profile?.username) return profile.username;
  const a = (profile?.address ?? address ?? '').toLowerCase();
  if (!a || a.length < 10) return 'anon';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
