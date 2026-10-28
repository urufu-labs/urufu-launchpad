'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatEther, isAddress, parseEther, parseUnits, formatUnits, type Address, type Hex } from 'viem';

import { erc20TokenAbi, permit2Abi, universalRouterAbi, v4SwapRouterAbi } from '@/lib/abis';
import {
  CHAIN_LABELS,
  V4_ROUTERS,
  DN404_PAIR_CURRENCIES,
  UNIVERSAL_ROUTERS,
  PERMIT2,
  UNISWAP_ALLOWLIST_PENDING_HOOKS,
  type ChainKey,
} from '@/lib/config';
import { buildErc20PoolKey, encodeV4ExactInSingle, encodeV4ExactInSingleSettleFirst } from '@/lib/v4Erc20Swap';
import { taxScopeNote, taxedBuyNetOut, taxedSellPoolInput } from '@/lib/dn404Tax';
import { CHAIN_KEY_TO_ID, explorerAddressUrl } from '@/lib/wagmi';
import { persistMetadata, safeBackgroundImage, type TokenMetadata } from '@/lib/metadata';
import { saveTokenMetadata } from '@/lib/socialApi';
import { MetadataForm, type MetadataInputs } from '@/components/MetadataForm';
import { MOCK_LAUNCHES, mockLaunchByAddress } from '@/lib/mockLaunches';
import { useMockDataMode } from '@/lib/mockDataMode';
import { isHiddenAddressAnywhere } from '@/lib/hiddenTokens';
import {
  MAX_NFTS_PER_TX,
  maxTokensInForNfts,
  maxTokensOutForNfts,
  nftsBurned,
  nftsMinted,
  scaleInputForOutput,
} from '@/lib/dn404Gas';
import { Mascot } from '@/components/Mascot';
import { TradeChart } from '@/components/TradeChart';
import { TokenHolderModules } from '@/components/TokenHolderModules';
import { PoolPolicyCard } from '@/components/PoolPolicyCard';
import { FairLaunchPanels } from '@/components/FairLaunchPanels';
import infoStyles from '@/components/info-panel.module.css';
import type { WagmiChainId } from '@/lib/wagmi';
import { TradeTicker, QuickAmounts, CopyCA, FlashCell, ChatDrawer } from '@/components/TradeEffects';
import { TokenOwnerControls } from '@/components/TokenOwnerControls';
import { MockTradeView } from './MockTradeView';
import styles from './trade-terminal.module.css';
import { Tabs } from '@/components/ui/Choice';
import { useTradeTerminal } from './useTradeTerminal';
import { AgentTag, useAgentTags } from '@/components/AgentBadge';

export default function TradePage({ params }: { params: Promise<{ address: string }> }) {
  const mockData = useMockDataMode();
  const resolved = use(params);
  const tokenAddress = (isAddress(resolved.address) ? resolved.address : '0x0000000000000000000000000000000000000000') as Address;
  const [mockLaunchesHydrated, setMockLaunchesHydrated] = useState(false);

  useEffect(() => {
    setMockLaunchesHydrated(true);
  }, []);

  // Retired-token check: if the address is in the hide list (TEST/BALLS etc.),
  // render a "retired" splash instead of routing to the live trade UI. Bookmarks +
  // pasted URLs land here too, so the block is comprehensive — not just the
  // feed-side filter.
  if (isHiddenAddressAnywhere(tokenAddress)) return <RetiredTokenView />;

  // Preview-mode fallback: if the address matches a mock fixture, render the mock UI so the
  // page is browsable without any contracts deployed. Dispatch happens via a sibling
  // component so rules-of-hooks stay clean — early-returning before the wagmi hooks below
  // would violate hook ordering.
  const mock = mockData.enabled
    ? (mockLaunchesHydrated
      ? mockLaunchByAddress(tokenAddress)
      : MOCK_LAUNCHES.find((launch) => launch.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null)
    : null;
  if (mock) return <MockTradeView launch={mock} />;
  return <LiveTradeView tokenAddress={tokenAddress} />;
}

function RetiredTokenView() {
  return (
    <div className={styles.retired}>
      <p className={styles.retiredEyebrow}>Retired token</p>
      <h1 className={styles.retiredTitle}>This token is retired</h1>
      <p className={styles.retiredCopy}>It was an early test token and is no longer listed.</p>
      <Link href="/discover" className="ui-btn" data-variant="primary" data-size="lg" style={{ marginTop: 8 }}>
        Back to Explore
      </Link>
    </div>
  );
}

function LiveTradeView({ tokenAddress }: { tokenAddress: Address }) {
  const {
    wallet,
    chainId,
    mounted,
    connectedForRender,
    tokenHomeChain,
    launchInfoLauncher,
    pairedMirror,
    walletChain,
    activeChain,
    contracts,
    readChainId,
    walletOnActiveChain,
    switchChain,
    switchPending,
    indexedCurveAddress,
    indexerChecked,
    curveQuery,
    factoryCurveAddress,
    dn404CurveFactory,
    dn404CurveQuery,
    curveAddress,
    pairCurrency,
    isErc20Pair,
    ethReserve,
    gradTarget,
    wlFallbackTs,
    wlReservedTokens,
    wlSoldTokens,
    wlSourceToken,
    wlEnabled,
    wlSourceValid,
    wlSourceName,
    wlSourceSymbol,
    wlSourceChainKey,
    graduated,
    feeBps,
    walletBalQ,
    tokenName,
    tokenSymbol,
    tokenTotalSupply,
    walletBal,
    walletEthBal,
    pairState,
    pairSym,
    pairDecimals,
    walletPairBal,
    fmtPair,
    metadata,
    setMetadata,
    overrideHookAddr,
    pendingLegacyCliff,
    hookAddr,
    erc20PoolKey,
    tokenIsCurrency0,
    poolId,
    setV4RefetchTick,
    chartPoints,
    RECENT_TRADES_COMPACT_COUNT,
    showAllTrades,
    setShowAllTrades,
    mergedRecentTradesFull,
    mergedRecentTrades,
    side,
    setSide,
    inputAmount,
    setInputAmount,
    slippagePct,
    setSlippagePct,
    inputWei,
    ethToGraduate,
    buyCapped,
    quoteOut,
    quoteFee,
    needsApproval,
    needsPairApproval,
    dn404UnitWei,
    isDn404Token,
    walletSkipNft,
    taxBps,
    sellsTaxed,
    taxSentence,
    taxedEthPoolKey,
    curveNftGuard,
    pairApproveSim,
    activeBuySim,
    sellSim,
    wlListCid,
    wlProof,
    wlProofErr,
    wlPreFallback,
    wlBuySim,
    writeContract,
    writePending,
    receipt,
    submit,
    progressPct,
    tokensSold,
    slot0Q,
    poolSpotPriceEthPerToken,
    effectiveSpotPrice,
    showPrice,
    showMcap,
    marketCap,
  } = useTradeTerminal(tokenAddress);
  const [infoTab, setInfoTab] = useState<'trades' | 'chat' | 'info'>('trades');
  const agentTags = useAgentTags([...mergedRecentTrades.map((t) => t.trader), ...(launchInfoLauncher ? [launchInfoLauncher] : [])]);

  if (!mounted) {
    return (
      <div className={styles.stateScreen}>
        <Mascot size={64} mood="sleepy" />
        <p className={styles.stateCopy}>Looking up the curve…</p>
      </div>
    );
  }

  if (!contracts) {
    return (
      <div className={styles.stateScreen}>
        <Mascot size={80} mood="confused" />
        <h1 className={styles.stateTitle}>Contracts aren&apos;t live on this chain yet</h1>
        <p className={styles.stateCopy}>Switch to a supported network to trade.</p>
      </div>
    );
  }
  // Show the lookup skeleton while EITHER path is still resolving. The old code
  // only checked curveQuery.isLoading, but that query is disabled until the
  // indexer has answered — so between "page mount" and "indexer response" we
  // fell through to the "no curve" empty state for ~1-3 seconds on slow RPCs.
  // Now: show loading if indexer hasn't checked yet, OR we're waiting on the
  // factory fallback because indexer had nothing.
  // Also wait for the DN404 factory lookup: URU-paired curves are never in the
  // indexer's curves table, so every URU-paired token flashed "no curve" for
  // a round-trip (and kept it if the public RPC read failed).
  const factoryLookupNeeded = indexerChecked && !indexedCurveAddress && !!contracts;
  const dn404LookupPending =
    factoryLookupNeeded && !!dn404CurveFactory && !factoryCurveAddress &&
    (!curveQuery.isFetched || !dn404CurveQuery.isFetched || dn404CurveQuery.isFetching);
  const stillResolvingCurve =
    !indexerChecked || (factoryLookupNeeded && (curveQuery.isFetching || !curveQuery.isFetched)) || dn404LookupPending;
  // A failed lookup isn't proof there's no curve; say so and offer a retry.
  const curveLookupFailed = !curveAddress && (curveQuery.isError || dn404CurveQuery.isError);
  if (stillResolvingCurve && !curveLookupFailed) {
    return (
      <div className={styles.stateScreen}>
        <Mascot size={64} mood="sleepy" />
        <p className={styles.stateCopy}>Looking up the curve…</p>
      </div>
    );
  }
  if (!curveAddress && curveLookupFailed) {
    return (
      <div className={styles.stateScreen}>
        <Mascot size={64} mood="sleepy" />
        <p className={styles.stateCopy}>
          Couldn&apos;t look up this token&apos;s curve. The network is busy.
        </p>
        <button
          type="button"
          className="ui-btn"
          data-variant="primary"
          style={{ marginTop: 8 }}
          onClick={() => { void curveQuery.refetch(); void dn404CurveQuery.refetch(); }}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!curveAddress) {
    return (
      <div className={styles.stateScreen}>
        <Mascot size={80} mood="confused" />
        <h1 className={styles.stateTitle}>No curve for this token</h1>
        <p className={styles.stateCopy}>This token wasn&apos;t launched with a bonding curve.</p>
        <Link href="/discover" className="ui-btn" data-variant="primary" style={{ marginTop: 8 }}>
          Back to launches
        </Link>
      </div>
    );
  }

  // Chart flash — fires when the newest indexed trade changes. Reads from the merged
  // curve + v4 list so post-graduation buys/sells still flash the chart. Before this,
  // it keyed off the curve-only list which is frozen after graduation → no flashes.
  const newestTrade = mergedRecentTrades[0];
  const chartFlashKey = newestTrade ? `${newestTrade.timestamp}-${newestTrade.trader}` : null;
  const chartFlashSide: 'buy' | 'sell' = newestTrade?.isBuy ? 'buy' : 'sell';

  // Cross-chain banner: when the token's home chain (from indexer) differs from the
  // wallet's current chain, show a prominent one-click switch prompt. Data still loads
  // for the token's actual chain regardless -- this is purely a "prompt to trade" nudge
  // so users don't hit the buy/sell widget disabled and wonder why.
  const showCrossChainBanner =
    connectedForRender && tokenHomeChain !== null && walletChain !== tokenHomeChain;

  return (
    <div className={styles.terminalPage}>
      {showCrossChainBanner && tokenHomeChain && (
        <div className={styles.notice}>
          <span>
            This token lives on <b>{CHAIN_LABELS[tokenHomeChain]}</b>. All data shown is live;
            switch networks to trade.
          </span>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            data-size="sm"
            onClick={() => switchChain({ chainId: CHAIN_KEY_TO_ID[tokenHomeChain] })}
            disabled={switchPending}
          >
            {switchPending ? 'Switching…' : `Switch to ${CHAIN_LABELS[tokenHomeChain]}`}
          </button>
        </div>
      )}
      {/* Legacy-graduator cliff warning: shown on pre-graduation curves whose
          `graduator` is baked to the pre-V3 (raw-ratio) graduator. When these
          hit their graduation target, the LP will be seeded at the wrong
          price and buyers who bought late on the curve will see a price cliff
          on Uniswap (same thing that happened to LUV). Buyers should see this
          coming BEFORE they buy. */}
      {pendingLegacyCliff && (
        <div className={styles.legacyBanner}>
          <div className={styles.legacyBannerIcon} aria-hidden>✿</div>
          <div className={styles.legacyBannerCopy}>
            <b>Heads up: this curve uses the old graduator.</b>
            <span>
              When it hits its target, the Uniswap v4 pool will be seeded at the
              old raw ratio (not the curve price). Expect a price drop on Uniswap
              right after graduation. Buying on the curve is fine, just don&apos;t
              expect the graduation price to hold.
            </span>
          </div>
        </div>
      )}
      {/* ================================================================
          TOKEN IDENTITY — compact market header with real art
          ================================================================ */}
      <section className={styles.marketHeader}>
      <div className={styles.identityBar}>
        <div className={styles.artFrame} aria-label="Token artwork">
          {metadata?.logoDataUrl ? (
            <div
              className={styles.artImage}
              style={{
                background: safeBackgroundImage(metadata.logoDataUrl),
                backgroundSize: 'contain',
                backgroundRepeat: 'no-repeat',
                backgroundColor: 'var(--surface-2)',
              }}
            />
          ) : (
            <div className={styles.artInitials}>{((tokenSymbol as string)?.slice(0, 3) || '???')}</div>
          )}
        </div>
        <div className={styles.identityCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>
              {(tokenName as string) ?? 'Loading…'}
            </h1>
            <span className={styles.symbolPill}>
              ${(tokenSymbol as string) ?? '—'}
            </span>
            {/* WL badge — visible whenever the curve was launched with a whitelist,
                regardless of window status. Discover feed already flags WL launches;
                this makes it obvious on the trade page too. */}
            {wlEnabled && (
              <span
                className={styles.wlBadge}
                title={wlPreFallback ? 'Community whitelist: exclusive window active' : 'Community whitelist: window ended, public buys open'}
              >
                Whitelist
              </span>
            )}
            <span className={styles.statusPill} data-graduated={graduated ? 'true' : undefined}>{graduated ? 'Uniswap v4' : 'Bonding curve'}</span>
            {pairedMirror && (() => {
              const pairAddr = pairedMirror.pairCurrency ?? '0x0000000000000000000000000000000000000000';
              const pairLabel = pairAddr === '0x0000000000000000000000000000000000000000'
                ? 'ETH'
                : (DN404_PAIR_CURRENCIES[activeChain as ChainKey] ?? [])
                    .find((o) => o.address.toLowerCase() === pairAddr.toLowerCase())?.label
                  ?? 'ERC-20';
              const unitStr = pairedMirror.unitWei && pairedMirror.unitWei !== '0'
                ? (BigInt(pairedMirror.unitWei) / 10n ** 18n).toString()
                : '?';
              return (
                <Link
                  href={`/collection/${pairedMirror.collectionAddress}`}
                  className={styles.dnPill}
                  title={`Priced in ${pairLabel} · hold ${unitStr} ${pairedMirror.ticker || 'TICK'} to hold 1 NFT`}
                >
                  DN404 · {pairLabel} pair
                </Link>
              );
            })()}
            {/* Legacy pill — surfaces that this token's v4 pool was seeded by
                the old raw-ratio graduator (pre-V3). Only shows once the token
                has actually graduated — pre-graduation curves have no pool yet
                and the pill would be misleading. */}
            {overrideHookAddr && graduated && (
              <span className={styles.legacyPill} title="Graduated on the older hook and graduator. Trading works normally; the pool was seeded at the old raw ratio instead of the curve price.">
                Legacy
              </span>
            )}
          </div>
          <div className={styles.metaLine}>
            <Link
              href={explorerAddressUrl(activeChain as ChainKey, tokenAddress)}
              target="_blank"
            >
              {tokenAddress.slice(0, 6)}…{tokenAddress.slice(-4)}
            </Link>
            {launchInfoLauncher && (
              <Link
                href={agentTags.has(launchInfoLauncher.toLowerCase()) ? `/agent/${launchInfoLauncher}` : `/profile/${launchInfoLauncher}`}
              >
                by {launchInfoLauncher.slice(0, 6)}…{launchInfoLauncher.slice(-4)}
                {agentTags.has(launchInfoLauncher.toLowerCase()) && <> <AgentTag address={launchInfoLauncher} info={agentTags.get(launchInfoLauncher.toLowerCase())} asText /></>}
              </Link>
            )}
            <span>Fee {typeof feeBps === 'number' ? `${(feeBps / 100).toFixed(2)}%` : '–'}</span>
            <CopyCA address={tokenAddress} />
          </div>
        </div>
      </div>

      <div className={styles.poolStrip}>
        <div className={styles.metricCell}>
          <div className={styles.eyebrow}>Market cap</div>
          <div className={styles.metricValue}>
            <FlashCell value={marketCap ?? undefined}>
              {marketCap ? showMcap(marketCap) : '—'}
            </FlashCell>
          </div>
        </div>
        <div className={styles.metricCell}>
          <div className={styles.eyebrow}>Price</div>
          <div className={styles.metricValue}>
            <FlashCell value={effectiveSpotPrice}>
              {effectiveSpotPrice > 0n ? showPrice(effectiveSpotPrice) : '—'}
            </FlashCell>
          </div>
        </div>
        <div className={styles.metricCell}>
          <div className={styles.eyebrow}>Route</div>
          <div className={styles.metricValue}>{graduated ? 'Uniswap v4' : 'Curve'}</div>
        </div>
        <div className={`${styles.metricCell} ${styles.progressCell}`}>
          <div className={styles.progressTop}>
            <span className={styles.eyebrow}>{graduated ? 'Graduated' : 'Graduation'}</span>
            <span>
              {isErc20Pair ? (
                <>
                  {typeof ethReserve === 'bigint' ? Number(fmtPair(ethReserve)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} /
                  {' '}{typeof gradTarget === 'bigint' ? Number(fmtPair(gradTarget)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {pairSym}
                </>
              ) : (
                <>
                  {typeof ethReserve === 'bigint' ? Number(formatEther(ethReserve)).toFixed(3) : '—'} /
                  {' '}{typeof gradTarget === 'bigint' ? Number(formatEther(gradTarget)).toFixed(1) : '—'} Ξ
                </>
              )}
              {' '}({progressPct.toFixed(1)}%)
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{
                width: `${progressPct}%`,
                background: graduated ? 'var(--buy)' : 'var(--accent)',
              }}
            />
          </div>
        </div>
      </div>
      </section>

      {/* Live trade ticker: this token's latest buys and sells scrolling by. */}
      <div className={styles.tickerBand}>
        <TradeTicker
          trades={mergedRecentTrades.map((t) => ({ isBuy: t.isBuy, eth: t.eth, tokens: t.tokens, trader: t.trader }))}
          symbol={tokenSymbol as string | undefined}
          pairSymbol={isErc20Pair ? pairSym : 'ETH'}
          pairDecimals={isErc20Pair ? pairDecimals : 18}
        />
      </div>

      <div className={styles.terminalGrid}>
        {/* MAIN — chart + recent trades */}
        <div className={`${styles.mainStack} space-y-3`}>
          <section className={styles.chartPanel}>
            <TradeChart points={chartPoints} flashKey={chartFlashKey} flashSide={chartFlashSide} pairSymbol={isErc20Pair ? pairSym : undefined} />
          </section>

          <section className={styles.tabsPanel}>
            <div className={styles.tabsHead}>
              <Tabs
                label="Token activity"
                value={infoTab}
                onChange={setInfoTab}
                options={[
                  { value: 'trades', label: 'Trades', count: mergedRecentTradesFull.length || undefined },
                  { value: 'chat', label: 'Chat' },
                  { value: 'info', label: 'Info' },
                ]}
              />
            </div>
            <div className={styles.tabsBody}>
              {infoTab === 'trades' && (
                <>
          {/* Recent trades — dense table with header row */}
          <div className={styles.tradeCard}>
            <div className={styles.panelHeader}>
              <div className={styles.eyebrow}>Recent trades</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.countText}>
                  {mergedRecentTrades.length}
                  {mergedRecentTradesFull.length > mergedRecentTrades.length
                    ? ` of ${mergedRecentTradesFull.length}`
                    : ''}
                </span>
                {mergedRecentTradesFull.length > RECENT_TRADES_COMPACT_COUNT && (
                  <button
                    type="button"
                    onClick={() => setShowAllTrades((v) => !v)}
                    className={styles.showAll}
                    aria-pressed={showAllTrades}
                  >
                    {showAllTrades ? 'Show less' : 'Show all'}
                  </button>
                )}
              </div>
            </div>
            {mergedRecentTrades.length === 0 ? (
              <div className={styles.emptyRow}>No trades yet. Be the first.</div>
            ) : (
              <>
                <div className={`${styles.tradeGrid} ${styles.tradeHead}`}>
                  <span>Side</span>
                  <span>{isErc20Pair ? pairSym : 'ETH'}</span>
                  <span className={styles.alignRight}>{(tokenSymbol as string) ?? 'Tokens'}</span>
                  <span className={styles.alignRight}>Trader</span>
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {mergedRecentTrades.map((t, i) => (
                    <li
                      key={i}
                      className={`${styles.tradeGrid} ${styles.tradeRow}`}
                    >
                      <span style={{ color: t.isBuy ? 'var(--buy)' : 'var(--sell)', fontWeight: 700 }}>
                        {t.isBuy ? 'Buy' : 'Sell'}
                      </span>
                      <span className={styles.clip}>
                        {isErc20Pair
                          ? Number(fmtPair(t.eth)).toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : Number(formatEther(t.eth)).toFixed(4)}
                      </span>
                      <span className={`${styles.clip} ${styles.alignRight}`}>
                        {Number(formatUnits(t.tokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                      <Link
                        href={agentTags.has(t.trader.toLowerCase()) ? `/agent/${t.trader}` : `/profile/${t.trader}`}
                        className={`${styles.clip} ${styles.alignRight}`}
                      >
                        {t.trader.slice(0, 6)}…{t.trader.slice(-4)}
                        {agentTags.has(t.trader.toLowerCase()) && <> <AgentTag address={t.trader} info={agentTags.get(t.trader.toLowerCase())} asText /></>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

                </>
              )}
              {infoTab === 'chat' && (
                <div style={{ padding: 12 }}>
          {/* Chat — API-backed when chainId is known so posts are shared across
              browsers; falls back to localStorage for the preview / mock modes. */}
          <ChatDrawer tokenAddress={tokenAddress} chainId={readChainId} wallet={wallet} />

                </div>
              )}
              {infoTab === 'info' && (
                <div className={styles.infoStack}>
          {/* Info sidebar (metadata). Edit affordance only shows when the
              connected wallet matches the token's launcher — belt-and-suspenders
              alongside the server's 403 on non-launcher writes, so non-owners
              never see an edit button they can't legitimately click. Launcher
              address comes from the indexer's launches row we already fetch
              above (into launchInfo). */}
          <MetadataPanel
            metadata={metadata}
            tokenAddress={tokenAddress}
            // The token's chain, not the wallet's: a launcher on another
            // network used to save metadata under the wrong chain id.
            chainId={readChainId ?? chainId}
            wallet={wallet as Address | undefined}
            launcher={launchInfoLauncher}
            onSaved={(next) => setMetadata(next)}
          />
          {/* Per-token holder actions — renders only if the token was launched
              with Staking, Vesting, or Votes modules installed (probes marker
              view functions with allowFailure). Bare-ERC20 tokens render nothing.
              readChainId is undefined until the token's home chain resolves —
              fall back to the current wallet chain to avoid mount thrash. */}
          <TokenHolderModules
            token={tokenAddress}
            chainId={(readChainId ?? chainId) as WagmiChainId}
          />

          {/* Post-graduation pool rules — creator fee %, anti-sniper remaining,
              buyback-burn %. Renders nothing pre-graduation (poolPolicy tuple
              is all zeros). poolId + hookAddr are computed above from the
              indexer's graduation row (or derived from the wired hook for
              pre-graduation launches — those get filtered out server-side). */}
          {/* Fair launch tokens only: opening batch (deposit / claim), sniper-tax
              chip and dev badge. Renders nothing for other lanes or while the
              Fair lane has no factory configured for this chain. */}
          <FairLaunchPanels
            token={tokenAddress}
            chainKey={activeChain ?? null}
            chainId={(readChainId ?? chainId) as WagmiChainId}
            graduated={!!graduated}
          />

          <PoolPolicyCard
            poolId={poolId as Hex | null}
            hookAddress={hookAddr as Address | null}
            chainId={(readChainId ?? chainId) as WagmiChainId}
          />


                </div>
              )}
            </div>
          </section>
        </div>

        {/* SIDEBAR — buy/sell panel */}
        <aside className={styles.sideRail}>
          <div className={styles.tradeCard}>
            {/* buy/sell toggle — full-bleed tabs, bolder pump-style. Hidden
                once the curve graduates: the GraduatedPanel has its own
                buy/sell control and this outer state stops driving anything,
                so leaving both visible was just duplicate UI (2 stacked
                tab rows). Pre-graduation this drives the curve trade side. */}
            {!graduated && (
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
            {taxSentence && (
              <div className={styles.taxNote}>
                <b>Token tax:</b> {taxSentence} {taxScopeNote(sellsTaxed)}
              </div>
            )}

            {graduated && !isErc20Pair && taxedEthPoolKey && curveAddress ? (
              <Erc20GraduatedPanel
                chain={activeChain}
                tokenAddress={tokenAddress}
                curveAddress={curveAddress}
                poolKey={taxedEthPoolKey}
                tokenIsCurrency0={false}
                pairCurrency={'0x0000000000000000000000000000000000000000'}
                pairSym="ETH"
                pairDecimals={18}
                tokenSymbol={(tokenSymbol as string) ?? ''}
                walletTokenBal={(walletBal as bigint | undefined) ?? 0n}
                walletPairBal={walletEthBal ?? 0n}
                walletOnActiveChain={walletOnActiveChain}
                onSwitchChain={() => {
                  if (activeChain) switchChain({ chainId: CHAIN_KEY_TO_ID[activeChain] });
                }}
                switchPending={switchPending}
                poolSpotPairPerToken={poolSpotPriceEthPerToken}
                dn404UnitWei={isDn404Token ? dn404UnitWei : undefined}
                walletSkipNft={walletSkipNft}
                taxBps={taxBps}
                sellsTaxed={sellsTaxed}
                onSwapComplete={() => {
                  slot0Q.refetch();
                  walletBalQ.refetch();
                  setV4RefetchTick((n) => n + 1);
                }}
              />
            ) : graduated && isErc20Pair && erc20PoolKey && pairCurrency && curveAddress ? (
              <Erc20GraduatedPanel
                chain={activeChain}
                tokenAddress={tokenAddress}
                curveAddress={curveAddress}
                poolKey={erc20PoolKey}
                tokenIsCurrency0={tokenIsCurrency0}
                pairCurrency={pairCurrency}
                pairSym={pairSym}
                pairDecimals={pairDecimals}
                tokenSymbol={(tokenSymbol as string) ?? ''}
                walletTokenBal={(walletBal as bigint | undefined) ?? 0n}
                walletPairBal={walletPairBal ?? 0n}
                walletOnActiveChain={walletOnActiveChain}
                onSwitchChain={() => {
                  if (activeChain) switchChain({ chainId: CHAIN_KEY_TO_ID[activeChain] });
                }}
                switchPending={switchPending}
                poolSpotPairPerToken={poolSpotPriceEthPerToken}
                dn404UnitWei={isDn404Token ? dn404UnitWei : undefined}
                walletSkipNft={walletSkipNft}
                taxBps={taxBps}
                sellsTaxed={sellsTaxed}
                onSwapComplete={() => {
                  slot0Q.refetch();
                  walletBalQ.refetch();
                  pairState.refetch();
                  setV4RefetchTick((n) => n + 1);
                }}
              />
            ) : graduated ? (
              <GraduatedPanel
                chain={activeChain}
                tokenAddress={tokenAddress}
                curveAddress={curveAddress}
                // Pass the per-token hook address (from graduations.hookAddress
                // in the indexer, or configHookAddr as fallback). Tokens that
                // graduated on an OLDER MultiHookHost (V1/V2/V3) point at that
                // hook forever - if we used HOOKS[chain]?.MultiHookHost (V4)
                // here, the poolKey for those tokens would derive to a pool
                // that doesn't exist, breaking the entire swap widget for
                // legacy graduations.
                hookAddr={hookAddr}
                tokenSymbol={(tokenSymbol as string) ?? ''}
                tokenTotalSupply={(tokenTotalSupply as bigint | undefined) ?? 0n}
                dn404UnitWei={isDn404Token ? dn404UnitWei : undefined}
                walletSkipNft={walletSkipNft}
                walletTokenBal={(walletBal as bigint | undefined) ?? 0n}
                walletOnActiveChain={walletOnActiveChain}
                onSwitchChain={() => {
                  if (activeChain) switchChain({ chainId: CHAIN_KEY_TO_ID[activeChain] });
                }}
                switchPending={switchPending}
                poolSpotEthPerToken={poolSpotPriceEthPerToken}
                onSwapComplete={() => {
                  // Instant refresh — no 8-30s polling wait. Refetches pool spot
                  // (slot0Q), wallet balances, and re-triggers the v4 events pull so
                  // the chart + recent trades show the user's just-completed swap.
                  slot0Q.refetch();
                  walletBalQ.refetch();
                  setV4RefetchTick((n) => n + 1);
                  // Nudge the v4 events effect by bumping its dep — via the receipt hash
                  // path we can't reach here, but the 30s interval will catch anything
                  // the immediate refetch misses.
                }}
              />
            ) : (
              <>
                <label style={{ display: 'block' }}>
                  <span className={styles.fieldLabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span>You pay</span>
                    {/* Wallet balance for the asset being spent — ETH on buy, the
                        token on sell. Only shown when connected. Clicking sets
                        the input to max. */}
                    {wallet && (
                      <button
                        type="button"
                        onClick={() => {
                          if (side === 'buy' && walletPairBal !== undefined) {
                            setInputAmount(fmtPair(walletPairBal));
                          } else if (side === 'sell' && walletBal !== undefined) {
                            setInputAmount(formatUnits(walletBal as bigint, 18));
                          }
                        }}
                        className={styles.balanceBtn}
                        title="Use your full balance"
                      >
                        {side === 'buy'
                          ? isErc20Pair
                            ? `Balance ${walletPairBal !== undefined ? Number(fmtPair(walletPairBal)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'} ${pairSym}`
                            : `Balance ${walletEthBal !== undefined ? Number(formatEther(walletEthBal)).toFixed(4) : '—'} ETH`
                          : `Balance ${walletBal !== undefined ? Number(formatUnits(walletBal as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'} ${(tokenSymbol as string) ?? ''}`}
                      </button>
                    )}
                  </span>
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
                      {side === 'buy' ? pairSym : (tokenSymbol as string) ?? ''}
                    </span>
                  </div>
                  {/* Anti-overshoot notice — the curve accepts every wei sent
                      even when only a fraction is needed to graduate, and the
                      excess ends up as launcher refund + smaller LP. Capping
                      the pay value at exactly ethToGraduate makes the last
                      buyer land right on target, LP absorbs the full amount,
                      no residual. Buyers see what happened. */}
                  {buyCapped && ethToGraduate !== null && (
                    <div className={styles.hint} style={{ marginTop: 6 }}>
                      Capped at {isErc20Pair ? Number(fmtPair(ethToGraduate)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : Number(formatEther(ethToGraduate)).toFixed(4)} {pairSym}, the amount needed to graduate. The rest stays in your wallet.
                    </div>
                  )}
                  {curveNftGuard && (
                    <Dn404GasNotice
                      guard={curveNftGuard}
                      tokenSymbol={(tokenSymbol as string) ?? ''}
                      inputLabel={curveNftGuard.side === 'buy' ? pairSym : (tokenSymbol as string) ?? ''}
                      formatInput={(v) => isErc20Pair ? Number(fmtPair(v)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : Number(formatEther(v)).toFixed(4)}
                    />
                  )}
                </label>

                {/* Quick pick chips — always visible on buy, only if balance>0 on sell */}
                <div>
                  <div className={styles.quickLabel}>Quick amounts</div>
                  {/* Buy-side presets are ETH amounts; hidden for ERC-20 pairs. */}
                  {!(isErc20Pair && side === 'buy') && <QuickAmounts
                    side={side}
                    walletBal={walletBal as bigint | undefined}
                    onPick={(amount) => setInputAmount(amount)}
                  />}
                </div>

                <div className={styles.quoteBox}>
                  <div className={styles.fieldLabel}>
                    You receive <span className={styles.hint}>estimate</span>
                  </div>
                  <div className={styles.quoteValue}>
                    {inputWei === 0n
                      ? '—'
                      : side === 'buy'
                        ? `${Number(formatUnits(quoteOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${(tokenSymbol as string) ?? ''}`
                        : isErc20Pair
                          ? `${Number(fmtPair(quoteOut)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${pairSym}`
                          : `${Number(formatEther(quoteOut)).toFixed(6)} ETH`}
                  </div>
                  {quoteFee > 0n && (
                    <div className={styles.hint} style={{ marginTop: 2 }}>
                      Fee {`${fmtPair(quoteFee)} ${pairSym}`}
                    </div>
                  )}
                </div>

                <label className={styles.slippageRow}>
                  <span className={styles.fieldLabel}>
                    Max slippage (%)
                  </span>
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
                  onClick={() => {
                    // Wallet on wrong chain? Prompt switch before submitting the trade. Once
                    // the wallet reports the new chain, `walletOnActiveChain` flips true and
                    // the button falls through to normal submit behavior.
                    if (connectedForRender && !walletOnActiveChain && activeChain) {
                      switchChain({ chainId: CHAIN_KEY_TO_ID[activeChain] });
                      return;
                    }
                    submit();
                  }}
                  disabled={
                    !connectedForRender ||
                    inputWei === 0n ||
                    writePending ||
                    receipt.isLoading ||
                    switchPending ||
                    // WL pre-fallback window: regular buy() reverts with
                    // BondingCurve__WlWindowActive. Only buyWithProof works
                    // during this window (shown in the WL panel above).
                    (wlEnabled && wlPreFallback && side === 'buy') ||
                    curveNftGuard !== null ||
                    (walletOnActiveChain && side === 'buy' && needsPairApproval && !pairApproveSim.data) ||
                    (walletOnActiveChain && side === 'buy' && !needsPairApproval && !activeBuySim.data) ||
                    (walletOnActiveChain && side === 'sell' && !needsApproval && !sellSim.data)
                  }
                  className={`ui-btn ${styles.primaryAction}`}
                  data-variant={side === 'buy' ? 'buy' : 'sell'}
                  data-size="lg"
                >
                  {!connectedForRender
                    ? 'Connect wallet'
                    : !walletOnActiveChain && activeChain
                      ? switchPending
                        ? 'Switching…'
                        : `Switch to ${activeChain}`
                      : writePending
                        ? 'Confirm in your wallet…'
                        : receipt.isLoading
                          ? 'Waiting for confirmation…'
                          : wlEnabled && wlPreFallback && side === 'buy'
                            ? 'Public buys open after the whitelist window'
                            : side === 'sell' && needsApproval
                              ? 'Approve first'
                              : needsPairApproval
                                ? `Approve ${pairSym} first`
                              : side === 'buy'
                                ? `Buy ${(tokenSymbol as string) ?? ''}`
                                : `Sell ${(tokenSymbol as string) ?? ''}`}
                </button>

                {(activeBuySim.error || sellSim.error) && (
                  <div className={styles.errorNote}>
                    This trade would fail right now: {(activeBuySim.error ?? sellSim.error)?.message.slice(0, 120)}
                  </div>
                )}

                {/* Whitelist buy — shown only pre-graduation while a WL is active on the
                    curve, the fallback window hasn't elapsed, and the connected wallet
                    resolves to a valid proof. WL buys draw from the reserved slice at the
                    same curve price; tokens land in the buyer's wallet immediately so
                    they can sell or transfer like any non-WL holder — no post-graduation
                    claim step. */}
                {wlEnabled && wlPreFallback && side === 'buy' && connectedForRender && (
                  <div className={styles.wlBox}>
                    <b>Community whitelist is active</b>
                    {wlSourceValid && (wlSourceSymbol || wlSourceName) && (
                      <div className={styles.wlMeta}>
                        For holders of{' '}
                        {(wlSourceChainKey ?? activeChain) ? (
                          <a
                            href={explorerAddressUrl((wlSourceChainKey ?? activeChain)!, wlSourceToken!)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.link}
                          >
                            <b>${wlSourceSymbol ?? wlSourceName}</b>
                            {wlSourceSymbol && wlSourceName && wlSourceSymbol !== wlSourceName ? ` (${wlSourceName})` : ''}
                          </a>
                        ) : (
                          <b>${wlSourceSymbol ?? wlSourceName}</b>
                        )}
                        {wlSourceChainKey === 'mainnet' ? ' on Ethereum' : ''}
                      </div>
                    )}
                    {wlFallbackTs && wlFallbackTs > 0n && (
                      <WlCountdown fallbackTs={wlFallbackTs} />
                    )}
                    {(() => {
                      // Fill-% bar for the WL reserved slice — visual signal of how
                      // close the WL slice is to filling before the 1h public window
                      // opens. Non-visible when reservedTokens hasn't loaded yet.
                      if (!wlReservedTokens || wlSoldTokens === undefined) {
                        return (
                          <div className={styles.wlMeta}>
                            Reserved slice loading…
                          </div>
                        );
                      }
                      const pct = wlReservedTokens > 0n
                        ? Number((wlSoldTokens * 10_000n) / wlReservedTokens) / 100
                        : 0;
                      const soldStr = Number(formatUnits(wlSoldTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
                      const reservedStr = Number(formatUnits(wlReservedTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
                      return (
                        <>
                          <div className={styles.wlRow}>
                            <span>Reserved slice</span>
                            <span className={styles.wlNum}>{soldStr} / {reservedStr} ({pct.toFixed(1)}%)</span>
                          </div>
                          <div
                            aria-label={`whitelist reserved slice ${pct.toFixed(0)}% filled`}
                            className={styles.wlBar}
                          >
                            <div
                              className={styles.wlFill}
                              style={{
                                width: `${Math.min(100, pct)}%`,
                                background: pct >= 100 ? 'var(--buy)' : 'var(--accent)',
                              }}
                            />
                          </div>
                        </>
                      );
                    })()}
                    {!wlListCid ? (
                      <div className={styles.wlMeta}>
                        The whitelist isn&apos;t available in this browser. The launcher needs to
                        share it, or open this page in a browser that has the metadata cached.
                      </div>
                    ) : wlProof ? (
                      <>
                        <div className={styles.wlEligible}>
                          You&apos;re eligible. Whitelist buys lock until graduation.
                        </div>
                        <button
                          type="button"
                          onClick={() => wlBuySim.data && writeContract(wlBuySim.data.request)}
                          disabled={
                            inputWei === 0n
                            || writePending
                            || receipt.isLoading
                            || !walletOnActiveChain
                            || !wlBuySim.data
                          }
                          className="ui-btn"
                          data-variant="primary"
                          data-block="true"
                        >
                          {writePending ? 'Confirm in your wallet…' : 'Buy (whitelist)'}
                        </button>
                        {wlBuySim.error && (
                          <div className={styles.errorNote}>
                            Whitelist buy would fail right now: {wlBuySim.error.message.slice(0, 120)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className={styles.wlMeta}>
                        {wlProofErr ?? 'Checking your eligibility…'}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            </div>
          </div>

          {/* Curve stats — tight rows */}
          <div className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Curve stats</h2>
            <ul className={styles.statsList}>
              <li>
                <span>Price</span>
                <FlashCell value={effectiveSpotPrice}>
                  <span className={styles.statStrong}>
                    {effectiveSpotPrice > 0n ? showPrice(effectiveSpotPrice) : '—'}
                  </span>
                </FlashCell>
              </li>
              <li>
                <span>Tokens sold</span>
                <span className={styles.statStrong}>
                  {Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li
                title={
                  wallet
                    ? `Balance of ${wallet}. If you use a smart wallet that submits through a different signer, tokens may sit at the smart account address instead.`
                    : 'Connect a wallet to see its balance.'
                }
              >
                <span>
                  Your balance
                  {wallet && (
                    <span className={styles.addrTag}>
                      {wallet.slice(0, 6)}…{wallet.slice(-4)}
                    </span>
                  )}
                </span>
                <span className={styles.statStrong}>
                  {walletBal !== undefined ? Number(formatUnits(walletBal as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                </span>
              </li>
              <li>
                <span>Curve contract</span>
                <Link
                  href={explorerAddressUrl(activeChain as ChainKey, curveAddress)}
                  target="_blank"
                >
                  {curveAddress.slice(0, 6)}…{curveAddress.slice(-4)}
                </Link>
              </li>
            </ul>
          </div>
          <details className={styles.accordion}>
            <summary>How trading works here</summary>
            <ul className={styles.riskList}>
              <li>{graduated ? 'Curve trading is closed; swaps route through the graduated Uniswap v4 pool.' : `Buys and sells route through the bonding curve until the ${pairSym} target is reached.`}</li>
              <li>Quotes can move before confirmation. Slippage protects the minimum output, not final price movement after submission.</li>
              <li>Creator and fee data come from indexed launch and on-chain curve reads when available.</li>
            </ul>
          </details>
          {wallet && activeChain && (
            <details className={styles.accordion}>
              <summary>Owner controls</summary>
              <div style={{ marginTop: 10 }}>
                <TokenOwnerControls visibleFor={wallet as Address} chain={activeChain} />
              </div>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}

/// Metadata sidebar + edit modal. Renders whatever the API knows about this token
/// (image, description, socials). Any connected wallet can click "edit" — the API
/// enforces launcher-only writes, so a non-launcher just gets a 403 back and sees an
/// inline error. Enables the launcher to back-fill an image after launch (or update it
/// later).
function MetadataPanel({
  metadata,
  tokenAddress,
  chainId,
  wallet,
  launcher,
  onSaved,
}: {
  metadata: TokenMetadata | null;
  tokenAddress: Address;
  chainId: number;
  wallet: Address | undefined;
  launcher: Address | null;
  onSaved: (next: TokenMetadata | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const hasContent = !!(metadata && (
    metadata.logoDataUrl || metadata.description || metadata.website ||
    metadata.twitter || metadata.telegram || metadata.discord || metadata.tiktok
  ));

  // Only the launcher wallet gets the edit affordance. Server enforces this too
  // (403 NOT_LAUNCHER), but showing the button to non-owners was confusing UX
  // and let a tester think they could edit metadata they didn't own.
  const canEdit = !!wallet && !!launcher && wallet.toLowerCase() === launcher.toLowerCase();

  return (
    <div className={infoStyles.block}>
      <div className={infoStyles.head}>
        <p className={infoStyles.label}>About</p>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={infoStyles.editBtn}>
            {hasContent ? 'Edit' : 'Add image + info'}
          </button>
        )}
      </div>
      {metadata?.description && <p className={infoStyles.text}>{metadata.description}</p>}
      {(metadata?.website || metadata?.twitter || metadata?.telegram || metadata?.discord || metadata?.tiktok) && (
        <div className={infoStyles.links}>
          {metadata.website && <Socialz href={metadata.website} label="Website" />}
          {metadata.twitter && <Socialz href={metadata.twitter} label="X" />}
          {metadata.telegram && <Socialz href={metadata.telegram} label="Telegram" />}
          {metadata.discord && <Socialz href={metadata.discord} label="Discord" />}
          {metadata.tiktok && <Socialz href={metadata.tiktok} label="TikTok" />}
        </div>
      )}
      {!hasContent && (
        <p className={infoStyles.muted}>
          {canEdit
            ? 'No info yet. Use "Add image + info" to give your token a card.'
            : 'No info yet. The launcher hasn’t added any.'}
        </p>
      )}
      {editing && canEdit && wallet && (
        <EditMetadataModal
          initial={metadata}
          tokenAddress={tokenAddress}
          chainId={chainId}
          wallet={wallet}
          onClose={() => setEditing(false)}
          onSaved={(next) => { setEditing(false); onSaved(next); }}
        />
      )}
    </div>
  );
}

function EditMetadataModal({
  initial,
  tokenAddress,
  chainId,
  wallet,
  onClose,
  onSaved,
}: {
  initial: TokenMetadata | null;
  tokenAddress: Address;
  chainId: number;
  wallet: Address;
  onClose: () => void;
  onSaved: (next: TokenMetadata) => void;
}) {
  const [inputs, setInputs] = useState<MetadataInputs>({
    logoDataUrl: initial?.logoDataUrl,
    description: initial?.description,
    website: initial?.website,
    twitter: initial?.twitter,
    telegram: initial?.telegram,
    discord: initial?.discord,
    tiktok: initial?.tiktok,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signMessageAsync } = useSignMessage();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // persistMetadata handles the Pinata upload (if NEXT_PUBLIC_PINATA_JWT is set)
      // and returns { cid, gatewayUrl } once pinned. Without Pinata we'd only have
      // the inline data URL, which the API refuses (imageUrl must be an http URL).
      const pinned = await persistMetadata(chainId, tokenAddress, {
        logoDataUrl: inputs.logoDataUrl,
        description: inputs.description,
        website: inputs.website,
        twitter: inputs.twitter,
        telegram: inputs.telegram,
        discord: inputs.discord,
        tiktok: inputs.tiktok,
      });
      const remote = await saveTokenMetadata(
        wallet,
        {
          chainId,
          tokenAddress,
          imageUrl: pinned.gatewayUrl ?? null,
          description: inputs.description ?? null,
          website: inputs.website ?? null,
          twitter: inputs.twitter ?? null,
          telegram: inputs.telegram ?? null,
          discord: inputs.discord ?? null,
          tiktok: inputs.tiktok ?? null,
          // Preserve the WL list CID across edits. Without this, a launcher
          // who opens the edit modal to add / fix their image would clobber
          // the wlListCid to null and the WL becomes unfetchable for every
          // other browser. `initial.wlListCid` comes from either the local
          // snapshot (launcher's browser has it cached from create) or the
          // remote fetch — whichever is present is the source of truth we
          // want to keep intact.
          wlListCid: initial?.wlListCid ?? null,
        },
        ({ message }) => signMessageAsync({ message }),
      );
      if (!remote.ok) {
        setError(remote.error === 'NOT_LAUNCHER'
          ? 'Only the launcher wallet can edit this token.'
          : `Save failed: ${remote.error}`);
        return;
      }
      onSaved({ ...pinned, savedAt: Date.now() });
    } catch (err) {
      setError((err as Error).message || 'Save cancelled.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} className="ui-overlay" data-sheet="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ui-dialog"
        style={{ ['--ui-dialog-w' as string]: '560px' }}
      >
        <div className="ui-dialog-head">
          <h2 className="ui-dialog-title">Edit token info</h2>
          <button
            type="button"
            onClick={onClose}
            className="ui-btn"
            data-variant="ghost"
            data-size="sm"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="ui-dialog-body">
          <MetadataForm value={inputs} onChange={setInputs} hideIntro />
          {error && (
            <div className={styles.errorNote} style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
          <div className={styles.dialogActions}>
            <button type="button" onClick={onClose} className="ui-btn" disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="ui-btn"
              data-variant="primary"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Sign and save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// Panel shown on `/trade/[address]` once the underlying BondingCurve has graduated. The
/// curve is closed for buys/sells at this point; users trade through the v4 pool the
/// Graduator seeded. Provides a real in-app buy/sell widget backed by V4SwapRouter, plus a
/// deep-link fallback to Uniswap's swap UI.
function GraduatedPanel({
  chain,
  tokenAddress,
  curveAddress,
  hookAddr,
  tokenSymbol,
  tokenTotalSupply,
  walletTokenBal,
  walletOnActiveChain,
  onSwitchChain,
  switchPending,
  poolSpotEthPerToken,
  onSwapComplete,
  dn404UnitWei,
  walletSkipNft,
}: {
  chain: ChainKey | null;
  tokenAddress: Address;
  curveAddress: Address;
  /// Per-token hook address (indexer's graduations.hookAddress, with V4 config
  /// fallback). Tokens graduated on V1/V2/V3 MultiHookHost still point at those
  /// old hooks - the poolKey MUST use whichever hook was live at graduation
  /// time or the pool won't resolve.
  hookAddr: Address | undefined;
  tokenSymbol: string;
  tokenTotalSupply: bigint;
  walletTokenBal: bigint;
  walletOnActiveChain: boolean;
  onSwitchChain: () => void;
  switchPending: boolean;
  /// Wei-of-ETH per whole token, from the graduated v4 pool's slot0. Used to compute a
  /// first-order output preview ("you receive ≈ X") — final amount will differ due to
  /// AMM slippage + hook fees, but this makes the panel feel less blind.
  poolSpotEthPerToken: bigint;
  /// Fires the first time a tx receipt lands per unique tx hash. Outer trade page uses
  /// this to force-refetch pool spot + wallet balance + trade list without waiting for
  /// the natural polling intervals (8-30s).
  onSwapComplete: () => void;
  /// DN404 only: tokens per NFT in wei, and the wallet's skipNFT flag. Omitted
  /// (or 0) for plain ERC-20 tokens, which disables the NFT gas guard.
  dn404UnitWei?: bigint;
  walletSkipNft?: boolean;
}) {
  const { address: wallet, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const connectedForRender = mounted && isConnected;

  const chainId = chain ? CHAIN_KEY_TO_ID[chain] : undefined;
  const v4Router = chain ? V4_ROUTERS[chain] : null;
  // hookAddr comes as a prop from the outer page (per-token via indexer). No
  // more `HOOKS[chain]?.MultiHookHost` pin - that would break V3-graduated
  // tokens that live on the old hook.

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amountInput, setAmountInput] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');

  const inputWei = useMemo(() => {
    try {
      return side === 'buy' ? parseEther(amountInput || '0') : parseUnits(amountInput || '0', 18);
    } catch {
      return 0n;
    }
  }, [side, amountInput]);

  const poolKey = useMemo(() => {
    if (!hookAddr) return null;
    return {
      currency0: '0x0000000000000000000000000000000000000000' as Address,
      currency1: tokenAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: hookAddr,
    };
  }, [hookAddr, tokenAddress]);

  // Approval check for sells.
  const allowanceQ = useReadContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'allowance',
    args: wallet && v4Router ? [wallet, v4Router] : undefined,
    chainId,
    query: { enabled: !!wallet && !!v4Router, refetchInterval: 15_000 },
  });
  const currentAllowance = (allowanceQ.data as bigint | undefined) ?? 0n;
  const needsApproval = side === 'sell' && inputWei > 0n && currentAllowance < inputWei;

  // DN404 per-tx NFT gas guard (see web/src/lib/dn404Gas.ts). Inert for
  // non-DN404 tokens: the outer page only passes dn404UnitWei for DN404 bases.
  const poolNftGuard = useMemo(() => {
    const unit = dn404UnitWei ?? 0n;
    if (unit <= 0n || inputWei === 0n) return null;
    if (side === 'buy') {
      const est = poolSpotEthPerToken > 0n ? (inputWei * 10n ** 18n) / poolSpotEthPerToken : 0n;
      const n = nftsMinted(walletTokenBal, est, unit, !!walletSkipNft);
      if (n <= MAX_NFTS_PER_TX) return null;
      const maxTokens = maxTokensInForNfts(walletTokenBal, unit, !!walletSkipNft) ?? 0n;
      return { side: 'buy' as const, nfts: n, maxTokens, aboutInput: scaleInputForOutput(inputWei, est, maxTokens) };
    }
    const n = nftsBurned(walletTokenBal, inputWei, unit, !!walletSkipNft);
    if (n <= MAX_NFTS_PER_TX) return null;
    return { side: 'sell' as const, nfts: n, maxTokens: maxTokensOutForNfts(walletTokenBal, unit, !!walletSkipNft) ?? 0n, aboutInput: 0n };
  }, [dn404UnitWei, walletSkipNft, inputWei, side, walletTokenBal, poolSpotEthPerToken]);

  // slippage → minOut is done inside sim to keep it live. Rough: 2% default.
  const slippageBps = Math.max(0, Math.min(5000, Math.round(Number(slippagePct || '0') * 100)));
  const minOut = inputWei === 0n ? 0n : (inputWei * BigInt(10_000 - slippageBps)) / 10_000n;

  // 5-min tx deadline for v4 router calls. Kept in state (not computed at
  // render) so the sim args stay stable across renders — otherwise every
  // render would recompute Date.now(), refire useSimulateContract, and
  // burn RPC calls. A ticker in a useEffect refreshes the anchor every 30s
  // so long-idle tabs still get an accurate deadline when the user clicks.
  // Also satisfies the react-hooks/purity lint (Date.now is impure).
  const [txDeadline, setTxDeadline] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000) + 300));
  useEffect(() => {
    const id = setInterval(() => setTxDeadline(BigInt(Math.floor(Date.now() / 1000) + 300)), 30_000);
    return () => clearInterval(id);
  }, []);

  const buySim = useSimulateContract({
    abi: v4SwapRouterAbi,
    address: (v4Router as Address | undefined) ?? undefined,
    functionName: 'swapExactETHForToken',
    // 5-min deadline: signed txs that idle in the mempool longer than this
    // revert at the router instead of executing at a stale price. V4 router
    // added this param; it was optional pre-V4 (no such arg).
    args: poolKey && wallet ? [poolKey, 1n, wallet, txDeadline] : undefined,
    value: inputWei,
    account: wallet,
    chainId,
    query: {
      enabled: !!poolKey && !!v4Router && !!wallet && walletOnActiveChain && side === 'buy' && inputWei > 0n,
    },
  });
  const sellSim = useSimulateContract({
    abi: v4SwapRouterAbi,
    address: (v4Router as Address | undefined) ?? undefined,
    functionName: 'swapExactTokenForETH',
    args: poolKey && wallet ? [poolKey, inputWei, 1n, wallet, txDeadline] : undefined,
    account: wallet,
    chainId,
    query: {
      enabled:
        !!poolKey && !!v4Router && !!wallet && walletOnActiveChain && side === 'sell' && inputWei > 0n && !needsApproval,
    },
  });
  const approveSim = useSimulateContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'approve',
    args: v4Router ? [v4Router as Address, 2n ** 256n - 1n] : undefined,
    account: wallet,
    chainId,
    query: { enabled: !!v4Router && !!wallet && walletOnActiveChain && side === 'sell' && needsApproval },
  });

  const { writeContract, isPending: writePending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash as Hex | undefined });

  // Fire onSwapComplete once per unique receipt hash — the outer trade page refetches
  // pool state + wallet balance immediately so users see the effect of their swap
  // without waiting for the polling intervals (8-30s).
  const notifiedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const h = receipt.data?.transactionHash;
    if (!h || h === notifiedRef.current) return;
    notifiedRef.current = h;
    onSwapComplete();
    // Also clear the amount input on successful swap so users don't accidentally re-send.
    setAmountInput('');
  }, [receipt.data?.transactionHash, onSwapComplete]);

  const submit = () => {
    if (side === 'sell' && needsApproval && approveSim.data) {
      writeContract(approveSim.data.request);
    } else if (side === 'buy' && buySim.data) {
      writeContract(buySim.data.request);
    } else if (side === 'sell' && sellSim.data) {
      writeContract(sellSim.data.request);
    }
  };

  const uniswapUrl = chainId
    ? `https://app.uniswap.org/swap?chain=${chain}&inputCurrency=NATIVE&outputCurrency=${tokenAddress}&exactField=input`
    : `https://app.uniswap.org/swap?outputCurrency=${tokenAddress}`;

  // Uniswap only surfaces hooks that are on its allowlist in the UI. Off-allowlist
  // hooks render as bare v4 pools with no metadata — someone can seed 0.001 ETH
  // of "LP" as bait, our deep-link routes buyers there, and they get robbed on
  // slippage. Until each chain's hook is allowlisted, hide the "open on Uniswap"
  // affordance entirely on that chain.
  //
  // Flip a chain's entry to `true` once its hook is confirmed on the Uniswap
  // allowlist. Explorer link stays available so people can always inspect
  // the pool address directly.
  const HOOK_UNISWAP_ALLOWLISTED: Partial<Record<string, boolean>> = {
    mainnet: true,
    base: true,
    'base-sepolia': true,
    sepolia: true,
    // Both V9 MHH (0xc282…20C4) and V10 MHH (0x83d6…E0C4) allowlisted by
    // Uniswap Labs 2026-08-14 — V9 covers LUV/GEMUSE and other legacy tokens,
    // V10 covers everything launched post-2026-08-12 rotation.
    robinhood: true,
    'robinhood-testnet': false,
  };
  // Per-hook override: a pool on a hook still under Uniswap review stays off.
  const hookPendingReview = !!hookAddr && UNISWAP_ALLOWLIST_PENDING_HOOKS.has(hookAddr.toLowerCase());
  const uniswapLinkSafe = chain ? (HOOK_UNISWAP_ALLOWLISTED[chain] ?? false) && !hookPendingReview : false;

  if (!v4Router) {
    return (
      <div className={styles.unavailable}>
        <b>Graduated</b>
        {uniswapLinkSafe ? (
          <>
            <span className={styles.hint}>
              In-app swaps aren&apos;t set up on this chain yet. You can trade on Uniswap.
            </span>
            <a href={uniswapUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
              Open Uniswap ↗
            </a>
          </>
        ) : (
          <span className={styles.hint}>
            In-app swaps aren&apos;t available on this chain yet.
          </span>
        )}
      </div>
    );
  }

  const balanceMax = side === 'sell' ? walletTokenBal : 0n;

  return (
    <div className={styles.poolPanel}>
      <div className={styles.poolTitle}>Trading on Uniswap v4</div>

      {/* Buy/sell toggle */}
      <div className={styles.tabGrid}>
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setAmountInput(''); }}
            className={styles.tabButton}
            data-active={side === s}
            data-side={s}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      {/* Input */}
      <label style={{ display: 'block' }}>
        <span className={styles.fieldLabel}>
          You pay
        </span>
        <div className={styles.inputRow}>
          <input
            className="ui-input"
            type="number"
            step="0.001"
            min="0"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.0"
            style={{ flex: 1 }}
          />
          <span className={styles.assetLabel}>
            {side === 'buy' ? 'ETH' : tokenSymbol || 'TKN'}
          </span>
        </div>
      </label>

      {/* Sell balance hint + max */}
      {side === 'sell' && (
        <div className={styles.poolBal}>
          <span>Balance {Number(formatUnits(walletTokenBal, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          <button
            type="button"
            onClick={() => setAmountInput(formatUnits(balanceMax, 18))}
            className={styles.balanceBtn}
          >
            Max
          </button>
        </div>
      )}

      {/* You receive — first-order estimate from pool spot × amount. Real amount differs
          due to AMM slippage + MultiHookHost's 2% output cut; we render "≈" to be honest. */}
      <div
        className={styles.quoteBox}
      >
        <div className={styles.fieldLabel}>
          You receive <span className={styles.hint}>estimate</span>
        </div>
        <div className={styles.quoteValue}>
          {inputWei === 0n || poolSpotEthPerToken === 0n
            ? '—'
            : side === 'buy'
              ? `≈ ${Number(formatUnits((inputWei * 10n ** 18n) / poolSpotEthPerToken, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${tokenSymbol || 'TKN'}`
              : `≈ ${Number(formatEther((inputWei * poolSpotEthPerToken) / 10n ** 18n)).toFixed(6)} ETH`}
        </div>
        <div className={styles.hint} style={{ marginTop: 2 }}>
          Final amount varies with slippage and the 2% swap fee.
        </div>
      </div>
      {poolNftGuard && (
        <Dn404GasNotice
          guard={poolNftGuard}
          tokenSymbol={tokenSymbol || 'TKN'}
          inputLabel={poolNftGuard.side === 'buy' ? 'ETH' : tokenSymbol || 'TKN'}
          formatInput={(v) => Number(formatEther(v)).toFixed(4)}
        />
      )}

      {/* Slippage */}
      <label className={styles.slippageRow}>
        <span className={styles.fieldLabel}>
          Max slippage (%)
        </span>
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

      {/* Submit button */}
      <button
        type="button"
        onClick={() => {
          if (connectedForRender && !walletOnActiveChain) { onSwitchChain(); return; }
          submit();
        }}
        disabled={
          !connectedForRender ||
          inputWei === 0n ||
          writePending ||
          receipt.isLoading ||
          switchPending ||
          poolNftGuard !== null ||
          (walletOnActiveChain && side === 'buy' && !buySim.data) ||
          (walletOnActiveChain && side === 'sell' && !needsApproval && !sellSim.data)
        }
        className={`ui-btn ${styles.primaryAction}`}
        data-variant={side === 'buy' ? 'buy' : 'sell'}
        data-size="lg"
      >
        {!connectedForRender
          ? 'Connect wallet'
          : !walletOnActiveChain
            ? switchPending ? 'Switching…' : `Switch to ${chain}`
            : writePending
              ? 'Confirm in your wallet…'
              : receipt.isLoading
                ? 'Waiting for confirmation…'
                : side === 'sell' && needsApproval
                  ? 'Approve first'
                  : side === 'buy'
                    ? `Buy ${tokenSymbol || ''}`
                    : `Sell ${tokenSymbol || ''}`}
      </button>

      {(buySim.error || sellSim.error) && (
        <div className={styles.errorNote}>
          This trade would fail right now: {(buySim.error ?? sellSim.error)?.message.slice(0, 120)}
        </div>
      )}

      {/* Fallback link + explorer */}
      <div className={styles.poolLinks}>
        <div><b>Prefer another app?</b></div>
        {uniswapLinkSafe ? (
          <div>
            <a href={uniswapUrl} target="_blank" rel="noopener noreferrer">
              Open on Uniswap ↗
            </a>
          </div>
        ) : (
          <div>
            The Uniswap link is hidden until this pool&apos;s hook is on Uniswap&apos;s allowlist. Their
            app could route you to a different pool with the same token. Trade here instead.
          </div>
        )}
        {chain && (
          <div>
            <a
              href={explorerAddressUrl(chain, curveAddress)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View curve on explorer ↗
            </a>
          </div>
        )}
      </div>
      {/* Silence unused ref warnings for tokenTotalSupply — kept in the API for a future
          "your position vs float" line. */}
      <span style={{ display: 'none' }}>{tokenTotalSupply.toString()}</span>
    </div>
  );
}

/// Post-graduation swap widget for ERC-20-paired DN404 tokens (pool = token /
/// pair, e.g. REH404 / URU, on the DN404 MultiHookHost). Our V4SwapRouter only
/// handles native-ETH pools, so this goes through Uniswap's Universal Router:
///   1. inputToken.approve(Permit2, max)          (once per token)
///   2. Permit2.approve(inputToken, UR, max160, +30d)  (when short or expired)
///   3. UR.execute([V4_SWAP], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL])
/// Buy = pair -> token, sell = token -> pair. The ETH GraduatedPanel is
/// untouched; the outer page picks one or the other on `isErc20Pair`.
function Erc20GraduatedPanel({
  chain,
  tokenAddress,
  curveAddress,
  poolKey,
  tokenIsCurrency0,
  pairCurrency,
  pairSym,
  pairDecimals,
  tokenSymbol,
  walletTokenBal,
  walletPairBal,
  walletOnActiveChain,
  onSwitchChain,
  switchPending,
  poolSpotPairPerToken,
  onSwapComplete,
  dn404UnitWei,
  walletSkipNft,
  taxBps = 0,
  sellsTaxed = true,
}: {
  chain: ChainKey | null;
  tokenAddress: Address;
  curveAddress: Address;
  poolKey: ReturnType<typeof buildErc20PoolKey>;
  tokenIsCurrency0: boolean;
  pairCurrency: Address;
  pairSym: string;
  pairDecimals: number;
  tokenSymbol: string;
  walletTokenBal: bigint;
  walletPairBal: bigint;
  walletOnActiveChain: boolean;
  onSwitchChain: () => void;
  switchPending: boolean;
  /// Pair-token atomic units per WHOLE token, from slot0.
  poolSpotPairPerToken: bigint;
  /// DN404 only: tokens per NFT in wei + the wallet's skipNFT flag (NFT gas guard).
  dn404UnitWei?: bigint;
  walletSkipNft?: boolean;
  onSwapComplete: () => void;
  /// Token transfer tax in bps (DN404 tax template). 0 = untaxed. When > 0:
  /// sells use the settle-first order (only the post-tax amount reaches the
  /// pool) and quotes subtract the tax on the token side.
  taxBps?: number;
  /// false for Dn404TaxTemplateV3 tokens: transfers into the PoolManager are
  /// untaxed, so sells quote on the full amount. Sells still use settle-first.
  sellsTaxed?: boolean;
}) {
  const { address: wallet, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const connectedForRender = mounted && isConnected;

  const chainId = chain ? CHAIN_KEY_TO_ID[chain] : undefined;
  const router = chain ? UNIVERSAL_ROUTERS[chain] : null;
  const permit2 = chain ? PERMIT2[chain] : null;

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amountInput, setAmountInput] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');

  const inputToken: Address = side === 'buy' ? pairCurrency : tokenAddress;
  // ETH-paired pools (taxed DN404s route here too): a buy pays native ETH as
  // msg.value, so there is no ERC-20 / Permit2 approval for the input.
  const nativeIn = side === 'buy' && pairCurrency.toLowerCase() === '0x0000000000000000000000000000000000000000';
  const taxedSell = taxBps > 0 && side === 'sell';
  const inputDecimals = side === 'buy' ? pairDecimals : 18;
  const inputWei = useMemo(() => {
    try { return parseUnits(amountInput || '0', inputDecimals); } catch { return 0n; }
  }, [amountInput, inputDecimals]);

  // Clock anchor for the swap deadline + Permit2 expiry. Kept in state and
  // refreshed every 30s so sim args stay stable between renders.
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  const txDeadline = BigInt(nowSec + 300);
  const permitExpiry = nowSec + 30 * 24 * 3600;

  // Step 1: ERC-20 allowance to Permit2. Step 2: Permit2 allowance to the router.
  const approvals = useReadContracts({
    contracts: wallet && permit2 && router && !nativeIn
      ? [
          { abi: erc20TokenAbi, address: inputToken, functionName: 'allowance', args: [wallet, permit2], chainId } as const,
          { abi: permit2Abi, address: permit2, functionName: 'allowance', args: [wallet, inputToken, router], chainId } as const,
        ]
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: !!wallet && !!permit2 && !!router && !nativeIn, refetchInterval: 15_000 },
  });
  const erc20ToPermit2 = (approvals.data?.[0]?.result as bigint | undefined) ?? 0n;
  const p2 = approvals.data?.[1]?.result as readonly [bigint, number, number] | undefined;
  const p2Amount = p2?.[0] ?? 0n;
  const p2Expiry = p2?.[1] ?? 0;
  const needsErc20Approve = !nativeIn && inputWei > 0n && erc20ToPermit2 < inputWei;
  const needsPermit2Approve = !nativeIn && !needsErc20Approve && inputWei > 0n && (p2Amount < inputWei || p2Expiry <= nowSec + 60);

  // Expected output from slot0 spot. No v4 Quoter read exists in this app, so
  // minOut is spot-based: expected * (1 - 0.3% LP fee - 2% hook fee - slippage).
  // Price impact is NOT modelled; a large trade will fail the sim (and the
  // button stays disabled) rather than execute at a bad price.
  const slippageBps = Math.max(0, Math.min(5000, Math.round(Number(slippagePct || '0') * 100)));
  // poolExpectedOut = what the POOL pays (the router's slippage checks run on
  // this, before any token tax). expectedOut = what lands in the wallet.
  //   taxed sell: only inputWei minus tax reaches the pool, so quote on that;
  //   taxed buy: the pool pays poolExpectedOut, the wallet nets it minus tax.
  const poolExpectedOut = useMemo(() => {
    if (inputWei === 0n || poolSpotPairPerToken === 0n) return 0n;
    return side === 'buy'
      ? (inputWei * 10n ** 18n) / poolSpotPairPerToken
      : (taxedSellPoolInput(inputWei, taxBps, sellsTaxed) * poolSpotPairPerToken) / 10n ** 18n;
  }, [inputWei, poolSpotPairPerToken, side, taxBps, sellsTaxed]);
  const expectedOut = side === 'buy' ? taxedBuyNetOut(poolExpectedOut, taxBps) : poolExpectedOut;
  const feeAndSlipBps = 230 + slippageBps;
  const minOut = feeAndSlipBps >= 10_000 ? 0n : (poolExpectedOut * BigInt(10_000 - feeAndSlipBps)) / 10_000n;
  const minOutNet = side === 'buy' ? taxedBuyNetOut(minOut, taxBps) : minOut;

  // DN404 per-tx NFT gas guard (see web/src/lib/dn404Gas.ts). Inert for
  // non-DN404 tokens: the outer page only passes dn404UnitWei for DN404 bases.
  const poolNftGuard = useMemo(() => {
    const unit = dn404UnitWei ?? 0n;
    if (unit <= 0n || inputWei === 0n) return null;
    if (side === 'buy') {
      const est = expectedOut;
      const n = nftsMinted(walletTokenBal, est, unit, !!walletSkipNft);
      if (n <= MAX_NFTS_PER_TX) return null;
      const maxTokens = maxTokensInForNfts(walletTokenBal, unit, !!walletSkipNft) ?? 0n;
      return { side: 'buy' as const, nfts: n, maxTokens, aboutInput: scaleInputForOutput(inputWei, est, maxTokens) };
    }
    const n = nftsBurned(walletTokenBal, inputWei, unit, !!walletSkipNft);
    if (n <= MAX_NFTS_PER_TX) return null;
    return { side: 'sell' as const, nfts: n, maxTokens: maxTokensOutForNfts(walletTokenBal, unit, !!walletSkipNft) ?? 0n, aboutInput: 0n };
  }, [dn404UnitWei, walletSkipNft, inputWei, side, walletTokenBal, expectedOut]);

  // buy: pair -> token. zeroForOne = input is currency0.
  const zeroForOne = side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0;
  const swapCall = useMemo(() => {
    if (!chainId || inputWei === 0n || inputWei >= 2n ** 128n) return null;
    try {
      // Taxed token as input: SETTLE first so the pool is credited only what
      // arrives after the tax, then swap that credit. Normal order otherwise.
      return taxedSell
        ? encodeV4ExactInSingleSettleFirst({ chainId, key: poolKey, zeroForOne, amountIn: inputWei, amountOutMinimum: minOut })
        : encodeV4ExactInSingle({ chainId, key: poolKey, zeroForOne, amountIn: inputWei, amountOutMinimum: minOut });
    } catch { return null; }
  }, [chainId, poolKey, zeroForOne, inputWei, minOut, taxedSell]);

  const erc20ApproveSim = useSimulateContract({
    abi: erc20TokenAbi,
    address: inputToken,
    functionName: 'approve',
    args: permit2 ? [permit2, 2n ** 256n - 1n] : undefined,
    account: wallet,
    chainId,
    query: { enabled: !!permit2 && !!wallet && walletOnActiveChain && needsErc20Approve },
  });
  const permit2ApproveSim = useSimulateContract({
    abi: permit2Abi,
    address: permit2 ?? undefined,
    functionName: 'approve',
    args: router ? [inputToken, router, 2n ** 160n - 1n, permitExpiry] : undefined,
    account: wallet,
    chainId,
    query: { enabled: !!permit2 && !!router && !!wallet && walletOnActiveChain && needsPermit2Approve },
  });
  const swapSim = useSimulateContract({
    abi: universalRouterAbi,
    address: router ?? undefined,
    functionName: 'execute',
    args: swapCall ? [swapCall.commands, swapCall.inputs, txDeadline] : undefined,
    ...(nativeIn ? { value: inputWei } : {}),
    account: wallet,
    chainId,
    query: {
      enabled: !!router && !!wallet && walletOnActiveChain && !!swapCall && !needsErc20Approve && !needsPermit2Approve,
    },
  });

  const { writeContract, isPending: writePending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash as Hex | undefined });
  const notifiedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const h = receipt.data?.transactionHash;
    if (!h || h === notifiedRef.current) return;
    notifiedRef.current = h;
    approvals.refetch();
    // Approval txs must not clear the amount the user is about to swap.
    if (!needsErc20Approve && !needsPermit2Approve) {
      onSwapComplete();
      setAmountInput('');
    }
  }, [receipt.data?.transactionHash]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (needsErc20Approve && erc20ApproveSim.data) writeContract(erc20ApproveSim.data.request);
    else if (needsPermit2Approve && permit2ApproveSim.data) writeContract(permit2ApproveSim.data.request);
    else if (swapSim.data) writeContract(swapSim.data.request);
  };

  if (!router || !permit2) {
    return (
      <div className={styles.unavailable}>
        <b>Graduated</b>
        <span className={styles.hint}>In-app swaps aren&apos;t available on this chain yet.</span>
      </div>
    );
  }

  const balance = side === 'buy' ? walletPairBal : walletTokenBal;
  const outSym = side === 'buy' ? tokenSymbol || 'TKN' : pairSym;
  const outDecimals = side === 'buy' ? 18 : pairDecimals;
  const activeSim = needsErc20Approve ? erc20ApproveSim : needsPermit2Approve ? permit2ApproveSim : swapSim;

  return (
    <div className={styles.poolPanel}>
      <div className={styles.poolTitle}>Trading on Uniswap v4</div>

      <div className={styles.tabGrid}>
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setAmountInput(''); }}
            className={styles.tabButton}
            data-active={side === s}
            data-side={s}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <label style={{ display: 'block' }}>
        <span className={styles.fieldLabel}>You pay</span>
        <div className={styles.inputRow}>
          <input
            className="ui-input"
            type="number"
            step="0.001"
            min="0"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.0"
            style={{ flex: 1 }}
          />
          <span className={styles.assetLabel}>{side === 'buy' ? pairSym : tokenSymbol || 'TKN'}</span>
        </div>
      </label>

      <div className={styles.poolBal}>
        <span>Balance {Number(formatUnits(balance, inputDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
        <button
          type="button"
          onClick={() => setAmountInput(formatUnits(balance, inputDecimals))}
          className={styles.balanceBtn}
        >
          Max
        </button>
      </div>

      <div className={styles.quoteBox}>
        <div className={styles.fieldLabel}>You receive <span className={styles.hint}>estimate</span></div>
        <div className={styles.quoteValue}>
          {expectedOut === 0n
            ? '—'
            : `≈ ${Number(formatUnits(expectedOut, outDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outSym}`}
        </div>
        <div className={styles.hint} style={{ marginTop: 2 }}>
          Minimum {Number(formatUnits(minOutNet, outDecimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {outSym} after fees and slippage{taxBps > 0 && (side === 'buy' || sellsTaxed) ? ` and ${taxBps / 100}% token tax` : ''}
        </div>
      </div>
      {poolNftGuard && (
        <Dn404GasNotice
          guard={poolNftGuard}
          tokenSymbol={tokenSymbol || 'TKN'}
          inputLabel={poolNftGuard.side === 'buy' ? pairSym : tokenSymbol || 'TKN'}
          formatInput={(v) => Number(formatUnits(v, pairDecimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        />
      )}

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
        onClick={() => {
          if (connectedForRender && !walletOnActiveChain) { onSwitchChain(); return; }
          submit();
        }}
        disabled={
          !connectedForRender ||
          inputWei === 0n ||
          writePending ||
          receipt.isLoading ||
          switchPending ||
          poolNftGuard !== null ||
          (walletOnActiveChain && !activeSim.data)
        }
        className={`ui-btn ${styles.primaryAction}`}
        data-variant={side === 'buy' ? 'buy' : 'sell'}
        data-size="lg"
      >
        {!connectedForRender
          ? 'Connect wallet'
          : !walletOnActiveChain
            ? switchPending ? 'Switching…' : `Switch to ${chain}`
            : writePending
              ? 'Confirm in your wallet…'
              : receipt.isLoading
                ? 'Waiting for confirmation…'
                : needsErc20Approve
                  ? `Approve ${side === 'buy' ? pairSym : tokenSymbol || 'TKN'} (1 of 2)`
                  : needsPermit2Approve
                    ? 'Allow the swap router (2 of 2)'
                    : side === 'buy'
                      ? `Buy ${tokenSymbol || ''}`
                      : `Sell ${tokenSymbol || ''}`}
      </button>

      {activeSim.error && (
        <div className={styles.errorNote}>
          This trade would fail right now: {activeSim.error.message.slice(0, 120)}
        </div>
      )}

      {chain && (
        <div className={styles.poolLinks}>
          <a href={explorerAddressUrl(chain, curveAddress)} target="_blank" rel="noopener noreferrer">
            View curve on explorer ↗
          </a>
        </div>
      )}
    </div>
  );
}

/// Live "public window opens in Xm YYs" countdown for the WL exclusive
/// window. Ticks once a second so users can see it move. Once fallbackTs
/// passes, flips to "WL window ended — public buys open" (the parent's
/// wlPreFallback gate should hide this block once that happens anyway, but
/// the label is here as a defensive fallback in case the parent takes a
/// second to re-render).
/// Plain-language notice shown when a DN404 buy or sell would mint or burn more
/// NFTs than one Robinhood transaction can hold (see web/src/lib/dn404Gas.ts).
function Dn404GasNotice({
  guard,
  tokenSymbol,
  inputLabel,
  formatInput,
}: {
  guard: { side: 'buy' | 'sell'; nfts: bigint; maxTokens: bigint; aboutInput: bigint };
  tokenSymbol: string;
  inputLabel: string;
  formatInput: (v: bigint) => string;
}) {
  const maxTok = Number(formatUnits(guard.maxTokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (
    <div className={styles.warnNote} style={{ marginTop: 8 }}>
      {guard.side === 'buy'
        ? <>Too big for one buy: it would mint {guard.nfts.toLocaleString()} NFTs, and one transaction can mint up to {MAX_NFTS_PER_TX.toLocaleString()}. Max for one buy is {maxTok} {tokenSymbol}{guard.aboutInput > 0n ? <> (about {formatInput(guard.aboutInput)} {inputLabel})</> : null}. Split it into smaller buys.</>
        : <>Too big for one sell: it would burn {guard.nfts.toLocaleString()} NFTs, and one transaction can burn up to {MAX_NFTS_PER_TX.toLocaleString()}. Max for one sell is {maxTok} {tokenSymbol}. Split it into smaller sells.</>}
    </div>
  );
}

function WlCountdown({ fallbackTs }: { fallbackTs: bigint }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const delta = Number(fallbackTs) - now;
  if (delta <= 0) {
    return (
      <div className={styles.hint}>
        The whitelist window has ended. Public buys are open.
      </div>
    );
  }
  const m = Math.floor(delta / 60);
  const s = delta % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return (
    <div className={styles.hint}>
      Public buys open in <b className="ui-num">{mm}:{ss}</b>
    </div>
  );
}

function Socialz({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={infoStyles.link}>
      {label} ↗
    </a>
  );
}
