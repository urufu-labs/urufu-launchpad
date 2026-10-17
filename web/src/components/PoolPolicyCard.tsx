'use client';

/// Post-graduation pool policy disclosure — mounts on the trade page and
/// reads `MultiHookHost.poolPolicy(poolId)` to show buyers exactly which
/// rules govern their trades:
///
///   - creator fee bps           (what the token creator earns per trade)
///   - platform fee bps          (what the launchpad earns per trade)
///   - anti-sniper time left     (how long the initial trade-freeze runs;
///                                stored as L1 blocks on chain, shown as seconds)
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
import styles from './info-panel.module.css';

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

  // Anti-sniper is expressed in blocks on chain, but MHH reads L1 block numbers
  // (12 sec cadence) because RH runs on Arbitrum stack. Convert to seconds so
  // launchers + buyers see a real-time countdown. `blockNumber` here is the L2
  // block from wagmi — we can't ask the chain for its current L1 block cheaply,
  // so approximate remaining time as `gateBlocksLeft * 12 sec`, floored at zero.
  const SEC_PER_L1_BLOCK = 12;
  const gateEndsAt = parsed.launchBlock + BigInt(parsed.antiSniperBlocks);
  const currentBlock = blockNumber ?? parsed.launchBlock;
  const gateBlocksLeft =
    currentBlock < gateEndsAt ? Number(gateEndsAt - currentBlock) : 0;
  const gateSecondsLeft = gateBlocksLeft * SEC_PER_L1_BLOCK;
  const gateActive = gateBlocksLeft > 0 && parsed.antiSniperBlocks > 0;
  const totalGateSeconds = parsed.antiSniperBlocks * SEC_PER_L1_BLOCK;

  return (
    <section className={styles.block}>
      <div className={styles.head}>
        <p className={styles.label}>Pool rules</p>
        <span className={styles.sub}>
          {parsed.immutable
            ? 'Frozen at launch, can’t change'
            : 'Set at graduation, frozen on the first trade'}
        </span>
      </div>

      <div className={styles.stats}>
        <Stat label="Creator fee" value={bpsPct(parsed.creatorFeeBps)} title="paid to the token creator on every swap through this pool" />
        <Stat label="Platform fee" value={bpsPct(parsed.platformFeeBps)} title="paid to the launchpad platform (funds the flywheel)" />
        <Stat
          label="Buyback burn"
          value={bpsPct(parsed.buybackBurnBps)}
          title="fraction of every trade auto-burned via the token's buyback path"
        />
        <Stat
          label="Anti-sniper"
          value={
            parsed.antiSniperBlocks === 0
              ? 'Off'
              : gateActive
                ? `~${gateSecondsLeft}s left`
                : 'Done'
          }
          title={
            parsed.antiSniperBlocks === 0
              ? 'no post-launch swap gate on this pool'
              : `swaps blocked for the first ~${totalGateSeconds}s after graduation (${parsed.antiSniperBlocks} L1 blocks)`
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
    <div title={title} className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}
