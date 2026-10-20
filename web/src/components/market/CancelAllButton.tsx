'use client';

/// Cancel every listing this wallet ever signed, in one transaction
/// (Seaport incrementCounter). Safety switch: use it if a wallet may be
/// compromised or you want everything off the market at once.

import { useEffect, useState } from 'react';
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { MARKET_CHAIN_ID, SEAPORT_ABI, SEAPORT_ADDRESS } from '@/lib/market';

export function CancelAllButton({ onDone }: { onDone?: () => void }) {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending, error } = useWriteContract();
  const [confirming, setConfirming] = useState(false);
  const [tx, setTx] = useState<`0x${string}` | undefined>();
  const { isLoading: waiting, isSuccess: done } = useWaitForTransactionReceipt({ hash: tx, chainId: MARKET_CHAIN_ID });
  useEffect(() => { if (done) onDone?.(); }, [done, onDone]);

  async function cancelAll() {
    if (chainId !== MARKET_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: MARKET_CHAIN_ID });
      } catch {
        return;
      }
    }
    try {
      const hash = await writeContractAsync({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'incrementCounter',
        chainId: MARKET_CHAIN_ID,
      });
      setTx(hash);
    } catch {
      // Shown via error.
    }
  }

  if (done) return <span className="ui-badge">All listings cancelled ✓</span>;
  if (!confirming) {
    return (
      <button type="button" className="ui-btn" data-size="sm" data-variant="ghost" onClick={() => setConfirming(true)}>
        Cancel all listings
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 12 }}>Cancels every listing from this wallet, here and anywhere else on Seaport.</span>
      <button type="button" className="ui-btn" data-size="sm" data-variant="primary" disabled={isPending || waiting} onClick={cancelAll}>
        {waiting ? 'Cancelling…' : isPending ? 'Confirm…' : 'Yes, cancel all'}
      </button>
      <button type="button" className="ui-btn" data-size="sm" onClick={() => setConfirming(false)}>Keep them</button>
      {error && <span className="ui-error">{error.message.split('\n')[0]}</span>}
    </span>
  );
}
