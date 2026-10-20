'use client';

/// Creator earnings section for the profile page — surfaces the wallet's
/// unclaimed post-graduation v4 swap-fee revenue across every launched-token pool
/// they're the recorded creator of. Reads on-chain `MultiHookHost.owed(0x0, wallet)`
/// per distinct hook the wallet has launched into.
///
/// Data sources:
///   1. Indexer `launchesByCreator` → tokens this wallet launched
///   2. Indexer `graduations` join → distinct hook addresses those tokens live on
///      (both V1 legacy + V2 per-launcher hooks show up automatically after redeploy)
///   3. On-chain `hook.owed(ETH, wallet)` per distinct hook via wagmi
///   4. On-chain `hook.claim(ETH)` for the button — pulls the full owed balance out
///      to the wallet in one tx (msg.sender authenticated on-chain).
///
/// Renders nothing unless `visibleFor === connected wallet` — earnings are personal
/// and would leak wallet balances if displayed on another wallet's public profile.
///
/// Rows appear per hook, not per token: `owed[currency][recipient]` in the hook is
/// a summed accumulator across ALL pools where this address is the creator, so we
/// only need one read + one claim per hook contract, not per token.

import { useEffect, useMemo, useState } from 'react';
import { formatEther, type Address } from 'viem';
import {
  useAccount,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { multiHookHostAbi } from '@/lib/abis';
import { HOOKS, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchGraduationForToken, fetchLaunchesByCreator } from '@/lib/indexer';
import card from './profile-card.module.css';

interface Props {
  /// Wallet the profile is rendering for. Widget stays hidden unless this matches
  /// the connected wallet — earnings are personal.
  visibleFor: Address;
  /// Chain the profile page is currently scoped to (from the header switcher).
  chain: ChainKey;
}

interface HookRow {
  hookAddress: Address;
  owed: bigint;
  /// Non-null only when the wallet is currently on `chain` and this row's balance
  /// is non-zero — that's when the claim button becomes actionable.
  chainId: number;
}

export function CreatorEarnings({ visibleFor, chain }: Props) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const isSelf = wallet?.toLowerCase() === visibleFor.toLowerCase();

  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const walletOnTargetChain = walletChainId === targetChainId;
  const configHook = HOOKS[chain]?.MultiHookHost as Address | undefined;

  // Union of hook addresses to probe: the current chain's config hook (V2 after
  // redeploy) + every distinct hook we've seen this wallet's launches graduate
  // against (catches V1 legacy earnings that would otherwise be invisible in the
  // widget after we cut over to V2).
  const [hookAddresses, setHookAddresses] = useState<Address[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isSelf) return;
    let cancelled = false;
    (async () => {
      const launches = await fetchLaunchesByCreator(visibleFor, 100);
      if (cancelled) return;
      // Fair launch fees live on FairHookHost and are claimed from the token's trade
      // page (FairLaunchPanels), not through the MultiHookHost reads below.
      const forChain = (launches ?? []).filter((l) => l.chainId === targetChainId && l.lane !== 'fair');
      // Resolve each launched token's graduation → hookAddress. Ungraduated tokens
      // return null and are dropped. Fan out in parallel so a wallet with lots of
      // launches doesn't wait N * indexer-round-trip.
      const graduations = await Promise.all(
        forChain.map((l) => fetchGraduationForToken(l.tokenAddress)),
      );
      if (cancelled) return;
      const set = new Set<string>();
      if (configHook) set.add(configHook.toLowerCase());
      for (const g of graduations) {
        if (g?.hookAddress) set.add(g.hookAddress.toLowerCase());
      }
      setHookAddresses(Array.from(set).map((s) => s as Address));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [isSelf, visibleFor, targetChainId, configHook]);

  const ETH_CURRENCY = '0x0000000000000000000000000000000000000000' as Address;

  const owedReads = useReadContracts({
    contracts: hookAddresses.map((h) => ({
      abi: multiHookHostAbi,
      address: h,
      functionName: 'owed' as const,
      args: [ETH_CURRENCY, visibleFor] as const,
      chainId: targetChainId,
    })),
    query: { enabled: hookAddresses.length > 0, refetchInterval: 20_000 },
  });

  const rows: HookRow[] = useMemo(() => {
    return hookAddresses.map((h, i) => ({
      hookAddress: h,
      owed: (owedReads.data?.[i]?.result as bigint | undefined) ?? 0n,
      chainId: targetChainId,
    }));
  }, [hookAddresses, owedReads.data, targetChainId]);

  const totalOwed = useMemo(
    () => rows.reduce((sum, r) => sum + r.owed, 0n),
    [rows],
  );

  // ---- claim tx handling -----------------------------------------------------
  const { writeContract, data: claimTxHash, isPending: isSubmitting, reset } = useWriteContract();
  const { isLoading: isMining, isSuccess: isMined } = useWaitForTransactionReceipt({
    hash: claimTxHash,
    chainId: targetChainId,
  });
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const [pendingHook, setPendingHook] = useState<Address | null>(null);

  useEffect(() => {
    if (isMined) {
      // The tx confirmed — repull owed[] so the row zeroes out for this hook. A
      // successful claim empties `owed[currency][msg.sender]` on-chain, so this
      // refetch is what flips the button to disabled + zeroes the total.
      setPendingHook(null);
      owedReads.refetch();
      reset();
    }
  }, [isMined, owedReads, reset]);

  if (!isSelf) return null;

  return (
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Creator earnings</h2>
        <span className={card.aside}>Fees from your graduated tokens</span>
      </div>

      {!ready && (
        <div className={card.body}>
          <p className={card.empty}>Checking your launches…</p>
        </div>
      )}

      {ready && rows.length === 0 && (
        <div className={card.body}>
          <p className={card.empty}>
            No launches yet. Launch a token and earn creator fees on every swap after it graduates.
          </p>
        </div>
      )}

      {ready && rows.length > 0 && (
        <>
          <div className={card.total}>
            <span className={card.totalLabel}>Unclaimed</span>
            <span className={card.totalValue} data-positive={totalOwed > 0n}>
              {Number(formatEther(totalOwed)).toFixed(6)} ETH
            </span>
          </div>
          <div className={card.tableWrap}>
            <table className={card.table}>
              <thead>
                <tr>
                  <th>Pool hook</th>
                  <th data-align="right">Owed</th>
                  <th data-align="right"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.hookAddress}>
                    <td className={card.num}>{r.hookAddress.slice(0, 6)}…{r.hookAddress.slice(-4)}</td>
                    <td className={card.num} data-align="right">
                      {Number(formatEther(r.owed)).toFixed(6)} ETH
                    </td>
                    <td data-align="right">
                      {r.owed === 0n ? (
                        <span className={card.faint}>Nothing to claim</span>
                      ) : (
                        <button
                          type="button"
                          className="ui-btn"
                          data-variant="primary"
                          data-size="sm"
                          disabled={isSubmitting || isMining || switchPending}
                          onClick={() => {
                            // Prompt a chain switch first so writeContract doesn't submit
                            // against the wrong RPC + revert against a nonexistent hook.
                            if (!walletOnTargetChain) {
                              switchChain({ chainId: targetChainId });
                              return;
                            }
                            setPendingHook(r.hookAddress);
                            writeContract({
                              abi: multiHookHostAbi,
                              address: r.hookAddress,
                              functionName: 'claim',
                              args: [ETH_CURRENCY],
                              chainId: targetChainId,
                            });
                          }}
                          title={walletOnTargetChain ? 'Claim your ETH' : 'Switch chain first, then claim'}
                        >
                          {pendingHook === r.hookAddress && (isSubmitting || isMining)
                            ? 'Claiming…'
                            : walletOnTargetChain
                              ? 'Claim'
                              : 'Switch chain'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
