'use client';

/// Public holder-facing module panel — the counterpart to TokenOwnerControls.
/// Where TokenOwnerControls exposes owner-only admin surfaces (pause, allowlist,
/// exempt-from-caps) to only the token owner, THIS component exposes the
/// holder-facing surfaces (stake, claim rewards, delegate votes, release vesting)
/// to any wallet that visits the trade page — because those actions are meant
/// for token HOLDERS, not the deployer.
///
/// Detection: fan out three marker view calls per token with allowFailure: true.
/// A successful non-revert = the module was composed into this token's impl:
///   - stakingRewardRate() → Staking module present
///   - vestingBeneficiary() → Vesting module present
///   - getVotes(0) → ERC20Votes module present
///
/// Bare-ERC20 tokens revert on all three and the panel renders nothing.
///
/// Sub-panel visibility rules:
///   - Staking: shown to ANY wallet if module present. Anyone can stake.
///   - Vesting: shown only if vestingBeneficiary() == connected wallet.
///     Non-beneficiaries would see a release button that would just revert.
///   - Votes:   shown to ANY wallet if module present. Anyone can (self-)delegate.

import { useEffect, useState } from 'react';
import {
  useAccount,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatUnits, isAddress, parseUnits, type Address } from 'viem';

import { tokenHolderModulesAbi } from '@/lib/abis';
import type { WagmiChainId } from '@/lib/wagmi';
import { decideVisibleModules, type MarkerResult } from './TokenHolderModules.logic';

interface Props {
  /// The launched token address to probe + interact with.
  token: Address;
  /// Wagmi chainId of the token's home chain. Passed to every read + write so
  /// hooks fire on the right client even if the wallet is on a different chain
  /// (the actions themselves will prompt switch-chain). Typed as the wagmi-
  /// config literal union so useReadContracts / useWriteContract accept it.
  chainId: WagmiChainId;
  /// ERC20 decimals for input formatting. Default 18; callers can pass a
  /// different value if the token uses something else.
  decimals?: number;
}

export function TokenHolderModules({ token, chainId, decimals = 18 }: Props) {
  const { address: wallet } = useAccount();

  // Marker probe: three holder-facing modules + three owner-restrictable
  // modules + owner(). allowFailure lets missing modules just return an
  // errored entry we treat as "not installed."
  const markers = useReadContracts({
    contracts: [
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingRewardRate', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingBeneficiary', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'getVotes', args: [wallet ?? ZERO], chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'pausablePaused', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'antiBotIsGated', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'antiWhaleIsActive', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'owner', chainId },
    ],
    query: { staleTime: 30_000 },
  });

  // All render decisions moved into a pure helper (decideVisibleModules) so
  // the branch matrix can be unit-tested without a browser / wallet / RPC.
  // Adapts wagmi's per-call result shape into the helper's neutral type.
  const raw: MarkerResult[] = (markers.data ?? []).map((r) => {
    if (!r || r.status !== 'success') return { ok: false };
    return { ok: true, value: r.result };
  });
  const decision = decideVisibleModules({ markers: raw, wallet: wallet ?? null });
  const { hasStaking, hasVesting, hasVotes, hasPausable, hasAntiBot, hasAntiWhale } = decision;
  const isBene = decision.vestingIsBeneficiary;
  const showAdminRisk = decision.showAdminBanner;
  const tokenOwner = decision.tokenOwner;

  if (markers.isPending || !decision.anythingToRender) return null;

  return (
    <section
      className="uru-shell"
      style={{ marginTop: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      {showAdminRisk && (
        <AdminRiskBanner
          hasPausable={hasPausable}
          hasAntiBot={hasAntiBot}
          hasAntiWhale={hasAntiWhale}
          owner={tokenOwner!}
        />
      )}

      {(hasStaking || (hasVesting && isBene) || hasVotes) && (
        <>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-hidden style={{ fontSize: 18 }}>✿</span>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 18 }}>
              holder actions
            </h3>
            <span style={{ color: 'var(--anchor-soft)', fontSize: 12 }}>
              modules the deployer picked at launch
            </span>
          </header>

          {hasStaking && <StakingPanel token={token} chainId={chainId} decimals={decimals} />}
          {hasVesting && isBene && <VestingPanel token={token} chainId={chainId} decimals={decimals} />}
          {hasVotes && <VotesPanel token={token} chainId={chainId} decimals={decimals} />}
        </>
      )}
    </section>
  );
}

// ============================================================================
// Admin-risk banner — surfaces owner-controlled transfer levers so buyers
// know the deployer can still restrict trading. Rendered ONLY when owner is
// non-zero AND at least one owner-restrictable module is present.
// ============================================================================

function AdminRiskBanner({
  hasPausable,
  hasAntiBot,
  hasAntiWhale,
  owner,
}: {
  hasPausable: boolean;
  hasAntiBot: boolean;
  hasAntiWhale: boolean;
  owner: Address;
}) {
  const levers: string[] = [];
  if (hasPausable) levers.push('pause all transfers');
  if (hasAntiBot) levers.push('restrict who can receive tokens');
  if (hasAntiWhale) levers.push('cap per-wallet balance + per-tx size');

  return (
    <div
      role="alert"
      style={{
        padding: 12,
        borderRadius: 10,
        border: '1.5px solid var(--anchor)',
        background: 'var(--yolk)',
        color: 'var(--anchor)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 16 }}>⚠</span>
        <strong style={{ fontFamily: 'var(--font-round), cursive', fontSize: 14 }}>
          deployer has admin power over this token
        </strong>
      </div>
      <p style={{ margin: 0, fontSize: 13 }}>
        the owner ({short(owner)}) can {levers.join(', ')}. curve-launched tokens usually renounce
        ownership at launch — this one did not, so restrictions on your ability to trade or hold
        are possible.
      </p>
    </div>
  );
}

// ============================================================================
// Staking sub-panel — stake, claim rewards, withdraw.
// ============================================================================

function StakingPanel({
  token,
  chainId,
  decimals,
}: {
  token: Address;
  chainId: WagmiChainId;
  decimals: number;
}) {
  const { address: wallet } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingBalanceOf', args: [wallet ?? ZERO], chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingEarned', args: [wallet ?? ZERO], chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingTotalStaked', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingRewardRate', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'stakingPeriodFinish', chainId },
    ],
    query: { staleTime: 15_000 },
  });

  const staked = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const earned = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;
  const total = (reads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const rewardRate = (reads.data?.[3]?.result as bigint | undefined) ?? 0n;
  const periodFinish = (reads.data?.[4]?.result as bigint | undefined) ?? 0n;

  const nowSec = useNowSec();
  const periodActive = Number(periodFinish) > nowSec;

  const [amount, setAmount] = useState('');
  const {
    writeContract,
    data: txHash,
    isPending: writePending,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: waitPending, isSuccess: waitSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });
  const busy = writePending || waitPending;

  // Refetch reads once a tx confirms so the panel shows the new balance/earned
  // immediately without a page refresh.
  useAutoRefetch(waitSuccess, [reads.refetch, resetWrite]);

  function submit(fn: 'stake' | 'stakingWithdraw' | 'stakingClaim') {
    if (!wallet) return;
    if (fn === 'stakingClaim') {
      writeContract({ abi: tokenHolderModulesAbi, address: token, functionName: fn, chainId });
      return;
    }
    let parsed: bigint;
    try {
      parsed = parseUnits(amount || '0', decimals);
    } catch {
      return;
    }
    if (parsed === 0n) return;
    writeContract({ abi: tokenHolderModulesAbi, address: token, functionName: fn, args: [parsed], chainId });
  }

  return (
    <div style={panelStyle}>
      <SectionHeading label="staking" hint={periodActive ? 'rewards live' : 'reward period ended'} />
      <div style={statsGrid}>
        <Stat label="your stake" value={fmt(staked, decimals)} />
        <Stat label="claimable" value={fmt(earned, decimals)} />
        <Stat label="total staked" value={fmt(total, decimals)} />
        <Stat
          label="reward rate"
          value={`${fmt(rewardRate, decimals)}/sec`}
          title="tokens paid per second, split pro-rata across all stakers"
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <input
          type="text"
          inputMode="decimal"
          placeholder="amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy || !wallet}
          style={inputStyle}
        />
        <button
          type="button"
          onClick={() => submit('stake')}
          disabled={busy || !wallet || !amount}
          style={btnPrimary}
        >
          stake
        </button>
        <button
          type="button"
          onClick={() => submit('stakingWithdraw')}
          disabled={busy || !wallet || !amount || staked === 0n}
          style={btnSecondary}
        >
          unstake
        </button>
        <button
          type="button"
          onClick={() => submit('stakingClaim')}
          disabled={busy || !wallet || earned === 0n}
          style={btnSecondary}
          title={earned === 0n ? 'nothing accrued yet' : 'claim accrued rewards without touching your stake'}
        >
          claim
        </button>
      </div>
      {!wallet && <Muted>connect a wallet to stake</Muted>}
    </div>
  );
}

// ============================================================================
// Vesting sub-panel — beneficiary-only. Release schedule + release button.
// ============================================================================

function VestingPanel({
  token,
  chainId,
  decimals,
}: {
  token: Address;
  chainId: WagmiChainId;
  decimals: number;
}) {
  const reads = useReadContracts({
    contracts: [
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingTotal', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingReleased', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingReleasable', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingCliffTimestamp', chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'vestingEndTimestamp', chainId },
    ],
    query: { staleTime: 15_000 },
  });
  const total = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const released = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;
  const releasable = (reads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const cliff = Number((reads.data?.[3]?.result as bigint | undefined) ?? 0n);
  const end = Number((reads.data?.[4]?.result as bigint | undefined) ?? 0n);
  const nowSec = useNowSec();

  const status =
    nowSec < cliff
      ? `cliff ${new Date(cliff * 1000).toLocaleDateString()}`
      : nowSec < end
        ? `linear release until ${new Date(end * 1000).toLocaleDateString()}`
        : 'fully vested';

  const { writeContract, data: txHash, isPending: writePending, reset: resetWrite } = useWriteContract();
  const { isLoading: waitPending, isSuccess: waitSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  useAutoRefetch(waitSuccess, [reads.refetch, resetWrite]);
  const busy = writePending || waitPending;

  return (
    <div style={panelStyle}>
      <SectionHeading label="vesting (your allocation)" hint={status} />
      <div style={statsGrid}>
        <Stat label="total allocation" value={fmt(total, decimals)} />
        <Stat label="already released" value={fmt(released, decimals)} />
        <Stat label="claimable now" value={fmt(releasable, decimals)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => writeContract({ abi: tokenHolderModulesAbi, address: token, functionName: 'vestingRelease', chainId })}
          disabled={busy || releasable === 0n}
          style={btnPrimary}
          title={releasable === 0n ? 'nothing has vested since your last release' : 'release the vested slice to your wallet'}
        >
          release
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Votes sub-panel — delegate voting power.
// ============================================================================

function VotesPanel({
  token,
  chainId,
  decimals,
}: {
  token: Address;
  chainId: WagmiChainId;
  decimals: number;
}) {
  const { address: wallet } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { abi: tokenHolderModulesAbi, address: token, functionName: 'getVotes', args: [wallet ?? ZERO], chainId },
      { abi: tokenHolderModulesAbi, address: token, functionName: 'delegates', args: [wallet ?? ZERO], chainId },
    ],
    query: { staleTime: 15_000 },
  });
  const votes = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const delegatee = reads.data?.[1]?.result as Address | undefined;
  const selfDelegated = !!wallet && !!delegatee && delegatee.toLowerCase() === wallet.toLowerCase();
  const nullDelegatee =
    !delegatee || delegatee === '0x0000000000000000000000000000000000000000';

  const [target, setTarget] = useState('');
  const { writeContract, data: txHash, isPending: writePending, reset: resetWrite } = useWriteContract();
  const { isLoading: waitPending, isSuccess: waitSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  useAutoRefetch(waitSuccess, [reads.refetch, resetWrite]);
  const busy = writePending || waitPending;

  function submit(delegatee_: Address) {
    writeContract({ abi: tokenHolderModulesAbi, address: token, functionName: 'delegate', args: [delegatee_], chainId });
  }

  return (
    <div style={panelStyle}>
      <SectionHeading
        label="voting power"
        hint={nullDelegatee ? 'undelegated — voting power is 0 until you delegate' : selfDelegated ? 'self-delegated' : `delegated to ${short(delegatee!)}`}
      />
      <div style={statsGrid}>
        <Stat label="your votes" value={fmt(votes, decimals)} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => wallet && submit(wallet)}
          disabled={busy || !wallet || selfDelegated}
          style={btnPrimary}
        >
          delegate to self
        </button>
        <input
          type="text"
          placeholder="0x… address to delegate to"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy || !wallet}
          style={{ ...inputStyle, minWidth: 260 }}
        />
        <button
          type="button"
          onClick={() => isAddress(target) && submit(target as Address)}
          disabled={busy || !wallet || !isAddress(target)}
          style={btnSecondary}
        >
          delegate
        </button>
      </div>
      {!wallet && <Muted>connect a wallet to delegate</Muted>}
    </div>
  );
}

// ============================================================================
// tiny local helpers — kept inline so the component ships as one file.
// ============================================================================

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function fmt(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  // Trim trailing zeros and stray dot; keep up to 4 fractional digits for readability.
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole ?? '0';
  const trimmed = frac.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : (whole ?? '0');
}

function short(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// Stable "now-in-seconds" clock that ticks every 30s. Ref-cell + effect keeps
/// the render path pure (React 19's react-hooks/purity rule forbids Date.now
/// during render). 30s cadence is a compromise — the status strings ("cliff
/// on X" / "rewards live") only need to flip once per period boundary, not
/// per-frame.
function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/// Fire a bag of side effects (usually a react-query refetch + wagmi
/// resetWrite) exactly once when `fired` flips from false to true. Prior
/// version did the flip conditionally-in-render + called setState during
/// render, which React tolerates but can loop if refetch triggers another
/// render mid-transition. This effect variant is boring + correct.
function useAutoRefetch(fired: boolean, actions: Array<() => void>) {
  useEffect(() => {
    if (!fired) return;
    for (const a of actions) a();
    // actions is a fresh array on every render; using JSON identity would
    // fire in a loop. Depending on `fired` alone is intentional — each
    // caller passes the tx confirmation flag which flips true exactly once
    // per successful write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fired]);
}

function SectionHeading({ label, hint }: { label: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <strong style={{ fontFamily: 'var(--font-round), cursive', fontSize: 15 }}>{label}</strong>
      {hint && <span style={{ color: 'var(--anchor-soft)', fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--anchor-soft)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      <span className="uru-num" style={{ fontSize: 14 }}>{value}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: 'var(--anchor-soft)', fontSize: 12 }}>{children}</p>;
}

// ---- shared inline styles ----

const panelStyle: React.CSSProperties = {
  padding: 12,
  background: 'var(--card)',
  border: '1px solid var(--anchor-soft)',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const statsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 12,
  padding: '6px 0',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--anchor-soft)',
  borderRadius: 8,
  background: 'var(--input-bg, var(--paper-white, #fff))',
  color: 'var(--anchor)',
  fontFamily: 'var(--font-body), Georgia, serif',
  fontSize: 14,
  flex: '1 1 140px',
  minWidth: 100,
};

const btnBase: React.CSSProperties = {
  padding: '8px 16px',
  border: '1px solid var(--anchor)',
  borderRadius: 8,
  background: 'var(--pink-warm)',
  color: 'var(--anchor)',
  fontFamily: 'var(--font-round), cursive',
  fontSize: 14,
  cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pink-hot)',
  color: 'var(--anchor)',
};

const btnSecondary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--mizuiro)',
};
