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
import card from './profile-card.module.css';

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
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Graduation refund</h2>
        <span className={card.aside}>Leftover ETH from a token you launched</span>
      </div>

      <div className={card.body}>
        <div className={card.kv}>
          <span className={card.kvKey}>Claimable</span>
          <span className={card.totalValue}>
            {formatEther(claimable)} ETH
          </span>
        </div>

        <div className="ui-seg" data-block="true">
          {(['self', 'to'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setRouteMode(m)}
              aria-pressed={routeMode === m}
            >
              {m === 'self' ? 'To my wallet' : 'To another address'}
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
            className="ui-input"
            data-mono="true"
            title="Use this for Safe or contract wallets that can't receive ETH directly"
          />
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || switchPending || (routeMode === 'to' && !isAddress(routeTo))}
          className="ui-btn"
          data-variant="primary"
          data-block="true"
        >
          {switchPending
            ? `Switching to ${chain}…`
            : writePending
              ? 'Confirm in your wallet…'
              : waitPending
                ? 'Waiting for confirmation…'
                : !onTargetChain
                  ? `Claim on ${chain} (switches chain)`
                  : routeMode === 'to'
                    ? `Claim to ${routeTo ? routeTo.slice(0, 6) + '…' : '…'}`
                    : 'Claim to my wallet'}
        </button>

        <p className={card.muted}>
          Adding liquidity at graduation always leaves a little rounding dust, and it gets
          credited here. It&apos;s safe to skip. Nothing bad happens if you never claim it.
        </p>
      </div>
    </section>
  );
}
