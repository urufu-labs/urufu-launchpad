'use client';

/// Cancel one of your listings on-chain (Seaport cancel). A signed listing
/// stays fillable by anyone holding the signature until it's cancelled on
/// Seaport or expires, so cancelling is a transaction, not just a delete.

import { useEffect, useState } from 'react';
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { MARKET_CHAIN_ID, SEAPORT_ABI, SEAPORT_ADDRESS, cancelArgs, type MarketListing } from '@/lib/market';

export function CancelButton({ listing, onDone }: { listing: MarketListing; onDone?: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending, error } = useWriteContract();
  const [tx, setTx] = useState<`0x${string}` | undefined>();
  const { isLoading: waiting, isSuccess: done } = useWaitForTransactionReceipt({ hash: tx, chainId: MARKET_CHAIN_ID });
  useEffect(() => { if (done) onDone?.(); }, [done, onDone]);

  if (!address || address.toLowerCase() !== listing.seller.toLowerCase()) return null;

  async function cancel() {
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
        functionName: 'cancel',
        args: cancelArgs(listing),
        chainId: MARKET_CHAIN_ID,
      });
      setTx(hash);
    } catch {
      // Shown via error.
    }
  }

  return (
    <span>
      <button type="button" className="ui-btn" data-size="sm" disabled={isPending || waiting || done} onClick={cancel}>
        {done ? 'Cancelled ✓' : waiting ? 'Cancelling…' : isPending ? 'Confirm…' : 'Cancel'}
      </button>
      {error && <span className="ui-error"> {error.message.split('\n')[0]}</span>}
    </span>
  );
}
