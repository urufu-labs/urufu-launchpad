'use client';

/// Flywheel rewards section for the profile page. Shows the connected wallet's
/// per-epoch claim state against the on-chain `NftRevenueVault` (Base only for
/// now — gemu NFT holders get ETH from the 35% fee slice via Merkle drops).
///
/// Data sources:
///   1. compile-service `/rewards/base/vault-summary`  → header numbers
///   2. compile-service `/rewards/base/epochs/:addr`   → all allocations for wallet
///   3. on-chain `vault.isClaimed(epochId, wallet)`    → dedupe already-claimed
///   4. on-chain `vault.claim(epochId, amount, proof)` → claim button
///
/// Only renders anything when `visibleFor` (the profile owner) === the connected
/// wallet. Rewards are personal — showing another wallet's claim state on a public
/// page would just leak balances without giving that user any action to take.

import { useEffect, useMemo, useState } from 'react';
import { formatEther, type Address, type Hex } from 'viem';
import { useAccount, useReadContracts, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { nftRevenueVaultAbi } from '@/lib/abis';
import { FLYWHEEL, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchEpochsForHolder, fetchVaultSummary, type EpochAllocation, type VaultSummary } from '@/lib/rewardsApi';

interface Props {
  /// Wallet the profile is rendering for. Rewards only surface when this matches
  /// the currently-connected wallet (self view).
  visibleFor: Address;
  /// Kept for API compatibility — no longer influences render. The section always
  /// queries Robinhood (urufu gemu NFT is Robinhood-only post-migration),
  /// regardless of what chain the user's wallet is currently on. Claim button
  /// prompts a wallet switch to Robinhood if the wallet is elsewhere.
  chain?: ChainKey;
}

const REWARDS_CHAIN: ChainKey = 'robinhood';
const REWARDS_CHAIN_ID = CHAIN_KEY_TO_ID[REWARDS_CHAIN];

/// Short "unlocks in Xh Ym" / "unlocks in Xm" / "unlocks now" label from a
/// unix timestamp (seconds). Rendered inline instead of the claim button when
/// an epoch's tree exists off-chain but on-chain activation is still pending.
function _relativeUnlock(unixSec: number): string {
  const delta = unixSec - Math.floor(Date.now() / 1000);
  if (delta <= 0) return 'unlocks now';
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h >= 24) return 'unlocks in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  if (h > 0) return 'unlocks in ' + h + 'h ' + m + 'm';
  return 'unlocks in ' + m + 'm';
}

export function FlywheelRewards({ visibleFor }: Props) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const isSelf = wallet?.toLowerCase() === visibleFor.toLowerCase();

  const vaultAddress = FLYWHEEL[REWARDS_CHAIN]?.NftRevenueVault ?? null;
  const shouldRender = isSelf && vaultAddress !== null;

  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [epochs, setEpochs] = useState<EpochAllocation[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Fetch vault header + wallet's allocations. Refreshed on address change or
  // after a successful claim (via `refreshTick`).
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    (async () => {
      const [s, e] = await Promise.all([
        fetchVaultSummary('robinhood'),
        fetchEpochsForHolder('robinhood', visibleFor),
      ]);
      if (cancelled) return;
      setSummary(s);
      setEpochs(e);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldRender, visibleFor, refreshTick]);

  // Batch-check on-chain `isClaimed` for each epoch the wallet has an allocation
  // in. useReadContracts fans one RPC round-trip → an isClaimed call per epoch;
  // returned in the same order. Force `chainId` to Base so reads work even when
  // the wallet is currently on a different chain (base-sepolia, etc.).
  const claimedReads = useReadContracts({
    contracts: vaultAddress
      ? epochs.map((e) => ({
          abi: nftRevenueVaultAbi,
          address: vaultAddress,
          functionName: 'isClaimed' as const,
          args: [BigInt(e.epochId), visibleFor] as const,
          chainId: REWARDS_CHAIN_ID,
        }))
      : [],
    query: { enabled: epochs.length > 0 && !!vaultAddress },
  });

  // The compile-service happily returns proofs for epochs whose tree it has,
  // even if the corresponding on-chain epoch is still pending (not yet
  // activated). Reading `nextEpochId` from the vault tells us the highest
  // activated index — any epochId >= nextEpochId is un-claimable (would
  // revert with EpochUnknown), so we gate the claim button on it.
  const vaultReads = useReadContracts({
    contracts: vaultAddress
      ? [
          {
            abi: nftRevenueVaultAbi,
            address: vaultAddress,
            functionName: 'nextEpochId' as const,
            chainId: REWARDS_CHAIN_ID,
          },
          {
            abi: nftRevenueVaultAbi,
            address: vaultAddress,
            functionName: 'pendingEpoch' as const,
            chainId: REWARDS_CHAIN_ID,
          },
        ]
      : [],
    query: { enabled: !!vaultAddress },
  });
  const nextEpochId = (vaultReads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const pendingEpochTuple = vaultReads.data?.[1]?.result as
    | readonly [bigint, `0x${string}`, bigint, bigint]
    | undefined;
  const pendingReadyAtSec = pendingEpochTuple ? Number(pendingEpochTuple[3]) : 0;

  const rows = useMemo(() => {
    return epochs.map((e, i) => {
      const claimed = (claimedReads.data?.[i]?.result as boolean | undefined) ?? false;
      const activated = BigInt(e.epochId) < nextEpochId;
      const isPending = !activated && pendingEpochTuple && Number(pendingEpochTuple[0]) === e.epochId;
      return { ...e, claimed, activated, isPending };
    });
  }, [epochs, claimedReads.data, nextEpochId, pendingEpochTuple]);

  const unclaimedTotal = useMemo(
    () => rows.filter((r) => !r.claimed && r.activated).reduce((sum, r) => sum + BigInt(r.amount), 0n),
    [rows],
  );

  // --- claim tx handling ------------------------------------------------
  const {
    writeContract,
    data: claimTxHash,
    isPending: isSubmitting,
    error: writeError,
    reset,
  } = useWriteContract();
  const { isLoading: isMining, isSuccess: isMined, error: mineError } = useWaitForTransactionReceipt({
    hash: claimTxHash,
    chainId: REWARDS_CHAIN_ID,
  });
  const { switchChain, error: switchError, isPending: isSwitching } = useSwitchChain();
  const [pendingEpoch, setPendingEpoch] = useState<number | null>(null);
  // Set when the user clicks claim while on the wrong chain — after the switch
  // succeeds we auto-fire the writeContract so the user doesn't have to click
  // twice. Legacy behavior required two clicks (switch, then claim) and users
  // consistently missed the second click.
  const [autoClaimAfterSwitch, setAutoClaimAfterSwitch] = useState<{
    epochId: number;
    amount: string;
    proof: readonly Hex[];
  } | null>(null);
  const walletOnRewardsChain = walletChainId === REWARDS_CHAIN_ID;

  // Fire the queued claim once the chain switch completes.
  useEffect(() => {
    if (!autoClaimAfterSwitch || !walletOnRewardsChain || !vaultAddress) return;
    const q = autoClaimAfterSwitch;
    setAutoClaimAfterSwitch(null);
    setPendingEpoch(q.epochId);
    writeContract({
      abi: nftRevenueVaultAbi,
      address: vaultAddress,
      functionName: 'claim',
      args: [BigInt(q.epochId), BigInt(q.amount), q.proof],
      chainId: REWARDS_CHAIN_ID,
    });
  }, [autoClaimAfterSwitch, walletOnRewardsChain, vaultAddress, writeContract]);

  useEffect(() => {
    if (isMined) {
      // Refresh both on-chain isClaimed reads and off-chain summary. The API
      // doesn't need a refetch since proofs don't change, but the vault-summary
      // publishedEpochs count might have moved if another epoch dropped mid-flow.
      setPendingEpoch(null);
      setRefreshTick((n) => n + 1);
      claimedReads.refetch();
      reset();
    }
  }, [isMined, claimedReads, reset]);

  if (!shouldRender) return null;

  return (
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">gemu holder rewards</div>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          報酬
        </span>
      </div>

      {!loaded && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          checking eligibility...
        </div>
      )}

      {loaded && rows.length === 0 && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)', lineHeight: 1.5 }}>
          no epochs yet ~~
          {summary && summary.publishedEpochs === 0 && (
            <> rewards pool balance is <b>{Number(formatEther(BigInt(summary.vaultBalance))).toFixed(4)}Ξ</b> and waiting for the first distribution.</>
          )}
          {summary && summary.publishedEpochs > 0 && (
            <> hold a gemu pass during the next snapshot to be eligible.</>
          )}
        </div>
      )}

      {loaded && rows.length > 0 && rows.every((r) => !r.activated) && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)', lineHeight: 1.5, marginBottom: 6 }}>
          your allocation is pending — claim unlocks after the epoch's timelock activates on-chain.
        </div>
      )}

      {loaded && rows.length > 0 && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '4px 0',
              borderBottom: '1px dashed var(--cream-shadow)',
              marginBottom: 6,
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10.5,
            }}
          >
            <span style={{ color: 'var(--anchor-soft)' }}>unclaimed</span>
            <span style={{ fontWeight: 700, color: unclaimedTotal > 0n ? 'var(--mint-hot)' : 'var(--anchor)' }}>
              {Number(formatEther(unclaimedTotal)).toFixed(5)}Ξ
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {rows.map((r) => (
              <li
                key={r.epochId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  borderBottom: '1px dashed var(--cream-shadow)',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10.5,
                }}
              >
                <span style={{ color: 'var(--anchor-soft)' }}>
                  epoch <b style={{ color: 'var(--anchor)' }}>#{r.epochId}</b>
                </span>
                <span>
                  {Number(formatEther(BigInt(r.amount))).toFixed(5)}Ξ
                </span>
                {r.claimed ? (
                  <span style={{ color: 'var(--anchor-soft)', fontSize: 10 }}>✓ claimed</span>
                ) : !r.activated ? (
                  <span
                    style={{ color: 'var(--anchor-soft)', fontSize: 10 }}
                    title={
                      r.isPending && pendingReadyAtSec > 0
                        ? 'unlocks ' + new Date(pendingReadyAtSec * 1000).toLocaleString()
                        : 'epoch not yet published'
                    }
                  >
                    {r.isPending && pendingReadyAtSec > 0
                      ? _relativeUnlock(pendingReadyAtSec)
                      : 'unpublished'}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="uru-chip"
                    disabled={isSubmitting || isMining || isSwitching || !vaultAddress}
                    onClick={() => {
                      if (!vaultAddress) return;
                      // Prompt a chain switch first if the wallet isn't on
                      // Robinhood — wagmi's writeContract would otherwise
                      // submit the tx on the wrong chain and revert against
                      // a nonexistent contract. Queue the claim so it auto-
                      // fires once the switch completes (see effect above).
                      if (!walletOnRewardsChain) {
                        setAutoClaimAfterSwitch({
                          epochId: r.epochId,
                          amount: r.amount,
                          proof: r.proof,
                        });
                        switchChain({ chainId: REWARDS_CHAIN_ID });
                        return;
                      }
                      setPendingEpoch(r.epochId);
                      writeContract({
                        abi: nftRevenueVaultAbi,
                        address: vaultAddress,
                        functionName: 'claim',
                        args: [BigInt(r.epochId), BigInt(r.amount), r.proof],
                        chainId: REWARDS_CHAIN_ID,
                      });
                    }}
                    style={{ padding: '2px 8px', fontSize: 10 }}
                    title={walletOnRewardsChain ? 'claim your share' : 'click to switch to Robinhood + claim'}
                  >
                    {isSwitching
                      ? 'switching…'
                      : pendingEpoch === r.epochId && (isSubmitting || isMining)
                        ? 'claiming...'
                        : walletOnRewardsChain
                          ? 'claim'
                          : 'switch → claim'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(writeError || switchError || mineError) && (
            <div
              style={{
                marginTop: 6,
                padding: '4px 6px',
                borderRadius: 4,
                background: 'rgba(200,0,0,0.08)',
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 10,
                color: '#a11',
                lineHeight: 1.4,
                wordBreak: 'break-word',
              }}
            >
              {switchError && <>chain switch failed: {switchError.message}</>}
              {writeError && <>claim tx failed to submit: {writeError.message}</>}
              {mineError && <>claim tx reverted on-chain: {mineError.message}</>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
