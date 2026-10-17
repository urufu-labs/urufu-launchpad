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
import ip from './info-panel.module.css';
import hm from './TokenHolderModules.module.css';

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
    <section className={ip.block}>
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
          <header className={ip.head}>
            <h3 className={ip.label}>Holder actions</h3>
            <span className={ip.sub}>Modules the deployer picked at launch</span>
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
  if (hasAntiWhale) levers.push('cap the balance per wallet and the size of each transfer');

  return (
    <div role="alert" className={hm.warn}>
      <strong className={hm.warnTitle}>The deployer still has admin control over this token</strong>
      <p className={hm.warnText}>
        The owner (<span className="ui-num">{short(owner)}</span>) can {levers.join(', ')}. Curve
        launches usually give up ownership at launch. This one didn&apos;t, so limits on your
        ability to trade or hold are possible.
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
    <div className={hm.panel}>
      <SectionHeading label="Staking" hint={periodActive ? 'Rewards are live' : 'Reward period ended'} />
      <div className={ip.stats}>
        <Stat label="Your stake" value={fmt(staked, decimals)} />
        <Stat label="Claimable" value={fmt(earned, decimals)} />
        <Stat label="Total staked" value={fmt(total, decimals)} />
        <Stat
          label="Reward rate"
          value={`${fmt(rewardRate * 86_400n, decimals)}/day`}
          title="Total tokens paid per day, split across all stakers by stake size"
        />
      </div>
      <div className={hm.actions}>
        <input
          type="text"
          inputMode="decimal"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy || !wallet}
          className={`ui-input ${hm.input}`}
          data-mono="true"
        />
        <button
          type="button"
          onClick={() => submit('stake')}
          disabled={busy || !wallet || !amount}
          className="ui-btn"
          data-variant="primary"
        >
          Stake
        </button>
        <button
          type="button"
          onClick={() => submit('stakingWithdraw')}
          disabled={busy || !wallet || !amount || staked === 0n}
          className="ui-btn"
        >
          Unstake
        </button>
        <button
          type="button"
          onClick={() => submit('stakingClaim')}
          disabled={busy || !wallet || earned === 0n}
          className="ui-btn"
          data-variant="ink"
          title={earned === 0n ? 'Nothing earned yet' : 'Claim your rewards without touching your stake'}
        >
          Claim
        </button>
      </div>
      {!wallet && <Muted>Connect a wallet to stake.</Muted>}
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
      ? `Cliff ends ${new Date(cliff * 1000).toLocaleDateString()}`
      : nowSec < end
        ? `Releasing gradually until ${new Date(end * 1000).toLocaleDateString()}`
        : 'Fully vested';

  const { writeContract, data: txHash, isPending: writePending, reset: resetWrite } = useWriteContract();
  const { isLoading: waitPending, isSuccess: waitSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  useAutoRefetch(waitSuccess, [reads.refetch, resetWrite]);
  const busy = writePending || waitPending;

  return (
    <div className={hm.panel}>
      <SectionHeading label="Vesting (your allocation)" hint={status} />
      <div className={ip.stats}>
        <Stat label="Total allocation" value={fmt(total, decimals)} />
        <Stat label="Already released" value={fmt(released, decimals)} />
        <Stat label="Claimable now" value={fmt(releasable, decimals)} />
      </div>
      <div className={hm.actions}>
        <button
          type="button"
          onClick={() => writeContract({ abi: tokenHolderModulesAbi, address: token, functionName: 'vestingRelease', chainId })}
          disabled={busy || releasable === 0n}
          className="ui-btn"
          data-variant="primary"
          title={releasable === 0n ? 'Nothing has vested since your last release' : 'Send the vested amount to your wallet'}
        >
          Release
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
    <div className={hm.panel}>
      <SectionHeading
        label="Voting power"
        hint={nullDelegatee ? 'Not delegated. Your voting power is 0 until you delegate.' : selfDelegated ? 'Delegated to yourself' : `Delegated to ${short(delegatee!)}`}
      />
      <div className={ip.stats}>
        <Stat label="Your votes" value={fmt(votes, decimals)} />
      </div>
      <div className={hm.actions}>
        <button
          type="button"
          onClick={() => wallet && submit(wallet)}
          disabled={busy || !wallet || selfDelegated}
          className="ui-btn"
          data-variant="primary"
        >
          Delegate to myself
        </button>
        <input
          type="text"
          placeholder="0x… address to delegate to"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy || !wallet}
          className={`ui-input ${hm.inputWide}`}
          data-mono="true"
        />
        <button
          type="button"
          onClick={() => isAddress(target) && submit(target as Address)}
          disabled={busy || !wallet || !isAddress(target)}
          className="ui-btn"
          data-variant="ink"
        >
          Delegate
        </button>
      </div>
      {!wallet && <Muted>Connect a wallet to delegate.</Muted>}
    </div>
  );
}

// ============================================================================
// tiny local helpers — kept inline so the component ships as one file.
// ============================================================================

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function fmt(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole ?? '0';
  // Adaptive precision: when the whole part is 0, extend the fractional
  // window past leading zeros so tiny amounts (staking earned in wei-scale,
  // reward-rate-per-sec, etc.) don't display as flat "0". Cap at 12 to
  // keep readability sane.
  const wholeIsZero = !whole || whole === '0';
  let maxFrac = 4;
  if (wholeIsZero) {
    const leadingZeros = frac.match(/^0+/)?.[0].length ?? 0;
    maxFrac = Math.min(12, leadingZeros + 4);
  }
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  return trimmed ? `${whole || '0'}.${trimmed}` : (whole ?? '0');
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
    <div className={hm.panelHead}>
      <strong className={hm.panelTitle}>{label}</strong>
      {hint && <span className={ip.sub}>{hint}</span>}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} className={ip.stat}>
      <span className={ip.statLabel}>{label}</span>
      <span className={ip.statValue}>{value}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className={ip.muted}>{children}</p>;
}
