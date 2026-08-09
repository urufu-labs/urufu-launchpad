'use client';

/// Post-graduation pool policy disclosure — mounts on the trade page and
/// reads `MultiHookHost.poolPolicy(poolId)` to show buyers exactly which
/// rules govern their trades:
///
///   - creator fee bps           (what the token creator earns per trade)
///   - platform fee bps          (what the launchpad earns per trade)
///   - anti-sniper blocks left   (how long the initial trade-freeze runs)
///   - buyback-burn bps          (what fraction of trades goes to buyback)
///   - launch block              (when the pool opened; anti-sniper window
///                                is measured from here)
///   - immutable flag            (whether the policy is frozen forever)
///
/// Renders nothing when the pool hasn't graduated yet or when `poolPolicy`
/// returns the zero-tuple (bare ERC20, direct launch, unknown pool).

import { useMemo } from 'react';
import { useBlockNumber, useReadContract } from 'wagmi';
import type { Address, Hex } from 'viem';

import { multiHookHostAbi } from '@/lib/abis';
import type { WagmiChainId } from '@/lib/wagmi';

interface Props {
  /// v4 pool id — the trade page derives this deterministically from
  /// (token, hookAddress) once graduation is known.
  poolId: Hex | null;
  /// The MultiHookHost holding the policy. Same address for every pool on
  /// the same chain (single MHH per chain).
  hookAddress: Address | null;
  /// Chain the pool lives on.
  chainId: WagmiChainId;
}

type PolicyTuple = readonly [
  number, // antiSniperBlocks (uint16)
  number, // buybackBurnBps (uint16)
  number, // platformFeeBps (uint16)
  number, // creatorFeeBps (uint16)
  Address, // creatorRecipient
  bigint, // launchBlock (uint64)
  boolean, // immutableAfterLaunch
];

export function PoolPolicyCard({ poolId, hookAddress, chainId }: Props) {
  const policy = useReadContract({
    abi: multiHookHostAbi,
    address: hookAddress ?? undefined,
    functionName: 'poolPolicy',
    args: poolId ? [poolId] : undefined,
    chainId,
    query: {
      enabled: !!hookAddress && !!poolId,
      staleTime: 30_000,
    },
  });
  const { data: blockNumber } = useBlockNumber({ chainId, watch: true });

  const parsed = useMemo(() => {
    const t = policy.data as PolicyTuple | undefined;
    if (!t) return null;
    const [antiSniperBlocks, buybackBurnBps, platformFeeBps, creatorFeeBps, creatorRecipient, launchBlock, immutable] = t;
    // Zero-tuple = policy never stamped (pre-graduation or unknown pool).
    if (launchBlock === 0n && !immutable) return null;
    return {
      antiSniperBlocks,
      buybackBurnBps,
      platformFeeBps,
      creatorFeeBps,
      creatorRecipient,
      launchBlock,
      immutable,
    };
  }, [policy.data]);

  if (!parsed) return null;

  const gateEndsAt = parsed.launchBlock + BigInt(parsed.antiSniperBlocks);
  const currentBlock = blockNumber ?? parsed.launchBlock;
  const gateBlocksLeft =
    currentBlock < gateEndsAt ? Number(gateEndsAt - currentBlock) : 0;
  const gateActive = gateBlocksLeft > 0 && parsed.antiSniperBlocks > 0;

  return (
    <section
      className="uru-shell"
      style={{ marginTop: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 16 }}>✿</span>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 15 }}>
          pool policy
        </h3>
        <span style={{ color: 'var(--anchor-soft)', fontSize: 11 }}>
          {parsed.immutable
            ? 'frozen at launch — cannot change'
            : 'set at graduation, freezes on first trade'}
        </span>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
        }}
      >
        <Stat label="creator fee" value={bpsPct(parsed.creatorFeeBps)} title="paid to the token creator on every swap through this pool" />
        <Stat label="platform fee" value={bpsPct(parsed.platformFeeBps)} title="paid to the launchpad platform (funds the flywheel)" />
        <Stat
          label="buyback burn"
          value={bpsPct(parsed.buybackBurnBps)}
          title="fraction of every trade auto-burned via the token's buyback path"
        />
        <Stat
          label="anti-sniper"
          value={
            parsed.antiSniperBlocks === 0
              ? 'off'
              : gateActive
                ? `${gateBlocksLeft} blocks left`
                : 'complete'
          }
          title={
            parsed.antiSniperBlocks === 0
              ? 'no launch-block gate on this pool'
              : `swaps blocked for the first ${parsed.antiSniperBlocks} blocks after graduation`
          }
        />
      </div>
    </section>
  );
}

function bpsPct(bps: number): string {
  if (!bps) return '0%';
  const pct = bps / 100;
  return `${pct.toFixed(pct === Math.floor(pct) ? 0 : 2)}%`;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          color: 'var(--anchor-soft)',
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      <span className="uru-num" style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}
