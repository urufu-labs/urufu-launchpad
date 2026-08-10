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
import styles from './trade-terminal.module.css';

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
    <div className={styles.terminalPage}>
      {/* preview-mode strip — slim colored bar */}
      <div className={styles.notice}>
        <b>◐ preview mode</b> ~ mock token for UI demo. buy/sell buttons are inert til phase 1 broadcasts.
      </div>

      {/* ================================================================
          TOKEN IDENTITY — compact market header with real art
          ================================================================ */}
      <section className={`uru-shell-tight ${styles.identityBar}`}>
        <div className={styles.artFrame} aria-label="Token artwork">
          {launch.imageUrl ? (
            <div
              className={styles.artImage}
              style={{
                backgroundImage: `url(${launch.imageUrl})`,
                backgroundPosition: 'center',
                backgroundSize: 'contain',
                backgroundRepeat: 'no-repeat',
              }}
            />
          ) : (
            <div className={styles.artInitials} style={{ background: launch.logoBg }}>{launch.ticker.slice(0, 3)}</div>
          )}
        </div>
        <div className={styles.identityCopy}>
          <div className="uru-eyebrow">token terminal</div>
          <div className={styles.titleRow}>
            <h1 className={`uru-h1 ${styles.title}`}>{launch.name}</h1>
            <span className={styles.symbolPill}>
              ${launch.ticker}
            </span>
            <span className={styles.statusPill}>{launch.graduated ? 'v4 pool' : 'curve live'}</span>
          </div>
          <div className={styles.metaLine}>
            <span>{launch.address.slice(0, 6)}…{launch.address.slice(-4)}</span>
            <Link href={`/profile/${launch.creator}`} style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
              creator {launch.creator.slice(0, 6)}…{launch.creator.slice(-4)}
            </Link>
            <span>fee: {launch.tradeFeeBps / 100}%</span>
            <span>{launch.trades.length} trades</span>
            <CopyCA address={launch.address} />
          </div>
        </div>
      </section>

      {/* ================================================================
          MARKET STRIP — compact stats and pool state
          ================================================================ */}
      <div className={styles.poolStrip}>
        <div className={styles.metricCell}>
          <div className="uru-eyebrow">mkt cap</div>
          <div className={styles.metricValue}>
            <FlashCell value={marketCap}>
              {Number(formatEther(marketCap)).toFixed(4)} Ξ
            </FlashCell>
          </div>
        </div>
        <div className={styles.metricCell}>
          <div className="uru-eyebrow">spot</div>
          <div className={styles.metricValue}>
            <FlashCell value={spotPrice}>{formatGweiPerToken(spotPrice)} gw</FlashCell>
          </div>
        </div>
        <div className={styles.metricCell}>
          <div className="uru-eyebrow">route</div>
          <div className={styles.metricValue}>{launch.graduated ? 'V4' : 'curve'}</div>
        </div>
        <div className={`${styles.metricCell} ${styles.progressCell}`}>
          <div className={styles.progressTop}>
            <span className="uru-eyebrow">{launch.graduated ? 'graduated' : 'grad -> v4'}</span>
            <span>
              {Number(formatEther(launch.ethReserve)).toFixed(3)} / {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} Ξ
              {' '}({progressPct.toFixed(1)}%)
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={`${styles.progressFill} ${progressPct > 85 && !launch.graduated ? 'uru-shimmer' : ''}`}
              style={{
                width: `${progressPct}%`,
                background: launch.graduated ? 'var(--mint-hot)' : 'var(--pink-hot)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Live ticker */}
      <div className={styles.tickerBand}>
        <TradeTicker trades={tickerTrades} symbol={launch.ticker} />
      </div>

      <div className={styles.terminalGrid}>
        {/* MAIN — chart + recent trades + about + chat */}
        <div className={`${styles.mainStack} space-y-3`}>
          <TradeChart points={tradePoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />

          {/* Recent trades — dense table */}
          <div className={`uru-shell-tight ${styles.tradeCard}`}>
            <div className={styles.panelHeader}>
              <div className="uru-eyebrow">recent trades</div>
              <span className={styles.countText}>
                {recentTrades.length} shown
              </span>
            </div>
            <div className={`${styles.tradeGrid} ${styles.tradeHead}`}>
              <span>side</span>
              <span>eth</span>
              <span className={styles.alignRight}>tokens</span>
              <span className={styles.alignRight}>trader</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recentTrades.map((t, i) => (
                <li
                  key={i}
                  className={`${i === 0 ? 'uru-slide-in' : ''} ${styles.tradeGrid} ${styles.tradeRow}`}
                >
                  <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                    {t.isBuy ? 'BUY' : 'SELL'}
                  </span>
                  <span className={styles.clip}>{Number(formatEther(t.ethAmount)).toFixed(4)}</span>
                  <span className={`${styles.clip} ${styles.alignRight}`}>
                    {Number(formatUnits(t.tokenAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <Link
                    href={`/profile/${t.trader}`}
                    className={`${styles.clip} ${styles.alignRight}`}
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
              { sender: 'guest_A9F2', text: `just bought ${launch.ticker}`, minutesAgo: 32 },
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
        <aside className={`${styles.sideRail} space-y-3 lg:sticky lg:top-4 lg:h-fit`}>
          <div className={`uru-shell-tight ${styles.tradeCard}`}>
            {/* buy/sell tabs — bolder pump-style */}
            <div className={styles.tabGrid}>
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setSide(s); setInputAmount(''); }}
                  className={styles.tabButton}
                  data-active={side === s}
                  data-side={s}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className={styles.tradeCardBody}>

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
                  <span className={styles.fieldLabel}>you pay</span>
                  <div className={styles.inputRow}>
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
                    <span className={styles.assetLabel}>
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

                <div className={styles.quoteBox}>
                  <div className={styles.fieldLabel}>you receive</div>
                  <div className={styles.quoteValue}>
                    — <span style={{ fontSize: 10, color: 'var(--anchor-soft)', marginLeft: 4 }}>(preview)</span>
                  </div>
                </div>

                <label style={{ display: 'block', marginTop: 10 }}>
                  <span className={styles.fieldLabel}>slippage tolerance (%)</span>
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
                  className={`${side === 'buy' ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'} ${styles.primaryAction}`}
                >
                  preview {side} (chart flashes)
                </button>
              </>
            )}
            </div>
          </div>

          {/* Curve stats — tight rows */}
          <div className="uru-shell-tight">
            <div className="uru-eyebrow" style={{ marginBottom: 6 }}>curve stats</div>
            <ul className={styles.statsList}>
              <li>
                <span>price</span>
                <FlashCell value={spotPrice}>
                  <span className={styles.statStrong}>
                    {formatGweiPerToken(spotPrice)} gw
                  </span>
                </FlashCell>
              </li>
              <li>
                <span>tokens sold</span>
                <span className={styles.statStrong}>
                  {Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li>
                <span>total supply</span>
                <span className={styles.statStrong}>
                  {Number(formatUnits(launch.totalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li>
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
          <details className={`uru-shell-tight ${styles.accordion}`}>
            <summary>pool truth + risk</summary>
            <ul className={styles.riskList}>
              <li>{launch.graduated ? 'Curve trading is closed in preview; the live route would use the graduated V4 pool.' : 'Preview mirrors the bonding-curve phase before the graduation target.'}</li>
              <li>Live pages use wallet quotes, approvals, slippage, and transaction simulation before sending.</li>
              <li>Preview data is labeled and does not represent current market state.</li>
            </ul>
          </details>

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
