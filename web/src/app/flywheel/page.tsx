'use client';

/// /flywheel — public transparency dashboard for the fee flow: where every
/// launch fee lands, whether a config change is queued in the URU-A11
/// timelock, and the recent buyback + distribution activity that proves the
/// flywheel is actually turning.
///
/// Read-only. Owner-only actions (proposeConfig, activateConfig, addEpoch,
/// keeper trigger) belong in the Safe UI, not urufulabs.xyz.
///
/// Reads FeeSplitter live via wagmi; historical events (Distributed,
/// BuybackExecuted, ConversionExecuted) come from the indexer's GraphQL
/// layer once they're subscribed. Until those subscriptions ship the
/// dashboard renders "activity feed loading" — the status card above still
/// works fine.

import { useEffect, useMemo, useState } from 'react';
import { formatEther, type Address } from 'viem';
import { useBalance, useReadContracts } from 'wagmi';

import { feeSplitterAbi } from '@/lib/abis';
import { FLYWHEEL, type ChainKey } from '@/lib/config';
import { FLYWHEEL_HISTORY_START_BLOCK } from '@/lib/launchpadStatus';
import { CHAIN_KEY_TO_ID, type WagmiChainId } from '@/lib/wagmi';
import {
  fetchFlywheelActivity,
  fetchFlywheelTotals,
  type FlywheelActivityRow,
} from '@/lib/indexer';

import styles from './flywheel.module.css';

const CHAIN: ChainKey = 'robinhood';
const CHAIN_ID = CHAIN_KEY_TO_ID[CHAIN] as WagmiChainId;

/// Ticking-clock hook. Seeded via a stable initializer on first render and
/// updated every 30 seconds so the pending-config countdown flip (from
/// "coming soon" to "ready to activate") happens without a manual refresh.
/// Kept internal to this file — the banner is the only place we need this.
function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function FlywheelPage() {
  const feeSplitter = FLYWHEEL[CHAIN]?.FeeSplitter as Address | undefined;
  const uruBuybackVault = FLYWHEEL[CHAIN]?.UruBuybackVault as Address | undefined;
  const nftRevenueVault = FLYWHEEL[CHAIN]?.NftRevenueVault as Address | undefined;

  const reads = useReadContracts({
    contracts: feeSplitter
      ? [
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'uruBuybackSink' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'nftRevenueSink' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'treasurySink' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'uruBuybackBps' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'nftRevenueBps' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'treasuryBps' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'minConfigDelay' as const, chainId: CHAIN_ID },
          { abi: feeSplitterAbi, address: feeSplitter, functionName: 'pendingConfig' as const, chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: !!feeSplitter, staleTime: 30_000 },
  });

  const parsed = useMemo(() => {
    if (!reads.data) return null;
    const d = reads.data;
    return {
      uruSink: d[0]?.result as Address | undefined,
      nftSink: d[1]?.result as Address | undefined,
      treasurySink: d[2]?.result as Address | undefined,
      uruBps: (d[3]?.result as number | undefined) ?? 0,
      nftBps: (d[4]?.result as number | undefined) ?? 0,
      treasuryBps: (d[5]?.result as number | undefined) ?? 0,
      minDelay: (d[6]?.result as bigint | undefined) ?? 0n,
      pending: d[7]?.result as
        | readonly [Address, Address, Address, number, number, number, bigint]
        | undefined,
    };
  }, [reads.data]);

  /// Three-state banner: no pending config, pending config with timelock
  /// still counting down, or pending config whose timelock already elapsed
  /// (ready to activate — copy switches from "coming soon" to "ready when
  /// owner activates"). Previously the banner said "coming soon" even after
  /// the timestamp passed, which read as broken data to visitors.
  ///
  /// `now` is a piece of state seeded on mount + ticked every 30s so React
  /// treats it as external. Reading Date.now during render violates the
  /// react-hooks/purity rule.
  const nowSec = useNowSec();
  const pendingReadyAt = parsed?.pending ? Number(parsed.pending[6]) : 0;
  const hasPending = pendingReadyAt > 0;
  const pendingReady = hasPending && pendingReadyAt <= nowSec;

  /// Lift activity-feed fetch to the parent so the totals row + the row list
  /// share one round-trip. Rows carry the per-event breakdown (ETH split into
  /// Activity feed: recent rows only, for the reel. LIFETIME totals come from
  /// a separate /api/flywheel/totals endpoint (below) so the tiles reflect
  /// every distribution ever, not just the last MAX_ROWS window.
  const [activityRows, setActivityRows] = useState<FlywheelActivityRow[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [lifetimeTotals, setLifetimeTotals] = useState<Awaited<ReturnType<typeof fetchFlywheelTotals>>>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, agg] = await Promise.all([
          fetchFlywheelActivity(CHAIN_ID, MAX_ROWS),
          fetchFlywheelTotals(CHAIN_ID),
        ]);
        if (cancelled) return;
        setActivityRows(data);
        setLifetimeTotals(agg);
      } catch (err) {
        if (cancelled) return;
        setActivityError(err instanceof Error ? err.message : 'indexer unreachable');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /// Filter out everything before FLYWHEEL_HISTORY_START_BLOCK. Default is a
  /// far-future block so every pre-launch test event is hidden — the display
  /// reads as zeroed until we lower the cutoff at real launch time. See
  /// launchpadStatus.ts for the flip procedure.
  const liveRows = useMemo(() => {
    if (!activityRows) return null;
    return activityRows
      .filter((r) => Number(r.blockNumber) >= FLYWHEEL_HISTORY_START_BLOCK)
      .filter((r) => !isEmptyDistribution(r));
  }, [activityRows]);

  /// Lifetime aggregates from the dedicated /totals endpoint. Falls back to
  /// null while loading — tile shows a placeholder instead of a misleading 0.
  const totals = useMemo(() => {
    if (!lifetimeTotals) return null;
    return {
      uruBoughtBack: BigInt(lifetimeTotals.buybacks.uruOut || '0'),
      ethToGemu: BigInt(lifetimeTotals.distributions.toNft || '0'),
      ethToTeam: BigInt(lifetimeTotals.distributions.toTreasury || '0'),
    };
  }, [lifetimeTotals]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Flywheel</p>
          <h1 className={styles.title}>Where launch fees go</h1>
          <p className={styles.lede}>
            Every fee paid on urufu labs is split three ways. The numbers on this page are read live
            from the contracts.
          </p>
        </div>
        <span className={styles.liveTag}><span className={styles.liveDot} aria-hidden />Live on Robinhood</span>
      </header>

      {!feeSplitter && (
        <p className={`${styles.panel} ${styles.state}`}>
          The fee split isn&apos;t live yet. Check back after the next deploy.
        </p>
      )}

      {feeSplitter && parsed && (
        <>
          {/* Current split: one bar plus the three shares as big numbers. */}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>The split right now</h2>
              <p className={styles.panelSub}>Applies to every launch fee</p>
            </div>
            <div className={styles.split}>
              <SplitBar
                parts={[
                  { label: 'URU buyback', bps: parsed.uruBps, color: 'var(--accent)' },
                  { label: 'gemu rewards', bps: parsed.nftBps, color: 'var(--fg)' },
                  { label: 'team + ops', bps: parsed.treasuryBps, color: 'var(--fg-faint)' },
                ]}
              />
              {/* Columns sized like the bar segments so each number sits under its slice. */}
              <div
                className={styles.legend}
                style={{ gridTemplateColumns: `${parsed.uruBps || 1}fr ${parsed.nftBps || 1}fr ${parsed.treasuryBps || 1}fr` }}
              >
                <LegendItem pct={parsed.uruBps / 100} color="var(--accent)" label="URU buyback" note="Buys URU on the open market." />
                <LegendItem pct={parsed.nftBps / 100} color="var(--fg)" label="gemu rewards" note="Paid out to urufu gemu nft holders." />
                <LegendItem pct={parsed.treasuryBps / 100} color="var(--fg-faint)" label="Team + ops" note="Keeps the lights on." />
              </div>
            </div>
          </section>

          {/* Pending timelock card, only when one is queued. */}
          {hasPending && (
            <section className={styles.pending} data-ready={pendingReady ? 'true' : 'false'}>
              <strong>{pendingReady ? 'A new split is ready to activate' : 'A new split is coming'}</strong>
              <p>
                {pendingReady
                  ? <>The waiting period ended{' '}
                    <b>{new Date(pendingReadyAt * 1000).toLocaleString()}</b>. Once the owner activates it, the next
                    fees go: </>
                  : <>The new split takes effect{' '}
                    <b>{new Date(pendingReadyAt * 1000).toLocaleString()}</b>. After that: </>}
                <b>{parsed.pending![3] / 100}%</b> URU buyback,{' '}
                <b>{parsed.pending![4] / 100}%</b> gemu rewards,{' '}
                <b>{parsed.pending![5] / 100}%</b> team + ops.
              </p>
            </section>
          )}

          <div className={styles.tilesPair}>
            {/* On-chain vault balances, polled every 10s. Independent of the
                FLYWHEEL_HISTORY_START_BLOCK filter, so pre-launch deposits show. */}
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2 className={styles.panelTitle}>In the pools now</h2>
                <p className={styles.panelSub}>Updates every 10s</p>
              </div>
              <div className={styles.tiles} style={{ marginTop: 14 }}>
                <VaultBalanceTile label="gemu rewards" vaultAddress={nftRevenueVault} tint="var(--fg)" />
                <VaultBalanceTile label="URU buyback" vaultAddress={uruBuybackVault} tint="var(--accent)" />
              </div>
            </section>

            {/* Lifetime totals, filtered by FLYWHEEL_HISTORY_START_BLOCK. */}
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2 className={styles.panelTitle}>Since launch</h2>
                <p className={styles.panelSub}>All time</p>
              </div>
              <div className={styles.tiles} style={{ marginTop: 14 }}>
                <TotalTile label="URU bought back" value={totals ? formatBig(totals.uruBoughtBack, 'URU') : '—'} tint="var(--accent)" />
                <TotalTile label="To gemu holders" value={totals ? formatBig(totals.ethToGemu, 'ETH') : '—'} tint="var(--fg)" />
                <TotalTile label="To team + ops" value={totals ? formatBig(totals.ethToTeam, 'ETH') : '—'} tint="var(--fg-faint)" />
              </div>
            </section>
          </div>
        </>
      )}

      <ActivityFeed rows={liveRows} error={activityError} />
    </div>
  );
}

function LegendItem({ pct, color, label, note }: { pct: number; color: string; label: string; note: string }) {
  return (
    <div className={styles.legendItem}>
      <span className={styles.legendPct}>{pct}%</span>
      <span className={styles.legendLabel}>
        <span className={styles.legendSwatch} style={{ background: color }} aria-hidden />
        {label}
      </span>
      <span className={styles.legendNote}>{note}</span>
    </div>
  );
}

/// Real-time on-chain balance tile. Uses wagmi's useBalance with a 10s
/// refetch interval so the number moves live as fees arrive / claims fire.
/// Independent of the FLYWHEEL_HISTORY_START_BLOCK filter — always shows
/// what's actually in the vault at this moment.
function VaultBalanceTile({
  label,
  vaultAddress,
  tint,
}: {
  label: string;
  vaultAddress: Address | undefined;
  tint: string;
}) {
  const bal = useBalance({
    address: vaultAddress,
    chainId: CHAIN_ID,
    query: {
      enabled: !!vaultAddress,
      refetchInterval: 10_000,
    },
  });
  const value = vaultAddress
    ? bal.data
      ? formatBig(bal.data.value, 'ETH')
      : '—'
    : '—';
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>
        <span className={styles.liveDot} aria-hidden />
        {label}
      </span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileBar} style={{ background: tint }} aria-hidden />
    </div>
  );
}

/// One of the three top-line tiles. Big number, tinted underline, small
/// caption. Kept plain so a visitor can scan all three at once.
function TotalTile({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileBar} style={{ background: tint }} aria-hidden />
    </div>
  );
}

/// Human-readable formatter for wei bignums with a currency suffix. Small
/// values get 4 decimals, larger values compact suffixes so a 12M URU total
/// doesn't span half the row.
function formatBig(wei: bigint, unit: string): string {
  const num = Number(wei) / 1e18;
  if (num === 0) return `0 ${unit}`;
  if (num < 0.0001) return `<0.0001 ${unit}`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M ${unit}`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K ${unit}`;
  if (num >= 1) return `${num.toFixed(3)} ${unit}`;
  return `${num.toFixed(4)} ${unit}`;
}

/// Fetches the merged event stream from the indexer's /api/flywheel/activity
/// endpoint and renders it as a compact list. RH-scoped for now (single
/// chain). Renders a small skeleton while loading, an honest empty state when
/// there's nothing to show (fresh contracts on a chain that hasn't graduated
/// anything yet), and an error state when the indexer is unreachable.
const INITIAL_ROWS = 6;
const MAX_ROWS = 30;

/// Presentation-only — the parent owns the fetch so the totals row + this
/// feed share the same batch. `rows === null` = loading, `error !== null` =
/// indexer unreachable, `rows === []` = fresh contracts with no events yet.
function ActivityFeed({ rows, error }: { rows: FlywheelActivityRow[] | null; error: string | null }) {
  /// Show a small window by default so the feed doesn't dominate the page;
  /// "show more" expands to the full pulled batch.
  const [expanded, setExpanded] = useState(false);

  const visibleRows = rows
    ? (expanded ? rows : rows.slice(0, INITIAL_ROWS))
    : null;
  const hiddenCount = rows ? Math.max(0, rows.length - INITIAL_ROWS) : 0;

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Recent activity</h2>
        {rows && rows.length > 0 && <p className={styles.panelSub}>{rows.length} events</p>}
      </div>

      {error && (
        <p className={styles.state}>Can&apos;t reach the data feed right now. Try again in a bit.</p>
      )}

      {!error && rows === null && <p className={styles.state}>Loading…</p>}

      {!error && rows?.length === 0 && (
        <p className={styles.state}>
          Nothing yet. The flywheel starts turning the first time a token launches here.
        </p>
      )}

      {!error && visibleRows && visibleRows.length > 0 && (
        <>
          <ul className={styles.activity}>
            {visibleRows.map((r) => (
              <ActivityRow key={`${r.kind}-${r.txHash}-${r.blockNumber}`} row={r} />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setExpanded((e) => !e)} className={styles.more}>
              {expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ActivityRow({ row }: { row: FlywheelActivityRow }) {
  const when = new Date(Number(row.blockTimestamp) * 1000).toLocaleString();
  let summary: React.ReactNode;
  if (row.kind === 'distribution') {
    summary = (
      <>
        Split <b className={styles.num}>{formatEth(row.total)}</b> ETH:{' '}
        <span className={styles.num}>{formatEth(row.toBuyback)}</span> for URU buyback,{' '}
        <span className={styles.num}>{formatEth(row.toNft)}</span> to gemu holders,{' '}
        <span className={styles.num}>{formatEth(row.toTreasury)}</span> to team + ops
      </>
    );
  } else if (row.kind === 'buyback') {
    summary = (
      <>
        Bought back <b className={styles.num}>{formatEth(row.uruOut)}</b> URU (spent{' '}
        <span className={styles.num}>{formatEth(row.ethIn)}</span> ETH)
      </>
    );
  } else if (isBurn(row)) {
    // UruDepositSink conversion that returned no ETH: the URU was burned,
    // not sold (the 2026-10-12 sink burn is the first of these).
    summary = (
      <>
        Burned <b className={styles.num}>{formatEth(row.uruIn)}</b> URU from the fee sink
      </>
    );
  } else {
    summary = (
      <>
        Swapped <b className={styles.num}>{formatEth(row.uruIn)}</b> URU paid in fees for{' '}
        <span className={styles.num}>{formatEth(row.ethOut)}</span> ETH, sent to the split
      </>
    );
  }
  const tagKind = row.kind === 'distribution' || row.kind === 'buyback' ? row.kind : isBurn(row) ? 'burn' : 'conversion';
  const tag = { distribution: 'Split', buyback: 'Buyback', burn: 'Burn', conversion: 'Convert' }[tagKind];

  return (
    <li className={styles.row}>
      <span className={styles.tag} data-kind={tagKind}>{tag}</span>
      <span>{summary}</span>
      <span className={styles.when}>{when}</span>
    </li>
  );
}

function isBurn(row: FlywheelActivityRow): boolean {
  return row.kind === 'conversion' && (!row.ethOut || row.ethOut === '0');
}

function formatEth(v: string | undefined): string {
  if (!v) return '0';
  const s = formatEther(BigInt(v));
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole ?? '0';
  // Adaptive precision: normal 4-decimal display for readable amounts, but
  // for sub-0.0001 splits extend the fractional window past the leading
  // zeros so a 0.00001 ETH row shows as "0.00001" instead of collapsing to
  // "0". Cap at 12 digits to keep the row from stretching absurdly.
  const wholeIsZero = !whole || whole === '0';
  let maxFrac = 4;
  if (wholeIsZero) {
    const leadingZeros = frac.match(/^0+/)?.[0].length ?? 0;
    maxFrac = Math.min(12, leadingZeros + 4);
  }
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  return trimmed ? `${whole || '0'}.${trimmed}` : (whole ?? '0');
}

/// Only hide distributions where the RAW wei values are all zero. Prior
/// version filtered on the display string, which meant any small split
/// (0.00001 ETH, 0.0001 ETH) got hidden because formatEth used to
/// truncate them to "0". formatEth is adaptive now, so any non-zero row
/// renders as a readable number; the filter here is just for the
/// occasional true-zero row.
function isEmptyDistribution(row: FlywheelActivityRow): boolean {
  if (row.kind !== 'distribution') return false;
  const isZero = (v: string | undefined) => !v || v === '0';
  return (
    isZero(row.total) ||
    (isZero(row.toBuyback) && isZero(row.toNft) && isZero(row.toTreasury))
  );
}

function SplitBar({ parts }: { parts: Array<{ label: string; bps: number; color: string }> }) {
  const total = parts.reduce((s, p) => s + p.bps, 0);
  return (
    <div
      role="img"
      aria-label={`fee split: ${parts.map((p) => `${p.label} ${(p.bps / 100).toFixed(0)}%`).join(', ')}`}
      className={styles.splitBar}
      // Same fr columns as the legend below, so the numbers line up with their slice.
      style={{ gridTemplateColumns: parts.map((p) => `${total > 0 ? p.bps || 1 : 1}fr`).join(' ') }}
    >
      {parts.map((p) => (
        <div
          key={p.label}
          title={`${p.label}: ${(p.bps / 100).toFixed(0)}%`}
          style={{ background: p.color }}
        />
      ))}
    </div>
  );
}
