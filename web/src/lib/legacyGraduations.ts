/// Single source of truth for tokens tied to the pre-V3 graduator stack on RH.
///
/// Two overlapping cohorts:
///
///   1. LEGACY_V10_HOOK — tokens whose v4 pool is (or will be) keyed at the
///      V10 MultiHookHost address (0x48C22af8). Every pool's hook is baked
///      into its poolId permanently on-chain, so nothing off-chain can move
///      them. The trade page uses this map to derive the correct poolId for
///      these tokens no matter what the indexer or config says.
///
///   2. PENDING_LEGACY_GRADUATION — tokens still on their bonding curve whose
///      `curve.graduator` is baked to the pre-V3 (raw-ratio) graduator. When
///      they eventually hit their graduation target they will seed the v4
///      pool at the wrong price and produce the same cliff LUV had. Trade
///      page renders a warning banner on these so buyers see it coming.
///
/// A token in PENDING_LEGACY_GRADUATION IS in LEGACY_V10_HOOK — once it
/// graduates, its pool will land on V10 MHH, and the hook-override map
/// keeps the trade page pointed at the right pool. Kept as two separate
/// sets so the pill / banner logic can distinguish "already graduated
/// against the old stack" from "will graduate against the old stack".
///
/// Deletion policy: once a PENDING_LEGACY_GRADUATION token actually
/// graduates, MOVE it out of that set but LEAVE it in LEGACY_V10_HOOK
/// forever — the poolId lookup still needs to work for its trade page.

import type { Address } from 'viem';

/// V10 MultiHookHost — the hook address every legacy V10 pool is keyed at.
export const V10_MULTI_HOOK_HOST: Address = '0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4';

/// Tokens (lowercase) whose v4 pool lives on V10 MHH. Includes both already-
/// graduated tokens and tokens that will graduate through V10 later.
const LEGACY_V10_HOOK: Set<string> = new Set([
  // Already graduated on V10 (the "40k → 20k" cliff cohort).
  '0x985ec2c71ffebf4822b6c877bb87229923813c63',
  // Still on curve, `curve.graduator = 0xA29Ee1DB…` (V10). Will produce a V10 pool
  // when they hit their graduation target — same cliff LUV had.
  '0x99f6d9b3284ce9c11cef0802539a4ba81070e875',
  '0xf382db5729bcbc61bc2fbc63f0b6ba93049cbb4a',
]);

/// Tokens still on curve whose graduator is the pre-V3 (raw-ratio) one.
const PENDING_LEGACY_GRADUATION: Set<string> = new Set([
  '0x99f6d9b3284ce9c11cef0802539a4ba81070e875',
  '0xf382db5729bcbc61bc2fbc63f0b6ba93049cbb4a',
]);

/// Returns V10 MHH for any token whose v4 pool lives on V10 (both already
/// graduated and pre-graduation curves that will graduate through V10).
/// The trade page uses this ahead of the indexer + config fallback so the
/// poolId always derives against the correct hook.
export function legacyHookOverride(tokenAddress: Address | string): Address | undefined {
  const lc = (tokenAddress as string).toLowerCase();
  return LEGACY_V10_HOOK.has(lc) ? V10_MULTI_HOOK_HOST : undefined;
}

/// True iff the token's v4 pool has already been seeded by the V10 (raw-ratio)
/// graduator. Used to render the "legacy" pill on discover cards + trade page.
/// Requires `graduated=true` so pre-graduation curves don't get the pill.
export function isLegacyGraduated(tokenAddress: Address | string, graduated: boolean | undefined): boolean {
  if (!graduated) return false;
  return LEGACY_V10_HOOK.has((tokenAddress as string).toLowerCase());
}

/// True iff the token is still on its bonding curve AND that curve's graduator
/// is the pre-V3 raw-ratio one. Trade page renders a cliff-warning banner on
/// these so buyers know what post-graduation LP seeding they will get.
export function willGraduateLegacy(tokenAddress: Address | string, graduated: boolean | undefined): boolean {
  if (graduated) return false;
  return PENDING_LEGACY_GRADUATION.has((tokenAddress as string).toLowerCase());
}
