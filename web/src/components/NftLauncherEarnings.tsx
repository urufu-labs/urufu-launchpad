'use client';

/// NFT-launcher earnings for the profile page. Twin of CreatorEarnings, but
/// for the pull-based NftMintModule payouts instead of the v4 pool royalties.
///
/// Data sources per collection this wallet launched on `chain`:
///   1. Indexer `nftCollectionss` filtered by launchedBy → collection addresses
///   2. On-chain owner() on each ERC-721 → mint module address
///   3. On-chain paymentToken() on the mint module → ETH mode (0x0) vs URU mode
///   4. On-chain launcherBalance() / launcherBalanceUru() → accrued 90% owed
///   5. On-chain withdraw() / withdrawUru() for the claim button
///
/// Renders nothing unless viewing your own profile — see isVisibleForViewer.

import { useEffect, useMemo, useState } from 'react';
import { formatEther, formatUnits, zeroAddress, type Address } from 'viem';
import {
  useAccount,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { nftMintModuleAbi } from '@/lib/abis';
import type { ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchNftCollectionsByLauncher } from '@/lib/indexer';
import {
  buildRows,
  claimButtonState,
  isVisibleForViewer,
  rowKey,
  totalFor,
  type CollectionRow,
} from './NftLauncherEarnings.logic';

// Solady Ownable — the NftLaunchFactory transfers the ERC-721 clone's
// ownership to the mint module at launch, so `owner()` on the ERC-721 IS
// the mint module. Kept inline to match /collection/[address]'s pattern
// rather than pulling in Solady's full ABI just for one call.
const soladyOwnerAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

interface Props {
  visibleFor: Address;
  chain: ChainKey;
}

export function NftLauncherEarnings({ visibleFor, chain }: Props) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const isSelf = isVisibleForViewer(visibleFor, wallet);
  const targetChainId = CHAIN_KEY_TO_ID[chain];

  const [collections, setCollections] = useState<Array<{ collectionAddress: Address; name: string }>>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isSelf) return;
    let cancelled = false;
    (async () => {
      const raw = await fetchNftCollectionsByLauncher(visibleFor, 100);
      if (cancelled) return;
      const forChain = (raw ?? []).filter((r) => r.chainId === targetChainId);
      setCollections(
        forChain.map((r) => ({ collectionAddress: r.collectionAddress, name: r.name })),
      );
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [isSelf, visibleFor, targetChainId]);

  // Resolve mint-module address per collection: it's owner() on the ERC-721.
  // Batched so a launcher with 20 collections is one round-trip, not 20.
  const ownerReads = useReadContracts({
    contracts: collections.map((c) => ({
      abi: soladyOwnerAbi,
      address: c.collectionAddress,
      functionName: 'owner' as const,
      chainId: targetChainId,
    })),
    query: { enabled: collections.length > 0, refetchInterval: 30_000 },
  });

  const mintModules = useMemo(() => {
    return collections.map((c, i) => ({
      collectionAddress: c.collectionAddress,
      name: c.name,
      mintModule: (ownerReads.data?.[i]?.result as Address | undefined) ?? zeroAddress,
    }));
  }, [collections, ownerReads.data]);

  const withModule = mintModules.filter((m) => m.mintModule !== zeroAddress);

  // Batch three reads per mint module: paymentToken, launcherBalance (ETH slot),
  // launcherBalanceUru (URU slot). We always read both balance slots even though
  // a collection only earns in one — cheaper than a second round-trip after we
  // learn the mode, and the unused slot always returns 0.
  const stateReads = useReadContracts({
    contracts: withModule.flatMap((m) => [
      {
        abi: nftMintModuleAbi,
        address: m.mintModule,
        functionName: 'paymentToken' as const,
        chainId: targetChainId,
      },
      {
        abi: nftMintModuleAbi,
        address: m.mintModule,
        functionName: 'launcherBalance' as const,
        chainId: targetChainId,
      },
      {
        abi: nftMintModuleAbi,
        address: m.mintModule,
        functionName: 'launcherBalanceUru' as const,
        chainId: targetChainId,
      },
    ]),
    query: { enabled: withModule.length > 0, refetchInterval: 15_000 },
  });

  const rows: CollectionRow[] = useMemo(() => {
    if (!stateReads.data) return [];
    const raw = withModule.map((m, i) => {
      const base = i * 3;
      return {
        collectionAddress: m.collectionAddress,
        mintModule: m.mintModule,
        name: m.name,
        paymentToken: (stateReads.data?.[base]?.result as Address | undefined) ?? zeroAddress,
        ethBalance: (stateReads.data?.[base + 1]?.result as bigint | undefined) ?? 0n,
        uruBalance: (stateReads.data?.[base + 2]?.result as bigint | undefined) ?? 0n,
      };
    });
    return buildRows(raw);
  }, [withModule, stateReads.data]);

  const totalEth = useMemo(() => totalFor('eth', rows), [rows]);
  const totalUru = useMemo(() => totalFor('uru', rows), [rows]);

  // ---- claim tx handling -----------------------------------------------------
  const { writeContract, data: claimTxHash, isPending: isSubmitting, reset } = useWriteContract();
  const { isLoading: isMining, isSuccess: isMined } = useWaitForTransactionReceipt({
    hash: claimTxHash,
    chainId: targetChainId,
  });
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);

  useEffect(() => {
    if (isMined) {
      setPendingRowKey(null);
      stateReads.refetch();
      reset();
    }
  }, [isMined, stateReads, reset]);

  if (!isSelf) return null;

  return (
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">❁ nft launcher earnings</div>
        <span
          style={{
            fontFamily: 'var(--font-jp), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
          }}
        >
          NFT収益
        </span>
      </div>

      {!ready && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          checking your collections...
        </div>
      )}

      {ready && rows.length === 0 && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)', lineHeight: 1.5 }}>
          no nft launches yet ~~ launch a collection and 90% of every mint accrues here for you to claim.
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
            <span>
              {totalEth > 0n && (
                <b style={{ color: 'var(--mint-hot)', marginRight: 8 }}>
                  {Number(formatEther(totalEth)).toFixed(6)}Ξ
                </b>
              )}
              {totalUru > 0n && (
                <b style={{ color: 'var(--mint-hot)' }}>
                  {Number(formatUnits(totalUru, 18)).toFixed(4)} URU
                </b>
              )}
              {totalEth === 0n && totalUru === 0n && (
                <span style={{ color: 'var(--anchor)' }}>0</span>
              )}
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {rows.map((r) => {
              const state = claimButtonState(r, walletChainId, targetChainId, pendingRowKey);
              const amount = r.mode === 'eth'
                ? `${Number(formatEther(r.balance)).toFixed(6)}Ξ`
                : `${Number(formatUnits(r.balance, 18)).toFixed(4)} URU`;
              return (
                <li
                  key={rowKey(r)}
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
                  <span style={{ color: 'var(--anchor-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                    <b style={{ color: 'var(--anchor)' }}>{r.name}</b>
                  </span>
                  <span>{amount}</span>
                  {state.kind === 'none' ? (
                    <span style={{ color: 'var(--anchor-soft)', fontSize: 10 }}>—</span>
                  ) : (
                    <button
                      type="button"
                      className="uru-chip"
                      disabled={isSubmitting || isMining || switchPending}
                      onClick={() => {
                        if (state.kind === 'switch') {
                          switchChain({ chainId: targetChainId });
                          return;
                        }
                        setPendingRowKey(rowKey(r));
                        writeContract({
                          abi: nftMintModuleAbi,
                          address: r.mintModule,
                          functionName: r.mode === 'eth' ? 'withdraw' : 'withdrawUru',
                          chainId: targetChainId,
                        });
                      }}
                      style={{ padding: '2px 8px', fontSize: 10 }}
                      title={state.kind === 'switch' ? 'click to switch chain + claim' : 'claim your earnings'}
                    >
                      {state.kind === 'pending' ? 'claiming...' : state.kind === 'switch' ? 'switch → claim' : 'claim'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
