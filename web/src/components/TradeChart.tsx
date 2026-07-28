'use client';

/// TradingView lightweight-charts wrapper — candlestick + trade-count volume.
///
/// Design tradeoff: on a bonding curve, price is deterministic per trade and flat
/// between trades — a step line is mathematically the most honest picture. But
/// candles are what users read fluently from every other market chart on the
/// internet. We render candles bucketed by a user-selectable interval; buckets
/// with a single trade render as a doji (open == close), buckets with many
/// trades show the full OHLC range. Post-graduation (v4 pool trades) this is
/// exactly the right primitive.
///
/// Colors: brand mint-hot (up) + pink-hot (down) instead of the classic
/// green/red. Volume bars use the same up/down color at 60% opacity.
///
/// Units note: raw curve prices are ETH-per-token in the 1e-9 to 1e-6 ETH range —
/// lightweight-charts' default formatter would round these to "0.00". We convert every
/// price to **gwei-per-token** (× 1e9) and auto-tune display precision from the smallest
/// value in the series.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { playSfx } from '@/lib/audio/sfx';
import { formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';

export interface TradePoint {
  timestamp: number; // seconds
  priceWeiPerToken: bigint;
}

/// Brand candle colors — mint-hot for up, pink-hot for down (matches --mint-hot
/// / --pink-hot in globals.css). Solid fill + wick match so the chart reads as
/// "sticker" flat blocks rather than the hollow classical candles.
const UP_COLOR = '#2fbf6a';
const DOWN_COLOR = '#ff88b3';
/// Volume bars use the same color pair at 55% alpha so the histogram doesn't
/// steal attention from the candles.
const UP_VOL = 'rgba(47, 191, 106, 0.55)';
const DOWN_VOL = 'rgba(255, 136, 179, 0.55)';

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
const CHART_MAX_ABS = 9e13;

/// Bucket intervals in seconds. Order matters — used to pick the default when
/// the series spans a small time range so tiny curves don't degenerate to a
/// single wide candle.
const INTERVALS = [
  { key: '5m', label: '5m', seconds: 5 * 60 },
  { key: '15m', label: '15m', seconds: 15 * 60 },
  { key: '1h', label: '1h', seconds: 60 * 60 },
  { key: '4h', label: '4h', seconds: 4 * 60 * 60 },
  { key: '1d', label: '1d', seconds: 24 * 60 * 60 },
] as const;
type IntervalKey = (typeof INTERVALS)[number]['key'];

/// Given a time span in seconds, pick a sensible default bucket so the chart
/// shows ~30-80 candles rather than 3 huge blocks or 1000 shard dojis.
function pickDefaultInterval(spanSeconds: number): IntervalKey {
  if (spanSeconds < 2 * 60 * 60) return '5m';
  if (spanSeconds < 24 * 60 * 60) return '15m';
  if (spanSeconds < 7 * 24 * 60 * 60) return '1h';
  if (spanSeconds < 60 * 24 * 60 * 60) return '4h';
  return '1d';
}

/// Bucket trade points into OHLC candles + a volume histogram (trades-per-bucket).
/// A single-trade bucket renders as a doji (open == high == low == close), which
/// is fine — that IS what happened. Multi-trade buckets get the full OHLC shape
/// derived from the actual per-trade prices in that window.
function toCandles(
  points: TradePoint[],
  useUsd: boolean,
  ethUsd: number | null,
  intervalSeconds: number,
): { candles: CandlestickData[]; volumes: HistogramData[] } {
  if (points.length === 0 || intervalSeconds <= 0) return { candles: [], volumes: [] };

  const sorted = [...points]
    .filter((p) => p.priceWeiPerToken > 0n)
    .sort((a, b) => a.timestamp - b.timestamp);

  type Bucket = { open: number; high: number; low: number; close: number; count: number };
  const buckets = new Map<number, Bucket>();
  let dropped = 0;
  for (const p of sorted) {
    const price = toDisplay(p.priceWeiPerToken, useUsd, ethUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (Math.abs(price) > CHART_MAX_ABS) {
      dropped++;
      continue;
    }
    const bucketStart = Math.floor(p.timestamp / intervalSeconds) * intervalSeconds;
    const b = buckets.get(bucketStart);
    if (!b) {
      buckets.set(bucketStart, { open: price, high: price, low: price, close: price, count: 1 });
    } else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.count += 1;
    }
  }
  if (dropped > 0) console.warn(`TradeChart: dropped ${dropped} out-of-range price points`);

  const times = Array.from(buckets.keys()).sort((a, b) => a - b);
  const candles: CandlestickData[] = times.map((t) => {
    const b = buckets.get(t)!;
    return { time: t as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close };
  });
  const volumes: HistogramData[] = times.map((t) => {
    const b = buckets.get(t)!;
    const up = b.close >= b.open;
    return { time: t as UTCTimestamp, value: b.count, color: up ? UP_VOL : DOWN_VOL };
  });
  return { candles, volumes };
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
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const useUsd = unit === 'usd' && ethUsd !== null && ethUsd > 0;

  // Auto-select bucket size from the series' time span, then let the user
  // override via the interval pill row.
  const [intervalKey, setIntervalKey] = useState<IntervalKey | null>(null);
  const spanSeconds = useMemo(() => {
    if (points.length < 2) return 0;
    const ts = points.map((p) => p.timestamp);
    return Math.max(...ts) - Math.min(...ts);
  }, [points]);
  const effectiveInterval = useMemo(() => {
    if (intervalKey) return intervalKey;
    return pickDefaultInterval(spanSeconds);
  }, [intervalKey, spanSeconds]);
  const intervalSeconds = useMemo(
    () => INTERVALS.find((i) => i.key === effectiveInterval)?.seconds ?? 60 * 60,
    [effectiveInterval],
  );

  const { candles, volumes } = useMemo(
    () => toCandles(points, useUsd, ethUsd, intervalSeconds),
    [points, useUsd, ethUsd, intervalSeconds],
  );

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
      if (!isFirstEver) playSfx(flashSide === 'sell' ? 'trade-sell' : 'trade-buy');
      const t = window.setTimeout(() => setFlashActive(null), 620);
      return () => window.clearTimeout(t);
    }
  }, [flashKey, flashSide]);

  // Auto-tune display precision from the smallest value across all candles.
  const precision = useMemo(() => {
    if (candles.length === 0) return 4;
    let min = Infinity;
    for (const c of candles) if (c.low < min) min = c.low;
    if (!Number.isFinite(min) || min <= 0) return 6;
    const magnitude = Math.floor(Math.log10(min));
    return Math.max(2, Math.min(8, 4 - magnitude));
  }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#fff8e7' },
        textColor: '#3a2c3a',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(58, 44, 58, 0.08)' },
        horzLines: { color: 'rgba(58, 44, 58, 0.08)' },
      },
      rightPriceScale: { borderColor: '#3a2c3a', scaleMargins: { top: 0.06, bottom: 0.28 } },
      timeScale: { borderColor: '#3a2c3a', timeVisible: true, secondsVisible: false },
      autoSize: true,
      crosshair: {
        horzLine: { color: '#3a2c3a', width: 1, style: 3, labelBackgroundColor: '#3a2c3a' },
        vertLine: { color: '#3a2c3a', width: 1, style: 3, labelBackgroundColor: '#3a2c3a' },
      },
      localization: {
        priceFormatter: (p: number) => {
          if (!Number.isFinite(p) || p <= 0) return '—';
          const weiPerToken = useUsd && ethUsd
            ? BigInt(Math.round((p / ethUsd) * 1e18))
            : BigInt(Math.round(p * 1e9));
          return formatPrice(weiPerToken, unit, ethUsd);
        },
      },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      priceFormat: {
        type: 'price',
        precision,
        minMove: 1 / Math.pow(10, precision),
      },
    });
    candle.setData(candles);
    candleRef.current = candle;

    // Volume pane — pinned to the bottom 22% of the chart via priceScaleId.
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: UP_VOL,
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    volume.setData(volumes);
    volumeRef.current = volume;

    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [candles, volumes, precision, useUsd, ethUsd, unit]);

  return (
    <div
      // Height uses clamp() so the chart is a legible 320px on desktop but folds down to
      // ~220px on phone-width viewports (below ~640px). Skips a media-query listener +
      // JS re-render since it's pure CSS.
      style={{
        position: 'relative',
        width: '100%',
        height: 'clamp(280px, 34vw, 420px)',
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
      {/* Flash overlay — spans the whole wrapper. */}
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
              ? 'rgba(47, 191, 106, 0.32)'
              : 'rgba(255, 136, 179, 0.32)',
            zIndex: 5,
          }}
        />
      )}
      {/* Interval toggle — top-right chunky pills, matches CheekyB's style */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          gap: 4,
          zIndex: 4,
        }}
      >
        {INTERVALS.map((i) => {
          const active = i.key === effectiveInterval;
          return (
            <button
              key={i.key}
              type="button"
              onClick={() => setIntervalKey(i.key)}
              style={{
                fontFamily: 'var(--font-round), Klee One, cursive',
                fontSize: 11,
                fontWeight: 700,
                padding: '3px 9px',
                borderRadius: 999,
                border: '1.5px solid var(--anchor)',
                background: active ? 'var(--mint-hot)' : 'rgba(255, 248, 231, 0.9)',
                color: active ? '#fff' : 'var(--anchor)',
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              {i.label}
            </button>
          );
        })}
      </div>
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
          zIndex: 4,
        }}
      >
        price ✿ {useUsd ? 'USD per token' : 'gwei per token'} · trades per {effectiveInterval}
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
