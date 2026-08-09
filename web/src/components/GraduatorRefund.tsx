'use client';

/// Launcher pull-refund panel — surfaces ETH credited to the connected wallet
/// on GraduatorV2 after any of their graduations. The V9 rehearsal proved
/// that even with raw-ratio pricing, every graduation leaves rounding dust
/// (verified live: 3,692,110,352,142 wei per 0.001-ETH graduation). Without
/// this panel launchers accumulate dust in the graduator forever.
///
/// Access model (matches contract): `claimableRefunds[msg.sender]` is
/// launcher-specific — anyone can call `claimRefund()` on themselves but
/// they only get their own credit. `claimRefundTo(recipient)` lets a Safe
/// or contract-wallet launcher route the pull to a recipient that can
/// actually receive ETH.
///
/// Only renders when `visibleFor` equals the connected wallet (self view)
/// AND the wallet has a non-zero credit — a stranger's profile never leaks
/// "this wallet has X ETH pending", and self-viewers with a zero balance
/// don't see a decorative empty card.

import { useMemo, useState } from 'react';
import { formatEther, isAddress, type Address } from 'viem';
import {
  useAccount,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { graduatorAbi } from '@/lib/abis';
import { GRADUATORS, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID, type WagmiChainId } from '@/lib/wagmi';

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

export function GraduatorRefund({ visibleFor, chain }: Props) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const isSelf = wallet?.toLowerCase() === visibleFor.toLowerCase();
  const targetChainId = CHAIN_KEY_TO_ID[chain] as WagmiChainId;
  const graduatorAddr = GRADUATORS[chain];

  const refund = useReadContract({
    abi: graduatorAbi,
    address: graduatorAddr ?? undefined,
    functionName: 'claimableRefunds',
    args: wallet ? [wallet] : undefined,
    chainId: targetChainId,
    query: {
      enabled: isSelf && !!graduatorAddr && !!wallet,
      staleTime: 15_000,
    },
  });
  const claimable = (refund.data as bigint | undefined) ?? 0n;

  const [routeTo, setRouteTo] = useState('');
  const [routeMode, setRouteMode] = useState<'self' | 'to'>('self');
  const {
    writeContract,
    data: txHash,
    isPending: writePending,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: waitPending, isSuccess: waitSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const onTargetChain = walletChainId === targetChainId;

  const busy = writePending || waitPending;

  // Auto-refetch balance after the tx confirms so the row zeros out live.
  const seenSuccess = useMemo(() => waitSuccess, [waitSuccess]);
  if (seenSuccess && !refund.isFetching) {
    void refund.refetch();
    resetWrite();
  }

  if (!isSelf || !graduatorAddr || refund.isPending || claimable === 0n) {
    return null;
  }

  async function submit() {
    if (!graduatorAddr) return;
    if (!onTargetChain) {
      try {
        await switchChainAsync({ chainId: targetChainId });
      } catch {
        return;
      }
    }
    if (routeMode === 'to') {
      if (!isAddress(routeTo)) return;
      writeContract({
        abi: graduatorAbi,
        address: graduatorAddr,
        functionName: 'claimRefundTo',
        args: [routeTo as Address],
        chainId: targetChainId,
      });
    } else {
      writeContract({
        abi: graduatorAbi,
        address: graduatorAddr,
        functionName: 'claimRefund',
        chainId: targetChainId,
      });
    }
  }

  return (
    <section
      className="uru-shell"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 18 }}>✿</span>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 18 }}>
          graduation refund
        </h3>
        <span style={{ color: 'var(--anchor-soft)', fontSize: 12 }}>
          LP-add dust credited to you from a token you launched
        </span>
      </header>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--anchor-soft)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          claimable
        </span>
        <span className="uru-num" style={{ fontSize: 20, fontWeight: 700 }}>
          {formatEther(claimable)} ETH
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {(['self', 'to'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setRouteMode(m)}
            className="uru-btn"
            style={{
              flex: 1,
              justifyContent: 'center',
              fontSize: 11,
              padding: '5px 8px',
              background: routeMode === m ? 'var(--pink-hot)' : 'var(--cream-deep)',
              color: routeMode === m ? 'var(--cream)' : 'var(--anchor)',
              borderColor: 'var(--anchor)',
            }}
          >
            {m === 'self' ? 'to my wallet' : 'to another address'}
          </button>
        ))}
      </div>

      {routeMode === 'to' && (
        <input
          type="text"
          placeholder="0x… recipient"
          value={routeTo}
          onChange={(e) => setRouteTo(e.target.value)}
          disabled={busy}
          className="uru-input"
          style={{ width: '100%', fontFamily: 'var(--font-pixel), monospace' }}
          title="use this for Safe / contract-wallet launchers that can't receive ETH directly"
        />
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy || switchPending || (routeMode === 'to' && !isAddress(routeTo))}
        className="uru-btn uru-btn-primary"
        style={{ width: '100%', justifyContent: 'center' }}
      >
        {switchPending
          ? `switch to ${chain} ~`
          : writePending
            ? 'confirming ~~'
            : waitPending
              ? 'waiting..'
              : !onTargetChain
                ? `claim on ${chain} (switch chain)`
                : routeMode === 'to'
                  ? `claim to ${routeTo ? routeTo.slice(0, 6) + '…' : '…'}`
                  : 'claim to my wallet'}
      </button>

      <p style={{ margin: 0, fontSize: 11, color: 'var(--anchor-soft)' }}>
        rounding dust from LP addition — every graduation leaves a small residual that
        gets credited here. safe to skip; nothing bad happens if you never claim ~
      </p>
    </section>
  );
}
