'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useSimulateContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  encodeAbiParameters,
  formatEther,
  isAddress,
  keccak256,
  parseEther,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';

import { bondingCurveAbi, curveFactoryAbi, erc20TokenAbi, v4SwapRouterAbi, v4StateViewAbi } from '@/lib/abis';
import { CHAIN_LABELS, CONTRACTS, HOOKS, V4_ROUTERS, V4_STATE_VIEWS, type ChainKey } from '@/lib/config';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID, explorerAddressUrl } from '@/lib/wagmi';
import { loadMetadata, persistMetadata, safeBackgroundImage, type TokenMetadata } from '@/lib/metadata';
import { fetchTokenMetadata, saveTokenMetadata } from '@/lib/socialApi';
import { MetadataForm, type MetadataInputs } from '@/components/MetadataForm';
import { mockLaunchByAddress } from '@/lib/mockLaunches';
import {
  fetchCurveByToken,
  fetchGraduationForToken,
  fetchLaunchesByTokens,
  fetchTradesForCurve,
  fetchV4SwapsForToken,
} from '@/lib/indexer';
import { isHiddenAddressAnywhere } from '@/lib/hiddenTokens';
import { useActiveChain } from '@/components/ChainSwitcher';
import { formatGweiPerToken } from '@/lib/priceFmt';
import { formatMcap, formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';
import { Mascot } from '@/components/Mascot';
import { TradeChart, type TradePoint } from '@/components/TradeChart';
import { TradeTicker, QuickAmounts, CopyCA, FlashCell, ChatDrawer } from '@/components/TradeEffects';
import { MockTradeView } from './MockTradeView';

type Side = 'buy' | 'sell';

export default function TradePage({ params }: { params: Promise<{ address: string }> }) {
  const resolved = use(params);
  const tokenAddress = (isAddress(resolved.address) ? resolved.address : '0x0000000000000000000000000000000000000000') as Address;

  // Retired-token check: if the address is in the hide list (TEST/BALLS etc.),
  // render a "retired" splash instead of routing to the live trade UI. Bookmarks +
  // pasted URLs land here too, so the block is comprehensive — not just the
  // feed-side filter.
  if (isHiddenAddressAnywhere(tokenAddress)) return <RetiredTokenView />;

  // Preview-mode fallback: if the address matches a mock fixture, render the mock UI so the
  // page is browsable without any contracts deployed. Dispatch happens via a sibling
  // component so rules-of-hooks stay clean — early-returning before the wagmi hooks below
  // would violate hook ordering.
  const mock = mockLaunchByAddress(tokenAddress);
  if (mock) return <MockTradeView launch={mock} />;
  return <LiveTradeView tokenAddress={tokenAddress} />;
}

function RetiredTokenView() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 text-center">
      <Mascot size={80} mood="sleepy" />
      <div className="uru-h1 mt-4" style={{ fontSize: 24 }}>this token is retired ~~</div>
      <p style={{ marginTop: 8, color: 'var(--anchor-soft)' }}>
        an early test token, no longer surfaced.
      </p>
      <Link href="/discover" className="uru-btn uru-btn-primary" style={{ marginTop: 16 }}>
        back to discover
      </Link>
    </div>
  );
}

function LiveTradeView({ tokenAddress }: { tokenAddress: Address }) {
  const { address: wallet, isConnected } = useAccount();
  const chainId = useChainId();
  // Wagmi's `isConnected` flips after hydration — gate any label / disabled decision
  // that could change what the first client paint shows.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const connectedForRender = mounted && isConnected;
  // Ask the indexer which chain THIS token actually lives on. Every token is deployed
  // on exactly one chain and the `launches` row records it — so we can force all reads
  // to that chain regardless of what the header picker or the wallet's current chain
  // are set to. Prior versions used the picker/wallet chain for reads which meant a
  // trader viewing a Base-Sepolia token while their wallet was on Base mainnet saw
  // zero everything (name/price/mcap/trades) because RPC reads at the token address
  // on the wrong chain return empty. Falls back to the picker/wallet chain only when
  // the indexer hasn't indexed this token yet (fresh launch mid-catchup).
  const [tokenHomeChain, setTokenHomeChain] = useState<ChainKey | null>(null);
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    (async () => {
      const rows = await fetchLaunchesByTokens([tokenAddress]);
      if (cancelled) return;
      const row = rows?.[0];
      if (!row) return;
      const key = CHAIN_ID_TO_KEY[row.chainId];
      if (key) setTokenHomeChain(key);
    })();
    return () => { cancelled = true; };
  }, [tokenAddress]);

  const picker = useActiveChain();
  const pickerContracts = CONTRACTS[picker];
  const walletChain = CHAIN_ID_TO_KEY[chainId] ?? null;
  const walletContracts = walletChain ? CONTRACTS[walletChain as ChainKey] : null;
  // Last-resort fallback so anonymous visitors (no wallet, no picker override) still
  // see live data. Picks the first CHAINS_ENABLED entry with CONTRACTS populated —
  // usually Base today now that mainnet is up.
  const fallbackChain: ChainKey | null =
    (Object.keys(CONTRACTS) as ChainKey[]).find((k) => CONTRACTS[k] !== null) ?? null;
  // Priority order: token's actual home chain (indexer-verified) > picker > wallet >
  // fallback. This means once the indexer confirms where the token lives, we IGNORE
  // the picker/wallet — the read chain is decided by the token itself.
  const activeChain: ChainKey | null =
    tokenHomeChain ??
    (pickerContracts ? picker : walletContracts ? walletChain : fallbackChain);
  const contracts = activeChain ? CONTRACTS[activeChain] : null;
  // Force every RPC read (curve lookup, reserves, token metadata) to hit the chain we
  // actually resolved contracts on — otherwise wagmi silently uses the wallet's chain and
  // returns zeros for a token that lives on a different chain (very common when the wallet
  // is on mainnet but the launch is on Base Sepolia).
  const readChainId = activeChain ? CHAIN_KEY_TO_ID[activeChain] : undefined;
  const walletOnActiveChain = walletChain === activeChain;
  const { switchChain, isPending: switchPending } = useSwitchChain();

  // ---------- Look up the curve for this token ----------
  // Two paths, in priority order:
  //   1. Indexer's curves table (populated from BondingCurve.CurveInitialized events)
  //      — factory-agnostic, survives a CurveFactory redeploy since the launches +
  //      curves rows key off the token address, not the factory address.
  //   2. Fallback: on-chain factory.curveFor(token) via the CURRENT CurveFactory in
  //      config. Only used for tokens the indexer hasn't caught up on yet (fresh
  //      launch mid-catchup).
  const [indexedCurveAddress, setIndexedCurveAddress] = useState<Address | null>(null);
  const [indexerChecked, setIndexerChecked] = useState(false);
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    (async () => {
      const c = await fetchCurveByToken(tokenAddress);
      if (cancelled) return;
      if (c?.curveAddress) setIndexedCurveAddress(c.curveAddress as Address);
      setIndexerChecked(true);
    })();
    return () => { cancelled = true; };
  }, [tokenAddress]);
  const curveQuery = useReadContract({
    abi: curveFactoryAbi,
    address: contracts?.CurveFactory,
    functionName: 'curveFor',
    args: [tokenAddress],
    chainId: readChainId,
    // Only ask the current factory if the indexer had no answer — spares an RPC
    // round-trip on every trade-page hit for tokens the indexer already knows about.
    query: { enabled: !!contracts && indexerChecked && !indexedCurveAddress, staleTime: 15_000 },
  });
  const factoryCurveAddress = curveQuery.data && curveQuery.data !== '0x0000000000000000000000000000000000000000'
    ? (curveQuery.data as Address)
    : null;
  const curveAddress: Address | null = indexedCurveAddress ?? factoryCurveAddress;

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
    // Leave allowFailure as its default (true) — the results below are read as
    // `csResults[i].result`, which is only present in the wrapped shape. Setting
    // allowFailure:false collapses each entry to the raw value and every widget
    // downstream reads undefined.
    ...(readChainId ? { chainId: readChainId } : {}),
    query: { enabled: !!curveAddress, refetchInterval: 8_000 },
  });
  const csResults = curveState.data ?? [];
  const ethReserve = csResults[0]?.result as bigint | undefined;
  const tokenReserve = csResults[1]?.result as bigint | undefined;
  const gradTarget = csResults[2]?.result as bigint | undefined;
  const curveSupply = csResults[3]?.result as bigint | undefined;
  const spotPrice = csResults[4]?.result as bigint | undefined;
  const graduated = csResults[5]?.result as boolean | undefined;
  // tradeFeeBps() returns uint16 → wagmi maps to `number`, not `bigint`. Reading it as
  // bigint made the fee row render '—' because `typeof feeBps === 'bigint'` was never true.
  const feeBps = csResults[6]?.result as number | undefined;

  const tokenNameQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'name', chainId: readChainId });
  const tokenSymbolQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'symbol', chainId: readChainId });
  const tokenTotalSupplyQ = useReadContract({ abi: erc20TokenAbi, address: tokenAddress, functionName: 'totalSupply', chainId: readChainId });
  const walletBalQ = useReadContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'balanceOf',
    args: wallet ? [wallet] : undefined,
    chainId: readChainId,
    query: { enabled: !!wallet, refetchInterval: 15_000 },
  });
  const curveAllowanceQ = useReadContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'allowance',
    args: wallet && curveAddress ? [wallet, curveAddress] : undefined,
    chainId: readChainId,
    query: { enabled: !!wallet && !!curveAddress, refetchInterval: 15_000 },
  });
  const tokenName = tokenNameQ.data;
  const tokenSymbol = tokenSymbolQ.data;
  const tokenTotalSupply = tokenTotalSupplyQ.data;
  const walletBal = walletBalQ.data;
  const curveAllowance = curveAllowanceQ.data;

  // ---------- Metadata (local snapshot + remote hydrate) ----------
  // Keyed by `readChainId` (the resolved read chain) NOT the wallet's `chainId` — a
  // disconnected visitor's wagmi chainId defaults to the first configured chain (usually
  // mainnet), which would query /token/1/... instead of the chain the token actually
  // lives on and come back empty. readChainId falls back through picker → wallet →
  // first-with-contracts, so anonymous reads still hit the right chain.
  const [metadata, setMetadata] = useState<TokenMetadata | null>(null);
  useEffect(() => {
    if (!tokenAddress || !readChainId) return;
    // Local paint first for offline / just-launched cases.
    setMetadata(loadMetadata(readChainId, tokenAddress));
    (async () => {
      const remote = await fetchTokenMetadata(readChainId, tokenAddress);
      if (!remote) return;
      // Remote wins for shared fields; local avatarDataUrl (there isn't one here) is
      // moot. Store the remote imageUrl AS `logoDataUrl` since that's what the render
      // already reads.
      setMetadata({
        logoDataUrl: remote.imageUrl ?? undefined,
        description: remote.description ?? undefined,
        website: remote.website ?? undefined,
        twitter: remote.twitter ?? undefined,
        telegram: remote.telegram ?? undefined,
        discord: remote.discord ?? undefined,
        tiktok: remote.tiktok ?? undefined,
        savedAt: Number(new Date(remote.updatedAt).getTime()) || Date.now(),
      });
    })();
  }, [tokenAddress, readChainId]);

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

  // Background poll so the recent-trades list + chart tick even without the current tab
  // firing a tx. 15s is a friendly interval — catches other users' trades on the same curve.
  useEffect(() => {
    if (!curveAddress) return;
    const id = setInterval(async () => {
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (!indexed || indexed.length === 0) return;
      setTradePoints(
        indexed.map((t) => ({ timestamp: Number(t.blockTimestamp), priceWeiPerToken: BigInt(t.priceWeiPerToken) })),
      );
      setRecentTrades(
        indexed.slice().reverse().slice(0, 25).map((t) => ({
          isBuy: t.isBuy,
          eth: BigInt(t.ethAmount),
          tokens: BigInt(t.tokenAmount),
          trader: t.trader,
          timestamp: Number(t.blockTimestamp),
        })),
      );
    }, 5_000);
    return () => clearInterval(id);
  }, [curveAddress]);

  // ---------- v4 pool swaps → chart points (post-graduation) ------------------
  // After graduation, the BondingCurve stops trading — the price story continues on the
  // v4 pool. Fetch PoolManager.Swap logs filtered by our poolId and convert each swap's
  // sqrtPriceX96 into a wei-per-token TradePoint. Bounded lookback keeps the initial pull
  // cheap; a 30s poll picks up new swaps for the live chart.
  //
  // poolId + hookAddr are re-used by the market-cap section further down; compute once
  // here so the effect can reference them before that section runs.
  //
  // Per-token hook resolution: prefer the hook address the indexer recorded at
  // graduation time. That way a future hook redeploy (MultiHookHost v2 with per-pool
  // creator revenue, etc.) doesn't break trade pages for tokens that graduated
  // against the OLD hook — every token remembers its own hook forever. Falls back to
  // the chain's current config hook for (a) tokens indexed before this column existed
  // and (b) freshly-graduated tokens the indexer hasn't caught up on yet.
  const [indexedHookAddr, setIndexedHookAddr] = useState<Address | undefined>();
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    (async () => {
      const g = await fetchGraduationForToken(tokenAddress);
      if (cancelled) return;
      if (g?.hookAddress) setIndexedHookAddr(g.hookAddress as Address);
    })();
    return () => { cancelled = true; };
  }, [tokenAddress]);
  const configHookAddr = activeChain ? HOOKS[activeChain]?.MultiHookHost : undefined;
  const hookAddr = indexedHookAddr ?? configHookAddr;
  const poolManagerAddr = activeChain ? HOOKS[activeChain]?.PoolManager : undefined;
  const poolId = useMemo(() => {
    if (!hookAddr) return undefined;
    return keccak256(
      encodeAbiParameters(
        [
          { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
        ],
        ['0x0000000000000000000000000000000000000000', tokenAddress, 3000, 60, hookAddr],
      ),
    );
  }, [tokenAddress, hookAddr]);
  const [v4TradePoints, setV4TradePoints] = useState<TradePoint[]>([]);
  /// Post-graduation swaps surfaced into the "recent trades" list. Sourced from the
  /// same v4 log pull as v4TradePoints so we don't double the RPC work.
  const [v4RecentTrades, setV4RecentTrades] = useState<
    Array<{ isBuy: boolean; eth: bigint; tokens: bigint; trader: Address; timestamp: number }>
  >([]);
  /// Most-recent v4 swap sqrtPriceX96. Used as a fallback for market cap / spot when
  /// StateView.getSlot0 hasn't returned yet (fresh RPC transports can lag several
  /// seconds behind the swap tx being mined).
  const [v4LatestSqrt, setV4LatestSqrt] = useState<bigint>(0n);
  /// Bump this to force the v4 log-fetch effect to re-run without waiting for the 30s
  /// interval. GraduatedPanel calls onSwapComplete which nudges this so the user's own
  /// swap appears in recent trades + updates the chart within one block.
  const [v4RefetchTick, setV4RefetchTick] = useState(0);
  useEffect(() => {
    if (!graduated) return;
    let cancelled = false;
    // Pull the FULL post-graduation swap history from the indexer. Prior versions used
    // client-side `publicClient.getLogs` with a bounded ~30k-block lookback, which
    // silently hid swaps older than ~16h on Base (~30k * 2s block time). Tokens
    // that graduated more than a day ago would show "no v4 swaps" on the trade page
    // while the home rail / profile page correctly rendered them from the indexer.
    // The indexer already parses sqrtPriceX96, blockTimestamp, amounts on ingest —
    // so this replaces ~100 lines of RPC chunking + block-lookup with one query.
    const load = async () => {
      const rows = await fetchV4SwapsForToken(tokenAddress, 500);
      if (cancelled || !rows) return;
      // Rows arrive newest-first (order: blockTimestamp desc). For the chart we want
      // oldest-first so the line reads left-to-right chronologically.
      const enriched = rows
        .map((r) => {
          const sqrtPriceX96 = BigInt(r.sqrtPriceX96);
          if (sqrtPriceX96 === 0n) return null;
          const sqSq = sqrtPriceX96 * sqrtPriceX96;
          if (sqSq === 0n) return null;
          const weiPerToken = ((10n ** 18n) << 192n) / sqSq;
          if (weiPerToken === 0n) return null;
          const amt0 = BigInt(r.amount0);
          const amt1 = BigInt(r.amount1);
          const abs = (n: bigint) => (n < 0n ? -n : n);
          // v4 Swap.amount* is the caller's delta: positive = tokens flowing OUT of
          // the pool to the swapper, negative = flowing IN from the swapper. For our
          // ETH(currency0)/token(currency1) pools a BUY is +token (amount1 > 0),
          // a SELL is +ETH (amount0 > 0). abs the values so recent-trades reads clean.
          const isBuy = amt1 > 0n;
          return {
            timestamp: Number(r.blockTimestamp),
            priceWeiPerToken: weiPerToken,
            sqrtPriceX96,
            isBuy,
            eth: abs(amt0),
            tokens: abs(amt1),
            trader: r.sender,
            blockNumber: BigInt(r.blockNumber),
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (cancelled) return;
      setV4TradePoints(enriched.map((e) => ({ timestamp: e.timestamp, priceWeiPerToken: e.priceWeiPerToken })));
      // Newest swaps first for the recent-trades list.
      setV4RecentTrades(
        enriched
          .slice()
          .reverse()
          .slice(0, 25)
          .map((e) => ({
            isBuy: e.isBuy,
            eth: e.eth,
            tokens: e.tokens,
            trader: e.trader,
            timestamp: e.timestamp,
          })),
      );
      // Freshest v4 spot for the market-cap fallback when StateView.getSlot0 is lagging.
      const newest = enriched.reduce<typeof enriched[number] | null>(
        (best, cur) => (!best || cur.blockNumber > best.blockNumber ? cur : best),
        null,
      );
      if (newest) setV4LatestSqrt(newest.sqrtPriceX96);
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [graduated, tokenAddress, v4RefetchTick]);

  // Chart consumes curve + v4 points, chronologically merged.
  const chartPoints = useMemo(() => {
    const merged = [...tradePoints, ...v4TradePoints].sort((a, b) => a.timestamp - b.timestamp);
    return merged;
  }, [tradePoints, v4TradePoints]);

  // Recent-trades ticker + list — merge curve trades (pre-grad) + v4 swaps (post-grad),
  // newest-first, capped at 25. Without this the list freezes at the graduation point
  // because curve.Trade events stop firing once the pool takes over.
  const mergedRecentTrades = useMemo(() => {
    return [...recentTrades, ...v4RecentTrades]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 25);
  }, [recentTrades, v4RecentTrades]);

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
    chainId: readChainId,
    query: { enabled: !!curveAddress && side === 'buy' && inputWei > 0n, refetchInterval: 6_000 },
  });
  const sellQuote = useReadContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'quoteSell',
    args: [inputWei],
    chainId: readChainId,
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

  // Simulations MUST target the same chain the wallet will sign on — otherwise wagmi picks
  // whatever the wallet is currently on and the sim silently succeeds against the wrong
  // chain (or fails against a missing contract). Gate sims on wallet-being-on-active-chain
  // so the "sim failed" banner doesn't fire while the user is mid-chain-switch.
  const buySim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'buy',
    args: [slippage],
    value: inputWei,
    account: wallet,
    chainId: readChainId,
    query: { enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'buy' && inputWei > 0n && !graduated },
  });
  const sellSim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'sell',
    args: [inputWei, slippage],
    account: wallet,
    chainId: readChainId,
    query: { enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'sell' && inputWei > 0n && !graduated && !needsApproval },
  });
  const approveSim = useSimulateContract({
    abi: erc20TokenAbi,
    address: tokenAddress,
    functionName: 'approve',
    args: curveAddress ? [curveAddress, 2n ** 256n - 1n] : undefined,
    account: wallet,
    chainId: readChainId,
    query: { enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'sell' && needsApproval },
  });

  const { writeContract, isPending: writePending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash as Hex | undefined });

  // Fire a fresh indexer pull the moment a trade lands so the "recent trades" list + chart
  // include the user's just-completed tx (indexer refetchInterval is 15s otherwise). Depends
  // on the receipt hash so it only runs once per successful confirm.
  useEffect(() => {
    if (!receipt.data || !curveAddress) return;
    let cancelled = false;
    (async () => {
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (cancelled || !indexed) return;
      setTradePoints(
        indexed.map((t) => ({ timestamp: Number(t.blockTimestamp), priceWeiPerToken: BigInt(t.priceWeiPerToken) })),
      );
      setRecentTrades(
        indexed.slice().reverse().slice(0, 25).map((t) => ({
          isBuy: t.isBuy,
          eth: BigInt(t.ethAmount),
          tokens: BigInt(t.tokenAmount),
          trader: t.trader,
          timestamp: Number(t.blockTimestamp),
        })),
      );
    })();
    // Also nudge the wagmi cache so curve reserves + wallet balance + allowance update in
    // the same beat. Allowance refetch is what unlocks the sell button immediately after
    // an approve tx confirms — without it the user waited on the 15s poll interval (or
    // had to reload the page) before the button flipped from "approve first" to "sell".
    curveState.refetch();
    walletBalQ.refetch();
    curveAllowanceQ.refetch();
    return () => { cancelled = true; };
  }, [receipt.data?.transactionHash, curveAddress]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // After graduation the curve's ethReserve is drained (all sent to LP), so the raw
    // ratio would read 0%. Pin the bar to 100% instead — that's the accurate state.
    if (graduated) return 100;
    if (!ethReserve || !gradTarget) return 0;
    return Math.min(100, Number(((ethReserve as bigint) * 10_000n) / (gradTarget as bigint)) / 100);
  }, [graduated, ethReserve, gradTarget]);

  const tokensSold = useMemo(() => {
    if (!curveSupply || !tokenReserve) return 0n;
    return (curveSupply as bigint) - (tokenReserve as bigint);
  }, [curveSupply, tokenReserve]);

  // ---- v4 pool state (post-graduation) — slot0 spot read via StateView.
  // `poolId` + `hookAddr` are defined earlier (near the chart-points effect) so they can
  // be re-used here without re-computing.
  const stateView = activeChain ? V4_STATE_VIEWS[activeChain] : null;
  const slot0Q = useReadContract({
    abi: v4StateViewAbi,
    address: (stateView as Address | undefined) ?? undefined,
    functionName: 'getSlot0',
    args: poolId ? [poolId] : undefined,
    chainId: readChainId,
    query: { enabled: !!poolId && !!stateView && !!graduated, refetchInterval: 8_000 },
  });
  const poolSqrtPriceX96 = slot0Q.data?.[0] as bigint | undefined;

  // Uniswap v4 sqrtPriceX96 encodes sqrt(price) × 2^96 where price = amount1/amount0 —
  // for our ETH(currency0)/token(currency1) pools, that's atomic-tokens per atomic-ETH,
  // a LARGE number (hundreds of millions of tokens per ETH). To get wei-ETH per WHOLE
  // token (the number chart + market cap want), we invert:
  //   price_ratio = (sqrt / 2^96)^2 = sqrt^2 / 2^192
  //   weiPerWholeToken = 1e18 / price_ratio  = (1e18 * 2^192) / sqrt^2
  // Direction matters — get it backwards and values blow past lightweight-charts'
  // ±9e13 safe range (assertion error caught this).
  const poolSpotPriceEthPerToken = useMemo(() => {
    // Prefer StateView.getSlot0 (freshest, no log-fetch lag). Fall back to the newest
    // v4 Swap log's sqrtPriceX96 — necessary when the RPC transport hasn't caught up
    // with slot0 yet, or when the reader is on a chain where StateView isn't wired.
    const src = poolSqrtPriceX96 && poolSqrtPriceX96 > 0n ? poolSqrtPriceX96 : v4LatestSqrt;
    if (!src || src === 0n) return 0n;
    return ((10n ** 18n) << 192n) / (src * src);
  }, [poolSqrtPriceX96, v4LatestSqrt]);

  /// Single source of truth for the sidebar's price row. Post-graduation the curve's
  /// priceWeiPerToken() reads virtual reserves (real ones were drained to the pool) so
  /// it silently returns a wrong number — use the v4 pool spot instead. Pre-graduation
  /// the curve's read IS the truth.
  const effectiveSpotPrice = useMemo<bigint>(() => {
    if (graduated) return poolSpotPriceEthPerToken;
    return (spotPrice as bigint | undefined) ?? 0n;
  }, [graduated, poolSpotPriceEthPerToken, spotPrice]);

  const unit = usePriceUnit();
  const ethUsd = useEthUsd();

  const marketCap = useMemo<bigint | null>(() => {
    if (!tokenTotalSupply) return null;
    // Post-graduation: use v4 pool spot × totalSupply. Pre-graduation: use curve spot.
    // Return null (not 0n) while we're still waiting for a spot to load — otherwise the
    // header would render "0.0000 Ξ" in the seconds between graduation flipping and slot0
    // returning, which reads as "worth nothing" instead of "still loading."
    const spot = graduated ? poolSpotPriceEthPerToken : ((spotPrice as bigint | undefined) ?? 0n);
    if (spot === 0n) return null;
    return (spot * (tokenTotalSupply as bigint)) / 10n ** 18n;
  }, [graduated, poolSpotPriceEthPerToken, spotPrice, tokenTotalSupply]);

  // ============================================================================

  // First-paint skeleton: SSR + the very first client render show the same "looking up"
  // panel so wagmi hydration (which populates chainId + query state asynchronously) can't
  // cause the mascot to swap moods/sizes mid-hydrate. Once `mounted` flips, we fall through
  // to whichever real branch matches state below.
  if (!mounted) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 text-center">
        <Mascot size={64} mood="sleepy" />
        <div style={{ marginTop: 8, fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)' }}>
          looking up the curve..
        </div>
      </div>
    );
  }

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
    <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4">
      {showCrossChainBanner && tokenHomeChain && (
        <div
          className="uru-shell-tight"
          style={{
            marginBottom: 10,
            padding: '10px 14px',
            background: 'var(--yolk)',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            fontFamily: 'var(--font-round), Klee One, cursive',
            fontSize: 13,
          }}
        >
          <span>
            ✿ this token lives on <b>{CHAIN_LABELS[tokenHomeChain]}</b>. all data is real — just
            switch to trade.
          </span>
          <button
            type="button"
            className="uru-btn uru-btn-primary"
            onClick={() => switchChain({ chainId: CHAIN_KEY_TO_ID[tokenHomeChain] })}
            disabled={switchPending}
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            {switchPending ? 'switching…' : `switch to ${CHAIN_LABELS[tokenHomeChain]} →`}
          </button>
        </div>
      )}
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
            background: safeBackgroundImage(metadata?.logoDataUrl),
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
            <span>fee: {typeof feeBps === 'number' ? `${(feeBps / 100).toFixed(2)}%` : '—'}</span>
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
              <FlashCell value={marketCap ?? undefined}>
                {marketCap ? formatMcap(marketCap, unit, ethUsd) : '—'}
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
          trades={mergedRecentTrades.map((t) => ({ isBuy: t.isBuy, eth: t.eth, tokens: t.tokens, trader: t.trader }))}
          symbol={tokenSymbol as string | undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* MAIN — chart + recent trades */}
        <div className="space-y-3">
          <TradeChart points={chartPoints} flashKey={chartFlashKey} flashSide={chartFlashSide} />

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
                {mergedRecentTrades.length} shown
              </span>
            </div>
            {mergedRecentTrades.length === 0 ? (
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
                    gridTemplateColumns: 'minmax(42px, 52px) 1fr 1fr 1fr',
                    minWidth: 0,
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
                  {mergedRecentTrades.map((t, i) => (
                    <li
                      key={i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(42px, 52px) 1fr 1fr 1fr',
                    minWidth: 0,
                        gap: 8,
                        fontFamily: 'var(--font-pixel), monospace',
                        fontSize: 11,
                        alignItems: 'baseline',
                        padding: '4px 10px',
                        borderBottom: i === mergedRecentTrades.length - 1 ? 'none' : '1px dotted var(--anchor)',
                      }}
                    >
                      <span style={{ color: t.isBuy ? 'var(--mint-hot)' : 'var(--pink-hot)', fontWeight: 700 }}>
                        {t.isBuy ? 'BUY' : 'SELL'}
                      </span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {Number(formatEther(t.eth)).toFixed(4)}
                      </span>
                      <span style={{ textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {Number(formatUnits(t.tokens, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                      <Link
                        href={`/profile/${t.trader}`}
                        style={{
                          color: 'var(--link-blue)',
                          textDecoration: 'underline',
                          justifySelf: 'end',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
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

          {/* Chat — API-backed when chainId is known so posts are shared across
              browsers; falls back to localStorage for the preview / mock modes. */}
          <ChatDrawer tokenAddress={tokenAddress} chainId={readChainId} wallet={wallet} />

          {/* Info sidebar (metadata) — always renders when a wallet is connected, so
              the launcher can back-fill an image / description after launch. Server
              rejects the write if the signer isn't the launcher. */}
          <MetadataPanel
            metadata={metadata}
            tokenAddress={tokenAddress}
            chainId={chainId}
            wallet={wallet as Address | undefined}
            onSaved={(next) => setMetadata(next)}
          />
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
              <GraduatedPanel
                chain={activeChain}
                tokenAddress={tokenAddress}
                curveAddress={curveAddress}
                tokenSymbol={(tokenSymbol as string) ?? ''}
                tokenTotalSupply={(tokenTotalSupply as bigint | undefined) ?? 0n}
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
                    (walletOnActiveChain && side === 'buy' && !buySim.data) ||
                    (walletOnActiveChain && side === 'sell' && !needsApproval && !sellSim.data)
                  }
                  className={side === 'buy' ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'}
                  style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                >
                  {!connectedForRender
                    ? 'connect wallet'
                    : !walletOnActiveChain && activeChain
                      ? switchPending
                        ? 'switching..'
                        : `switch to ${activeChain} ✿`
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
                <FlashCell value={effectiveSpotPrice}>
                  <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                    {effectiveSpotPrice > 0n ? formatPrice(effectiveSpotPrice, unit, ethUsd) : '—'}
                  </span>
                </FlashCell>
              </li>
              <li style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--cream-shadow)', padding: '2px 0' }}>
                <span>tokens sold</span>
                <span style={{ color: 'var(--anchor)', fontWeight: 700 }}>
                  {Number(formatUnits(tokensSold, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </li>
              <li
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--cream-shadow)', padding: '2px 0' }}
                title={
                  wallet
                    ? `Balance of ${wallet} — if you use a smart-wallet that submits via a different signer, tokens may sit at the smart account address instead.`
                    : 'Connect a wallet to see its balance.'
                }
              >
                <span>
                  connected wallet
                  {wallet && (
                    <span style={{ fontFamily: 'var(--font-pixel), monospace', color: 'var(--anchor-soft)', marginLeft: 4, fontSize: 9 }}>
                      {wallet.slice(0, 6)}…{wallet.slice(-4)}
                    </span>
                  )}
                </span>
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
  onSaved,
}: {
  metadata: TokenMetadata | null;
  tokenAddress: Address;
  chainId: number;
  wallet: Address | undefined;
  onSaved: (next: TokenMetadata | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const hasContent = !!(metadata && (
    metadata.logoDataUrl || metadata.description || metadata.website ||
    metadata.twitter || metadata.telegram || metadata.discord || metadata.tiktok
  ));

  if (!hasContent && !wallet) return null;

  return (
    <div className="uru-shell uru-shell-tight">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="uru-eyebrow">❀ about</div>
        {wallet && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 10,
              color: 'var(--link-blue)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {hasContent ? 'edit ✿' : 'add image + info ✿'}
          </button>
        )}
      </div>
      {metadata?.description && (
        <p style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 8 }}>{metadata.description}</p>
      )}
      {(metadata?.website || metadata?.twitter || metadata?.telegram || metadata?.discord || metadata?.tiktok) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {metadata.website && <Socialz href={metadata.website} label="site" />}
          {metadata.twitter && <Socialz href={metadata.twitter} label="twitter" />}
          {metadata.telegram && <Socialz href={metadata.telegram} label="tg" />}
          {metadata.discord && <Socialz href={metadata.discord} label="discord" />}
          {metadata.tiktok && <Socialz href={metadata.tiktok} label="tiktok" />}
        </div>
      )}
      {editing && wallet && (
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
        },
        ({ message }) => signMessageAsync({ message }),
      );
      if (!remote.ok) {
        setError(remote.error === 'NOT_LAUNCHER'
          ? 'only the launcher wallet can edit this token'
          : `save failed: ${remote.error}`);
        return;
      }
      onSaved({ ...pinned, savedAt: Date.now() });
    } catch (err) {
      setError((err as Error).message || 'save cancelled');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(58,44,58,0.35)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="uru-shell"
        style={{ width: 'min(560px, 100%)', marginTop: 24, background: 'var(--paper-base)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <div className="uru-h2">✿ edit metadata</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontFamily: 'var(--font-pixel), monospace',
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--anchor-soft)',
            }}
          >
            close ×
          </button>
        </div>
        <MetadataForm value={inputs} onChange={setInputs} hideIntro />
        {error && (
          <div
            style={{
              marginTop: 10,
              padding: 8,
              border: '1.5px dashed var(--pink-hot)',
              background: 'var(--pink-warm)',
              fontSize: 12,
              fontFamily: 'var(--font-pixel), monospace',
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onClose} className="uru-btn" disabled={saving}>
            cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="uru-btn uru-btn-primary"
            disabled={saving}
          >
            {saving ? 'saving…' : 'save + sign ✦'}
          </button>
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
  tokenSymbol,
  tokenTotalSupply,
  walletTokenBal,
  walletOnActiveChain,
  onSwitchChain,
  switchPending,
  poolSpotEthPerToken,
  onSwapComplete,
}: {
  chain: ChainKey | null;
  tokenAddress: Address;
  curveAddress: Address;
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
}) {
  const { address: wallet, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const connectedForRender = mounted && isConnected;

  const chainId = chain ? CHAIN_KEY_TO_ID[chain] : undefined;
  const v4Router = chain ? V4_ROUTERS[chain] : null;
  const hookAddr = chain ? HOOKS[chain]?.MultiHookHost : undefined;

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

  // slippage → minOut is done inside sim to keep it live. Rough: 2% default.
  const slippageBps = Math.max(0, Math.min(5000, Math.round(Number(slippagePct || '0') * 100)));
  const minOut = inputWei === 0n ? 0n : (inputWei * BigInt(10_000 - slippageBps)) / 10_000n;

  const buySim = useSimulateContract({
    abi: v4SwapRouterAbi,
    address: (v4Router as Address | undefined) ?? undefined,
    functionName: 'swapExactETHForToken',
    args: poolKey && wallet ? [poolKey, 1n, wallet] : undefined,
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
    args: poolKey && wallet ? [poolKey, inputWei, 1n, wallet] : undefined,
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

  if (!v4Router) {
    return (
      <div style={{ padding: 16, textAlign: 'center', background: 'var(--pink-warm)', border: '1.5px solid var(--anchor)', fontFamily: 'var(--font-round), Klee One, cursive', fontSize: 13 }}>
        ✿ graduated ✿<br />
        <span style={{ fontSize: 11, color: 'var(--anchor-soft)' }}>
          V4SwapRouter not deployed on this chain yet — trade on Uniswap:
        </span><br />
        <a href={uniswapUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
          ✦ open Uniswap →
        </a>
      </div>
    );
  }

  const balanceMax = side === 'sell' ? walletTokenBal : 0n;

  return (
    <div
      style={{
        padding: 14,
        background: 'linear-gradient(180deg, var(--mint) 0%, var(--paper-base) 100%)',
        border: '1.5px solid var(--anchor)',
        boxShadow: '3px 3px 0 var(--anchor)',
        fontFamily: 'var(--font-round), Klee One, cursive',
      }}
    >
      <div style={{ fontSize: 18, marginBottom: 8 }}>✿ graduated · trade on v4 ✿</div>

      {/* Buy/sell toggle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSide(s); setAmountInput(''); }}
            className={side === s ? 'uru-btn uru-btn-primary' : 'uru-btn'}
            style={{ flex: 1, justifyContent: 'center', padding: '4px 8px', fontSize: 12 }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Input */}
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
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.0"
            style={{ flex: 1 }}
          />
          <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 12, fontWeight: 700 }}>
            {side === 'buy' ? 'ETH' : tokenSymbol || 'TKN'}
          </span>
        </div>
      </label>

      {/* Sell balance hint + max */}
      {side === 'sell' && (
        <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          <span>bal: {Number(formatUnits(walletTokenBal, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          <button
            type="button"
            onClick={() => setAmountInput(formatUnits(balanceMax, 18))}
            style={{ background: 'transparent', border: 'none', color: 'var(--link-blue)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline' }}
          >
            max
          </button>
        </div>
      )}

      {/* You receive — first-order estimate from pool spot × amount. Real amount differs
          due to AMM slippage + MultiHookHost's 2% output cut; we render "≈" to be honest. */}
      <div
        style={{
          marginTop: 8,
          padding: 8,
          background: 'var(--cream-deep)',
          border: '1.5px dashed var(--anchor)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          you receive (est.)
        </div>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 16, fontWeight: 700, color: 'var(--anchor)', marginTop: 2 }}>
          {inputWei === 0n || poolSpotEthPerToken === 0n
            ? '—'
            : side === 'buy'
              ? `≈ ${Number(formatUnits((inputWei * 10n ** 18n) / poolSpotEthPerToken, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${tokenSymbol || 'TKN'}`
              : `≈ ${Number(formatEther((inputWei * poolSpotEthPerToken) / 10n ** 18n)).toFixed(6)} ETH`}
        </div>
        <div style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 9, color: 'var(--anchor-soft)', marginTop: 2 }}>
          final differs by slippage + 2% swap fee
        </div>
      </div>

      {/* Slippage */}
      <label style={{ display: 'block', marginTop: 8 }}>
        <span style={{ fontFamily: 'var(--font-pixel), monospace', fontSize: 10, color: 'var(--anchor-soft)' }}>
          slippage %
        </span>
        <input
          className="uru-input"
          type="number"
          step="0.1"
          min="0"
          max="50"
          value={slippagePct}
          onChange={(e) => setSlippagePct(e.target.value)}
          style={{ marginTop: 3, width: '100%' }}
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
          (walletOnActiveChain && side === 'buy' && !buySim.data) ||
          (walletOnActiveChain && side === 'sell' && !needsApproval && !sellSim.data)
        }
        className={side === 'buy' ? 'uru-btn uru-btn-mint' : 'uru-btn uru-btn-primary'}
        style={{ width: '100%', justifyContent: 'center', marginTop: 12, padding: '10px 12px', fontSize: 13 }}
      >
        {!connectedForRender
          ? 'connect wallet'
          : !walletOnActiveChain
            ? switchPending ? 'switching..' : `switch to ${chain} ✿`
            : writePending
              ? 'confirming ~~'
              : receipt.isLoading
                ? 'waiting..'
                : side === 'sell' && needsApproval
                  ? '✿ approve first'
                  : side === 'buy'
                    ? `✿ buy ${tokenSymbol || ''}`
                    : `sell ${tokenSymbol || ''} ✿`}
      </button>

      {(buySim.error || sellSim.error) && (
        <div style={{ marginTop: 8, padding: 8, background: 'var(--pink-warm)', border: '1px solid var(--anchor)', fontFamily: 'var(--font-pixel), monospace', fontSize: 10 }}>
          sim failed: {(buySim.error ?? sellSim.error)?.message.slice(0, 120)}
        </div>
      )}

      {/* Fallback link + explorer */}
      <div
        style={{
          marginTop: 12,
          padding: 8,
          background: 'var(--cream-deep)',
          border: '1px dashed var(--anchor)',
          fontFamily: 'var(--font-pixel), monospace',
          fontSize: 10,
          color: 'var(--anchor-soft)',
          textAlign: 'left',
          lineHeight: 1.5,
        }}
      >
        <div><b>prefer external UIs?</b></div>
        <div style={{ marginTop: 4 }}>
          <a href={uniswapUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}>
            open on Uniswap →
          </a>
        </div>
        {chain && (
          <div style={{ marginTop: 2 }}>
            <a
              href={explorerAddressUrl(chain, curveAddress)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--link-blue)', textDecoration: 'underline' }}
            >
              curve on explorer →
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
