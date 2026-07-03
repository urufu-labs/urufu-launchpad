'use client';

/// TradingView lightweight-charts wrapper. Takes a list of `TradePoint`s (one per Trade event)
/// and aggregates them into OHLC candles at a chosen resolution on the fly.
///
/// Units note: raw curve prices are ETH-per-token which for a launched memecoin is on the
/// order of 1e-9 to 1e-6 ETH — lightweight-charts' default 2-decimal formatter rounds those
/// to "0.00" on the Y-axis, which is why the chart LOOKED broken. We convert every price to
/// **gwei-per-token** (multiply by 1e9) so the axis + tooltip show real numbers, and pick a
/// precision high enough to survive further shrinkage on brand-new launches. Kept
/// intentionally dependency-light: no realtime WebSocket yet, no Ponder-served candles.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CandlestickSeries,
  type CandlestickData,
  type IChartApi,
} from 'lightweight-charts';

import { playSfx } from '@/lib/audio/sfx';

export interface TradePoint {
  timestamp: number; // seconds
  priceWeiPerToken: bigint;
}

const RESOLUTION_SECONDS = 60; // 1-minute candles for MVP

/// Convert wei-per-token → gwei-per-token as a JS number. Safe because typical launched
/// tokens sit in the 1e9–1e14 wei-per-token range, well within Number precision.
function toGwei(weiPerToken: bigint): number {
  // divide by 1e9 (wei → gwei). We keep sub-gwei precision via Number, since the values
  // we care about (a few gwei to tens of thousands of gwei) fit cleanly in float64.
  return Number(weiPerToken) / 1e9;
}

function aggregate(points: TradePoint[]): CandlestickData[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, { open: number; high: number; low: number; close: number }>();
  for (const p of sorted) {
    if (p.priceWeiPerToken <= 0n) continue; // skip zero-price rows (bad data guard)
    const bucket = Math.floor(p.timestamp / RESOLUTION_SECONDS) * RESOLUTION_SECONDS;
    const price = toGwei(p.priceWeiPerToken);
    if (!Number.isFinite(price) || price <= 0) continue;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { open: price, high: price, low: price, close: price });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, ohlc]) => ({
      time: time as CandlestickData['time'],
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
    }));
}

export function TradeChart({
  points,
  flashKey,
  flashSide,
}: {
  points: TradePoint[];
  /// When this value changes, the chart flashes green (buy) / pink (sell) for ~600ms.
  /// Pass a monotonic counter (tx hash, incrementing nonce, or newest-trade timestamp).
  flashKey?: number | string | null;
  flashSide?: 'buy' | 'sell';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candles = useMemo(() => aggregate(points), [points]);

  // Flash overlay — the animation is keyed on flashCounter so mounting fires the CSS keyframe
  // from the start every time. flashKey drives when to bump the counter; flashSide picks color.
  const seenKeyRef = useRef<typeof flashKey>(undefined);
  const [flashCounter, setFlashCounter] = useState(0);
  const [flashActive, setFlashActive] = useState<'buy' | 'sell' | null>(null);
  useEffect(() => {
    if (flashKey != null && flashKey !== seenKeyRef.current) {
      const isFirstEver = seenKeyRef.current === undefined;
      seenKeyRef.current = flashKey;
      setFlashCounter((n) => n + 1);
      setFlashActive(flashSide ?? 'buy');
      // Skip audio on the first render — we don't want the chart to blast a sound just
      // because the newest indexed trade happened to seed the flash key on mount.
      if (!isFirstEver) playSfx(flashSide === 'sell' ? 'trade-sell' : 'trade-buy');
      const t = window.setTimeout(() => setFlashActive(null), 620);
      return () => window.clearTimeout(t);
    }
  }, [flashKey, flashSide]);

  // Auto-tune display precision from the smallest close in the dataset so brand-new
  // launches (tiny gwei) still get readable ticks, while mature curves don't drown in
  // trailing zeros. Precision caps at 8 to match lightweight-charts' internal limit.
  const precision = useMemo(() => {
    if (candles.length === 0) return 4;
    const min = Math.min(...candles.map((c) => c.close as number));
    if (!Number.isFinite(min) || min <= 0) return 6;
    // We want 4–5 significant digits above the noise floor.
    const magnitude = Math.floor(Math.log10(min));
    return Math.max(2, Math.min(8, 4 - magnitude));
  }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#fff8e7' },
        textColor: '#3a2c3a',
        fontFamily: 'Pixelify Sans, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(58, 44, 58, 0.08)' },
        horzLines: { color: 'rgba(58, 44, 58, 0.08)' },
      },
      rightPriceScale: { borderColor: '#3a2c3a' },
      timeScale: { borderColor: '#3a2c3a', timeVisible: true, secondsVisible: false },
      autoSize: true,
      localization: {
        priceFormatter: (p: number) => p.toFixed(precision),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#8ee0a0',
      downColor: '#ff6f9e',
      borderUpColor: '#3a2c3a',
      borderDownColor: '#3a2c3a',
      wickUpColor: '#3a2c3a',
      wickDownColor: '#3a2c3a',
      priceFormat: {
        type: 'price',
        precision,
        minMove: 1 / Math.pow(10, precision),
      },
    });
    series.setData(candles);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, [candles, precision]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: 320,
        border: '1.5px solid var(--anchor)',
        boxShadow: '3px 3px 0 var(--anchor)',
        background: '#fff8e7',
        boxSizing: 'border-box',
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
        }}
      />
      {/* Flash overlay — spans the whole wrapper. No blend mode: canvas + blend behaves
          inconsistently, easier to just tune the alpha directly. */}
      {flashActive && (
        <div
          key={flashCounter}
          aria-hidden
          className="uru-chart-flash"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: flashActive === 'buy'
              ? 'rgba(107, 203, 119, 0.38)'
              : 'rgba(232, 110, 132, 0.38)',
            zIndex: 5,
          }}
        />
      )}
      {/* Unit label — pixel font, top-right, so users know the y-axis scale */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 12,
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10,
          color: 'var(--anchor-soft)',
          background: 'rgba(255, 248, 231, 0.9)',
          padding: '2px 6px',
          border: '1px solid rgba(58, 44, 58, 0.2)',
          pointerEvents: 'none',
        }}
      >
        price ✿ gwei per token
      </div>
      {candles.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 12,
            color: 'var(--anchor-soft)',
            pointerEvents: 'none',
          }}
        >
          no trades yet ~~ chart lights up on first buy
        </div>
      )}
    </div>
  );
}
