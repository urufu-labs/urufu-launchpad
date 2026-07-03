'use client';

/// Mock trade view — same visual as the live trade page but reads from a static fixture
/// instead of on-chain state. Buy/sell buttons show a "demo mode" banner instead of firing
/// txns. Delete when the indexer + Phase 1 broadcast land.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, formatUnits } from 'viem';

import { Mascot } from '@/components/Mascot';
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
  // Shape mock trades to match the ticker's expected input.
  const tickerTrades = useMemo(
    () => recentTrades.map((t) => ({ isBuy: t.isBuy, eth: t.ethAmount, tokens: t.tokenAmount, trader: t.trader })),
    [recentTrades],
  );

  // Derive a stable flash key from the latest real mock trade so the chart flashes on mount
  // AND when the preview buy/sell fires (previewNonce). Preview action takes priority.
  const newestMockTrade = recentTrades[0];
  const chartFlashKey = previewNonce > 0
    ? `preview-${previewNonce}`
    : newestMockTrade
      ? `${newestMockTrade.timestamp}-${newestMockTrade.trader}`
      : null;
  const chartFlashSide: Side = previewNonce > 0 ? previewSide : (newestMockTrade?.isBuy ? 'buy' : 'sell');

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      {/* preview-mode ribbon */}
      <div className="uru-shell uru-shell-tight" style={{ marginBottom: 10, background: 'var(--yolk)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Mascot size={28} mood="confused" />
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor)' }}>
            <b>preview mode</b> ~ this is a mock token for UI demo. buy/sell buttons are inert til phase 1 broadcasts.
          </div>
        </div>
      </div>

      {/* Header — token identity + market cap */}
      <div className="flex items-start gap-3 mb-3">
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 12,
            border: '1.5px solid var(--anchor)',
            boxShadow: '2px 2px 0 var(--anchor)',
            background: launch.logoBg,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 36,
          }}
        >
          {launch.logoEmoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="uru-eyebrow">trade</div>
          <h1 className="uru-h1" style={{ fontSize: 30, lineHeight: 1.1 }}>
            {launch.name}{' '}
            <span style={{ color: 'var(--anchor-soft)', fontSize: 20 }}>${launch.ticker}</span>
          </h1>
          <div style={{ marginTop: 4, display: 'flex', gap: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--anchor-soft)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{launch.address.slice(0, 6)}…{launch.address.slice(-4)}</span>
            <span>mkt cap:{' '}
              <FlashCell value={marketCap}>
                {Number(formatEther(marketCap)).toFixed(4)} ETH
              </FlashCell>
            </span>
            <span>fee: {launch.tradeFeeBps / 100}%</span>
            <span>{launch.trades.length} trades</span>
          </div>
        </div>
      </div>

      {/* Ticker + copy-CA pinned to the right */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TradeTicker trades={tickerTrades} symbol={launch.ticker} />
        </div>
        <CopyCA address={launch.address} />
      </div>

      {/* Graduation progress bar */}
      <div className="uru-shell uru-shell-tight" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <div className="uru-eyebrow">graduation ✿ v4</div>
          <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 12, color: 'var(--anchor)' }}>
            {Number(formatEther(launch.ethReserve)).toFixed(4)} /{' '}
            {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} ETH ({progressPct.toFixed(1)}%)
          </div>
        </div>
        <div style={{ height: 14, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)', position: 'relative' }}>
          <div
            className={progressPct > 85 && !launch.graduated ? 'uru-shimmer' : ''}
            style={{
              width: `${progressPct}%`,
              height: '100%',
              background: launch.graduated ? 'var(--mint)' : 'var(--pink-hot)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
        {progressPct > 85 && !launch.graduated && (
          <div style={{ marginTop: 6, fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--pink-hot)', fontWeight: 700 }}>
            so close ✿✿✿ almost graduated!!
          </div>
        )}
        {launch.graduated && (
          <div style={{ marginTop: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 12, color: 'var(--pink-hot)', fontWeight: 700 }}>
            ✿ GRADUATED ~★ trading moves to uniswap v4
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* MAIN — chart + recent trades */}
        <div className="space-y-3">
          <TradeChart points={tradePoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />

          {/* Recent trades */}
          <div className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 8 }}>✿ recent trades</div>
            <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 4 }}>
              {recentTrades.map((t, i) => (
                <li
                  key={i}
                  className={i === 0 ? 'uru-slide-in' : ''}
                  style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 8, fontFamily: 'var(--font-pixel), monospace', fontSize: 11 }}
                >
                  <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                    {t.isBuy ? 'BUY' : 'SELL'}
                  </span>
                  <span>{Number(formatEther(t.ethAmount)).toFixed(4)} ETH</span>
                  <span>{Number(formatUnits(t.tokenAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} {launch.ticker}</span>
                  <Link href={`/profile/${t.trader}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
                    {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Chat — seeded so preview feels alive on first visit */}
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
          <div className="uru-shell uru-shell-tight">
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
          <div className="uru-shell uru-shell-tight">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setSide(s); setInputAmount(''); }}
                  className="uru-btn"
                  style={{
                    justifyContent: 'center',
                    fontSize: 13,
                    background: side === s ? (s === 'buy' ? 'var(--mint)' : 'var(--pink-warm)') : 'transparent',
                    fontWeight: 700,
                  }}
                >
                  {s === 'buy' ? '✿ buy' : 'sell ✿'}
                </button>
              ))}
            </div>

            {launch.graduated ? (
              <div style={{ padding: 16, textAlign: 'center', background: 'var(--pink-warm)', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
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

                {/* Quick pick chips — visible above the input */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 4 }}>
                    quick pick ✿
                  </div>
                  <QuickAmounts
                    side={side}
                    walletBal={undefined /* mock: no wallet */}
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

          {/* Curve stats */}
          <div className="uru-shell uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>curve stats</div>
            <dl style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 11, lineHeight: 1.7, color: 'var(--anchor-soft)' }}>
              <div>price:{' '}
                <FlashCell value={spotPrice}>
                  <span style={{ color: 'var(--anchor)' }}>
                    {formatGweiPerToken(spotPrice)} <span style={{ color: 'var(--anchor-soft)' }}>gwei/token</span>
                  </span>
                </FlashCell>
              </div>
              <div>tokens sold: <span style={{ color: 'var(--anchor)' }}>{Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
              <div>total supply: <span style={{ color: 'var(--anchor)' }}>{Number(formatUnits(launch.totalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
              <div>creator: <Link href={`/profile/${launch.creator}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>{launch.creator.slice(0, 6)}…{launch.creator.slice(-4)}</Link></div>
            </dl>
          </div>

          <Link href="/discover" style={{ display: 'block', textAlign: 'center', fontFamily: 'var(--font-pixel), monospace', fontSize: 11, color: 'var(--link-blue)', textDecoration: 'underline' }}>
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
