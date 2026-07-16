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
      const forChain = (launches ?? []).filter((l) => l.chainId === targetChainId);
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
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">✿ creator earnings</div>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          創作者
        </span>
      </div>

      {!ready && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          checking your launches...
        </div>
      )}

      {ready && rows.length === 0 && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)', lineHeight: 1.5 }}>
          no launches yet ~~ launch a token and earn creator fees on every swap after it graduates.
        </div>
      )}

      {ready && rows.length > 0 && (
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
            <span style={{ fontWeight: 700, color: totalOwed > 0n ? 'var(--mint-hot)' : 'var(--anchor)' }}>
              {Number(formatEther(totalOwed)).toFixed(6)}Ξ
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {rows.map((r) => (
              <li
                key={r.hookAddress}
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
                  hook <b style={{ color: 'var(--anchor)' }}>{r.hookAddress.slice(0, 6)}…{r.hookAddress.slice(-4)}</b>
                </span>
                <span>
                  {Number(formatEther(r.owed)).toFixed(6)}Ξ
                </span>
                {r.owed === 0n ? (
                  <span style={{ color: 'var(--anchor-soft)', fontSize: 10 }}>—</span>
                ) : (
                  <button
                    type="button"
                    className="uru-chip"
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
                    style={{ padding: '2px 8px', fontSize: 10 }}
                    title={walletOnTargetChain ? 'claim your ETH' : 'click to switch chain + claim'}
                  >
                    {pendingHook === r.hookAddress && (isSubmitting || isMining)
                      ? 'claiming...'
                      : walletOnTargetChain
                        ? 'claim'
                        : 'switch → claim'}
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
