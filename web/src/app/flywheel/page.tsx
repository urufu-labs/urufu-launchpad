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

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useReadContracts } from 'wagmi';

import { feeSplitterAbi } from '@/lib/abis';
import { FLYWHEEL, type ChainKey } from '@/lib/config';
import { CHAIN_KEY_TO_ID, type WagmiChainId } from '@/lib/wagmi';

const CHAIN: ChainKey = 'robinhood';
const CHAIN_ID = CHAIN_KEY_TO_ID[CHAIN] as WagmiChainId;

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

  const hasPending = parsed?.pending && parsed.pending[6] > 0n;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1
          className="uru-h1"
          style={{ fontSize: 26, fontFamily: 'var(--font-round), cursive' }}
        >
          ✿ flywheel status
        </h1>
        <p style={{ color: 'var(--anchor-soft)', fontSize: 13, margin: '4px 0 0 0' }}>
          public read-only view of where every launch fee goes on Robinhood.
        </p>
      </header>

      {!feeSplitter && (
        <div className="uru-shell" style={{ padding: 12, marginBottom: 16 }}>
          fee splitter not configured for {CHAIN} yet — check back after the next deploy.
        </div>
      )}

      {feeSplitter && parsed && (
        <>
          {/* Split card */}
          <section
            className="uru-shell"
            style={{ padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden style={{ fontSize: 18 }}>♡</span>
              <h2 style={{ margin: 0, fontFamily: 'var(--font-round), cursive', fontSize: 18 }}>
                current split
              </h2>
            </header>

            <SplitBar
              parts={[
                { label: 'URU buyback', bps: parsed.uruBps, color: 'var(--pink-hot)' },
                { label: 'NFT revenue', bps: parsed.nftBps, color: 'var(--mint-hot)' },
                { label: 'treasury', bps: parsed.treasuryBps, color: 'var(--yolk-deep)' },
              ]}
            />

            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
              <SinkRow label="URU buyback" bps={parsed.uruBps} sink={parsed.uruSink} note="ETH → URU on the market → burn" />
              <SinkRow label="NFT revenue" bps={parsed.nftBps} sink={parsed.nftSink} note="drops to gemu holders via Merkle epochs" />
              <SinkRow label="treasury" bps={parsed.treasuryBps} sink={parsed.treasurySink} note="operational + long-term reserves" />
            </ul>
          </section>

          {/* Pending timelock card */}
          {hasPending && (
            <section
              className="uru-shell"
              style={{
                padding: 16,
                marginBottom: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: 'var(--yolk)',
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span aria-hidden style={{ fontSize: 16 }}>⏳</span>
                <strong style={{ fontFamily: 'var(--font-round), cursive', fontSize: 14 }}>
                  config change queued
                </strong>
              </header>
              <p style={{ margin: 0, fontSize: 12 }}>
                a new split is in the URU-A11 timelock, activates{' '}
                <b>{new Date(Number(parsed.pending![6]) * 1000).toLocaleString()}</b>. proposed:
                {' '}{parsed.pending![3] / 100}% URU buyback / {parsed.pending![4] / 100}% NFT rev /
                {' '}{parsed.pending![5] / 100}% treasury.
              </p>
            </section>
          )}

          {/* Sink addresses */}
          <section
            className="uru-shell"
            style={{ padding: 12, marginBottom: 16, fontSize: 11, color: 'var(--anchor-soft)' }}
          >
            <div style={{ marginBottom: 4 }}>
              contracts: FeeSplitter {short(feeSplitter)}
              {uruBuybackVault && <>, UruBuybackVault {short(uruBuybackVault)}</>}
              {nftRevenueVault && <>, NftRevenueVault {short(nftRevenueVault)}</>}
            </div>
            <div>
              min config delay:{' '}
              {parsed.minDelay > 0n
                ? `${Number(parsed.minDelay) / 86_400} days (URU-A11)`
                : 'none'}
            </div>
          </section>
        </>
      )}

      {/* Activity feed placeholder — the indexer has to subscribe to
          FeeSplitter.Distributed + UruBuybackVault.BuybackExecuted +
          UruDepositSink.ConversionExecuted before this section can render
          historical rows. Those subscriptions can land in a follow-up PR
          (add the ABIs to ponder.config.ts + handlers to src/index.ts). */}
      <section
        className="uru-shell"
        style={{ padding: 12, color: 'var(--anchor-soft)', fontSize: 12, marginBottom: 8 }}
      >
        <div style={{ marginBottom: 4 }}>
          <b>recent activity</b>
        </div>
        <p style={{ margin: 0 }}>
          buyback + distribution event feed lands once the indexer subscribes to the
          FeeSplitter + UruBuybackVault events. until then, this stays quiet ~
        </p>
      </section>
    </div>
  );
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
  sink,
  note,
}: {
  label: string;
  bps: number;
  sink: Address | undefined;
  note: string;
}) {
  return (
    <li style={{ padding: '6px 0', borderTop: '1px solid var(--anchor-soft)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <b>{label}</b>
        <span className="uru-num">{(bps / 100).toFixed(0)}%</span>
      </div>
      <div style={{ color: 'var(--anchor-soft)', fontSize: 11 }}>
        {note} → {sink ? short(sink) : '—'}
      </div>
    </li>
  );
}

function short(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
