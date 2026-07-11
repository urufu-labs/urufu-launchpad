'use client';

/// Mock trade view — same visual as the live trade page but reads from a static fixture
/// instead of on-chain state. Buy/sell buttons show a "demo mode" banner instead of firing
/// txns. Delete when the indexer + Phase 1 broadcast land.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, formatUnits } from 'viem';

import { TradeChart, type TradePoint } from '@/components/TradeChart';
import { TradeTicker, QuickAmounts, CopyCA, FlashCell, ChatDrawer } from '@/components/TradeEffects';
import { mockMarketCapEth, type MockLaunch } from '@/lib/mockLaunches';
import { formatGweiPerToken } from '@/lib/priceFmt';

type Side = 'buy' | 'sell';

export function MockTradeView({ launch }: { launch: MockLaunch }) {
  const [side, setSide] = useState<Side>('buy');
  const [inputAmount, setInputAmount] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');
  // Fake-trade nonce — bump on the "preview buy/sell" button to fire a chart flash even
  // when there's no real chain event yet. Side comes from the current side toggle.
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewSide, setPreviewSide] = useState<Side>('buy');

  const tradePoints: TradePoint[] = useMemo(
    () =>
      launch.trades.map((t) => ({
        timestamp: t.timestamp,
        priceWeiPerToken:
          t.tokenAmount > 0n ? (t.ethAmount * 10n ** 18n) / t.tokenAmount : 0n,
      })),
    [launch.trades],
  );

  const progressPct = useMemo(() => {
    if (launch.graduated) return 100;
    return Math.min(100, Number((launch.ethReserve * 10_000n) / launch.graduationTargetEth) / 100);
  }, [launch]);

  const spotPrice = useMemo(
    () =>
      ((launch.ethReserve + launch.virtualEthReserve) * 10n ** 18n) /
      (launch.tokenReserve + launch.virtualTokenReserve),
    [launch],
  );

  const marketCap = useMemo(() => mockMarketCapEth(launch), [launch]);
  const tokensSold = launch.curveSupply - launch.tokenReserve;

  const recentTrades = useMemo(() => launch.trades.slice(-25).reverse(), [launch.trades]);
  const tickerTrades = useMemo(
    () => recentTrades.map((t) => ({ isBuy: t.isBuy, eth: t.ethAmount, tokens: t.tokenAmount, trader: t.trader })),
    [recentTrades],
  );

  const newestMockTrade = recentTrades[0];
  const chartFlashKey = previewNonce > 0
    ? `preview-${previewNonce}`
    : newestMockTrade
      ? `${newestMockTrade.timestamp}-${newestMockTrade.trader}`
      : null;
  const chartFlashSide: Side = previewNonce > 0 ? previewSide : (newestMockTrade?.isBuy ? 'buy' : 'sell');

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
      {/* preview-mode strip — slim colored bar */}
      <div
        style={{
          padding: '6px 12px',
          marginBottom: 10,
          background: 'var(--yolk)',
          borderLeft: '4px solid var(--anchor)',
          border: '1.5px solid var(--anchor)',
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10.5,
          color: 'var(--anchor)',
        }}
      >
        <b>◐ preview mode</b> ~ mock token for UI demo. buy/sell buttons are inert til phase 1 broadcasts.
      </div>

      {/* ================================================================
          COMPACT HEADER — identity + mcap + address + fee, one row
          ================================================================ */}
      <section
        className="uru-shell"
        style={{
          padding: '10px 14px',
          marginBottom: 10,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 10,
            border: '1.5px solid var(--anchor)',
            background: launch.logoBg,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 30,
          }}
        >
          {launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1.05 }}>{launch.name}</h1>
            <span style={{ color: 'var(--anchor-soft)', fontFamily: 'var(--font-pixel), monospace', fontSize: 13 }}>
              ${launch.ticker}
            </span>
          </div>
          <div
            style={{
              marginTop: 2,
              display: 'flex',
              gap: 10,
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10.5,
              color: 'var(--anchor-soft)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span>{launch.address.slice(0, 6)}…{launch.address.slice(-4)}</span>
            <span>fee: {launch.tradeFeeBps / 100}%</span>
            <span>{launch.trades.length} trades</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ textAlign: 'right', paddingRight: 8, borderRight: '1px dashed var(--anchor)' }}>
            <div className="uru-eyebrow">mkt cap</div>
            <div
              style={{
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--anchor)',
                lineHeight: 1.05,
              }}
            >
              <FlashCell value={marketCap}>
                {Number(formatEther(marketCap)).toFixed(4)} Ξ
              </FlashCell>
            </div>
          </div>
          <CopyCA address={launch.address} />
        </div>
      </section>

      {/* ================================================================
          GRADUATION STRIP — slim ribbon
          ================================================================ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '4px 10px',
          marginBottom: 10,
          background: 'var(--cream)',
          border: '1.5px solid var(--anchor)',
        }}
      >
        <span className="uru-eyebrow" style={{ flexShrink: 0 }}>
          {launch.graduated ? '✿ graduated' : 'grad → v4'}
        </span>
        <div style={{ flex: 1, height: 10, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)', minWidth: 100 }}>
          <div
            className={progressPct > 85 && !launch.graduated ? 'uru-shimmer' : ''}
            style={{
              width: `${progressPct}%`,
              height: '100%',
              background: launch.graduated ? 'var(--mint-hot)' : 'var(--pink-hot)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
        <span
          style={{
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 11,
            color: 'var(--anchor)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {Number(formatEther(launch.ethReserve)).toFixed(3)} / {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} Ξ
          {' '}<b style={{ color: progressPct > 85 && !launch.graduated ? 'var(--pink-hot)' : 'var(--anchor)' }}>({progressPct.toFixed(1)}%)</b>
        </span>
      </div>

      {/* Live ticker */}
      <div style={{ marginBottom: 10 }}>
        <TradeTicker trades={tickerTrades} symbol={launch.ticker} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* MAIN — chart + recent trades + about + chat */}
        <div className="space-y-3">
          <TradeChart points={tradePoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />

          {/* Recent trades — dense table */}
          <div className="uru-shell-tight" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                background: 'var(--cream-deep)',
                borderBottom: '1.5px solid var(--anchor)',
              }}
            >
              <div className="uru-eyebrow">✿ recent trades</div>
              <span
                style={{
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 10,
                  color: 'var(--anchor-soft)',
                }}
              >
                {recentTrades.length} shown
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '52px 1fr 1fr 1fr',
                gap: 8,
                padding: '4px 10px',
                borderBottom: '1px dotted var(--anchor)',
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 9,
                letterSpacing: '0.08em',
                color: 'var(--anchor-soft)',
                textTransform: 'uppercase',
              }}
            >
              <span>side</span>
              <span>eth</span>
              <span style={{ textAlign: 'right' }}>tokens</span>
              <span style={{ textAlign: 'right' }}>trader</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recentTrades.map((t, i) => (
                <li
                  key={i}
                  className={i === 0 ? 'uru-slide-in' : ''}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '52px 1fr 1fr 1fr',
                    gap: 8,
                    fontFamily: 'var(--font-pixel), monospace',
                    fontSize: 11,
                    alignItems: 'baseline',
                    padding: '4px 10px',
                    borderBottom: i === recentTrades.length - 1 ? 'none' : '1px dotted var(--anchor)',
                  }}
                >
                  <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                    {t.isBuy ? 'BUY' : 'SELL'}
                  </span>
                  <span>{Number(formatEther(t.ethAmount)).toFixed(4)}</span>
                  <span style={{ textAlign: 'right' }}>
                    {Number(formatUnits(t.tokenAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <Link
                    href={`/profile/${t.trader}`}
                    style={{
                      color: 'var(--link-blue)',
                      textDecoration: 'underline',
                      justifySelf: 'end',
                    }}
                  >
                    {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Chat — seeded so preview feels alive */}
          <ChatDrawer
            tokenAddress={launch.address}
            seed={[
              { sender: 'guest_A9F2', text: `just aped in ${launch.ticker} lol`, minutesAgo: 32 },
              { sender: '0x8f31…c0de', text: 'lp locked??', minutesAgo: 21 },
              { sender: 'guest_B8AA', text: 'lp locked forever. read the readme ~', minutesAgo: 20 },
              { sender: 'guest_C1E4', text: `so when does ${launch.ticker} grad`, minutesAgo: 12 },
              { sender: '0x0ba7…f00d', text: 'wen chart flash ✿', minutesAgo: 3 },
            ]}
          />

          {/* About panel */}
          <div className="uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ about</div>
            <p style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 8 }}>{launch.description}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {launch.website && <MiniLink href={launch.website} label="site" />}
              {launch.twitter && <MiniLink href={launch.twitter} label="twitter" />}
              {launch.telegram && <MiniLink href={launch.telegram} label="tg" />}
            </div>
          </div>
        </div>

        {/* SIDEBAR — buy/sell panel */}
        <aside className="space-y-3 lg:sticky lg:top-4 lg:h-fit">
          <div className="uru-shell-tight" style={{ padding: 0, overflow: 'hidden' }}>
            {/* buy/sell tabs — bolder pump-style */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setSide(s); setInputAmount(''); }}
                  style={{
                    padding: '8px 0',
                    fontFamily: 'var(--font-round), Klee One, cursive',
                    fontSize: 14,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    border: 'none',
                    borderBottom: side === s
                      ? `3px solid ${s === 'buy' ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}`
                      : '3px solid transparent',
                    background: side === s
                      ? (s === 'buy' ? 'var(--mint)' : 'var(--pink-warm)')
                      : 'var(--cream-deep)',
                    color: side === s
                      ? (s === 'buy' ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)')
                      : 'var(--anchor-soft)',
                    cursor: 'pointer',
                  }}
                >
                  {s === 'buy' ? 'buy ✿' : '✦ sell'}
                </button>
              ))}
            </div>
            <div style={{ padding: 12 }}>

            {launch.graduated ? (
              <div
                style={{
                  padding: 16,
                  textAlign: 'center',
                  background: 'var(--pink-warm)',
                  border: '1.5px solid var(--anchor)',
                  fontFamily: 'var(--font-round), Klee One, cursive',
                  fontSize: 13,
                }}
              >
                curve graduated ~~<br />trade on uniswap v4 (phase 3~)
              </div>
            ) : (
              <>
                <label style={{ display: 'block' }}>
                  <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>you pay</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <input
                      className="uru-input"
                      type="number"
                      step="0.001"
                      min="0"
                      value={inputAmount}
                      onChange={(e) => setInputAmount(e.target.value)}
                      placeholder="0.0"
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 12, fontWeight: 700 }}>
                      {side === 'buy' ? 'ETH' : launch.ticker}
                    </span>
                  </div>
                </label>

                {/* Quick pick chips */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 4 }}>
                    quick pick ✿
                  </div>
                  <QuickAmounts
                    side={side}
                    walletBal={undefined}
                    onPick={(amount) => setInputAmount(amount)}
                  />
                </div>

                <div style={{ marginTop: 12, padding: 8, background: 'var(--cream-deep)', border: '1.5px dashed var(--anchor)' }}>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>you receive</div>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 16, fontWeight: 700, color: 'var(--anchor)' }}>
                    — <span style={{ fontSize: 10, color: 'var(--anchor-soft)', marginLeft: 4 }}>(preview)</span>
                  </div>
                </div>

                <label style={{ display: 'block', marginTop: 10 }}>
                  <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>slippage tolerance (%)</span>
                  <input
                    className="uru-input"
                    type="number"
                    step="0.1"
                    min="0"
                    max="50"
                    value={slippagePct}
                    onChange={(e) => setSlippagePct(e.target.value)}
                    style={{ marginTop: 3 }}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => { setPreviewSide(side); setPreviewNonce((n) => n + 1); }}
                  className={side === 'buy' ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                >
                  ✿ preview {side} (chart flashes) ✿
                </button>
              </>
            )}
            </div>
          </div>

          {/* Curve stats — tight rows */}
          <div className="uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>curve stats</div>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                fontFamily: 'var(--font-pixel), monospace',
                fontSize: 11,
                lineHeight: 1.7,
                color: 'var(--anchor-soft)',
              }}
            >
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--cream-shadow)', padding: '2px 0' }}>
                <span>price</span>
                <FlashCell value={spotPrice}>
                  <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                    {formatGweiPerToken(spotPrice)} gw
                  </span>
                </FlashCell>
              </li>
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--cream-shadow)', padding: '2px 0' }}>
                <span>tokens sold</span>
                <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                  {Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--cream-shadow)', padding: '2px 0' }}>
                <span>total supply</span>
                <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                  {Number(formatUnits(launch.totalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
                <span>creator</span>
                <Link
                  href={`/profile/${launch.creator}`}
                  style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
                >
                  {launch.creator.slice(0, 6)}…{launch.creator.slice(-4)}
                </Link>
              </li>
            </ul>
          </div>

          <Link
            href="/discover"
            style={{
              display: 'block',
              textAlign: 'center',
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 11,
              color: 'var(--link-blue)',
              textDecoration: 'underline',
            }}
          >
            « back to launches
          </Link>
        </aside>
      </div>
    </div>
  );
}

function MiniLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="uru-88"
      style={{ padding: '2px 8px', fontSize: 11, fontFamily: 'var(--font-pixel), monospace' }}
    >
      {label} →
    </a>
  );
}
