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
import { useReadContracts } from 'wagmi';

import { feeSplitterAbi } from '@/lib/abis';
import { FLYWHEEL, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID, type WagmiChainId } from '@/lib/wagmi';
import {
  fetchFlywheelActivity,
  type FlywheelActivityRow,
} from '@/lib/indexer';

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
  /// buyback / nft / treasury on distributions; URU acquired on buybacks) so
  /// summing across them gives lifetime totals without a dedicated aggregate
  /// endpoint. Numbers are capped at whatever MAX_ROWS the feed pulls, which
  /// is fine for launch — a proper `/api/flywheel/totals` endpoint can replace
  /// this later.
  const [activityRows, setActivityRows] = useState<FlywheelActivityRow[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchFlywheelActivity(CHAIN_ID, MAX_ROWS);
        if (cancelled) return;
        setActivityRows(data);
      } catch (err) {
        if (cancelled) return;
        setActivityError(err instanceof Error ? err.message : 'indexer unreachable');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totals = useMemo(() => {
    if (!activityRows) return null;
    let uruBoughtBack = 0n;
    let ethToGemu = 0n;
    let ethToTeam = 0n;
    for (const r of activityRows) {
      if (r.kind === 'distribution') {
        if (r.toNft) ethToGemu += BigInt(r.toNft);
        if (r.toTreasury) ethToTeam += BigInt(r.toTreasury);
      } else if (r.kind === 'buyback') {
        if (r.uruOut) uruBoughtBack += BigInt(r.uruOut);
      }
    }
    return { uruBoughtBack, ethToGemu, ethToTeam };
  }, [activityRows]);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1
          className="uru-h1"
          style={{ fontSize: 26, fontFamily: 'var(--font-round), cursive' }}
        >
          ✿ where launch fees go
        </h1>
        <p style={{ color: 'var(--anchor-soft)', fontSize: 13, margin: '4px 0 0 0' }}>
          every fee paid to launch a token gets split three ways. this page shows the
          current split live from the contracts.
        </p>
      </header>

      {!feeSplitter && (
        <div className="uru-shell" style={{ padding: 12, marginBottom: 16 }}>
          fee split isn&apos;t live yet. check back after the next deploy ~
        </div>
      )}

      {feeSplitter && parsed && (
        <>
          {/* Lifetime totals row — the top-line numbers a visitor should see
              first: what has actually happened, not what percentages will
              apply. Three tiles in a line, responsive down to a single column
              on narrow phones. */}
          <section
            className="uru-shell"
            style={{
              padding: 16,
              marginBottom: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <TotalTile
              label="URU bought back"
              value={totals ? formatBig(totals.uruBoughtBack, 'URU') : '—'}
              tint="var(--pink-hot)"
            />
            <TotalTile
              label="paid to gemu holders"
              value={totals ? formatBig(totals.ethToGemu, 'ETH') : '—'}
              tint="var(--mint-hot)"
            />
            <TotalTile
              label="paid to team + ops"
              value={totals ? formatBig(totals.ethToTeam, 'ETH') : '—'}
              tint="var(--yolk-deep)"
            />
          </section>

          {/* Current split — one compact bar + a caption line. Way lighter
              than the earlier three-row SinkRow list; the labels + %s in the
              caption are enough since the totals above show the effect. */}
          <section
            className="uru-shell"
            style={{ padding: 14, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <header style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span aria-hidden style={{ fontSize: 15 }}>♡</span>
              <h2 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 15 }}>
                the split right now
              </h2>
            </header>
            <SplitBar
              parts={[
                { label: 'URU buyback', bps: parsed.uruBps, color: 'var(--pink-hot)' },
                { label: 'gemu rewards', bps: parsed.nftBps, color: 'var(--mint-hot)' },
                { label: 'team + ops', bps: parsed.treasuryBps, color: 'var(--yolk-deep)' },
              ]}
            />
            <div style={{ fontSize: 12, color: 'var(--anchor-soft)' }}>
              <b>{parsed.uruBps / 100}%</b> URU buyback ·{' '}
              <b>{parsed.nftBps / 100}%</b> gemu rewards ·{' '}
              <b>{parsed.treasuryBps / 100}%</b> team + ops
            </div>
          </section>

          {/* Pending timelock card — only when there's actually one queued. */}
          {hasPending && (
            <section
              className="uru-shell"
              style={{
                padding: 14,
                marginBottom: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: pendingReady ? 'var(--mint)' : 'var(--yolk)',
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden style={{ fontSize: 15 }}>{pendingReady ? '✿' : '⏳'}</span>
                <strong style={{ fontFamily: 'var(--font-round), cursive', fontSize: 14 }}>
                  {pendingReady ? 'new split ready to activate' : 'new split coming soon'}
                </strong>
              </header>
              <p style={{ margin: 0, fontSize: 12 }}>
                {pendingReady
                  ? <>timelock ended{' '}
                    <b>{new Date(pendingReadyAt * 1000).toLocaleString()}</b>. next launch fee
                    after the owner activates: </>
                  : <>new split takes effect{' '}
                    <b>{new Date(pendingReadyAt * 1000).toLocaleString()}</b>. after that: </>}
                <b>{parsed.pending![3] / 100}%</b> URU buyback,{' '}
                <b>{parsed.pending![4] / 100}%</b> gemu rewards,{' '}
                <b>{parsed.pending![5] / 100}%</b> team + ops.
              </p>
            </section>
          )}
        </>
      )}

      <ActivityFeed rows={activityRows} error={activityError} />
    </div>
  );
}

/// One of the three top-line tiles. Big number, tinted underline, small
/// caption. Kept plain so a visitor can scan all three at once.
function TotalTile({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        className="uru-num"
        style={{
          fontSize: 20,
          lineHeight: 1.15,
          fontFamily: 'var(--font-round), cursive',
          borderBottom: `2px solid ${tint}`,
          paddingBottom: 3,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>{label}</div>
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
    <section className="uru-shell" style={{ padding: 12, marginBottom: 8 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span aria-hidden style={{ fontSize: 15 }}>✦</span>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 15 }}>
          what&apos;s been happening
        </h3>
      </header>

      {error && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--anchor-soft)' }}>
          can&apos;t reach the data feed right now, try again in a bit ~
        </p>
      )}

      {!error && rows === null && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--anchor-soft)' }}>loading ~</p>
      )}

      {!error && rows?.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--anchor-soft)' }}>
          nothing yet. the flywheel starts turning the first time a token launches on here ~
        </p>
      )}

      {!error && visibleRows && visibleRows.length > 0 && (
        <>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleRows.map((r) => (
              <ActivityRow key={`${r.kind}-${r.txHash}-${r.blockNumber}`} row={r} />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              style={{
                marginTop: 8,
                background: 'transparent',
                border: 'none',
                color: 'var(--anchor)',
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 11,
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              {expanded ? `show fewer ~` : `show ${hiddenCount} more ~`}
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
        split <b className="uru-num">{formatEth(row.total)}</b> ETH:{' '}
        <span className="uru-num">{formatEth(row.toBuyback)}</span> for URU buyback,{' '}
        <span className="uru-num">{formatEth(row.toNft)}</span> to gemu holders,{' '}
        <span className="uru-num">{formatEth(row.toTreasury)}</span> to team + ops
      </>
    );
  } else if (row.kind === 'buyback') {
    summary = (
      <>
        bought back <b className="uru-num">{formatEth(row.uruOut)}</b> URU (spent{' '}
        <span className="uru-num">{formatEth(row.ethIn)}</span> ETH)
      </>
    );
  } else {
    summary = (
      <>
        traded <b className="uru-num">{formatEth(row.uruIn)}</b> URU for{' '}
        <span className="uru-num">{formatEth(row.ethOut)}</span> ETH
      </>
    );
  }
  const badge =
    row.kind === 'distribution'
      ? { text: 'split', bg: 'var(--yolk-deep)' }
      : row.kind === 'buyback'
        ? { text: 'buyback', bg: 'var(--pink-hot)' }
        : { text: 'trade', bg: 'var(--mint-hot)' };

  return (
    <li
      style={{
        padding: 8,
        border: '1px solid var(--anchor-soft)',
        borderRadius: 8,
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            padding: '1px 6px',
            borderRadius: 4,
            background: badge.bg,
            color: 'var(--anchor)',
            fontFamily: 'var(--font-round), cursive',
          }}
        >
          {badge.text}
        </span>
        <span style={{ color: 'var(--anchor-soft)', fontSize: 11 }}>{when}</span>
      </div>
      <div>{summary}</div>
    </li>
  );
}

function formatEth(v: string | undefined): string {
  if (!v) return '0';
  const s = formatEther(BigInt(v));
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : (whole ?? '0');
}

function SplitBar({ parts }: { parts: Array<{ label: string; bps: number; color: string }> }) {
  const total = parts.reduce((s, p) => s + p.bps, 0);
  return (
    <div
      role="img"
      aria-label={`fee split: ${parts.map((p) => `${p.label} ${(p.bps / 100).toFixed(0)}%`).join(', ')}`}
      style={{
        display: 'flex',
        height: 14,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--anchor)',
      }}
    >
      {parts.map((p) => (
        <div
          key={p.label}
          title={`${p.label} — ${(p.bps / 100).toFixed(0)}%`}
          style={{
            flexBasis: `${total > 0 ? (p.bps * 100) / total : 0}%`,
            background: p.color,
          }}
        />
      ))}
    </div>
  );
}

function SinkRow({
  label,
  bps,
  note,
}: {
  label: string;
  bps: number;
  note: string;
}) {
  return (
    <li style={{ padding: '6px 0', borderTop: '1px solid var(--anchor-soft)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <b>{label}</b>
        <span className="uru-num">{(bps / 100).toFixed(0)}%</span>
      </div>
      <div style={{ color: 'var(--anchor-soft)', fontSize: 11 }}>{note}</div>
    </li>
  );
}

function short(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
