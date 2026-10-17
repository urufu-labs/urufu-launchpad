'use client';

/// NFT-launcher earnings for the profile page. Twin of CreatorEarnings, but
/// for the pull-based NftMintModule payouts instead of the v4 pool royalties.
///
/// Data sources per collection this wallet launched on `chain`:
///   1. Indexer `nftCollectionss` filtered by launchedBy → collection addresses
///      + the bound mintModuleAddress (from the V4 schema onward)
///   2. On-chain minter() on each ERC-721 → mint module address (fallback
///      for older indexer rows where mintModuleAddress isn't populated)
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
import styles from './NftLauncherEarnings.module.css';

// V5 two-role model: the ERC-721 clone's `minter()` returns the mint
// module (Solady owner() returns the LAUNCHER in V5, not the module).
// Kept inline to match /collection/[address]'s pattern rather than
// pulling in the full ABI just for one call.
const nftErc721MinterAbi = [
  { type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
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
      // DN404 collections have no mint module and no mint earnings, so they
      // never belong here (and must not show while the DN404 lane is off).
      const forChain = (raw ?? []).filter((r) => r.chainId === targetChainId && r.lane !== 'dn404');
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
      abi: nftErc721MinterAbi,
      address: c.collectionAddress,
      functionName: 'minter' as const,
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
    <section className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>NFT launch earnings</h2>
      </div>

      {!ready && (
        <div className={styles.muted}>
          Checking your collections…
        </div>
      )}

      {ready && rows.length === 0 && (
        <div className={styles.muted}>
          No NFT launches yet. Launch a collection and 90% of every mint collects here for you to claim.
        </div>
      )}

      {ready && rows.length > 0 && (
        <>
          <div className={styles.total}>
            <span className={styles.totalLabel}>Unclaimed</span>
            <span className={styles.totalValues}>
              {totalEth > 0n && (
                <b className={styles.num}>
                  {Number(formatEther(totalEth)).toFixed(6)} Ξ
                </b>
              )}
              {totalUru > 0n && (
                <b className={styles.num}>
                  {Number(formatUnits(totalUru, 18)).toFixed(4)} URU
                </b>
              )}
              {totalEth === 0n && totalUru === 0n && (
                <span className={styles.num}>0</span>
              )}
            </span>
          </div>
          <ul className={styles.list}>
            {rows.map((r) => {
              const state = claimButtonState(r, walletChainId, targetChainId, pendingRowKey);
              const amount = r.mode === 'eth'
                ? `${Number(formatEther(r.balance)).toFixed(6)} Ξ`
                : `${Number(formatUnits(r.balance, 18)).toFixed(4)} URU`;
              return (
                <li key={rowKey(r)} className={styles.row}>
                  <span className={styles.name} title={r.name}>{r.name}</span>
                  <span className={styles.num}>{amount}</span>
                  {state.kind === 'none' ? (
                    <span className={styles.none}>Nothing to claim</span>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn"
                      data-size="sm"
                      data-variant={state.kind === 'claim' ? 'primary' : undefined}
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
                      title={state.kind === 'switch' ? 'Switch network, then claim' : 'Claim your earnings'}
                    >
                      {state.kind === 'pending' ? 'Claiming…' : state.kind === 'switch' ? 'Switch network' : 'Claim'}
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
