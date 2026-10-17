'use client';

/// Owner-only control panel for tokens the connected wallet still owns. Renders on
/// the profile page ONLY when `visibleFor` equals the connected wallet — the
/// controls' semantics (pause everyone's tokens, add to allowlist, etc.) belong to
/// the owner alone. Rendering it on a stranger's profile page would leak "this
/// wallet still owns X, Y, Z" and expose per-token control state (paused? gated?)
/// even though the buttons themselves would revert without the owner's signature.
///
/// Data flow:
///   1. `fetchLaunchesByCreator(wallet)` — every token this wallet ever launched
///   2. `useReadContracts` on `token.owner()` for each — filter to the ones where
///      owner == this wallet TODAY (drops renounced curve tokens + tokens whose
///      ownership was later transferred to a multisig).
///   3. Per surviving token, probe each module's marker view (pausablePaused,
///      antiBotGateEndsAtBlock, antiWhaleConfig) with `allowFailure: true`. A
///      successful read means the module is installed and we surface its controls.
///
/// Reads all use `staleTime: 30_000` so hover/re-render doesn't hammer the RPC.
/// Every mutation triggers a targeted refetch of the touched read so the row
/// reflects on-chain state within one block.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { isAddress, type Address } from 'viem';
import {
  useAccount,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { tokenOwnerAbi } from '@/lib/abis';
import { type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { fetchLaunchesByCreator, type IndexerLaunch } from '@/lib/indexer';
import card from './profile-card.module.css';

interface Props {
  /// The wallet whose profile is being viewed.
  visibleFor: Address;
  /// Chain the profile page is scoped to. All reads and writes force this chainId.
  chain: ChainKey;
}

interface OwnedToken {
  tokenAddress: Address;
  name: string;
  ticker: string;
  chainId: number;
  /// Which modules are installed. Derived from successful marker reads.
  modules: {
    pausable: boolean;
    antiBot: boolean;
    antiWhale: boolean;
  };
}

export function TokenOwnerControls({ visibleFor, chain }: Props) {
  const { address: wallet, chainId: walletChainId } = useAccount();
  const isSelf = wallet?.toLowerCase() === visibleFor.toLowerCase();

  const targetChainId = CHAIN_KEY_TO_ID[chain];
  const walletOnTargetChain = walletChainId === targetChainId;

  // ---- Step 1: fetch launches by this wallet on this chain --------------
  const [launches, setLaunches] = useState<IndexerLaunch[]>([]);
  const [launchesReady, setLaunchesReady] = useState(false);

  useEffect(() => {
    if (!isSelf) return;
    let cancelled = false;
    (async () => {
      const rows = await fetchLaunchesByCreator(visibleFor, 100);
      if (cancelled) return;
      // Filter to ERC20 (base 0) tokens on the target chain. NFT bases aren't
      // in launchpad scope right now, so this filter is effectively a no-op
      // today; kept explicit so if NFTs ship later the shelf doesn't start
      // rendering rows for tokens it has no controls for.
      setLaunches((rows ?? []).filter((r) => r.chainId === targetChainId && r.base === 0));
      setLaunchesReady(true);
    })();
    return () => { cancelled = true; };
  }, [isSelf, visibleFor, targetChainId]);

  // ---- Step 2: read owner() for each launch, keep only where owner == wallet ----
  const ownerReads = useReadContracts({
    contracts: launches.map((l) => ({
      abi: tokenOwnerAbi,
      address: l.tokenAddress as Address,
      functionName: 'owner' as const,
      chainId: targetChainId,
    })),
    query: { enabled: launches.length > 0 && isSelf, staleTime: 30_000 },
  });

  const ownedIndices = useMemo(() => {
    const walletLc = visibleFor.toLowerCase();
    return launches
      .map((_, i) => i)
      .filter((i) => {
        const o = ownerReads.data?.[i]?.result as Address | undefined;
        return o !== undefined && o.toLowerCase() === walletLc;
      });
  }, [launches, ownerReads.data, visibleFor]);

  // ---- Step 3: probe module markers for each owned token --------------------
  // Fan out three reads per token (pausable / antibot / antiwhale). allowFailure
  // is the default true here — missing modules just return an errored entry we
  // treat as "not installed."
  const markerContracts = useMemo(
    () =>
      ownedIndices.flatMap((i) => {
        const addr = launches[i]!.tokenAddress as Address;
        return [
          { abi: tokenOwnerAbi, address: addr, functionName: 'pausablePaused' as const, chainId: targetChainId },
          {
            abi: tokenOwnerAbi,
            address: addr,
            functionName: 'antiBotGateEndsAtBlock' as const,
            chainId: targetChainId,
          },
          { abi: tokenOwnerAbi, address: addr, functionName: 'antiWhaleConfig' as const, chainId: targetChainId },
        ];
      }),
    [ownedIndices, launches, targetChainId],
  );

  const markerReads = useReadContracts({
    contracts: markerContracts,
    query: { enabled: markerContracts.length > 0 && isSelf, staleTime: 30_000 },
  });

  const ownedTokens: OwnedToken[] = useMemo(() => {
    return ownedIndices.map((i, k) => {
      const l = launches[i]!;
      const pausableResult = markerReads.data?.[k * 3 + 0];
      const antiBotResult = markerReads.data?.[k * 3 + 1];
      const antiWhaleResult = markerReads.data?.[k * 3 + 2];
      return {
        tokenAddress: l.tokenAddress as Address,
        name: l.name || l.ticker || l.tokenAddress.slice(0, 8),
        ticker: l.ticker,
        chainId: l.chainId,
        modules: {
          pausable: pausableResult?.status === 'success',
          antiBot: antiBotResult?.status === 'success',
          antiWhale: antiWhaleResult?.status === 'success',
        },
      };
    });
  }, [ownedIndices, launches, markerReads.data]);

  // ---- Write path -----------------------------------------------------------
  const { writeContract, data: txHash, isPending: writePending, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId: targetChainId });
  const { switchChain, isPending: switchPending } = useSwitchChain();

  useEffect(() => {
    if (receipt.isSuccess) {
      // Refetch reads so the row reflects the new on-chain state.
      ownerReads.refetch();
      markerReads.refetch();
      reset();
    }
  }, [receipt.isSuccess, ownerReads, markerReads, reset]);

  const runWrite = (args: {
    address: Address;
    functionName: 'pause' | 'unpause' | 'setAntiBotAllowed' | 'setAntiWhaleExcluded' | 'renounceOwnership' | 'transferOwnership';
    argsList?: readonly unknown[];
  }) => {
    if (!walletOnTargetChain) {
      switchChain({ chainId: targetChainId });
      return;
    }
    writeContract({
      abi: tokenOwnerAbi,
      address: args.address,
      functionName: args.functionName,
      args: args.argsList as never,
      chainId: targetChainId,
    });
  };

  // ---- Render --------------------------------------------------------------
  if (!isSelf) return null;

  return (
    <section className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Owner controls</h2>
        <span className={card.aside}>Tokens you still own</span>
      </div>

      <div className={card.body}>
      {!launchesReady && (
        <p className={card.empty}>Checking your launches…</p>
      )}

      {launchesReady && ownedTokens.length === 0 && (
        <p className={card.empty}>
          You don&apos;t own any tokens on {chain}. Most curve launches give up ownership
          at launch, so this list only shows tokens where this wallet still
          has the owner role.
        </p>
      )}

      {ownedTokens.length > 0 && (
        <ul className={card.list}>
          {ownedTokens.map((t) => (
            <TokenRow
              key={t.tokenAddress}
              token={t}
              chain={chain}
              walletOnTargetChain={walletOnTargetChain}
              switchPending={switchPending}
              writePending={writePending}
              receiptPending={receipt.isLoading}
              runWrite={runWrite}
            />
          ))}
        </ul>
      )}
      </div>
    </section>
  );
}

// ============================================================================
// Row per token
// ============================================================================

function TokenRow({
  token,
  chain,
  walletOnTargetChain,
  switchPending,
  writePending,
  receiptPending,
  runWrite,
}: {
  token: OwnedToken;
  chain: ChainKey;
  walletOnTargetChain: boolean;
  switchPending: boolean;
  writePending: boolean;
  receiptPending: boolean;
  runWrite: (args: {
    address: Address;
    functionName: 'pause' | 'unpause' | 'setAntiBotAllowed' | 'setAntiWhaleExcluded' | 'renounceOwnership' | 'transferOwnership';
    argsList?: readonly unknown[];
  }) => void;
}) {
  const busy = writePending || receiptPending || switchPending;
  const targetChainId = CHAIN_KEY_TO_ID[chain];

  // Pausable — read current paused state so the button shows the right label.
  const pausedRead = useReadContracts({
    contracts: token.modules.pausable
      ? [{
          abi: tokenOwnerAbi,
          address: token.tokenAddress,
          functionName: 'pausablePaused' as const,
          chainId: targetChainId,
        }]
      : [],
    query: { enabled: token.modules.pausable, staleTime: 15_000 },
  });
  const isPaused = (pausedRead.data?.[0]?.result as boolean | undefined) ?? false;

  // Per-module input states. Empty string is fine — we validate before submit.
  const [allowInput, setAllowInput] = useState('');
  const [excludeInput, setExcludeInput] = useState('');
  const [newOwnerInput, setNewOwnerInput] = useState('');
  const [renounceConfirm, setRenounceConfirm] = useState(false);

  const shortAddr = `${token.tokenAddress.slice(0, 6)}…${token.tokenAddress.slice(-4)}`;

  return (
    <li className={card.item}>
      <div className={card.itemHead}>
        <div>
          <span className={card.itemName}>{token.name}</span>
          <span className={card.itemMeta}>
            ${token.ticker} · <Link href={`/trade/${token.tokenAddress}`}>{shortAddr}</Link>
          </span>
        </div>
        <span className={card.tags}>
          {([
            token.modules.pausable && 'Pausable',
            token.modules.antiBot && 'Anti-bot',
            token.modules.antiWhale && 'Anti-whale',
          ].filter(Boolean) as string[]).map((m) => (
            <span key={m} className="ui-badge">{m}</span>
          ))}
          {!token.modules.pausable && !token.modules.antiBot && !token.modules.antiWhale && (
            <span className="ui-badge">Ownable</span>
          )}
        </span>
      </div>

      {/* Pausable controls */}
      {token.modules.pausable && (
        <div className={card.row}>
          <span className={card.status}>
            Status: <b data-state={isPaused ? 'paused' : 'live'}>{isPaused ? 'Paused' : 'Live'}</b>
          </span>
          <button
            type="button"
            className="ui-btn"
            data-variant={isPaused ? 'primary' : 'ink'}
            data-size="sm"
            disabled={busy}
            onClick={() =>
              runWrite({
                address: token.tokenAddress,
                functionName: isPaused ? 'unpause' : 'pause',
              })
            }
          >
            {isPaused ? 'Unpause' : 'Pause all trades'}
          </button>
        </div>
      )}

      {/* AntiBot allowlist add */}
      {token.modules.antiBot && (
        <div className={card.row}>
          <input
            className={`ui-input ${card.grow}`}
            data-mono="true"
            type="text"
            placeholder="0x… wallet to let through the anti-bot gate"
            value={allowInput}
            onChange={(e) => setAllowInput(e.target.value)}
          />
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={busy || !isAddress(allowInput.trim())}
            onClick={() => {
              runWrite({
                address: token.tokenAddress,
                functionName: 'setAntiBotAllowed',
                argsList: [allowInput.trim() as Address, true],
              });
              setAllowInput('');
            }}
          >
            Allow
          </button>
        </div>
      )}

      {/* AntiWhale exclude */}
      {token.modules.antiWhale && (
        <div className={card.row}>
          <input
            className={`ui-input ${card.grow}`}
            data-mono="true"
            type="text"
            placeholder="0x… wallet to exempt from whale caps"
            value={excludeInput}
            onChange={(e) => setExcludeInput(e.target.value)}
          />
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={busy || !isAddress(excludeInput.trim())}
            onClick={() => {
              runWrite({
                address: token.tokenAddress,
                functionName: 'setAntiWhaleExcluded',
                argsList: [excludeInput.trim() as Address, true],
              });
              setExcludeInput('');
            }}
          >
            Exempt
          </button>
        </div>
      )}

      {/* Ownership handoff — always available since every token is Ownable */}
      <details className={card.details}>
        <summary>Ownership options</summary>
        <div className={card.detailsBody}>
          <div className={card.row}>
            <input
              className={`ui-input ${card.grow}`}
              data-mono="true"
              type="text"
              placeholder="0x… new owner (multisig or another wallet)"
              value={newOwnerInput}
              onChange={(e) => setNewOwnerInput(e.target.value)}
            />
            <button
              type="button"
              className="ui-btn"
              data-variant="ink"
              disabled={busy || !isAddress(newOwnerInput.trim())}
              onClick={() => {
                runWrite({
                  address: token.tokenAddress,
                  functionName: 'transferOwnership',
                  argsList: [newOwnerInput.trim() as Address],
                });
                setNewOwnerInput('');
              }}
            >
              Transfer
            </button>
          </div>
          <div className={card.row}>
            <label className={card.check}>
              <input
                type="checkbox"
                checked={renounceConfirm}
                onChange={(e) => setRenounceConfirm(e.target.checked)}
              />
              <span>I understand renouncing is <b>permanent</b></span>
            </label>
            <button
              type="button"
              className="ui-btn"
              data-variant={renounceConfirm ? 'primary' : undefined}
              data-size="sm"
              disabled={busy || !renounceConfirm}
              onClick={() =>
                runWrite({
                  address: token.tokenAddress,
                  functionName: 'renounceOwnership',
                })
              }
            >
              Renounce forever
            </button>
          </div>
        </div>
      </details>

      {!walletOnTargetChain && (
        <div className={card.warn}>
          Switch to {chain} to sign owner transactions.
        </div>
      )}
    </li>
  );
}

export type { OwnedToken };
