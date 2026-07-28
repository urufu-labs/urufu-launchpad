'use client';

/// TradingView lightweight-charts wrapper — dual mode:
///
///  - **Step-line** (default when < 15 trades exist): one point per trade, flat
///    between them, colored green if trending up / pink if trending down.
///    Mathematically honest — every price shown IS the price a trader would
///    have seen right after that trade landed. Good for launch-phase testing
///    when you have 3-5 trades and candles would collapse into meaningless
///    giant blocks.
///
///  - **Candlesticks + volume** (default when >= 15 trades, or user toggles):
///    OHLC bucketed by user-selected interval (1m / 5m / 15m / 1h / 4h / 1d)
///    with a volume histogram at the bottom. Trades-per-bucket used as
///    volume proxy (real ETH volume would require the caller to pass the
///    per-trade eth amount — currently not in TradePoint shape). Best for
///    active v4 pool trading post-graduation.
///
///  - User can force either mode via a `[step / candles]` toggle pill in the
///    top-left of the chart. Mode-switch resets the interval to the default
///    for the current data range.
///
/// Colors: brand mint-hot (up) + pink-hot (down) instead of the classic
/// green/red. Volume bars use the same up/down color at 55% opacity.
///
/// Units note: raw curve prices are ETH-per-token in the 1e-9 to 1e-6 ETH range —
/// lightweight-charts' default formatter would round these to "0.00". We convert every
/// price to **gwei-per-token** (× 1e9) and auto-tune display precision from the smallest
/// value in the series.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  LineType,
  type AreaData,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { playSfx } from '@/lib/audio/sfx';
import { formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';

export interface TradePoint {
  timestamp: number; // seconds
  priceWeiPerToken: bigint;
}

/// Below this many trades, default to step-line. Above, default to candles.
/// User can override with the mode toggle. Set high enough that a
/// bonding-curve launch (typically < 30 trades before graduation) stays on
/// the step-line — candles look sparse and misleading with few points.
/// Post-graduation v4 pools blow past this quickly and get real candles.
const CANDLE_AUTO_THRESHOLD = 30;

const UP_COLOR = '#2fbf6a';
const DOWN_COLOR = '#ff88b3';
const UP_VOL = 'rgba(47, 191, 106, 0.55)';
const DOWN_VOL = 'rgba(255, 136, 179, 0.55)';

function toDisplay(weiPerToken: bigint, useUsd: boolean, ethUsd: number | null): number {
  if (useUsd && ethUsd) {
    return (Number(weiPerToken) / 1e18) * ethUsd;
  }
  return Number(weiPerToken) / 1e9;
}

const CHART_MAX_ABS = 9e13;

const INTERVALS = [
  { key: '1m', label: '1m', seconds: 60 },
  { key: '5m', label: '5m', seconds: 5 * 60 },
  { key: '15m', label: '15m', seconds: 15 * 60 },
  { key: '1h', label: '1h', seconds: 60 * 60 },
  { key: '4h', label: '4h', seconds: 4 * 60 * 60 },
  { key: '1d', label: '1d', seconds: 24 * 60 * 60 },
] as const;
type IntervalKey = (typeof INTERVALS)[number]['key'];

function pickDefaultInterval(spanSeconds: number): IntervalKey {
  if (spanSeconds < 30 * 60) return '1m';
  if (spanSeconds < 2 * 60 * 60) return '5m';
  if (spanSeconds < 24 * 60 * 60) return '15m';
  if (spanSeconds < 7 * 24 * 60 * 60) return '1h';
  if (spanSeconds < 60 * 24 * 60 * 60) return '4h';
  return '1d';
}

/// Step-line series — one point per trade, no aggregation.
function toStepSeries(points: TradePoint[], useUsd: boolean, ethUsd: number | null): AreaData[] {
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
    byTime.set(p.timestamp, price);
  }
  if (dropped > 0) console.warn(`TradeChart: dropped ${dropped} out-of-range price points`);
  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as AreaData['time'], value }));
}

/// OHLC candles bucketed by interval + trade-count volume histogram.
///
/// Key detail: on a bonding curve, each trade IS the price movement — there's
/// no separate bid/ask spread that could give a bucket its own open + close.
/// If we naively use the first trade's price as `open` and the last trade's
/// price as `close`, single-trade buckets become dojis (open == close) and
/// even multi-trade buckets skip the "gap" between the previous bucket's
/// close and the current bucket's open.
///
/// Fix: carry `lastClose` forward across buckets. Every bucket's `open` is
/// the previous bucket's `close` (i.e., the price the market was sitting at
/// when the bucket started). The FIRST-EVER bucket has no predecessor, so
/// it falls back to using its first trade's price as `open` (a doji only
/// for the very first bar of the whole series). high/low always include
/// `open` so the wick reflects the full move.
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
  const bucketOrder: number[] = [];
  let lastClose: number | null = null;

  for (const p of sorted) {
    const price = toDisplay(p.priceWeiPerToken, useUsd, ethUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (Math.abs(price) > CHART_MAX_ABS) continue;
    const bucketStart = Math.floor(p.timestamp / intervalSeconds) * intervalSeconds;
    let b = buckets.get(bucketStart);
    if (!b) {
      // Open = previous bucket's close (the market's state at bucket start).
      // First-ever bucket has no predecessor — fall back to this trade's price.
      const openAtBucketStart = lastClose ?? price;
      b = {
        open: openAtBucketStart,
        high: Math.max(openAtBucketStart, price),
        low: Math.min(openAtBucketStart, price),
        close: price,
        count: 1,
      };
      buckets.set(bucketStart, b);
      bucketOrder.push(bucketStart);
    } else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.count += 1;
    }
    lastClose = price;
  }

  const candles: CandlestickData[] = bucketOrder.map((t) => {
    const b = buckets.get(t)!;
    return { time: t as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close };
  });
  const volumes: HistogramData[] = bucketOrder.map((t) => {
    const b = buckets.get(t)!;
    const up = b.close >= b.open;
    return { time: t as UTCTimestamp, value: b.count, color: up ? UP_VOL : DOWN_VOL };
  });
  return { candles, volumes };
}

type ChartMode = 'step' | 'candles' | 'auto';

export function TradeChart({
  points,
  flashKey,
  flashSide,
}: {
  points: TradePoint[];
  flashKey?: number | string | null;
  flashSide?: 'buy' | 'sell';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const useUsd = unit === 'usd' && ethUsd !== null && ethUsd > 0;

  // Mode toggle — starts on 'auto' which picks step-line for low-trade counts
  // and candles once activity picks up. User can force 'step' or 'candles'.
  const [mode, setMode] = useState<ChartMode>('auto');
  const effectiveMode: 'step' | 'candles' = useMemo(() => {
    if (mode === 'step') return 'step';
    if (mode === 'candles') return 'candles';
    return points.length >= CANDLE_AUTO_THRESHOLD ? 'candles' : 'step';
  }, [mode, points.length]);

  const [intervalKey, setIntervalKey] = useState<IntervalKey | null>(null);
  const spanSeconds = useMemo(() => {
    if (points.length < 2) return 0;
    const ts = points.map((p) => p.timestamp);
    return Math.max(...ts) - Math.min(...ts);
  }, [points]);
  const effectiveInterval = useMemo(
    () => intervalKey ?? pickDefaultInterval(spanSeconds),
    [intervalKey, spanSeconds],
  );
  const intervalSeconds = useMemo(
    () => INTERVALS.find((i) => i.key === effectiveInterval)?.seconds ?? 60 * 60,
    [effectiveInterval],
  );

  // Step-line series
  const stepSeries = useMemo(() => toStepSeries(points, useUsd, ethUsd), [points, useUsd, ethUsd]);
  const isUp = useMemo(() => {
    if (stepSeries.length < 2) return true;
    const last = stepSeries[stepSeries.length - 1].value;
    const prev = stepSeries[stepSeries.length - 2].value;
    return last >= prev;
  }, [stepSeries]);

  // Candle series
  const { candles, volumes } = useMemo(
    () => toCandles(points, useUsd, ethUsd, intervalSeconds),
    [points, useUsd, ethUsd, intervalSeconds],
  );

  // Flash overlay
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

  // Auto-tune precision — use step values if step mode, candle lows if candle mode
  const precision = useMemo(() => {
    let min = Infinity;
    if (effectiveMode === 'step') {
      for (const p of stepSeries) if (p.value < min) min = p.value;
    } else {
      for (const c of candles) if (c.low < min) min = c.low;
    }
    if (!Number.isFinite(min) || min <= 0) return 6;
    const magnitude = Math.floor(Math.log10(min));
    return Math.max(2, Math.min(8, 4 - magnitude));
  }, [effectiveMode, stepSeries, candles]);

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
      rightPriceScale: {
        borderColor: '#3a2c3a',
        scaleMargins: effectiveMode === 'candles'
          ? { top: 0.06, bottom: 0.28 }
          : { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#3a2c3a',
        timeVisible: true,
        secondsVisible: false,
        // Fixed bar width so a handful of candles don't inflate to giant
        // blocks. Default was ~6px which fitContent() then overrode; with 4
        // bars fitContent stretched each to ~100px+. Pinning barSpacing to
        // 8px keeps them sticker-thin whether you have 4 or 400 candles.
        barSpacing: 8,
        // Allow zoom-out to see very old data but keep min zoom-in tight.
        minBarSpacing: 2,
        // Trailing padding so the newest bar isn't glued to the right edge.
        rightOffset: 4,
      },
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

    if (effectiveMode === 'step') {
      const line = chart.addSeries(AreaSeries, {
        lineType: LineType.WithSteps,
        lineWidth: 2,
        lineColor: isUp ? UP_COLOR : DOWN_COLOR,
        topColor: isUp ? 'rgba(47, 191, 106, 0.35)' : 'rgba(255, 136, 179, 0.35)',
        bottomColor: isUp ? 'rgba(47, 191, 106, 0)' : 'rgba(255, 136, 179, 0)',
        pointMarkersVisible: stepSeries.length <= 40,
        pointMarkersRadius: 3,
        priceFormat: {
          type: 'price',
          precision,
          minMove: 1 / Math.pow(10, precision),
        },
      });
      line.setData(stepSeries);
    } else {
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
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: UP_VOL,
        // Hide the last-value price line + label on the volume series. Without
        // these, the volume histogram renders a bogus "$1.0000" (or whatever
        // the last bucket count is) using the PRICE formatter on the right
        // axis, which reads as a real price level and cluters the chart.
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({
        // Volume gets the bottom 15% of the chart. Top 85% left for candles.
        // Was 22% + no explicit top-pane margin, so with sparse data the
        // volume bar filled ~half the visible area.
        scaleMargins: { top: 0.85, bottom: 0 },
      });
      // Also compress the candle pane's own margins so the candles don't
      // hover in the middle third with dead space above and below when the
      // price range is tight (typical for a few 0.001 ETH buys).
      chart.priceScale('right').applyOptions({
        scaleMargins: { top: 0.08, bottom: 0.2 },
      });
      volume.setData(volumes);
    }

    // Zoom behavior differs by mode:
    //  - Candles: keep bars at their fixed 8px width; scroll to the newest
    //    bar. fitContent() here would inflate a handful of bars into giant
    //    blocks (the earlier bug).
    //  - Step-line: fitContent() looks right at any zoom (a line is a line),
    //    and keeping barSpacing pinned would squish the series into a
    //    narrow band on the right. Let it fill the width.
    if (effectiveMode === 'candles') {
      chart.timeScale().scrollToRealTime();
    } else {
      chart.timeScale().fitContent();
    }
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [effectiveMode, stepSeries, candles, volumes, precision, isUp, useUsd, ethUsd, unit]);

  const hasData = effectiveMode === 'step' ? stepSeries.length > 0 : candles.length > 0;

  return (
    <div
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

      {/* Mode toggle — top-left, chunky pills. Auto is selected when user
          hasn't touched it; explicit step/candles overrides the auto rule. */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          display: 'flex',
          gap: 4,
          zIndex: 4,
        }}
      >
        {(['step', 'candles'] as const).map((m) => {
          const active = m === effectiveMode;
          const userForced = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(userForced ? 'auto' : m)}
              title={userForced ? 'click again for auto' : `force ${m}`}
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
              {m}
            </button>
          );
        })}
      </div>

      {/* Interval toggle — top-right; only shown in candles mode */}
      {effectiveMode === 'candles' && (
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
      )}

      {/* Unit label — bottom-left so it doesn't fight the toggles */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
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
        {useUsd ? 'USD per token' : 'gwei per token'}
        {effectiveMode === 'candles' && ` · trades per ${effectiveInterval}`}
        {effectiveMode === 'step' && ` · one point per trade`}
      </div>

      {!hasData && (
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
