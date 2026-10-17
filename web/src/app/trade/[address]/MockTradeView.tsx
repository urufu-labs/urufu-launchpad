'use client';

/// Mock trade view — same visual as the live trade page but reads from a static fixture
/// instead of on-chain state. Buy/sell buttons show a "demo mode" banner instead of firing
/// txns. Delete when the indexer + Phase 1 broadcast land.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEther, formatUnits, parseEther, parseUnits } from 'viem';

import { TradeChart, type TradePoint } from '@/components/TradeChart';
import { TradeTicker, QuickAmounts, CopyCA, FlashCell, ChatDrawer } from '@/components/TradeEffects';
import { mockMarketCapEth, type MockLaunch, type MockTrade } from '@/lib/mockLaunches';
import { formatGweiPerToken } from '@/lib/priceFmt';
import { Tabs } from '@/components/ui/Choice';
import styles from './trade-terminal.module.css';

type Side = 'buy' | 'sell';
const PREVIEW_TRADER = '0x0badf00d0badf00d0badf00d0badf00d0badf00d' as const;

export function MockTradeView({ launch }: { launch: MockLaunch }) {
  const [side, setSide] = useState<Side>('buy');
  const [inputAmount, setInputAmount] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');
  const [simulatedTrades, setSimulatedTrades] = useState<MockTrade[]>([]);
  const [tradeNotice, setTradeNotice] = useState<string | null>(null);
  // Bumped for each local fill so TradeChart highlights the simulated trade.
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewSide, setPreviewSide] = useState<Side>('buy');
  const [infoTab, setInfoTab] = useState<'trades' | 'chat' | 'info'>('trades');

  const trades = useMemo(() => [...launch.trades, ...simulatedTrades], [launch.trades, simulatedTrades]);
  const latestTrade = trades.at(-1);
  const ethReserve = latestTrade?.ethReserve ?? launch.ethReserve;
  const tokenReserve = latestTrade?.tokenReserve ?? launch.tokenReserve;
  const tradeAmount = inputAmount || (side === 'buy' ? '0.1' : '100000');

  const previewQuote = useMemo(() => {
    if (launch.graduated) return null;
    try {
      const input = side === 'buy' ? parseEther(tradeAmount) : parseUnits(tradeAmount, 18);
      if (input <= 0n) return null;
      const effectiveEth = ethReserve + launch.virtualEthReserve;
      const effectiveToken = tokenReserve + launch.virtualTokenReserve;
      const invariant = effectiveEth * effectiveToken;
      if (side === 'buy') {
        const nextEffectiveToken = invariant / (effectiveEth + input);
        const tokensOut = effectiveToken - nextEffectiveToken;
        if (tokensOut <= 0n || tokensOut >= tokenReserve) return null;
        return {
          ethAmount: input,
          tokenAmount: tokensOut,
          nextEthReserve: ethReserve + input,
          nextTokenReserve: tokenReserve - tokensOut,
        };
      }
      const nextEffectiveEth = invariant / (effectiveToken + input);
      const ethOut = effectiveEth - nextEffectiveEth;
      if (ethOut <= 0n || ethOut >= ethReserve) return null;
      return {
        ethAmount: ethOut,
        tokenAmount: input,
        nextEthReserve: ethReserve - ethOut,
        nextTokenReserve: tokenReserve + input,
      };
    } catch {
      return null;
    }
  }, [ethReserve, launch.graduated, launch.virtualEthReserve, launch.virtualTokenReserve, side, tokenReserve, tradeAmount]);

  function simulateTrade() {
    if (!previewQuote) {
      setTradeNotice('Enter an amount the preview curve can fill.');
      return;
    }
    const trade: MockTrade = {
      isBuy: side === 'buy',
      ethAmount: previewQuote.ethAmount,
      tokenAmount: previewQuote.tokenAmount,
      ethReserve: previewQuote.nextEthReserve,
      tokenReserve: previewQuote.nextTokenReserve,
      trader: PREVIEW_TRADER,
      timestamp: Math.floor(Date.now() / 1000),
    };
    setSimulatedTrades((current) => [...current, trade]);
    setPreviewSide(side);
    setPreviewNonce((current) => current + 1);
    setTradeNotice(`Simulated ${side}. No wallet prompt or network transaction.`);
  }

  const tradePoints: TradePoint[] = useMemo(
    () =>
      trades.map((t) => ({
        timestamp: t.timestamp,
        priceWeiPerToken:
          t.tokenAmount > 0n ? (t.ethAmount * 10n ** 18n) / t.tokenAmount : 0n,
      })),
    [trades],
  );

  const progressPct = useMemo(() => {
    if (launch.graduated) return 100;
    return Math.min(100, Number((ethReserve * 10_000n) / launch.graduationTargetEth) / 100);
  }, [ethReserve, launch.graduated, launch.graduationTargetEth]);

  const spotPrice = useMemo(
    () =>
      ((ethReserve + launch.virtualEthReserve) * 10n ** 18n) /
      (tokenReserve + launch.virtualTokenReserve),
    [ethReserve, launch.virtualEthReserve, launch.virtualTokenReserve, tokenReserve],
  );

  const marketCap = useMemo(
    () => mockMarketCapEth({ ...launch, ethReserve, tokenReserve, trades }),
    [ethReserve, launch, tokenReserve, trades],
  );
  const tokensSold = launch.curveSupply - tokenReserve;

  const recentTrades = useMemo(() => trades.slice(-25).reverse(), [trades]);
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
      {/* Preview-mode notice */}
      <div className={styles.notice}>
        <span><b>Preview mode.</b> Trades are simulated in this tab and never broadcast.</span>
      </div>

      {/* ================================================================
          TOKEN IDENTITY + MARKET STRIP (same layout as the live page)
          ================================================================ */}
      <section className={styles.marketHeader}>
        <div className={styles.identityBar}>
          <div className={styles.artFrame} aria-label="Token artwork">
            {launch.imageUrl ? (
              <div
                className={styles.artImage}
                style={{
                  backgroundImage: `url(${launch.imageUrl})`,
                  backgroundPosition: 'center',
                  backgroundSize: 'contain',
                  backgroundRepeat: 'no-repeat',
                  backgroundColor: 'var(--surface-2)',
                }}
              />
            ) : (
              <div className={styles.artInitials}>{launch.ticker.slice(0, 3)}</div>
            )}
          </div>
          <div className={styles.identityCopy}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{launch.name}</h1>
              <span className={styles.symbolPill}>
                ${launch.ticker}
              </span>
              <span className={styles.statusPill} data-graduated={launch.graduated ? 'true' : undefined}>
                {launch.graduated ? 'Uniswap v4' : 'Bonding curve'}
              </span>
            </div>
            <div className={styles.metaLine}>
              <span>{launch.address.slice(0, 6)}…{launch.address.slice(-4)}</span>
              <Link href={`/profile/${launch.creator}`}>
                by {launch.creator.slice(0, 6)}…{launch.creator.slice(-4)}
              </Link>
              <span>Fee {(launch.tradeFeeBps / 100).toFixed(2)}%</span>
              <span>{trades.length} trades</span>
              <CopyCA address={launch.address} />
            </div>
          </div>
        </div>

        <div className={styles.poolStrip}>
          <div className={styles.metricCell}>
            <div className={styles.eyebrow}>Market cap</div>
            <div className={styles.metricValue}>
              <FlashCell value={marketCap}>
                {Number(formatEther(marketCap)).toFixed(4)} Ξ
              </FlashCell>
            </div>
          </div>
          <div className={styles.metricCell}>
            <div className={styles.eyebrow}>Price</div>
            <div className={styles.metricValue}>
              <FlashCell value={spotPrice}>{formatGweiPerToken(spotPrice)} gwei</FlashCell>
            </div>
          </div>
          <div className={styles.metricCell}>
            <div className={styles.eyebrow}>Route</div>
            <div className={styles.metricValue}>{launch.graduated ? 'Uniswap v4' : 'Curve'}</div>
          </div>
          <div className={`${styles.metricCell} ${styles.progressCell}`}>
            <div className={styles.progressTop}>
              <span className={styles.eyebrow}>{launch.graduated ? 'Graduated' : 'Graduation'}</span>
              <span>
                {Number(formatEther(ethReserve)).toFixed(3)} / {Number(formatEther(launch.graduationTargetEth)).toFixed(1)} Ξ
                {' '}({progressPct.toFixed(1)}%)
              </span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${progressPct > 85 && !launch.graduated ? 'uru-shimmer' : ''}`}
                style={{
                  width: `${progressPct}%`,
                  background: launch.graduated ? 'var(--buy)' : 'var(--accent)',
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Live ticker */}
      <div className={styles.tickerBand}>
        <TradeTicker trades={tickerTrades} symbol={launch.ticker} />
      </div>

      <div className={styles.terminalGrid}>
        {/* MAIN: chart + trades / chat / info tabs */}
        <div className={styles.mainStack}>
          <section className={styles.chartPanel}>
            <TradeChart points={tradePoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />
          </section>

          <section className={styles.tabsPanel}>
            <div className={styles.tabsHead}>
              <Tabs
                label="Token activity"
                value={infoTab}
                onChange={setInfoTab}
                options={[
                  { value: 'trades', label: 'Trades', count: recentTrades.length || undefined },
                  { value: 'chat', label: 'Chat' },
                  { value: 'info', label: 'Info' },
                ]}
              />
            </div>
            <div className={styles.tabsBody}>
              {infoTab === 'trades' && (
                <div className={styles.tradeCard}>
                  <div className={styles.panelHeader}>
                    <div className={styles.eyebrow}>Recent trades</div>
                    <span className={styles.countText}>
                      {recentTrades.length} shown
                    </span>
                  </div>
                  <div className={`${styles.tradeGrid} ${styles.tradeHead}`}>
                    <span>Side</span>
                    <span>ETH</span>
                    <span className={styles.alignRight}>{launch.ticker}</span>
                    <span className={styles.alignRight}>Trader</span>
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {recentTrades.map((t, i) => (
                      <li
                        key={i}
                        className={`${i === 0 ? 'uru-slide-in' : ''} ${styles.tradeGrid} ${styles.tradeRow}`}
                      >
                        <span style={{ color: t.isBuy ? 'var(--buy)' : 'var(--sell)', fontWeight: 700 }}>
                          {t.isBuy ? 'Buy' : 'Sell'}
                        </span>
                        <span className={styles.clip}>{Number(formatEther(t.ethAmount)).toFixed(4)}</span>
                        <span className={`${styles.clip} ${styles.alignRight}`}>
                          {Number(formatUnits(t.tokenAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                        <Link
                          href={`/profile/${t.trader}`}
                          className={`${styles.clip} ${styles.alignRight}`}
                        >
                          {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {infoTab === 'chat' && (
                <div style={{ padding: 12 }}>
                  {/* Chat, seeded so the preview feels alive */}
                  <ChatDrawer
                    tokenAddress={launch.address}
                    seed={[
                      { sender: 'guest_A9F2', text: `just bought ${launch.ticker}`, minutesAgo: 32 },
                      { sender: '0x8f31…c0de', text: 'is the LP locked?', minutesAgo: 21 },
                      { sender: 'guest_B8AA', text: 'LP is locked forever, it is in the docs', minutesAgo: 20 },
                      { sender: 'guest_C1E4', text: `when does ${launch.ticker} graduate?`, minutesAgo: 12 },
                      { sender: '0x0ba7…f00d', text: 'chart looks good', minutesAgo: 3 },
                    ]}
                  />
                </div>
              )}
              {infoTab === 'info' && (
                <div className={styles.infoStack}>
                  <div className={styles.sideCard}>
                    <h2 className={styles.sideTitle}>About</h2>
                    <p className={styles.aboutText}>{launch.description}</p>
                    <div className={styles.aboutLinks}>
                      {launch.website && <MiniLink href={launch.website} label="Website" />}
                      {launch.twitter && <MiniLink href={launch.twitter} label="X" />}
                      {launch.telegram && <MiniLink href={launch.telegram} label="Telegram" />}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* SIDEBAR: buy/sell panel */}
        <aside className={styles.sideRail}>
          <div className={styles.tradeCard}>
            {!launch.graduated && (
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
                    {s === 'buy' ? 'Buy' : 'Sell'}
                  </button>
                ))}
              </div>
            )}
            <div className={styles.tradeCardBody}>

            {launch.graduated ? (
              <div className={styles.unavailable}>
                <b>Graduated</b>
                <span className={styles.hint}>This curve has graduated. Trading moves to the Uniswap v4 pool.</span>
              </div>
            ) : (
              <>
                <label style={{ display: 'block' }}>
                  <span className={styles.fieldLabel}><span>You pay</span></span>
                  <div className={styles.inputRow}>
                    <input
                      className="ui-input"
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

                <div>
                  <div className={styles.quickLabel}>Quick amounts</div>
                  <QuickAmounts
                    side={side}
                    walletBal={undefined}
                    onPick={(amount) => setInputAmount(amount)}
                  />
                </div>

                <div className={styles.quoteBox}>
                  <div className={styles.fieldLabel}>
                    You receive <span className={styles.hint}>simulated</span>
                  </div>
                  <div className={styles.quoteValue}>
                    {previewQuote
                      ? `${side === 'buy'
                        ? Number(formatUnits(previewQuote.tokenAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                        : Number(formatEther(previewQuote.ethAmount)).toFixed(5)} ${side === 'buy' ? launch.ticker : 'ETH'}`
                      : '—'}
                  </div>
                </div>

                <label className={styles.slippageRow}>
                  <span className={styles.fieldLabel}>Max slippage (%)</span>
                  <input
                    className="ui-input"
                    type="number"
                    step="0.1"
                    min="0"
                    max="50"
                    value={slippagePct}
                    onChange={(e) => setSlippagePct(e.target.value)}
                  />
                </label>

                <button
                  type="button"
                  onClick={simulateTrade}
                  className={`ui-btn ${styles.primaryAction}`}
                  data-variant={side === 'buy' ? 'buy' : 'sell'}
                  data-size="lg"
                >
                  Simulate {side} (no wallet)
                </button>
                {tradeNotice && <div role="status" className={styles.hint}>{tradeNotice}</div>}
              </>
            )}
            </div>
          </div>

          {/* Curve stats */}
          <div className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Curve stats</h2>
            <ul className={styles.statsList}>
              <li>
                <span>Price</span>
                <FlashCell value={spotPrice}>
                  <span className={styles.statStrong}>
                    {formatGweiPerToken(spotPrice)} gwei
                  </span>
                </FlashCell>
              </li>
              <li>
                <span>Tokens sold</span>
                <span className={styles.statStrong}>
                  {Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li>
                <span>Total supply</span>
                <span className={styles.statStrong}>
                  {Number(formatUnits(launch.totalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li>
                <span>Creator</span>
                <Link href={`/profile/${launch.creator}`}>
                  {launch.creator.slice(0, 6)}…{launch.creator.slice(-4)}
                </Link>
              </li>
            </ul>
          </div>
          <details className={styles.accordion}>
            <summary>How trading works here</summary>
            <ul className={styles.riskList}>
              <li>{launch.graduated ? 'Curve trading is closed in preview; the live route would use the graduated Uniswap v4 pool.' : 'Preview mirrors the bonding-curve phase before the graduation target.'}</li>
              <li>Live pages use wallet quotes, approvals, slippage, and transaction simulation before sending.</li>
              <li>Preview data is labeled and does not represent current market state.</li>
            </ul>
          </details>

          <Link href="/discover" className="ui-btn" data-variant="ghost" data-block="true">
            Back to launches
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
      className="ui-btn"
      data-size="sm"
    >
      {label} ↗
    </a>
  );
}
