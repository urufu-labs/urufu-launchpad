'use client';

/// TradingView lightweight-charts wrapper — step-line only.
///
/// One point per trade, flat between them, colored mint-hot if trending up /
/// pink-hot if trending down. Mathematically honest: every price shown IS the
/// price a trader would have seen right after that trade landed, and the flat
/// segments between trades reflect that on a bonding curve NOTHING happens
/// between trades (no bid/ask spread, no continuous price movement).
///
/// Candles were tried and removed — they require inventing OHLC data that
/// doesn't exist on a bonding curve, and any bucketing choice produces a
/// misleading picture with < 30 trades. Step-line stays honest at every
/// activity level.
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

const UP_COLOR = '#2fbf6a';
const DOWN_COLOR = '#ff88b3';

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
    byTime.set(p.timestamp, price);
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
  flashKey?: number | string | null;
  flashSide?: 'buy' | 'sell';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const useUsd = unit === 'usd' && ethUsd !== null && ethUsd > 0;

  const series = useMemo(() => toSeries(points, useUsd, ethUsd), [points, useUsd, ethUsd]);

  // Direction of the last move — colors the series mint if up-only-or-flat, pink
  // if the latest trade dropped the price below its predecessor.
  const isUp = useMemo(() => {
    if (series.length < 2) return true;
    const last = series[series.length - 1].value;
    const prev = series[series.length - 2].value;
    return last >= prev;
  }, [series]);

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
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(58, 44, 58, 0.08)' },
        horzLines: { color: 'rgba(58, 44, 58, 0.08)' },
      },
      rightPriceScale: {
        borderColor: '#3a2c3a',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#3a2c3a',
        timeVisible: true,
        secondsVisible: false,
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

    const line = chart.addSeries(AreaSeries, {
      lineType: LineType.WithSteps,
      lineWidth: 2,
      lineColor: isUp ? UP_COLOR : DOWN_COLOR,
      topColor: isUp ? 'rgba(47, 191, 106, 0.35)' : 'rgba(255, 136, 179, 0.35)',
      bottomColor: isUp ? 'rgba(47, 191, 106, 0)' : 'rgba(255, 136, 179, 0)',
      // Always show dot markers so individual trades pop even in tight price ranges.
      pointMarkersVisible: true,
      pointMarkersRadius: 4,
      priceFormat: {
        type: 'price',
        precision,
        minMove: 1 / Math.pow(10, precision),
      },
    });
    line.setData(series);

    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [series, precision, isUp, useUsd, ethUsd, unit]);

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
        {useUsd ? 'USD per token' : 'gwei per token'} · one point per trade
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
