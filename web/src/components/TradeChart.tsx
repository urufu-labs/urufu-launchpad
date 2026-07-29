'use client';

/// TradingView lightweight-charts wrapper, step-line with buy/sell markers.
///
/// Design goals:
///   - Zero reflash on polls. The chart instance is created ONCE per mount +
///     setData()'d once with initial history. Every subsequent trade poll uses
///     series.update() for the new bar and setMarkers() for the delta list.
///     No teardown, no full repaint. Matches the pattern from lightweight-charts
///     realtime-updates docs.
///   - Buy/sell markers on the price line so it reads as a trading terminal.
///     Up-arrow mint = buy, down-arrow pink = sell.
///   - Step-line only (candles removed earlier, per user pref).
///
/// Units note: raw curve prices are ETH-per-token in the 1e-9 to 1e-6 ETH range.
/// lightweight-charts' default formatter would round these to "0.00". We convert
/// every price to gwei-per-token (× 1e9) and auto-tune display precision from
/// the smallest value in the series.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  ColorType,
  LineType,
  createSeriesMarkers,
  type AreaData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';

import { playSfx } from '@/lib/audio/sfx';
import { formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';

export interface TradePoint {
  timestamp: number; // seconds
  priceWeiPerToken: bigint;
  /// Optional: when set, the chart draws a buy/sell marker at this point.
  /// Caller is free to omit for e.g. mock data or bulk-loads where side isn't
  /// known.
  isBuy?: boolean;
}

const UP_COLOR = '#2fbf6a';
const DOWN_COLOR = '#ff88b3';

function toDisplay(weiPerToken: bigint, useUsd: boolean, ethUsd: number | null): number {
  if (useUsd && ethUsd) return (Number(weiPerToken) / 1e18) * ethUsd;
  return Number(weiPerToken) / 1e9;
}

/// lightweight-charts asserts data values fit in ±(2^53 / 100). Anything outside
/// (broken oracle, extreme AMM state, inverted math) would crash the chart.
/// Clamp so a single bad point can't take the page down.
const CHART_MAX_ABS = 9e13;

/// Sanitize + sort + dedupe-by-timestamp so the internal series stays monotonic.
/// lightweight-charts requires strictly ascending time on update() calls or it
/// throws.
function normalize(points: TradePoint[]): TradePoint[] {
  const byTime = new Map<number, TradePoint>();
  for (const p of points) {
    if (p.priceWeiPerToken <= 0n) continue;
    const price = Number(p.priceWeiPerToken);
    if (!Number.isFinite(price) || price <= 0) continue;
    // Later trades at the same second overwrite earlier ones. This matches how
    // observers read reserves after a multi-trade block.
    byTime.set(p.timestamp, p);
  }
  return Array.from(byTime.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function toAreaData(p: TradePoint, useUsd: boolean, ethUsd: number | null): AreaData | null {
  const value = toDisplay(p.priceWeiPerToken, useUsd, ethUsd);
  if (!Number.isFinite(value) || value <= 0 || Math.abs(value) > CHART_MAX_ABS) return null;
  return { time: p.timestamp as AreaData['time'], value };
}

function toMarker(p: TradePoint): SeriesMarker<Time> | null {
  if (p.isBuy === undefined) return null;
  // Small colored circle sitting ON the price line (inBar position). Replaces
  // the built-in AreaSeries pointMarkersVisible dots so buy/sell information
  // fully substitutes for the neutral gray dots instead of double-marking.
  // aboveBar/belowBar shapes floated visually detached from the actual price
  // point which read as "wrong" to users. inBar circles sit exactly where the
  // trade landed.
  return {
    time: p.timestamp as Time,
    position: 'inBar',
    color: p.isBuy ? UP_COLOR : DOWN_COLOR,
    shape: 'circle',
    size: 1,
  };
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
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /// Timestamp of the last point pushed to the series. update() only accepts
  /// times >= the last one. We use this to decide whether a poll's newest
  /// point is 'append' or 'no-op'.
  const lastTimeRef = useRef<number>(0);

  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  const useUsd = unit === 'usd' && ethUsd !== null && ethUsd > 0;

  const sorted = useMemo(() => normalize(points), [points]);

  const isUp = useMemo(() => {
    if (sorted.length < 2) return true;
    const last = sorted[sorted.length - 1].priceWeiPerToken;
    const prev = sorted[sorted.length - 2].priceWeiPerToken;
    return last >= prev;
  }, [sorted]);

  const precision = useMemo(() => {
    if (sorted.length === 0) return 4;
    let min = Infinity;
    for (const p of sorted) {
      const v = toDisplay(p.priceWeiPerToken, useUsd, ethUsd);
      if (v < min) min = v;
    }
    if (!Number.isFinite(min) || min <= 0) return 6;
    const magnitude = Math.floor(Math.log10(min));
    return Math.max(2, Math.min(8, 4 - magnitude));
  }, [sorted, useUsd, ethUsd]);

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

  // Refs holding the LATEST render values that the formatter closure needs.
  // The chart-creation effect can't re-run every time unit / ethUsd changes
  // (that would reflash the whole chart), so the priceFormatter reads from
  // these refs instead of closing over stale state.
  const unitRef = useRef(unit);
  const useUsdRef = useRef(useUsd);
  const ethUsdRef = useRef(ethUsd);
  useEffect(() => {
    unitRef.current = unit;
    useUsdRef.current = useUsd;
    ethUsdRef.current = ethUsd;
  }, [unit, useUsd, ethUsd]);

  // ONE-TIME chart creation. Only re-runs on mount / unmount. Deliberately
  // NOT dependent on data, precision, unit, or isUp -- all of those get
  // applied via series.applyOptions() in the data effect below. The previous
  // version depended on isUp + precision which recalculated on every trade
  // poll and forced a full chart teardown+repaint every ~15s.
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
          // Read via refs so this closure never goes stale as unit/ethUsd
          // change. Chart is created ONCE; this formatter runs on every
          // hover / axis tick.
          if (!Number.isFinite(p) || p <= 0) return '~';
          const uUsd = useUsdRef.current;
          const eUsd = ethUsdRef.current;
          const weiPerToken = uUsd && eUsd
            ? BigInt(Math.round((p / eUsd) * 1e18))
            : BigInt(Math.round(p * 1e9));
          return formatPrice(weiPerToken, unitRef.current, eUsd);
        },
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineType: LineType.WithSteps,
      lineWidth: 2,
      lineColor: UP_COLOR,
      topColor: 'rgba(47, 191, 106, 0.35)',
      bottomColor: 'rgba(47, 191, 106, 0)',
      // No built-in point markers. Our own createSeriesMarkers below draws
      // colored buy/sell circles at each trade, which fully replaces the
      // neutral gray dots.
      pointMarkersVisible: false,
      priceFormat: {
        type: 'price',
        precision: 4,
        minMove: 0.0001,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markerPluginRef.current = createSeriesMarkers(series, []);
    lastTimeRef.current = 0;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markerPluginRef.current = null;
      lastTimeRef.current = 0;
    };
  }, []);

  // OPTIONS effect: applies line-color (up/down mint/pink) + precision changes
  // to the existing series WITHOUT recreating the chart. Runs whenever isUp
  // or precision changes but leaves the chart canvas / camera / data intact.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.applyOptions({
      lineColor: isUp ? UP_COLOR : DOWN_COLOR,
      topColor: isUp ? 'rgba(47, 191, 106, 0.35)' : 'rgba(255, 136, 179, 0.35)',
      bottomColor: isUp ? 'rgba(47, 191, 106, 0)' : 'rgba(255, 136, 179, 0)',
      priceFormat: {
        type: 'price',
        precision,
        minMove: 1 / Math.pow(10, precision),
      },
    });
  }, [isUp, precision]);

  // REALTIME DATA effect. On first run after chart create, calls setData() with
  // the whole history. On subsequent runs it walks only the tail (points newer
  // than lastTimeRef) and calls series.update() for each. This is the
  // TradingView-recommended pattern that avoids the reflash.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    const markers = markerPluginRef.current;
    if (!series || !chart) return;

    // First data load (or unit change that reset the chart): use setData once.
    if (lastTimeRef.current === 0) {
      const data: AreaData[] = [];
      for (const p of sorted) {
        const d = toAreaData(p, useUsd, ethUsd);
        if (d) data.push(d);
      }
      if (data.length > 0) {
        series.setData(data);
        lastTimeRef.current = sorted[sorted.length - 1].timestamp;
        chart.timeScale().fitContent();
      }
    } else {
      // Realtime tail: only push points strictly newer than what the series
      // already has. Same-timestamp points are ignored to keep the series
      // monotonic (lightweight-charts throws on out-of-order update()).
      const cutoff = lastTimeRef.current;
      for (const p of sorted) {
        if (p.timestamp <= cutoff) continue;
        const d = toAreaData(p, useUsd, ethUsd);
        if (!d) continue;
        series.update(d);
        lastTimeRef.current = p.timestamp;
      }
    }

    // Markers are always recomputed from the full point list (cheap for our
    // volumes). setMarkers wipes+repaints only the marker layer, not the price
    // line, so there's no visible reflash of the chart itself.
    if (markers) {
      const list: SeriesMarker<Time>[] = [];
      for (const p of sorted) {
        const m = toMarker(p);
        if (m) list.push(m);
      }
      markers.setMarkers(list);
    }
  }, [sorted, useUsd, ethUsd]);

  const hasData = sorted.length > 0;

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
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
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
