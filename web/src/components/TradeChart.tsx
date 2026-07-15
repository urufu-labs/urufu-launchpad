'use client';

/// TradingView lightweight-charts wrapper.
///
/// Bonding-curve prices don't behave like an order-book market: every trade moves the
/// price deterministically along the curve, and BETWEEN trades the price is exactly flat.
/// So OHLC candles are the wrong primitive — they invent open/high/low/close data that
/// doesn't exist on a curve with a handful of trades, and read as noise or misleading
/// dojis.
///
/// Instead we render a **step-line area chart**: one point per Trade event, price stays
/// flat until the next trade, then jumps. That's what actually happened on-chain, no
/// aggregation, no fudged wicks. Colors reflect the trend since the previous point
/// (green if up, pink if down), matching the buy/sell theme used elsewhere.
///
/// Units note: raw curve prices are ETH-per-token in the 1e-9 to 1e-6 ETH range —
/// lightweight-charts' default formatter would round these to "0.00". We convert every
/// price to **gwei-per-token** (× 1e9) and auto-tune display precision from the smallest
/// value in the series.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  ColorType,
  LineType,
  type AreaData,
  type IChartApi,
} from 'lightweight-charts';

import { playSfx } from '@/lib/audio/sfx';
import { formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';

export interface TradePoint {
  timestamp: number; // seconds
  priceWeiPerToken: bigint;
}

/// Convert wei-per-token to whichever display unit the toggle is set to. In ETH mode
/// we plot gwei-per-token (× 1e9); in USD mode we plot USD-per-token (× ethUsd / 1e18).
/// Both stay comfortably inside JS Number precision for typical launched-token ranges.
function toDisplay(weiPerToken: bigint, useUsd: boolean, ethUsd: number | null): number {
  if (useUsd && ethUsd) {
    return (Number(weiPerToken) / 1e18) * ethUsd;
  }
  return Number(weiPerToken) / 1e9;
}

/// lightweight-charts asserts data values fit in ±(2^53 / 100). Anything outside — from a
/// broken oracle, an extreme AMM state, or an inverted math bug in the caller — would
/// crash the whole chart. We clamp so a single bad point can't take the page down.
const CHART_MAX_ABS = 9e13; // safe upper bound for both gwei-per-token AND USD ranges.

/// Turn a Trade stream into a step-line series. De-dupes points that share a timestamp
/// (multiple trades in the same block: keep the last one — that's the state observers
/// see when reading the reserve). Sorted ascending by time.
function toSeries(points: TradePoint[], useUsd: boolean, ethUsd: number | null): AreaData[] {
  if (points.length === 0) return [];
  const sorted = [...points]
    .filter((p) => p.priceWeiPerToken > 0n)
    .sort((a, b) => a.timestamp - b.timestamp);
  const byTime = new Map<number, number>();
  let dropped = 0;
  for (const p of sorted) {
    const price = toDisplay(p.priceWeiPerToken, useUsd, ethUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (Math.abs(price) > CHART_MAX_ABS) { dropped++; continue; }
    byTime.set(p.timestamp, price); // later trades at the same second overwrite
  }
  if (dropped > 0) console.warn(`TradeChart: dropped ${dropped} out-of-range price points`);
  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as AreaData['time'], value }));
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
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const useUsd = unit === 'usd' && ethUsd !== null && ethUsd > 0;

  const series = useMemo(() => toSeries(points, useUsd, ethUsd), [points, useUsd, ethUsd]);

  // Direction of the last move — colors the series green if up-only-or-flat, pink if
  // the latest trade dropped the price below its predecessor. Cheap eyeball signal.
  const isUp = useMemo(() => {
    if (series.length < 2) return true;
    const last = series[series.length - 1].value;
    const prev = series[series.length - 2].value;
    return last >= prev;
  }, [series]);

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

  // Auto-tune display precision from the smallest value in the series so brand-new
  // launches (tiny gwei) still get readable ticks, while mature curves don't drown in
  // trailing zeros. Precision caps at 8 to match lightweight-charts' internal limit.
  const precision = useMemo(() => {
    if (series.length === 0) return 4;
    const min = Math.min(...series.map((p) => p.value));
    if (!Number.isFinite(min) || min <= 0) return 6;
    const magnitude = Math.floor(Math.log10(min));
    return Math.max(2, Math.min(8, 4 - magnitude));
  }, [series]);

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
      crosshair: {
        // horz + vert dashed lines; tooltip in top-left shows the value.
        horzLine: { color: '#3a2c3a', width: 1, style: 3, labelBackgroundColor: '#3a2c3a' },
        vertLine: { color: '#3a2c3a', width: 1, style: 3, labelBackgroundColor: '#3a2c3a' },
      },
      localization: {
        // Convert the display value back to wei so formatPrice can use its adaptive
        // ladder (subscript for tiny USD, gwei formatting for ETH). Keeps the chart's
        // Y-axis + crosshair tooltip labeled in the same units + notation as every
        // other price on the page.
        priceFormatter: (p: number) => {
          if (!Number.isFinite(p) || p <= 0) return '—';
          const weiPerToken = useUsd && ethUsd
            ? BigInt(Math.round((p / ethUsd) * 1e18))
            : BigInt(Math.round(p * 1e9));
          return formatPrice(weiPerToken, unit, ethUsd);
        },
      },
    });
    const upColor = '#6bcb77';
    const downColor = '#e86e84';
    const line = chart.addSeries(AreaSeries, {
      lineType: LineType.WithSteps,
      lineWidth: 2,
      lineColor: isUp ? upColor : downColor,
      topColor: isUp ? 'rgba(107, 203, 119, 0.35)' : 'rgba(232, 110, 132, 0.35)',
      bottomColor: isUp ? 'rgba(107, 203, 119, 0)' : 'rgba(232, 110, 132, 0)',
      // Show a small marker on every trade point so a single-trade curve isn't invisible.
      pointMarkersVisible: series.length <= 40,
      pointMarkersRadius: 3,
      priceFormat: {
        type: 'price',
        precision,
        minMove: 1 / Math.pow(10, precision),
      },
    });
    line.setData(series);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, [series, precision, isUp]);

  return (
    <div
      // Height uses clamp() so the chart is a legible 320px on desktop but folds down to
      // ~220px on phone-width viewports (below ~640px). Skips a media-query listener +
      // JS re-render since it's pure CSS.
      style={{
        position: 'relative',
        width: '100%',
        height: 'clamp(220px, 30vw, 320px)',
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
      {/* Unit label — pixel font, top-left, so users know the y-axis scale */}
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
        price ✿ {useUsd ? 'USD per token' : 'gwei per token'} · step per trade
      </div>
      {series.length === 0 && (
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
