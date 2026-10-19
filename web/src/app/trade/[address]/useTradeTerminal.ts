'use client';

/// Trade terminal state and actions (docs/PLAN-ui-revamp.md, Phase 3).
/// Moved verbatim out of LiveTradeView in page.tsx so the page is only layout.
/// Hook order is unchanged: this is the same code, called once at the top of the view.

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSimulateContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  encodeAbiParameters,
  formatEther,
  keccak256,
  parseEther,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';

import {
  bondingCurveAbi,
  curveFactoryAbi,
  dn404BaseAbi,
  dn404BondingCurveAbi,
  dn404CurveFactoryAbi,
  dn404TaxAbi,
  erc20TokenAbi,
  v4StateViewAbi,
} from '@/lib/abis';
import {
  CONTRACTS,
  COMPILE_SERVICE_URL,
  HOOKS,
  V4_STATE_VIEWS,
  DN404_LAUNCHES,
  DN404_TAX_DESTINATIONS,
  type ChainKey,
} from '@/lib/config';
import { buildErc20PoolKey, pairPerTokenFromSqrt, poolIdOf } from '@/lib/v4Erc20Swap';
import { describeTax } from '@/lib/dn404Tax';
import { CHAIN_ID_TO_KEY, CHAIN_KEY_TO_ID } from '@/lib/wagmi';
import { loadMetadata, type TokenMetadata } from '@/lib/metadata';
import { toGatewayUrl } from '@/lib/ipfsFetch';
import { fetchTokenMetadata } from '@/lib/socialApi';
import {
  fetchCurveByToken,
  fetchGraduationForToken,
  fetchLaunchesByTokens,
  fetchTradesForCurve,
  fetchV4SwapsForToken,
  fetchV4SwapsForPoolId,
  fetchV4RouterSwapsForToken,
  fetchDn404MirrorForBase,
  type IndexerNftCollection,
} from '@/lib/indexer';
import {
  MAX_NFTS_PER_TX,
  maxTokensInForNfts,
  maxTokensOutForNfts,
  nftsBurned,
  nftsMinted,
  scaleInputForOutput,
} from '@/lib/dn404Gas';
import { legacyHookOverride, willGraduateLegacy } from '@/lib/legacyGraduations';
import { useActiveChain } from '@/components/ChainSwitcher';
import { formatMcap, formatPrice, useEthUsd, usePriceUnit } from '@/lib/priceUnit';
import { type TradePoint } from '@/components/TradeChart';

export type Side = 'buy' | 'sell';

/// Compute the curve's spot price (wei-per-token, 18-decimal fixed point) from
/// its post-trade reserves. Mirrors BondingCurve.priceWeiPerToken() on-chain:
///   price = (virtEth + realEth) * 1e18 / (virtToken + realToken)
///
/// This is the marginal price after the trade, which is what a trading chart
/// should plot — versus the indexer's stored `priceWeiPerToken` field, which is
/// the per-trade *realized average* (ETH-in / tokens-out). Realized average
/// always sits below the true post-trade spot on a sell (making tiny sells
/// look like disproportionate downticks) and below true post-trade spot on a
/// buy, so plotting it produced visually misleading candles on the chart.
export function spotFromReserves(
  virtualEth: bigint,
  virtualToken: bigint,
  realEth: bigint,
  realToken: bigint,
): bigint {
  const denom = virtualToken + realToken;
  if (denom === 0n) return 0n;
  return ((virtualEth + realEth) * 10n ** 18n) / denom;
}


export function useTradeTerminal(tokenAddress: Address) {
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
  // launcher = wallet that created this token, sourced from the indexer's
  // launches row. Used to gate the metadata-edit affordance on the frontend so
  // non-owners never see an edit button they can't legitimately use.
  const [launchInfoLauncher, setLaunchInfoLauncher] = useState<Address | null>(null);
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
      if (row.launchedBy) setLaunchInfoLauncher(row.launchedBy as Address);
    })();
    return () => { cancelled = true; };
  }, [tokenAddress]);

  // DN404 reverse lookup: if this token is the base half of a DN404 pair,
  // the indexer has an `nftCollections` row with `pairedToken=<this>` for
  // the mirror. Non-DN404 tokens return null and the strip is elided.
  const [pairedMirror, setPairedMirror] = useState<IndexerNftCollection | null>(null);
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    (async () => {
      const mirror = await fetchDn404MirrorForBase(tokenAddress);
      if (!cancelled) setPairedMirror(mirror);
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
  // 3. ERC-20-paired DN404 curves (pairCurrency != 0, URU today) live on the
  //    Dn404CurveFactory, not the V10 one. Only asked once both the indexer and
  //    V10 came back empty, so ETH tokens never pay for this read.
  const dn404CurveFactory = activeChain ? DN404_LAUNCHES[activeChain]?.CurveFactory : undefined;
  const dn404CurveQuery = useReadContract({
    abi: dn404CurveFactoryAbi,
    address: dn404CurveFactory,
    functionName: 'curveFor',
    args: [tokenAddress],
    chainId: readChainId,
    query: {
      enabled: !!dn404CurveFactory && indexerChecked && !indexedCurveAddress && curveQuery.isFetched && !factoryCurveAddress,
      staleTime: 15_000,
    },
  });
  const dn404FactoryCurveAddress = dn404CurveQuery.data && dn404CurveQuery.data !== '0x0000000000000000000000000000000000000000'
    ? (dn404CurveQuery.data as Address)
    : null;
  const curveAddress: Address | null = indexedCurveAddress ?? factoryCurveAddress ?? dn404FactoryCurveAddress;

  // ---------- Pair currency (DN404 ERC-20 pairs) ----------
  // ETH for every V10 curve. For a DN404 launch that picked an ERC-20 pair the
  // indexer's mirror row carries it; otherwise read pairCurrency() off the
  // curve. V10 curves have no such function, so a failed read means ETH.
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const mirrorPair = pairedMirror?.pairCurrency && pairedMirror.pairCurrency !== ZERO_ADDR
    ? (pairedMirror.pairCurrency as Address)
    : null;
  const curvePairQ = useReadContract({
    abi: dn404BondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'pairCurrency',
    chainId: readChainId,
    query: { enabled: !!curveAddress && !mirrorPair, retry: false, staleTime: Infinity },
  });
  const curvePair = curvePairQ.data && curvePairQ.data !== ZERO_ADDR ? (curvePairQ.data as Address) : null;
  const pairCurrency: Address | null = mirrorPair ?? curvePair;
  const isErc20Pair = !!pairCurrency;

  // ---------- Live curve + token state ----------
  const curveState = useReadContracts({
    contracts: curveAddress
      ? [
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'ethReserve', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'tokenReserve', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'graduationTargetEth', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'curveSupply', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'priceWeiPerToken', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'graduated', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'tradeFeeBps', chainId: readChainId },
          // Static virtual reserves (set at CurveInitialized, never change). We
          // read them alongside the mutable state so the chart can compute
          // spot-after-trade prices from the reserves saved in each Trade event
          // instead of the per-trade realized average the indexer stores.
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'virtualEthReserve', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'virtualTokenReserve', chainId: readChainId },
        ]
      : [],
    // Leave allowFailure as its default (true) — the results below are read as
    // `csResults[i].result`, which is only present in the wrapped shape. Setting
    // allowFailure:false collapses each entry to the raw value and every widget
    // downstream reads undefined.
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: !!curveAddress, refetchInterval: 8_000 },
  });
  const csResults = curveState.data ?? [];
  const ethReserve = csResults[0]?.result as bigint | undefined;
  const tokenReserve = csResults[1]?.result as bigint | undefined;
  const gradTarget = csResults[2]?.result as bigint | undefined;
  const curveSupply = csResults[3]?.result as bigint | undefined;
  const spotPrice = csResults[4]?.result as bigint | undefined;

  // ---------- Whitelist state (WL-aware curves only) ----------
  // Kept as a separate useReadContracts so csResults array indices upstream stay stable.
  // Non-WL curves return zero for these — the WL UI branches on `wlEnabled` before
  // rendering, so the reads are cheap noise on legacy curves.
  const wlState = useReadContracts({
    contracts: curveAddress
      ? [
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'whitelistRoot', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'fallbackTs', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'reservedTokens', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'wlSold', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'sourceTokenAddress', chainId: readChainId },
          { abi: bondingCurveAbi, address: curveAddress, functionName: 'sourceChainId', chainId: readChainId },
        ]
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: !!curveAddress, refetchInterval: 8_000 },
  });
  const wlRoot = wlState.data?.[0]?.result as `0x${string}` | undefined;
  const wlFallbackTs = wlState.data?.[1]?.result as bigint | undefined;
  const wlReservedTokens = wlState.data?.[2]?.result as bigint | undefined;
  const wlSoldTokens = wlState.data?.[3]?.result as bigint | undefined;
  const wlSourceToken = wlState.data?.[4]?.result as Address | undefined;
  const wlSourceChainIdRaw = wlState.data?.[5]?.result as number | undefined;
  const wlEnabled = !!wlRoot && wlRoot !== `0x${'0'.repeat(64)}`;

  // The source project can live on another chain (Ethereum). Read its name +
  // symbol and link the explorer on THAT chain. Older curves stored the launch
  // chain or 0 here; anything unknown to wagmi falls back to the launch chain.
  const wlSourceChainKey: ChainKey | undefined =
    wlSourceChainIdRaw && CHAIN_ID_TO_KEY[wlSourceChainIdRaw] ? CHAIN_ID_TO_KEY[wlSourceChainIdRaw] : undefined;
  const wlSourceReadChainId = wlSourceChainKey ? CHAIN_KEY_TO_ID[wlSourceChainKey] : readChainId;

  // Resolve the WL source token's name + symbol so the WL panel can label
  // WHICH community is eligible (e.g. "whitelist for holders of $KAWAII").
  // Skipped when the WL source is unset (zero-address = no source recorded).
  const wlSourceValid = wlEnabled && !!wlSourceToken && wlSourceToken !== '0x0000000000000000000000000000000000000000';
  const wlSourceMeta = useReadContracts({
    contracts: wlSourceValid
      ? [
          { abi: erc20TokenAbi, address: wlSourceToken!, functionName: 'name', chainId: wlSourceReadChainId },
          { abi: erc20TokenAbi, address: wlSourceToken!, functionName: 'symbol', chainId: wlSourceReadChainId },
        ]
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: wlSourceValid },
  });
  const wlSourceName = wlSourceMeta.data?.[0]?.result as string | undefined;
  const wlSourceSymbol = wlSourceMeta.data?.[1]?.result as string | undefined;
  const graduated = csResults[5]?.result as boolean | undefined;
  // tradeFeeBps() returns uint16 → wagmi maps to `number`, not `bigint`. Reading it as
  // bigint made the fee row render '—' because `typeof feeBps === 'bigint'` was never true.
  const feeBps = csResults[6]?.result as number | undefined;
  const virtualEthReserve = csResults[7]?.result as bigint | undefined;
  const virtualTokenReserve = csResults[8]?.result as bigint | undefined;

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

  // Native ETH balance of the connected wallet on the token's chain. Displayed
  // next to the amount input so users can eyeball what's in their wallet before
  // typing / hitting max. Refetch matches walletBalQ so the two feel in sync.
  const walletEthBalQ = useBalance({
    address: wallet,
    chainId: readChainId,
    query: { enabled: !!wallet, refetchInterval: 15_000 },
  });
  const walletEthBal = walletEthBalQ.data?.value;

  // Pair-token metadata + wallet state, only for ERC-20-paired DN404 curves.
  // `pairSym` / `pairDecimals` collapse to ETH / 18 otherwise, so every label
  // below can use them unconditionally without changing the ETH path.
  const pairMeta = useReadContracts({
    contracts: pairCurrency
      ? ([
          { abi: erc20TokenAbi, address: pairCurrency, functionName: 'symbol', chainId: readChainId },
          { abi: erc20TokenAbi, address: pairCurrency, functionName: 'decimals', chainId: readChainId },
        ] as const)
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: !!pairCurrency, staleTime: Infinity },
  });
  const pairState = useReadContracts({
    contracts: pairCurrency && wallet && curveAddress
      ? ([
          { abi: erc20TokenAbi, address: pairCurrency, functionName: 'balanceOf', args: [wallet], chainId: readChainId },
          { abi: erc20TokenAbi, address: pairCurrency, functionName: 'allowance', args: [wallet, curveAddress], chainId: readChainId },
        ] as const)
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: !!pairCurrency && !!wallet && !!curveAddress, refetchInterval: 15_000 },
  });
  const pairSym = isErc20Pair ? ((pairMeta.data?.[0]?.result as string | undefined) ?? 'PAIR') : 'ETH';
  const pairDecimals = isErc20Pair ? Number((pairMeta.data?.[1]?.result as number | undefined) ?? 18) : 18;
  const walletPairBal = isErc20Pair ? (pairState.data?.[0]?.result as bigint | undefined) : walletEthBal;
  const pairCurveAllowance = (pairState.data?.[1]?.result as bigint | undefined) ?? 0n;
  /// Pair-side amount → display string. ETH keeps formatEther (identical output).
  const fmtPair = (v: bigint) => (isErc20Pair ? formatUnits(v, pairDecimals) : formatEther(v));

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
      // already reads. wlListCid piped through so cross-device viewers can fetch the
      // pinned WL holder list (deployer's local snapshot alone wouldn't reach them).
      setMetadata({
        // Gateway links go through /api/ipfs (public gateways died 2026-10);
        // data: URLs and other https links pass through unchanged.
        logoDataUrl: remote.imageUrl ? (toGatewayUrl(remote.imageUrl) ?? remote.imageUrl) : undefined,
        description: remote.description ?? undefined,
        website: remote.website ?? undefined,
        twitter: remote.twitter ?? undefined,
        telegram: remote.telegram ?? undefined,
        discord: remote.discord ?? undefined,
        tiktok: remote.tiktok ?? undefined,
        wlListCid: remote.wlListCid ?? undefined,
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
    // Virtual reserves used to be a hard prerequisite — if the wagmi read
    // hadn't landed yet (common for anonymous users on mobile before
    // hydration completes) the chart stayed blank until they connected a
    // wallet. Now: if virtuals are missing, fall back to the indexer's
    // per-trade `priceWeiPerToken` field which is realized-average price
    // and plots cleanly on its own. Chart lines appear immediately for
    // anon visitors; once wagmi's read lands we recompute with the more
    // accurate spot-after-trade formula.
    const vE = virtualEthReserve;
    const vT = virtualTokenReserve;
    let cancelled = false;
    (async () => {
      // 1) Prefer the indexer — full history, cheap query, no RPC round-trip cap.
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (cancelled) return;
      if (indexed && indexed.length > 0) {
        const pts: TradePoint[] = indexed.map((t) => ({
          timestamp: Number(t.blockTimestamp),
          priceWeiPerToken: (vE !== undefined && vT !== undefined)
            ? spotFromReserves(vE, vT, BigInt(t.ethReserveAfter), BigInt(t.tokenReserveAfter))
            : BigInt(t.priceWeiPerToken),
          isBuy: t.isBuy,
        }));
        const rec = indexed.slice().reverse().slice(0, 200).map((t) => ({
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
      //    exists — dies at scale but that's fine for launch day. Needs virtual reserves
      //    to compute spot from the Trade event payload; skip until they land (indexer path
      //    already covered the wallet-less anon case).
      if (!publicClient || vE === undefined || vT === undefined) return;
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
          // Trade event payload carries the post-trade reserves — same source
          // the indexer reads. Compute spot from those so the chart tracks the
          // curve's marginal price, not the per-trade realized average (a
          // realized average always sits BELOW pre-trade spot on a sell and
          // BELOW post-trade spot on a buy, making tiny sells look bigger
          // than they are).
          const ethReserveAfter = args.ethReserve as bigint;
          const tokenReserveAfter = args.tokenReserve as bigint;
          const spotWei = spotFromReserves(vE, vT, ethReserveAfter, tokenReserveAfter);
          pts.push({ timestamp: ts, priceWeiPerToken: spotWei, isBuy: args.isBuy as boolean });
          rec.push({
            isBuy: args.isBuy as boolean,
            eth: ethAmount,
            tokens: tokenAmount,
            trader: args.trader as Address,
            timestamp: ts,
          });
        }
        setTradePoints(pts);
        setRecentTrades(rec.reverse().slice(0, 200));
      } catch {
        // Silent — transient RPC / indexer hiccups happen constantly and
        // this poll retries every 30s anyway. Filling the console with
        // hundreds of "trade log fetch failed" entries during a long
        // page-open session helped nobody.
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, curveAddress, virtualEthReserve, virtualTokenReserve]);

  // Background poll so the recent-trades list + chart tick even without the current tab
  // firing a tx. 30s is a friendly interval — catches other users' trades on the same curve
  // without hammering the indexer over long-lived sessions (was 15s; hitting Vercel + Ponder
  // rate limits after several thousand ticks in the same tab).
  useEffect(() => {
    if (!curveAddress) return;
    // Same fallback as the initial load: use indexer's per-trade price if
    // virtual reserves aren't loaded (anon users pre-hydration).
    const vE = virtualEthReserve;
    const vT = virtualTokenReserve;
    const id = setInterval(async () => {
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (!indexed || indexed.length === 0) return;
      setTradePoints(
        indexed.map((t) => ({
          timestamp: Number(t.blockTimestamp),
          priceWeiPerToken: (vE !== undefined && vT !== undefined)
            ? spotFromReserves(vE, vT, BigInt(t.ethReserveAfter), BigInt(t.tokenReserveAfter))
            : BigInt(t.priceWeiPerToken),
          isBuy: t.isBuy,
        })),
      );
      setRecentTrades(
        indexed.slice().reverse().slice(0, 200).map((t) => ({
          isBuy: t.isBuy,
          eth: BigInt(t.ethAmount),
          tokens: BigInt(t.tokenAmount),
          trader: t.trader,
          timestamp: Number(t.blockTimestamp),
        })),
      );
    }, 5_000);
    return () => clearInterval(id);
  }, [curveAddress, virtualEthReserve, virtualTokenReserve]);

  // ---------- v4 pool swaps → chart points (post-graduation) ------------------
  // After graduation, the BondingCurve stops trading — the price story continues on the
  // v4 pool. Fetch PoolManager.Swap logs filtered by our poolId and convert each swap's
  // sqrtPriceX96 into a wei-per-token TradePoint. Bounded lookback keeps the initial pull
  // cheap; a 30s poll picks up new swaps for the live chart.
  //
  // poolId + hookAddr are re-used by the market-cap section further down; compute once
  // here so the effect can reference them before that section runs.
  //
  // Per-token hook resolution, in priority order:
  //   1. legacyHookOverride(token) — belt-and-suspenders for tokens whose v4
  //      pool is on the pre-V3 (V10) MHH. Includes both already-graduated and
  //      pre-graduation curves that will graduate through V10. See
  //      web/src/lib/legacyGraduations.ts for the set.
  //   2. Indexer's graduations.hookAddress — the truth for any graduation
  //      indexed after the column was added.
  //   3. Config default (HOOKS[chain]?.MultiHookHost) — last-resort fallback
  //      for tokens indexed before the column existed AND not on the override
  //      list. Kept pointing at the current default hook so a freshly-graduated
  //      token can still resolve while the indexer catches up.
  const overrideHookAddr = legacyHookOverride(tokenAddress);
  const pendingLegacyCliff = willGraduateLegacy(tokenAddress, graduated);
  const [indexedHookAddr, setIndexedHookAddr] = useState<Address | undefined>();
  useEffect(() => {
    if (!tokenAddress || overrideHookAddr) return;
    let cancelled = false;
    (async () => {
      const g = await fetchGraduationForToken(tokenAddress);
      if (cancelled) return;
      if (g?.hookAddress) setIndexedHookAddr(g.hookAddress as Address);
    })();
    return () => { cancelled = true; };
  }, [tokenAddress, overrideHookAddr]);
  const configHookAddr = activeChain ? HOOKS[activeChain]?.MultiHookHost : undefined;
  // ERC-20-paired DN404 curves graduate through Dn404Graduator onto the DN404
  // lane's own host, never the ERC-20 lane's. Pinned from config so it can't
  // fall through to configHookAddr while the indexer lacks the graduation row.
  const dn404Host = activeChain ? DN404_LAUNCHES[activeChain]?.MultiHookHost : undefined;
  const hookAddr = isErc20Pair ? dn404Host : (overrideHookAddr ?? indexedHookAddr ?? configHookAddr);
  const erc20PoolKey = useMemo(
    () => (isErc20Pair && pairCurrency && dn404Host ? buildErc20PoolKey(tokenAddress, pairCurrency, dn404Host) : null),
    [isErc20Pair, pairCurrency, dn404Host, tokenAddress],
  );
  const tokenIsCurrency0 = !!erc20PoolKey && erc20PoolKey.currency0.toLowerCase() === tokenAddress.toLowerCase();
  const poolManagerAddr = activeChain ? HOOKS[activeChain]?.PoolManager : undefined;
  const poolId = useMemo(() => {
    if (erc20PoolKey) return poolIdOf(erc20PoolKey);
    if (!hookAddr) return undefined;
    return keccak256(
      encodeAbiParameters(
        [
          { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
        ],
        ['0x0000000000000000000000000000000000000000', tokenAddress, 3000, 60, hookAddr],
      ),
    );
  }, [tokenAddress, hookAddr, erc20PoolKey]);
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
      // Three queries, all joined post-fetch:
      //   1. v4Swapss by tokenAddress — the primary path; returns rows where the
      //      indexer's `graduations.poolId → tokenAddress` reverse-lookup landed.
      //   2. v4Swapss by poolId — the rescue path; catches legacy tokens whose
      //      rows have tokenAddress=null because the indexer's join failed at
      //      ingest time (early graduations, indexer env drift, etc). LUV +
      //      the other two pre-V3 tokens hit this case — without the poolId
      //      query their recent trades panel would stay empty forever.
      //   3. v4RouterSwapss by tokenAddress — real user attribution via
      //      V4SwapRouter.Swapped(user, ...). Joined onto (1)+(2) by txHash so
      //      each row shows the actual wallet instead of the router address.
      // Promise.allSettled so one query's failure doesn't kill the whole load.
      // The Ponder schema may not have every table (e.g. v4RouterSwapss added
      // late) — a hard throw there previously blanked the entire recent-trades
      // panel. Now each query resolves independently and we use whatever came
      // back.
      const settled = await Promise.allSettled([
        fetchV4SwapsForToken(tokenAddress, 500),
        poolId ? fetchV4SwapsForPoolId(poolId, 500) : Promise.resolve(null),
        fetchV4RouterSwapsForToken(tokenAddress, 500),
      ]);
      if (cancelled) return;
      const rowsByToken = settled[0].status === 'fulfilled' ? settled[0].value : null;
      const rowsByPool = settled[1].status === 'fulfilled' ? settled[1].value : null;
      const routerRows = settled[2].status === 'fulfilled' ? settled[2].value : null;
      // Merge + dedupe (v4Swaps.id is unique — chainId-txHash-logIndex).
      const seenIds = new Set<string>();
      const rows: NonNullable<typeof rowsByToken> = [];
      for (const r of [...(rowsByToken ?? []), ...(rowsByPool ?? [])]) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);
        rows.push(r);
      }
      if (rows.length === 0) return;
      // Build txHash → user lookup for trader attribution.
      const userByTx: Record<string, Address> = {};
      for (const r of routerRows ?? []) userByTx[r.txHash.toLowerCase()] = r.user;
      // Rows arrive newest-first (order: blockTimestamp desc). For the chart we want
      // oldest-first so the line reads left-to-right chronologically.
      const enriched = rows
        .map((r) => {
          const sqrtPriceX96 = BigInt(r.sqrtPriceX96);
          if (sqrtPriceX96 === 0n) return null;
          const sqSq = sqrtPriceX96 * sqrtPriceX96;
          if (sqSq === 0n) return null;
          const weiPerToken = erc20PoolKey
            ? pairPerTokenFromSqrt(sqrtPriceX96, tokenIsCurrency0)
            : ((10n ** 18n) << 192n) / sqSq;
          if (weiPerToken === 0n) return null;
          const amt0 = BigInt(r.amount0);
          const amt1 = BigInt(r.amount1);
          const abs = (n: bigint) => (n < 0n ? -n : n);
          // v4 Swap.amount* is the caller's delta: positive = tokens flowing OUT of
          // the pool to the swapper, negative = flowing IN from the swapper. For our
          // ETH(currency0)/token(currency1) pools a BUY is +token (amount1 > 0),
          // a SELL is +ETH (amount0 > 0). abs the values so recent-trades reads clean.
          // ERC-20 pools: the token may sit on either side; a buy is +token out.
          const isBuy = erc20PoolKey ? (tokenIsCurrency0 ? amt0 > 0n : amt1 > 0n) : amt1 > 0n;
          // Prefer the real user address from V4SwapRouter.Swapped(user, ...).
          // Fall back to r.sender (router address) only if the router swap event
          // is missing for this tx — that would only happen for swaps submitted
          // directly to PoolManager, which the front-end never generates.
          const trader = (userByTx[r.txHash.toLowerCase()] ?? r.sender) as Address;
          return {
            timestamp: Number(r.blockTimestamp),
            priceWeiPerToken: weiPerToken,
            sqrtPriceX96,
            isBuy,
            eth: erc20PoolKey && tokenIsCurrency0 ? abs(amt1) : abs(amt0),
            tokens: erc20PoolKey && tokenIsCurrency0 ? abs(amt0) : abs(amt1),
            trader,
            blockNumber: BigInt(r.blockNumber),
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (cancelled) return;
      setV4TradePoints(enriched.map((e) => ({ timestamp: e.timestamp, priceWeiPerToken: e.priceWeiPerToken, isBuy: e.isBuy })));
      // Newest swaps first for the recent-trades list.
      setV4RecentTrades(
        enriched
          .slice()
          .reverse()
          .slice(0, 200)
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
    // 5s poll (was 30s) so post-graduation chart ticks visibly. Same cadence
    // as the curve trades poll -- makes the chart feel real-time. Ponder can
    // handle it at the trade-page scale (single-token filter, small window).
    const id = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [graduated, tokenAddress, v4RefetchTick, erc20PoolKey, tokenIsCurrency0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart consumes curve + v4 points, chronologically merged.
  const chartPoints = useMemo(() => {
    const merged = [...tradePoints, ...v4TradePoints].sort((a, b) => a.timestamp - b.timestamp);
    return merged;
  }, [tradePoints, v4TradePoints]);

  // Recent-trades ticker + list — merge curve trades (pre-grad) + v4 swaps (post-grad),
  // newest-first. Cap at 200 for the working pool; the header toggle picks
  // between "compact" (default 8) and "all" for the actual rendered slice.
  // Without the merge the list would freeze at the graduation point because
  // curve.Trade events stop firing once the pool takes over.
  const RECENT_TRADES_COMPACT_COUNT = 8;
  const [showAllTrades, setShowAllTrades] = useState(false);
  const mergedRecentTradesFull = useMemo(() => {
    return [...recentTrades, ...v4RecentTrades]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 200);
  }, [recentTrades, v4RecentTrades]);
  const mergedRecentTrades = useMemo(
    () => (showAllTrades ? mergedRecentTradesFull : mergedRecentTradesFull.slice(0, RECENT_TRADES_COMPACT_COUNT)),
    [mergedRecentTradesFull, showAllTrades],
  );

  // ---------- Trade panel ----------
  const [side, setSide] = useState<Side>('buy');
  const [inputAmount, setInputAmount] = useState('');
  const [slippagePct, setSlippagePct] = useState('2');

  const inputWei = useMemo(() => {
    try {
      if (side === 'buy') return isErc20Pair ? parseUnits(inputAmount || '0', pairDecimals) : parseEther(inputAmount || '0');
      return parseUnits(inputAmount || '0', 18);
    } catch { return 0n; }
  }, [inputAmount, side, isErc20Pair, pairDecimals]);

  // Anti-overshoot cap. If a buyer sends more ETH than the curve needs to
  // reach `gradTarget`, the curve accepts it all (no refund logic), the
  // graduator gets the excess, and the LP-mint math leaves the residual
  // credited to the launcher via claimableRefunds. Post-graduation the pool
  // spot is still correct (curve marginal), but LP size is smaller than
  // intended. Capping the *pay value* at exactly `gradTarget - ethReserve`
  // prevents that whole scenario: the last buyer's ETH lands exactly at
  // target, graduation triggers, LP absorbs the full amount, no residual.
  //
  // The `inputWei` state stays as-typed so the user sees what they entered;
  // `buyPayValue` is what actually goes on-chain. When they differ we
  // render a small notice below the input.
  // Anti-overshoot cap uses the trade-fee bps already read at csResults[6]
  // (feeBps is declared near line 300 for the header display). The bonding
  // curve deducts this fee off the top of every buy BEFORE adding to
  // ethReserve, so buying exactly gradTarget only puts (gradTarget * (1-fee))
  // into the reserve. To land the reserve on target, the buy is grossed-up:
  //   grossBuy = need * 10000 / (10000 - feeBps)
  const ethToGraduate = useMemo(() => {
    if (graduated || !gradTarget || ethReserve === undefined) return null;
    const need = gradTarget > (ethReserve as bigint) ? (gradTarget as bigint) - (ethReserve as bigint) : 0n;
    // Gross up for the 1% (or whatever) trade fee so the buy actually lands the
    // reserve on target instead of 1% short. Extra 1 wei rounds any integer-
    // division truncation up so we NEVER end up 1 wei below target.
    const bps = feeBps ?? 100;
    return need > 0n ? (need * 10_000n) / BigInt(10_000 - bps) + 1n : 0n;
  }, [graduated, gradTarget, ethReserve, feeBps]);

  const buyPayValue = useMemo(() => {
    if (side !== 'buy' || graduated || ethToGraduate === null) return inputWei;
    if (inputWei > ethToGraduate && ethToGraduate > 0n) return ethToGraduate;
    return inputWei;
  }, [inputWei, side, graduated, ethToGraduate]);

  const buyCapped = side === 'buy' && !graduated && buyPayValue < inputWei && buyPayValue > 0n;

  const buyQuote = useReadContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'quoteBuy',
    args: [buyPayValue],
    chainId: readChainId,
    query: { enabled: !!curveAddress && side === 'buy' && buyPayValue > 0n, refetchInterval: 6_000 },
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
  /// ERC-20-paired buys pull the pair token via transferFrom, so the curve
  /// needs an allowance first. Always false on ETH curves.
  const needsPairApproval = isErc20Pair && side === 'buy' && buyPayValue > 0n && pairCurveAllowance < buyPayValue;

  // ---------- DN404 per-tx NFT gas guard ----------
  // Robinhood caps a tx at 32M gas and each mirror NFT minted or burned costs
  // ~11.5k, so a buy/sell crossing more than MAX_NFTS_PER_TX unit boundaries
  // would revert on-chain. DN404 tokens only (pairedMirror present); plain
  // ERC-20 launches never reach this. skipNFT wallets mint/burn nothing.
  const dn404UnitWei = pairedMirror?.unitWei && pairedMirror.unitWei !== '0' ? BigInt(pairedMirror.unitWei) : 0n;
  const isDn404Token = dn404UnitWei > 0n;
  const skipNftQ = useReadContract({
    abi: dn404BaseAbi,
    address: tokenAddress,
    functionName: 'getSkipNFT',
    args: wallet ? [wallet] : undefined,
    chainId: readChainId,
    query: { enabled: isDn404Token && !!wallet, refetchInterval: 30_000 },
  });
  const walletSkipNft = skipNftQ.data === true;

  // ---------- DN404 per-transfer tax ----------
  // Only tax-template clones expose taxMode/taxBps; other tokens revert, which
  // allowFailure turns into "untaxed". Gated on DN404 so plain ERC-20 pages
  // don't spend an RPC call on it.
  const taxQ = useReadContracts({
    contracts: isDn404Token
      ? [
          { abi: dn404TaxAbi, address: tokenAddress, functionName: 'taxMode', chainId: readChainId } as const,
          { abi: dn404TaxAbi, address: tokenAddress, functionName: 'taxBps', chainId: readChainId } as const,
          { abi: dn404TaxAbi, address: tokenAddress, functionName: 'taxTarget', chainId: readChainId } as const,
          // V3 only; V1/V2 revert -> allowFailure -> undefined -> sells taxed.
          { abi: dn404TaxAbi, address: tokenAddress, functionName: 'POOL_MANAGER', chainId: readChainId } as const,
        ]
      : [],
    // chainId is set per contract above: wagmi ignores a top-level one here.
    query: { enabled: isDn404Token, refetchInterval: 60_000 },
  });
  const taxModeOnChain = Number((taxQ.data?.[0]?.result as number | undefined) ?? 0);
  const taxBpsOnChain = Number((taxQ.data?.[1]?.result as number | undefined) ?? 0);
  const taxTargetOnChain = taxQ.data?.[2]?.result as Address | undefined;
  const isTaxed = isDn404Token && taxModeOnChain !== 0 && taxBpsOnChain > 0;
  const taxBps = isTaxed ? taxBpsOnChain : 0;
  // Dn404TaxTemplateV3 exposes POOL_MANAGER(); its pool sells are untaxed.
  const isTaxV3 = typeof taxQ.data?.[3]?.result === 'string';
  const sellsTaxed = isTaxed && !isTaxV3;
  const taxTargetLabel = taxTargetOnChain && activeChain
    ? (DN404_TAX_DESTINATIONS[activeChain] ?? []).find((o) => o.address.toLowerCase() === taxTargetOnChain.toLowerCase())?.label
    : undefined;
  const taxSentence = isTaxed ? describeTax(taxModeOnChain, taxBpsOnChain, taxTargetLabel) : null;
  // Taxed ETH-paired DN404s can't use our V4SwapRouter after graduation: it
  // pulls/forwards the FULL amount, but the token taxes the hop into or out of
  // the PoolManager, so both directions revert. They trade through the
  // Universal Router panel instead (settle-first sells, normal-order buys).
  const taxedEthPoolKey = useMemo(
    () => (isTaxed && !isErc20Pair && hookAddr ? buildErc20PoolKey(tokenAddress, '0x0000000000000000000000000000000000000000', hookAddr) : null),
    [isTaxed, isErc20Pair, hookAddr, tokenAddress],
  );
  const curveNftGuard = useMemo(() => {
    if (!isDn404Token || graduated) return null;
    const bal = (walletBal as bigint | undefined) ?? 0n;
    if (side === 'buy') {
      const n = nftsMinted(bal, quoteOut, dn404UnitWei, walletSkipNft);
      if (n <= MAX_NFTS_PER_TX) return null;
      const maxTokens = maxTokensInForNfts(bal, dn404UnitWei, walletSkipNft) ?? 0n;
      return { side: 'buy' as const, nfts: n, maxTokens, aboutInput: scaleInputForOutput(buyPayValue, quoteOut, maxTokens) };
    }
    const n = nftsBurned(bal, inputWei, dn404UnitWei, walletSkipNft);
    if (n <= MAX_NFTS_PER_TX) return null;
    return { side: 'sell' as const, nfts: n, maxTokens: maxTokensOutForNfts(bal, dn404UnitWei, walletSkipNft) ?? 0n, aboutInput: 0n };
  }, [isDn404Token, graduated, walletBal, side, quoteOut, dn404UnitWei, walletSkipNft, buyPayValue, inputWei]);

  // Simulations MUST target the same chain the wallet will sign on — otherwise wagmi picks
  // whatever the wallet is currently on and the sim silently succeeds against the wrong
  // chain (or fails against a missing contract). Gate sims on wallet-being-on-active-chain
  // so the "sim failed" banner doesn't fire while the user is mid-chain-switch.
  const buySim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'buy',
    args: [slippage],
    value: buyPayValue,
    account: wallet,
    chainId: readChainId,
    query: { enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'buy' && buyPayValue > 0n && !graduated && !isErc20Pair },
  });
  // Dn404BondingCurve.buy(pairAmountIn, minTokensOut): non-payable, pulls the
  // pair token. Only for ERC-20-paired DN404 curves.
  const erc20BuySim = useSimulateContract({
    abi: dn404BondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'buy',
    args: [buyPayValue, slippage],
    account: wallet,
    chainId: readChainId,
    query: {
      enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'buy' && buyPayValue > 0n
        && !graduated && isErc20Pair && !needsPairApproval,
    },
  });
  const pairApproveSim = useSimulateContract({
    abi: erc20TokenAbi,
    address: pairCurrency ?? undefined,
    functionName: 'approve',
    args: curveAddress ? [curveAddress, 2n ** 256n - 1n] : undefined,
    account: wallet,
    chainId: readChainId,
    query: { enabled: !!curveAddress && !!wallet && walletOnActiveChain && needsPairApproval && !graduated },
  });
  /// Single "buy" sim the UI reads, whichever curve flavour this is.
  const activeBuySim = isErc20Pair ? erc20BuySim : buySim;
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

  // ---------- Whitelist proof + buy/claim ----------
  // Fetch proof for the connected wallet against the WL list pinned at launch. The
  // wlListCid lives in token metadata (persisted at launch time by the create page).
  // Trade page reads it via loadMetadata; if the local copy is missing (cross-device
  // viewer), the WL slice remains inaccessible from this frontend — the on-chain
  // WL still functions, but a proof needs to be provided out-of-band.
  const wlListCid = metadata?.wlListCid;
  const [wlProof, setWlProof] = useState<`0x${string}`[] | null>(null);
  const [wlProofErr, setWlProofErr] = useState<string | null>(null);
  // Whether the WL-exclusive window is still open (block.timestamp < fallbackTs).
  // Kept as state + effect (not useMemo) because Date.now() is impure — React 19's
  // react-hooks/purity rule forbids it in render. Interval ticks every 30s so the
  // banner + "buy (whitelist)" button flip cleanly the moment the window ends.
  const [wlPreFallback, setWlPreFallback] = useState(false);
  useEffect(() => {
    if (!wlEnabled || !wlFallbackTs) {
      setWlPreFallback(false);
      return;
    }
    const tick = () => setWlPreFallback(BigInt(Math.floor(Date.now() / 1000)) < wlFallbackTs);
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [wlEnabled, wlFallbackTs]);

  useEffect(() => {
    if (!wlEnabled || !wallet || !wlListCid || graduated) {
      setWlProof(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = `${COMPILE_SERVICE_URL}/wl/proof?listCid=${encodeURIComponent(wlListCid)}&addr=${wallet}`;
        const res = await fetch(url);
        if (!res.ok) {
          if (!cancelled) {
            setWlProof(null);
            setWlProofErr(res.status === 404 ? 'not on the whitelist' : `proof lookup failed: ${res.status}`);
          }
          return;
        }
        const data = (await res.json()) as { proof: `0x${string}`[] };
        if (!cancelled) {
          setWlProof(data.proof);
          setWlProofErr(null);
        }
      } catch (e) {
        if (!cancelled) setWlProofErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [wlEnabled, wallet, wlListCid, graduated]);

  const wlBuySim = useSimulateContract({
    abi: bondingCurveAbi,
    address: curveAddress ?? undefined,
    functionName: 'buyWithProof',
    args: wlProof ? [wlProof, slippage] : undefined,
    value: buyPayValue,
    account: wallet,
    chainId: readChainId,
    query: {
      enabled: !!curveAddress && !!wallet && walletOnActiveChain && side === 'buy'
        && buyPayValue > 0n && !graduated && wlEnabled && wlPreFallback && !!wlProof && !isErc20Pair,
    },
  });

  const { writeContract, isPending: writePending, data: txHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: txHash as Hex | undefined });

  // Fire a fresh indexer pull the moment a trade lands so the "recent trades" list + chart
  // include the user's just-completed tx (indexer refetchInterval is 15s otherwise). Depends
  // on the receipt hash so it only runs once per successful confirm.
  useEffect(() => {
    if (!receipt.data || !curveAddress) return;
    // Same fallback pattern: never gate on virtual reserves. If they're
    // there we compute the exact spot; if not (anon-race), fall through
    // to indexer's per-trade price so the chart tail always updates.
    const vE = virtualEthReserve;
    const vT = virtualTokenReserve;
    let cancelled = false;
    (async () => {
      const indexed = await fetchTradesForCurve(curveAddress, 500);
      if (cancelled || !indexed) return;
      setTradePoints(
        indexed.map((t) => ({
          timestamp: Number(t.blockTimestamp),
          priceWeiPerToken: (vE !== undefined && vT !== undefined)
            ? spotFromReserves(vE, vT, BigInt(t.ethReserveAfter), BigInt(t.tokenReserveAfter))
            : BigInt(t.priceWeiPerToken),
          isBuy: t.isBuy,
        })),
      );
      setRecentTrades(
        indexed.slice().reverse().slice(0, 200).map((t) => ({
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
    if (isErc20Pair) pairState.refetch();
    // Clear the input on tx success. Without this, wagmi's useSimulateContract re-runs
    // the same amount against post-tx state and often reverts with an opaque signature
    // (curve reserves shifted, slippage, WL slice exhausted, etc.) -- users saw a
    // "sim failed" banner appear seconds after their SUCCESSFUL buy, which read as
    // "my tx broke something" even though the tx went through fine. Clearing zeros
    // out inputWei -> sim disables -> banner disappears.
    setInputAmount('');
    return () => { cancelled = true; };
  }, [receipt.data?.transactionHash, curveAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (side === 'sell' && needsApproval && approveSim.data) {
      writeContract(approveSim.data.request);
    } else if (side === 'buy' && needsPairApproval && pairApproveSim.data) {
      writeContract(pairApproveSim.data.request);
    } else if (side === 'buy' && isErc20Pair && erc20BuySim.data) {
      writeContract(erc20BuySim.data.request);
    } else if (side === 'buy' && !isErc20Pair && buySim.data) {
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
    // Post-graduation tokenReserve is legitimately 0n (curve drained into the
    // v4 pool), which the old `!tokenReserve` guard mistook for "unloaded" and
    // returned 0 — reading as "no tokens sold" on the graduated stats card.
    // Use explicit undefined checks so a real 0 flows through as
    // `curveSupply - 0 = curveSupply` (all curve tokens sold).
    if (curveSupply === undefined || tokenReserve === undefined) return 0n;
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
    // ERC-20 pair: pair-token atomic units per whole token, either ordering.
    if (erc20PoolKey) return pairPerTokenFromSqrt(src, tokenIsCurrency0);
    return ((10n ** 18n) << 192n) / (src * src);
  }, [poolSqrtPriceX96, v4LatestSqrt, erc20PoolKey, tokenIsCurrency0]);

  /// Single source of truth for the sidebar's price row. Post-graduation the curve's
  /// priceWeiPerToken() reads virtual reserves (real ones were drained to the pool) so
  /// it silently returns a wrong number — use the v4 pool spot instead. Pre-graduation
  /// the curve's read IS the truth.
  // Fallback derived from the latest indexed trade point. When wagmi's curve
  // read is racing (anon users pre-hydration, mobile without wallet), the
  // trade points array already has valid prices from the indexer — use the
  // most-recent one as spot so header + chart tell the same story. Same
  // pattern for post-grad using v4TradePoints.
  const latestIndexedSpot = useMemo<bigint | undefined>(() => {
    if (graduated) {
      const last = v4TradePoints[v4TradePoints.length - 1];
      return last?.priceWeiPerToken;
    }
    const last = tradePoints[tradePoints.length - 1];
    return last?.priceWeiPerToken;
  }, [graduated, tradePoints, v4TradePoints]);

  const effectiveSpotPrice = useMemo<bigint>(() => {
    if (graduated) {
      return poolSpotPriceEthPerToken > 0n
        ? poolSpotPriceEthPerToken
        : (latestIndexedSpot ?? 0n);
    }
    return (spotPrice as bigint | undefined) ?? latestIndexedSpot ?? 0n;
  }, [graduated, poolSpotPriceEthPerToken, spotPrice, latestIndexedSpot]);

  const unit = usePriceUnit();
  const ethUsd = useEthUsd();
  // ERC-20-paired curves price in the pair token, not ETH. There is no
  // URU/USD feed here, so those render in pair units only (never a USD number
  // computed from the ETH rate, which would be wrong).
  const showPrice = (v: bigint) => {
    if (!isErc20Pair) return formatPrice(v, unit, ethUsd);
    const n = Number(formatUnits(v, pairDecimals));
    return `${n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n.toPrecision(4)} ${pairSym}`;
  };
  const showMcap = (v: bigint) => {
    if (!isErc20Pair) return formatMcap(v, unit, ethUsd);
    return `${Number(formatUnits(v, pairDecimals)).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${pairSym}`;
  };

  // Fetch total supply from the indexer as a fallback when wagmi's read
  // hasn't returned (anon users pre-hydration). Every launched token uses
  // the CurveFactory default supply which is available via IndexerCurve.
  const [indexedTotalSupply, setIndexedTotalSupply] = useState<bigint | undefined>();
  useEffect(() => {
    if (!tokenAddress) return;
    let cancelled = false;
    (async () => {
      const c = await fetchCurveByToken(tokenAddress);
      if (cancelled) return;
      if (c?.curveSupply) setIndexedTotalSupply(BigInt(c.curveSupply));
    })();
    return () => { cancelled = true; };
  }, [tokenAddress]);

  const marketCap = useMemo<bigint | null>(() => {
    // Prefer wagmi's read (exact totalSupply from token contract); fall back
    // to indexer's curveSupply (same value in practice — every launch uses
    // the curve's supply as the mint amount). Guarantees MC renders for
    // anon users where wagmi reads are racing.
    const supply = (tokenTotalSupply as bigint | undefined) ?? indexedTotalSupply;
    if (!supply) return null;
    const spot = effectiveSpotPrice;
    if (spot === 0n) return null;
    return (spot * supply) / 10n ** 18n;
  }, [effectiveSpotPrice, tokenTotalSupply, indexedTotalSupply]);

  // ============================================================================

  // First-paint skeleton: SSR + the very first client render show the same "looking up"
  // panel so wagmi hydration (which populates chainId + query state asynchronously) can't
  // cause the mascot to swap moods/sizes mid-hydrate. Once `mounted` flips, we fall through
  // to whichever real branch matches state below.

  return {
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
  };
}
