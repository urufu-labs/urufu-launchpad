/// Pure decision logic for TokenHolderModules — extracted from the component
/// so every render branch can be unit-tested without JSDOM / wagmi / RPC.
///
/// The component fires 7 marker view calls (order fixed at the call site):
///   0. stakingRewardRate    → success = Staking installed
///   1. vestingBeneficiary   → success = Vesting installed; result = beneficiary address
///   2. getVotes             → success = ERC20Votes installed
///   3. pausablePaused       → success = Pausable installed
///   4. antiBotIsGated       → success = AntiBot installed
///   5. antiWhaleIsActive    → success = AntiWhale installed
///   6. owner                → success = Ownable present; result = current owner
///
/// Each result is normalised into `{ ok: boolean, value?: unknown }` so this
/// helper doesn't leak wagmi types.
import type { Address } from 'viem';

export interface MarkerResult {
  ok: boolean;
  value?: unknown;
}

export interface DecideInput {
  markers: MarkerResult[];
  wallet: Address | null;
}

export interface Decision {
  hasStaking: boolean;
  hasVesting: boolean;
  hasVotes: boolean;
  hasPausable: boolean;
  hasAntiBot: boolean;
  hasAntiWhale: boolean;
  /// Vesting-beneficiary sub-panel only meaningful when the connected wallet
  /// is the beneficiary — the release() action reverts for anyone else, so
  /// showing them a button would just be a foot-gun.
  vestingIsBeneficiary: boolean;
  /// Current on-chain owner (or null when not detectable). address(0) means
  /// the token renounced ownership at launch — the common case for
  /// curve-launched tokens.
  tokenOwner: Address | null;
  /// Owner-restrictable modules only pose a live risk when someone can call
  /// the setter. If owner is address(0) the modules are inert and the
  /// banner stays hidden even if the impl was composed with them.
  showAdminBanner: boolean;
  /// If false, the whole component renders null — no shell, no header, no
  /// stray padding around an empty section.
  anythingToRender: boolean;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export function decideVisibleModules({ markers, wallet }: DecideInput): Decision {
  const hasStaking = !!markers[0]?.ok;
  const hasVesting = !!markers[1]?.ok;
  const hasVotes = !!markers[2]?.ok;
  const hasPausable = !!markers[3]?.ok;
  const hasAntiBot = !!markers[4]?.ok;
  const hasAntiWhale = !!markers[5]?.ok;

  const vestingBene = hasVesting ? (markers[1]?.value as Address | undefined) ?? null : null;
  const tokenOwner = markers[6]?.ok ? ((markers[6]?.value as Address | undefined) ?? null) : null;

  const vestingIsBeneficiary =
    !!wallet && !!vestingBene && wallet.toLowerCase() === vestingBene.toLowerCase();

  const ownerRenounced = !tokenOwner || tokenOwner.toLowerCase() === ZERO.toLowerCase();
  const showAdminBanner = !ownerRenounced && (hasPausable || hasAntiBot || hasAntiWhale);

  const anythingToRender =
    hasStaking || (hasVesting && vestingIsBeneficiary) || hasVotes || showAdminBanner;

  return {
    hasStaking,
    hasVesting,
    hasVotes,
    hasPausable,
    hasAntiBot,
    hasAntiWhale,
    vestingIsBeneficiary,
    tokenOwner,
    showAdminBanner,
    anythingToRender,
  };
}
