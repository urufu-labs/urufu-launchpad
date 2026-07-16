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
      // Filter to ERC20 (base 0) tokens on the target chain — owner controls are
      // ERC20-specific for now. NFT owner ops (setDefaultRoyalty etc) can land later.
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
    <section className="uru-shell-tight" style={{ background: 'var(--cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">⚙ your tokens (owner controls)</div>
        <span style={{ fontFamily: 'var(--font-jp), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>管理</span>
      </div>

      {!launchesReady && (
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10.5, color: 'var(--anchor-soft)' }}>
          checking your launches...
        </div>
      )}

      {launchesReady && ownedTokens.length === 0 && (
        <div
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10.5,
            color: 'var(--anchor-soft)',
            lineHeight: 1.5,
          }}
        >
          no owned tokens on {chain}. bonding-curve launches auto-renounce ownership, so this is
          the direct-launch shelf ~~
        </div>
      )}

      {ownedTokens.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    <li
      style={{
        border: '1.5px solid var(--anchor)',
        padding: 10,
        background: 'var(--cream-deep)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontWeight: 700 }}>{token.name}</span>
          <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
            ${token.ticker} · <Link href={`/trade/${token.tokenAddress}`} style={{ color: 'var(--link-blue)' }}>{shortAddr}</Link>
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 9,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--anchor-soft)',
          }}
        >
          {[
            token.modules.pausable && 'pausable',
            token.modules.antiBot && 'antibot',
            token.modules.antiWhale && 'antiwhale',
          ].filter(Boolean).join(' · ') || 'ownable'}
        </span>
      </div>

      {/* Pausable controls */}
      {token.modules.pausable && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, flex: 1 }}>
            status: <b style={{ color: isPaused ? 'var(--pink-hot)' : 'var(--mint-hot)' }}>{isPaused ? 'paused' : 'live'}</b>
          </span>
          <button
            type="button"
            className={isPaused ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'}
            style={{ fontSize: 11, padding: '3px 10px' }}
            disabled={busy}
            onClick={() =>
              runWrite({
                address: token.tokenAddress,
                functionName: isPaused ? 'unpause' : 'pause',
              })
            }
          >
            {isPaused ? '✿ unpause' : '⏸ pause all trades'}
          </button>
        </div>
      )}

      {/* AntiBot allowlist add */}
      {token.modules.antiBot && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            className="uru-input"
            type="text"
            placeholder="0x… (wallet to allow through anti-bot gate)"
            value={allowInput}
            onChange={(e) => setAllowInput(e.target.value)}
            style={{ flex: 1, minWidth: 220, fontSize: 11 }}
          />
          <button
            type="button"
            className="uru-btn uru-btn-mint"
            style={{ fontSize: 11, padding: '3px 10px' }}
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
            + allow
          </button>
        </div>
      )}

      {/* AntiWhale exclude */}
      {token.modules.antiWhale && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            className="uru-input"
            type="text"
            placeholder="0x… (wallet to exempt from whale caps)"
            value={excludeInput}
            onChange={(e) => setExcludeInput(e.target.value)}
            style={{ flex: 1, minWidth: 220, fontSize: 11 }}
          />
          <button
            type="button"
            className="uru-btn uru-btn-mint"
            style={{ fontSize: 11, padding: '3px 10px' }}
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
            + exempt
          </button>
        </div>
      )}

      {/* Ownership handoff — always available since every token is Ownable */}
      <details>
        <summary
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10,
            color: 'var(--anchor-soft)',
            cursor: 'pointer',
          }}
        >
          ownership options ~~
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              className="uru-input"
              type="text"
              placeholder="0x… new owner (multisig or new EOA)"
              value={newOwnerInput}
              onChange={(e) => setNewOwnerInput(e.target.value)}
              style={{ flex: 1, minWidth: 220, fontSize: 11 }}
            />
            <button
              type="button"
              className="uru-btn uru-btn-primary"
              style={{ fontSize: 11, padding: '3px 10px' }}
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
              hand off
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, flex: 1 }}>
              <input
                type="checkbox"
                checked={renounceConfirm}
                onChange={(e) => setRenounceConfirm(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              i understand renouncing is <b>permanent</b>
            </label>
            <button
              type="button"
              className="uru-btn"
              style={{
                fontSize: 11,
                padding: '3px 10px',
                background: renounceConfirm ? 'var(--pink-hot)' : 'var(--cream-deep)',
                color: renounceConfirm ? 'white' : 'var(--anchor-soft)',
                border: '1px solid var(--anchor)',
              }}
              disabled={busy || !renounceConfirm}
              onClick={() =>
                runWrite({
                  address: token.tokenAddress,
                  functionName: 'renounceOwnership',
                })
              }
            >
              ✕ renounce forever
            </button>
          </div>
        </div>
      </details>

      {!walletOnTargetChain && (
        <div
          style={{
            padding: 6,
            background: 'var(--yolk)',
            border: '1px solid var(--anchor)',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 10,
          }}
        >
          switch to {chain} to sign owner txs ~~
        </div>
      )}
    </li>
  );
}

export type { OwnedToken };
