'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  formatEther,
  isAddress,
  parseEther,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';

import { bondingCurveAbi, curveFactoryAbi, erc20TokenAbi } from '@/lib/abis';
import { CONTRACTS, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, explorerAddressUrl } from '@/lib/wagmi';
import { loadMetadata, type TokenMetadata } from '@/lib/metadata';
import { mockLaunchByAddress } from '@/lib/mockLaunches';
import { fetchTradesForCurve } from '@/lib/indexer';
import { formatGweiPerToken } from '@/lib/priceFmt';
import { Mascot } from '@/components/Mascot';
import { TradeChart, type TradePoint } from '@/components/TradeChart';
import { TradeTicker, QuickAmounts, CopyCA, FlashCell, ChatDrawer } from '@/components/TradeEffects';
import { MockTradeView } from './MockTradeView';

type Side = 'buy' | 'sell';

export default function TradePage({ params }: { params: Promise<{ address: string }> }) {
  const resolved = use(params);
  const tokenAddress = (isAddress(resolved.address) ? resolved.address : '0x0000000000000000000000000000000000000000') as Address;

  // Preview-mode fallback: if the address matches a mock fixture, render the mock UI so the
  // page is browsable without any contracts deployed. Dispatch happens via a sibling
  // component so rules-of-hooks stay clean — early-returning before the wagmi hooks below
  // would violate hook ordering.
  const mock = mockLaunchByAddress(tokenAddress);
  if (mock) return <MockTradeView launch={mock} />;
  return <LiveTradeView tokenAddress={tokenAddress} />;
}

function LiveTradeView({ tokenAddress }: { tokenAddress: Address }) {
  const { address: wallet, isConnected } = useAccount();
  const chainId = useChainId();
  // Wagmi's `isConnected` flips after hydration — gate any label / disabled decision
  // that could change what the first client paint shows.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const connectedForRender = mounted && isConnected;
  const activeChain = CHAIN_ID_TO_KEY[chainId] ?? null;
  const contracts = activeChain ? CONTRACTS[activeChain as ChainKey] : null;

  // ---------- Look up the curve for this token via the factory ----------
  const curveQuery = useReadContract({
    abi: curveFactoryAbi,
    address: contracts?.CurveFactory,
    functionName: 'curveFor',
    args: [tokenAddress],
    query: { enabled: !!contracts, staleTime: 15_000 },
  });
  const curveAddress = curveQuery.data && curveQuery.data !== '0x0000000000000000000000000000000000000000'
    ? (curveQuery.data as Address)
    : null;

  // ---------- Live curve + token state ----------
  const curveState = useReadContracts({
    contracts: curveAddress
      ? [
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'ethReserve' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'tokenReserve' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'graduationTargetEth' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'curveSupply' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'priceWeiPerToken' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'graduated' },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'tradeFeeBps' },
        ]
      : [],
    query: { enabled: !!curveAddress, refetchInterval: 8_000 },
  });
  const csResults = curveState.data ?? [];
  const ethReserve = csResults[0]?.result as bigint | undefined;
  const tokenReserve = csResults[1]?.result as bigint | undefined;
  const gradTarget = csResults[2]?.result as bigint | undefined;
  const curveSupply = csResults[3]?.result as bigint | undefined;
  const spotPrice = csResults[4]?.result as bigint | undefined;
  const graduated = csResults[5]?.result as boolean | undefined;
  const feeBps = csResults[6]?.result as bigint | undefined;

  const tokenNameQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'name' });
  const tokenSymbolQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'symbol' });
  const tokenTotalSupplyQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'totalSupply' });
  const walletBalQ = useReadContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'balanceOf',
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 15_000 },
  });
  const curveAllowanceQ = useReadContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'allowance',
    args: wallet && curveAddress ? [wallet, curveAddress] : undefined,
    query: { enabled: !!wallet && !!curveAddress, refetchInterval: 15_000 },
  });
  const tokenName = tokenNameQ.data;
  const tokenSymbol = tokenSymbolQ.data;
  const tokenTotalSupply = tokenTotalSupplyQ.data;
  const walletBal = walletBalQ.data;
  const curveAllowance = curveAllowanceQ.data;

  // ---------- Metadata (localStorage payload written at launch time) ----------
  const [metadata, setMetadata] = useState<TokenMetadata | null>(null);
  useEffect(() => {
    if (!tokenAddress) return;
    setMetadata(loadMetadata(chainId, tokenAddress));
  }, [tokenAddress, chainId]);

  // ---------- Trade event stream → chart points ----------
  const publicClient = usePublicClient();
  const [tradePoints, setTradePoints] = useState<TradePoint[]>([]);
  const [recentTrades, setRecentTrades] = useState<
    Array<{ isBuy: boolean; eth: bigint; tokens: bigint; trader: Address; timestamp: number }>
  >([]);

  useEffect(() => {
    if (!curveAddress) return;
    let cancelled = false;
    (async () => {
      // 1) Prefer the indexer — full history, cheap query, no RPC round-trip cap.
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (cancelled) return;
      if (indexed && indexed.length > 0) {
        const pts: TradePoint[] = indexed.map((t) => ({
          timestamp: Number(t.blockTimestamp),
          priceWeiPerToken: BigInt(t.priceWeiPerToken),
        }));
        const rec = indexed.slice().reverse().slice(0, 25).map((t) => ({
          isBuy: t.isBuy,
          eth: BigInt(t.ethAmount),
          tokens: BigInt(t.tokenAmount),
          trader: t.trader,
          timestamp: Number(t.blockTimestamp),
        }));
        setTradePoints(pts);
        setRecentTrades(rec);
        return;
      }

      // 2) Fallback: client-side getLogs with a bounded lookback. Works before the indexer
      //    exists — dies at scale but that's fine for launch day.
      if (!publicClient) return;
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 5000n ? currentBlock - 5000n : 0n;
        const logs = await publicClient.getLogs({
          address: curveAddress,
          event: bondingCurveAbi.find((x) => x.type === 'event' && x.name === 'Trade') as never,
          fromBlock,
          toBlock: 'latest',
        });
        if (cancelled) return;
        const pts: TradePoint[] = [];
        const rec: typeof recentTrades = [];
        for (const log of logs) {
          const args = (log as unknown as { args: Record<string, unknown> }).args;
          const ts = Number(args.timestamp as bigint);
          const ethAmount = args.ethAmount as bigint;
          const tokenAmount = args.tokenAmount as bigint;
          const priceWei = tokenAmount > 0n ? (ethAmount * 10n ** 18n) / tokenAmount : 0n;
          pts.push({ timestamp: ts, priceWeiPerToken: priceWei });
          rec.push({
            isBuy: args.isBuy as boolean,
            eth: ethAmount,
            tokens: tokenAmount,
            trader: args.trader as Address,
            timestamp: ts,
          });
        }
        setTradePoints(pts);
        setRecentTrades(rec.reverse().slice(0, 25));
      } catch (err) {
        console.warn('trade log fetch failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, curveAddress]);

  // ---------- Trade panel ----------
  const [side, setSide] = useState<Side>('buy');
  const [inputAmount, setInputAmount] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');

  const inputWei = useMemo(() => {
    try {
      if (side === 'buy') return parseEther(inputAmount || '0');
      return parseUnits(inputAmount || '0', 18);
    } catch { return 0n; }
  }, [inputAmount, side]);

  const buyQuote = useReadContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'quoteBuy',
    args: [inputWei],
    query: { enabled: !!curveAddress && side === 'buy' && inputWei > 0n, refetchInterval: 6_000 },
  });
  const sellQuote = useReadContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'quoteSell',
    args: [inputWei],
    query: { enabled: !!curveAddress && side === 'sell' && inputWei > 0n, refetchInterval: 6_000 },
  });

  const quoteOut = side === 'buy'
    ? (buyQuote.data?.[0] as bigint | undefined) ?? 0n
    : (sellQuote.data?.[0] as bigint | undefined) ?? 0n;
  const quoteFee = side === 'buy'
    ? (buyQuote.data?.[1] as bigint | undefined) ?? 0n
    : (sellQuote.data?.[1] as bigint | undefined) ?? 0n;

  const slippage = useMemo(() => {
    const pct = Math.max(0, Math.min(50, Number(slippagePct) || 0));
    if (quoteOut === 0n) return 0n;
    return quoteOut - (quoteOut * BigInt(Math.floor(pct * 100))) / 10_000n;
  }, [quoteOut, slippagePct]);

  const needsApproval = side === 'sell' && (curveAllowance as bigint | undefined ?? 0n) < inputWei;

  const buySim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'buy',
    args: [slippage],
    value: inputWei,
    account: wallet,
    query: { enabled: !!curveAddress && !!wallet && side === 'buy' && inputWei > 0n && !graduated },
  });
  const sellSim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'sell',
    args: [inputWei, slippage],
    account: wallet,
    query: { enabled: !!curveAddress && !!wallet && side === 'sell' && inputWei > 0n && !graduated && !needsApproval },
  });
  const approveSim = useSimulateContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'approve',
    args: curveAddress ? [curveAddress, 2n ** 256n - 1n] : undefined,
    account: wallet,
    query: { enabled: !!curveAddress && !!wallet && side === 'sell' && needsApproval },
  });

  const { writeContract, isPending: writePending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash as Hex | undefined });

  const submit = () => {
    if (side === 'sell' && needsApproval && approveSim.data) {
      writeContract(approveSim.data.request);
    } else if (side === 'buy' && buySim.data) {
      writeContract(buySim.data.request);
    } else if (side === 'sell' && sellSim.data) {
      writeContract(sellSim.data.request);
    }
  };

  const progressPct = useMemo(() => {
    if (!ethReserve || !gradTarget) return 0;
    return Math.min(100, Number(((ethReserve as bigint) * 10_000n) / (gradTarget as bigint)) / 100);
  }, [ethReserve, gradTarget]);

  const tokensSold = useMemo(() => {
    if (!curveSupply || !tokenReserve) return 0n;
    return (curveSupply as bigint) - (tokenReserve as bigint);
  }, [curveSupply, tokenReserve]);

  const marketCap = useMemo(() => {
    if (!spotPrice || !tokenTotalSupply) return 0n;
    return ((spotPrice as bigint) * (tokenTotalSupply as bigint)) / 10n ** 18n;
  }, [spotPrice, tokenTotalSupply]);

  // ============================================================================

  if (!contracts) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 text-center">
        <Mascot size={80} mood="confused" />
        <div className="uru-h1 mt-4" style={{ fontSize: 28 }}>contracts arent live on this chain yet ~~</div>
        <p style={{ marginTop: 8, color: 'var(--anchor-soft)' }}>switch to a supported network to trade</p>
      </div>
    );
  }
  if (curveQuery.isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 text-center">
        <Mascot size={64} mood="sleepy" />
        <div style={{ marginTop: 8, fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)' }}>
          looking up the curve..
        </div>
      </div>
    );
  }
  if (!curveAddress) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 text-center">
        <Mascot size={80} mood="confused" />
        <div className="uru-h1 mt-4" style={{ fontSize: 28 }}>no curve for this token</div>
        <p style={{ marginTop: 8, color: 'var(--anchor-soft)' }}>this token wasn&apos;t launched with a bonding curve.</p>
        <Link href="/discover" className="uru-btn uru-btn-primary" style={{ marginTop: 16 }}>
          back to launches
        </Link>
      </div>
    );
  }

  // Chart flash — fires when the newest indexed trade changes. Side + timestamp drives it.
  const newestTrade = recentTrades[0];
  const chartFlashKey = newestTrade ? `${newestTrade.timestamp}-${newestTrade.trader}` : null;
  const chartFlashSide: 'buy' | 'sell' = newestTrade?.isBuy ? 'buy' : 'sell';

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
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
            background: metadata?.logoDataUrl
              ? `#fff url(${metadata.logoDataUrl}) center/cover no-repeat`
              : 'var(--cream-deep)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-pixel), monospace',
            fontSize: 16,
            color: 'var(--anchor-soft)',
          }}
        >
          {!metadata?.logoDataUrl && ((tokenSymbol as string)?.slice(0, 2) || '?')}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <h1 className="uru-h1" style={{ fontSize: 22, lineHeight: 1.05 }}>
              {(tokenName as string) ?? 'loading..'}
            </h1>
            <span style={{ color: 'var(--anchor-soft)', fontFamily: 'var(--font-pixel), monospace', fontSize: 13 }}>
              ${(tokenSymbol as string) ?? '—'}
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
            <Link
              href={explorerAddressUrl(activeChain as ChainKey, tokenAddress)}
              target="_blank"
              style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
            >
              {tokenAddress.slice(0, 6)}…{tokenAddress.slice(-4)}
            </Link>
            <span>fee: {typeof feeBps === 'bigint' ? `${Number(feeBps) / 100}%` : '—'}</span>
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
                {typeof marketCap === 'bigint' ? Number(formatEther(marketCap)).toFixed(4) : '—'} Ξ
              </FlashCell>
            </div>
          </div>
          <CopyCA address={tokenAddress} />
        </div>
      </section>

      {/* ================================================================
          GRADUATION STRIP — slim ribbon (compact, not a big shell)
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
        <span
          className="uru-eyebrow"
          style={{ flexShrink: 0 }}
        >
          {graduated ? '✿ graduated' : 'grad → v4'}
        </span>
        <div style={{ flex: 1, height: 10, background: 'var(--cream-deep)', border: '1.5px solid var(--anchor)', minWidth: 100 }}>
          <div
            className={progressPct > 85 && !graduated ? 'uru-shimmer' : ''}
            style={{
              width: `${progressPct}%`,
              height: '100%',
              background: graduated ? 'var(--mint-hot)' : 'var(--pink-hot)',
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
          {typeof ethReserve === 'bigint' ? Number(formatEther(ethReserve)).toFixed(3) : '—'} /
          {' '}{typeof gradTarget === 'bigint' ? Number(formatEther(gradTarget)).toFixed(1) : '—'} Ξ
          {' '}<b style={{ color: progressPct > 85 && !graduated ? 'var(--pink-hot)' : 'var(--anchor)' }}>({progressPct.toFixed(1)}%)</b>
        </span>
      </div>

      {/* Live trade ticker */}
      <div style={{ marginBottom: 10 }}>
        <TradeTicker
          trades={recentTrades.map((t) => ({ isBuy: t.isBuy, eth: t.eth, tokens: t.tokens, trader: t.trader }))}
          symbol={tokenSymbol as string | undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* MAIN — chart + recent trades */}
        <div className="space-y-3">
          <TradeChart points={tradePoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />

          {/* Recent trades — dense table with header row */}
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
            {recentTrades.length === 0 ? (
              <div
                style={{
                  padding: 16,
                  textAlign: 'center',
                  fontFamily: 'var(--font-pixel), monospace',
                  fontSize: 12,
                  color: 'var(--anchor-soft)',
                }}
              >
                no trades yet ~~ be the first
              </div>
            ) : (
              <>
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
                      <span>{Number(formatEther(t.eth)).toFixed(4)}</span>
                      <span style={{ textAlign: 'right' }}>
                        {Number(formatUnits(t.tokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
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
              </>
            )}
          </div>

          {/* Local chat — dopamine layer. Ships as localStorage-backed for now. */}
          <ChatDrawer tokenAddress={tokenAddress} wallet={wallet} />

          {/* Info sidebar (metadata) */}
          {metadata && (metadata.description || metadata.website || metadata.twitter || metadata.telegram || metadata.discord) && (
            <div className="uru-shell uru-shell-tight">
              <div className="uru-eyebrow" style={{ marginBottom: 6 }}>❀ about</div>
              {metadata.description && (
                <p style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 8 }}>{metadata.description}</p>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {metadata.website && <Socialz href={metadata.website} label="site" />}
                {metadata.twitter && <Socialz href={metadata.twitter} label="twitter" />}
                {metadata.telegram && <Socialz href={metadata.telegram} label="tg" />}
                {metadata.discord && <Socialz href={metadata.discord} label="discord" />}
              </div>
            </div>
          )}
        </div>

        {/* SIDEBAR — buy/sell panel */}
        <aside className="space-y-3 lg:sticky lg:top-4 lg:h-fit">
          <div className="uru-shell-tight" style={{ padding: 0, overflow: 'hidden' }}>
            {/* buy/sell toggle — full-bleed tabs, bolder pump-style */}
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
                    borderBottom: side === s ? `3px solid ${s === 'buy' ? 'var(--mint-hot,#2b8a3e)' : 'var(--pink-hot)'}` : '3px solid transparent',
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

            {graduated ? (
              <div style={{ padding: 16, textAlign: 'center', background: 'var(--pink-warm)', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
                curve graduated ~~<br />trade on uniswap v4 (phase 3~)
              </div>
            ) : (
              <>
                <label style={{ display: 'block' }}>
                  <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                    you pay
                  </span>
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
                      {side === 'buy' ? 'ETH' : (tokenSymbol as string) ?? ''}
                    </span>
                  </div>
                </label>

                {/* Quick pick chips — always visible on buy, only if balance>0 on sell */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginBottom: 4 }}>
                    quick pick ✿
                  </div>
                  <QuickAmounts
                    side={side}
                    walletBal={walletBal as bigint | undefined}
                    onPick={(amount) => setInputAmount(amount)}
                  />
                </div>

                <div style={{ marginTop: 12, padding: 8, background: 'var(--cream-deep)', border: '1.5px dashed var(--anchor)' }}>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                    you receive
                  </div>
                  <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 16, fontWeight: 700, color: 'var(--anchor)' }}>
                    {inputWei === 0n
                      ? '—'
                      : side === 'buy'
                        ? `${Number(formatUnits(quoteOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${(tokenSymbol as string) ?? ''}`
                        : `${Number(formatEther(quoteOut)).toFixed(6)} ETH`}
                  </div>
                  {quoteFee > 0n && (
                    <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)', marginTop: 2 }}>
                      fee: {side === 'buy' ? `${formatEther(quoteFee)} ETH` : `${formatEther(quoteFee)} ETH`}
                    </div>
                  )}
                </div>

                <label style={{ display: 'block', marginTop: 10 }}>
                  <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
                    slippage tolerance (%)
                  </span>
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
                  onClick={submit}
                  disabled={!connectedForRender || inputWei === 0n || writePending || receipt.isLoading}
                  className={side === 'buy' ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                >
                  {!connectedForRender
                    ? 'connect wallet'
                    : writePending
                      ? 'confirming ~~'
                      : receipt.isLoading
                        ? 'waiting..'
                        : side === 'sell' && needsApproval
                          ? '✿ approve first'
                          : side === 'buy'
                            ? `✿ buy ${(tokenSymbol as string) ?? ''}`
                            : `sell ${(tokenSymbol as string) ?? ''} ✿`}
                </button>

                {(buySim.error || sellSim.error) && (
                  <div style={{ marginTop: 8, padding: 8, background: 'var(--pink-warm)', border: '1px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 10 }}>
                    sim failed: {(buySim.error ?? sellSim.error)?.message.slice(0, 120)}
                  </div>
                )}
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
                    {typeof spotPrice === 'bigint' ? formatGweiPerToken(spotPrice as bigint) : '—'} gw
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
                <span>your balance</span>
                <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                  {walletBal !== undefined ? Number(formatUnits(walletBal as bigint, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                </span>
              </li>
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
                <span>curve</span>
                <Link
                  href={explorerAddressUrl(activeChain as ChainKey, curveAddress)}
                  target="_blank"
                  style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
                >
                  {curveAddress.slice(0, 6)}…{curveAddress.slice(-4)}
                </Link>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Socialz({ href, label }: { href: string; label: string }) {
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
