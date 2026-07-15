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
import { formatEther, type Address } from 'viem';
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { nftRevenueVaultAbi } from '@/lib/abis';
import { FLYWHEEL, type ChainKey } from '@/lib/config';
import { fetchEpochsForHolder, fetchVaultSummary, type EpochAllocation, type VaultSummary } from '@/lib/rewardsApi';

interface Props {
  /// Wallet the profile is rendering for. Rewards only surface when this matches
  /// the currently-connected wallet (self view).
  visibleFor: Address;
  /// Which chain to query. Currently only 'base' has a flywheel deploy; we skip
  /// entirely for other chains.
  chain: ChainKey;
}

export function FlywheelRewards({ visibleFor, chain }: Props) {
  const { address: wallet } = useAccount();
  const isSelf = wallet?.toLowerCase() === visibleFor.toLowerCase();

  const vaultAddress = FLYWHEEL[chain]?.NftRevenueVault ?? null;
  const shouldRender = chain === 'base' && isSelf && vaultAddress !== null;

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
        fetchVaultSummary('base'),
        fetchEpochsForHolder('base', visibleFor),
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
  // returned in the same order.
  const claimedReads = useReadContracts({
    contracts: vaultAddress
      ? epochs.map((e) => ({
          abi: nftRevenueVaultAbi,
          address: vaultAddress,
          functionName: 'isClaimed' as const,
          args: [BigInt(e.epochId), visibleFor] as const,
        }))
      : [],
    query: { enabled: epochs.length > 0 && !!vaultAddress },
  });

  const rows = useMemo(() => {
    return epochs.map((e, i) => {
      const claimed = (claimedReads.data?.[i]?.result as boolean | undefined) ?? false;
      return { ...e, claimed };
    });
  }, [epochs, claimedReads.data]);

  const unclaimedTotal = useMemo(
    () => rows.filter((r) => !r.claimed).reduce((sum, r) => sum + BigInt(r.amount), 0n),
    [rows],
  );

  // --- claim tx handling ------------------------------------------------
  const { writeContract, data: claimTxHash, isPending: isSubmitting, reset } = useWriteContract();
  const { isLoading: isMining, isSuccess: isMined } = useWaitForTransactionReceipt({ hash: claimTxHash });
  const [pendingEpoch, setPendingEpoch] = useState<number | null>(null);

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
        <div className="uru-eyebrow">❋ flywheel rewards</div>
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
            <> vault is <b>{Number(formatEther(BigInt(summary.vaultBalance))).toFixed(4)}Ξ</b> and waiting for the first drop.</>
          )}
          {summary && summary.publishedEpochs > 0 && (
            <> hold a gemu nft during the next snapshot to be eligible.</>
          )}
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
                ) : (
                  <button
                    type="button"
                    className="uru-chip"
                    disabled={isSubmitting || isMining || !vaultAddress}
                    onClick={() => {
                      if (!vaultAddress) return;
                      setPendingEpoch(r.epochId);
                      writeContract({
                        abi: nftRevenueVaultAbi,
                        address: vaultAddress,
                        functionName: 'claim',
                        args: [BigInt(r.epochId), BigInt(r.amount), r.proof],
                      });
                    }}
                    style={{ padding: '2px 8px', fontSize: 10 }}
                  >
                    {pendingEpoch === r.epochId && (isSubmitting || isMining) ? 'claiming...' : 'claim'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
