import { createConfig } from '@ponder/core';
import { http, parseAbi, parseAbiItem } from 'viem';

import {
  CHAIN_CATALOG,
  enabledChains,
  readAddress,
  readRpcUrl,
  readStartBlock,
  type AddressKey,
  type ChainSlug,
} from './chains';

/// Multi-chain Ponder config. One process subscribes to every chain in
/// `enabledChains()` at once — no more one-service-per-chain on Railway.
///
/// Which chains actually get indexed is decided by two things:
///   1. INDEXER_CHAINS=base-sepolia,base   (comma-separated slug list; opt-in)
///      — or legacy INDEXER_CHAIN=base-sepolia (single slug, still honored)
///   2. Env vars per chain: `<PREFIX>_RPC_URL` + at least one
///      `<PREFIX>_<CONTRACT>_ADDRESS` (see indexer/chains.ts ADDRESS_KEYS).
/// A chain listed in INDEXER_CHAINS but missing its RPC or address vars is
/// silently skipped — enabling a new chain in prod is a Railway env-var change,
/// not a redeploy.

// ---------------------------------------------------------------- ABIs
// Same shapes wagmi uses on the client side. Kept human-readable via parseAbi.

export const nameRegistryAbi = parseAbi([
  'event Reserved(bytes32 indexed nameHash, bytes32 indexed tickerHash, address indexed token, address launchedBy, string name, string ticker, uint256 timestamp, uint256 chainId)',
]);

export const routerAbi = parseAbi([
  'event Launched(address indexed token, address indexed launchedBy, uint8 indexed base, bytes32 nameHash, bytes32 tickerHash, uint256 feePaid, bool installedHook, bool installedGovernance)',
  'event CurveInstalled(address indexed token, address indexed curve)',
  /// RouterV2 additions (Robinhood-only). Paired 1:1 with Launched on the same token.
  'event LaunchedInURU(address indexed token, address indexed launchedBy, uint256 uruPaid)',
  'event LaunchedWithWhitelist(address indexed token, address indexed launchedBy, bytes32 whitelistRoot, uint256 reservedTokens, uint256 maxWlPerAddress, uint64 fallbackTs, address sourceTokenAddress, uint32 sourceChainId)',
]);

export const factoryAbi = parseAbi([
  'event Deployed(address indexed token, address indexed launcher, bytes32 indexed configHash, address impl, string name, string ticker)',
]);

export const curveFactoryAbi = parseAbi([
  'event CurveCreated(address indexed token, address indexed curve, address indexed launcher)',
]);

export const bondingCurveAbi = parseAbi([
  'event CurveInitialized(address indexed token, address indexed feeReceiver, uint256 curveSupply, uint256 virtualTokenReserve, uint256 virtualEthReserve, uint256 graduationTargetEth, uint16 tradeFeeBps)',
  'event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)',
  'event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)',
  /// Whitelist additions (WL-aware CurveFactoryV2 launches only). Non-WL curves never
  /// emit these, so unindexed pre-WL curves are unaffected.
  'event WhitelistConfigured(bytes32 root, uint256 reservedTokens, uint256 maxWlPerAddress, uint64 fallbackTs, address sourceTokenAddress, uint32 sourceChainId, uint32 declaredHolderCount)',
  'event WlBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 wlPurchasedAfter)',
  'event WlClaimed(address indexed buyer, uint256 amount)',
]);

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/// ERC-721 has the SAME event signature/topic0 as ERC-20 (Transfer(address,address,uint256))
/// but with `tokenId` in the third slot INDEXED instead of the ERC-20 `value` un-indexed.
/// Ponder needs the correct ABI shape to decode the event args; treating gemu NFT as an
/// ERC-20 would give the wrong decode.
export const erc721Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export const v4SwapRouterAbi = parseAbi([
  'event Swapped(address indexed user, address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut)',
]);

export const poolManagerAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

/// Flywheel ABIs — MultiHookHost / FeeSplitter / UruBuybackVault / UruDepositSink.
/// Only the value events are indexed (admin config like KeeperSet, SwapTargetSet,
/// CreatorSet, ConfigSet, InitializerSet are intentionally excluded to keep the
/// per-log DB writes lean). PoolConfigSet is kept because it maps 1:1 to per-pool
/// UI state (anti-sniper + burn bps rendered on the trade page).
/// GH-13: HookPolicySet is a struct-typed event — the second arg is the packed
/// `PoolPolicy` tuple. parseAbi accepts a struct declaration in the same array
/// and resolves the reference (order-independent), so the ABI stays
/// human-readable and viem decodes `event.args.policy` as an object with
/// named fields.
export const multiHookHostAbi = parseAbi([
  'event FeeAccrued(address indexed currency, uint256 platformShare, uint256 creatorShare)',
  'event FeeClaimed(address indexed currency, address indexed to, uint256 amount)',
  'event BuybackBurned(address indexed currency, uint256 amount)',
  'event PoolConfigSet(bytes32 indexed poolId, uint32 antiSniperBlocks, uint16 buybackBurnBps)',
  'struct PoolPolicy { uint16 antiSniperBlocks; uint16 buybackBurnBps; uint16 platformFeeBps; uint16 creatorFeeBps; address creatorRecipient; uint64 launchBlock; bool immutableAfterLaunch; }',
  'event HookPolicySet(bytes32 indexed poolId, PoolPolicy policy)',
]);

export const feeSplitterAbi = parseAbi([
  'event FeeReceived(address indexed launcher, uint8 indexed base, uint256 amount)',
  'event Distributed(uint256 total, uint256 toBuyback, uint256 toNft, uint256 toTreasury)',
  // V4 addition: emitted when the treasury-side transfer fails and the slice
  // is stuck in-contract awaiting sweep(). Distributed's toTreasury reports
  // intent; this event reports actual stuck balance so reconciliation stays
  // sum-of-slices == amount.
  'event TreasuryDistributionFailed(address indexed treasury, uint256 stuck)',
  'event Swept(address indexed to, uint256 amount)',
]);

export const uruBuybackVaultAbi = parseAbi([
  'event BuybackExecuted(uint256 ethIn, uint256 uruOut)',
  // V4 additions: owner-initiated escape hatches. Analytics that computes
  // vault liquidity from sum(ethIn) - sum(uruOut) drifts without these.
  'event UruSwept(address indexed to, uint256 amount)',
  'event EthSwept(address indexed to, uint256 amount)',
]);

export const uruDepositSinkAbi = parseAbi([
  'event Deposited(address indexed from, uint256 amount)',
  'event ConversionExecuted(uint256 uruIn, uint256 ethOut)',
]);

// NFT stack ABIs.
//   NftLaunchFactory.CollectionLaunched   — one row per launched collection.
//     `mintModule` (the clone) is the address we use as the dynamic-factory
//     `parameter` so Ponder auto-subscribes to every new mint-module clone
//     for Minted events without a per-collection static config.
//   NftMintModule.Minted                  — one row per mint tx.
//     `paidInUru` distinguishes ETH vs URU payment so the flywheel dashboard
//     can bucket revenue correctly (ETH mints hit FeeSplitter directly;
//     URU mints hit UruDepositSink which the keeper converts downstream).
export const nftLaunchFactoryAbi = parseAbi([
  'event CollectionLaunched(address indexed token, address indexed launcher, address mintModule, address whitelistModule, bytes32 configHash, uint256 uruPaid, string name, string ticker)',
]);

export const nftMintModuleAbi = parseAbi([
  'event Minted(address indexed minter, uint256 startTokenId, uint256 quantity, uint256 grossPaidWei, uint256 discountBps, bool wlUsed, bool paidInUru)',
]);

// ---------------------------------------------------------------- network + contract build

const ENABLED = enabledChains();
const has = (slug: ChainSlug) => ENABLED.includes(slug);
const addr = (slug: ChainSlug, key: AddressKey) => readAddress(slug, key);

if (ENABLED.length === 0) {
  console.warn(
    '[indexer] no chains enabled — set INDEXER_CHAINS=<slug1>,<slug2> + per-chain ' +
      '<PREFIX>_RPC_URL and <PREFIX>_<CONTRACT>_ADDRESS env vars. Ponder will still ' +
      'boot but won\'t subscribe to anything until env is populated.',
  );
}

/// Build a per-chain network-override object for a given contract-address key.
/// Ponder's contract `network` field accepts a string (single chain) OR a
/// `{ [chainSlug]: { address, startBlock } }` map. Chains without an address
/// for this key are omitted so Ponder doesn't subscribe to `undefined`.
///
/// The returned object is typed as `Partial<Record<ChainSlug, ...>>` so Ponder's
/// generic inference sees the same key literals it sees in the `networks` map.
function netFor(
  key: AddressKey,
): Partial<Record<ChainSlug, { address: `0x${string}`; startBlock: number }>> {
  const out: Partial<Record<ChainSlug, { address: `0x${string}`; startBlock: number }>> = {};
  for (const slug of ENABLED) {
    const a = readAddress(slug, key);
    if (!a) continue;
    out[slug] = { address: a, startBlock: readStartBlock(slug) };
  }
  return out;
}

/// BondingCurve subscription: dynamic factory pattern. Each chain's CurveFactory
/// emits `CurveCreated`; Ponder adds every new curve address as a Trade + Graduated
/// + CurveInitialized source automatically. Chains without a CurveFactory drop out.
function bondingCurveNet() {
  const event = parseAbiItem(
    'event CurveCreated(address indexed token, address indexed curve, address indexed launcher)',
  );
  const out: Partial<
    Record<
      ChainSlug,
      { factory: { address: `0x${string}`; event: typeof event; parameter: 'curve' }; startBlock: number }
    >
  > = {};
  for (const slug of ENABLED) {
    const cf = readAddress(slug, 'CURVE_FACTORY');
    if (!cf) continue;
    out[slug] = {
      factory: { address: cf, event, parameter: 'curve' },
      startBlock: readStartBlock(slug),
    };
  }
  return out;
}

/// PoolManager per-network config: filter Swap events to only those where sender is
/// our V4SwapRouter. Uniswap v4's PoolManager fires Swap for every pool on the chain;
/// without a filter, indexing on high-activity chains (Ethereum mainnet, Base) pulls
/// tens of thousands of unrelated swaps per block into the getLogs response and
/// blows past Alchemy's 10MB response body cap. Filtering to sender=<our router>
/// narrows it to only launchpad swaps + is the same set of trades users care about
/// (buy/sell via the trade page always goes through our router). Buybacks that go
/// via Universal Router don't get captured here, but that's a separate flow with
/// its own tracking. Requires V4SwapRouter address to be set per-chain.
function poolManagerNet() {
  const out: Partial<
    Record<
      ChainSlug,
      { address: `0x${string}`; startBlock: number; filter: { event: 'Swap'; args: { sender: `0x${string}` } } }
    >
  > = {};
  for (const slug of ENABLED) {
    const pm = readAddress(slug, 'POOL_MANAGER');
    const router = readAddress(slug, 'V4_SWAP_ROUTER');
    if (!pm || !router) continue;
    out[slug] = {
      address: pm,
      startBlock: readStartBlock(slug),
      filter: { event: 'Swap', args: { sender: router } },
    };
  }
  return out;
}

/// NftMintModule subscription: dynamic factory pattern rooted at NftLaunchFactory.
///
/// Every collection launched through NftLaunchFactory emits a `CollectionLaunched`
/// event whose `mintModule` param is the address of the freshly-cloned mint
/// module contract. Ponder registers each new mint module as a `NftMintModule`
/// source automatically — no per-collection static config, matches the pattern
/// used for BondingCurve above.
///
/// Chains without NFT_LAUNCH_FACTORY set → dropped silently, so pre-deploy
/// envs stay valid. Once the factory ships on RH, setting the env var + a
/// redeploy is the only change required.
function nftMintModuleNet() {
  const event = parseAbiItem(
    'event CollectionLaunched(address indexed token, address indexed launcher, address mintModule, address whitelistModule, bytes32 configHash, uint256 uruPaid, string name, string ticker)',
  );
  const out: Partial<
    Record<
      ChainSlug,
      { factory: { address: `0x${string}`; event: typeof event; parameter: 'mintModule' }; startBlock: number }
    >
  > = {};
  for (const slug of ENABLED) {
    const f = readAddress(slug, 'NFT_LAUNCH_FACTORY');
    if (!f) continue;
    out[slug] = {
      factory: { address: f, event, parameter: 'mintModule' },
      startBlock: readStartBlock(slug),
    };
  }
  return out;
}

/// Token (ERC-20) subscription: dynamic factory pattern rooted at ERC20Factory. Every
/// token our factory launches gets its Transfer events indexed automatically, no per-
/// token config change. Powers the `holders` table (profile page holdings list) and
/// the `transfers` table (per-token transfer history).
function tokenNet() {
  const event = parseAbiItem(
    'event Deployed(address indexed token, address indexed launcher, bytes32 indexed configHash, address impl, string name, string ticker)',
  );
  const out: Partial<
    Record<
      ChainSlug,
      { factory: { address: `0x${string}`; event: typeof event; parameter: 'token' }; startBlock: number }
    >
  > = {};
  for (const slug of ENABLED) {
    const f = readAddress(slug, 'ERC20_FACTORY');
    if (!f) continue;
    out[slug] = {
      factory: { address: f, event, parameter: 'token' },
      startBlock: readStartBlock(slug),
    };
  }
  return out;
}

// ---------------------------------------------------------------- networks

/// Batched HTTP transport with keepalive. Bundles multiple JSON-RPC calls into one
/// HTTP request -- Ponder's parallel getLogs during historical sync easily fills
/// batches. `wait: 16ms` gives Ponder's scheduler a moment to accumulate calls into
/// the same batch. `keepalive` reuses TCP connections instead of tearing them down.
///
/// batchSize kept at 50 (down from an earlier 1000) because Alchemy's response body
/// size cap kicks in with big batches -- getLogs replies can each carry hundreds of
/// log entries, so a batch of 1000 getLogs blows past the ~10MB Alchemy response
/// limit and viem throws ResponseBodyTooLargeError. 50 stays well under the limit
/// while still giving 50x fewer HTTP round-trips than raw http().
function batchedTransport(rpcUrl: string) {
  // Batch aggressively — the RPC round-trip is by far the largest cost during
  // historical sync. On a good RPC we can pack 100+ calls into one HTTP request
  // and each batch overlaps ~10-20ms of network. Larger `wait` fills batches
  // more completely at the cost of tail latency, which doesn't matter for
  // historical sync (we're seconds behind head anyway) and is barely visible
  // at live-tail (16-20ms is well under human perception).
  //
  // retryCount 5 (was 3) — public RPCs 429 during bursts; a couple more
  // retries with the transport's built-in exponential backoff smooths that
  // out without blocking forward progress.
  return http(rpcUrl, {
    batch: { batchSize: 100, wait: 20 },
    fetchOptions: { keepalive: true },
    retryCount: 5,
    timeout: 15_000,
  });
}

/// Build the Ponder `networks` map. Every chain in ENABLED gets a network entry
/// with its own RPC + chainId + polling interval. Static conditional spreads
/// preserve literal key types so Ponder's generic inference works.
const networks = {
  ...(has('sepolia') && {
    sepolia: {
      chainId: CHAIN_CATALOG.sepolia.id,
      transport: batchedTransport(readRpcUrl('sepolia')),
      pollingInterval: 120_000,
    },
  }),
  ...(has('mainnet') && {
    mainnet: {
      chainId: CHAIN_CATALOG.mainnet.id,
      transport: batchedTransport(readRpcUrl('mainnet')),
      pollingInterval: 120_000,
    },
  }),
  ...(has('base') && {
    base: {
      chainId: CHAIN_CATALOG.base.id,
      transport: batchedTransport(readRpcUrl('base')),
      pollingInterval: 120_000,
    },
  }),
  ...(has('base-sepolia') && {
    'base-sepolia': {
      chainId: CHAIN_CATALOG['base-sepolia'].id,
      transport: batchedTransport(readRpcUrl('base-sepolia')),
      pollingInterval: 120_000,
    },
  }),
  ...(has('robinhood') && {
    robinhood: {
      chainId: CHAIN_CATALOG.robinhood.id,
      transport: batchedTransport(readRpcUrl('robinhood')),
      pollingInterval: 120_000,
    },
  }),
  ...(has('robinhood-testnet') && {
    'robinhood-testnet': {
      chainId: CHAIN_CATALOG['robinhood-testnet'].id,
      transport: batchedTransport(readRpcUrl('robinhood-testnet')),
      pollingInterval: 120_000,
    },
  }),
};

// ---------------------------------------------------------------- contracts
//
// Every contract entry follows the same shape: `{ abi, network: netFor(KEY) }`.
// If a chain has no address for that key, netFor omits it — Ponder simply
// doesn't subscribe on that chain.
//
// Contract keys are static literal strings so `ponder.on('Router:Launched', ...)`
// in the handler file keeps its typed event args.

/// Ecosystem token subscriptions — fixed addresses, may live on Base and/or
/// Robinhood (RH is canonical post-2026-07-25 migration; Base kept for legacy
/// reads). Used by the flywheel snapshot service to compute per-holder gemu
/// NFT allocations + surface URU balances on profile badges.
///
/// Reads addresses from:
///   - Base (legacy):  URU_TOKEN_ADDRESS, GEMU_NFT_ADDRESS (flat env vars)
///   - Robinhood (canonical):  ROBINHOOD_URU_ADDRESS, ROBINHOOD_GEMU_NFT_ADDRESS
/// Both networks subscribed if their address + chain enablement present. Missing
/// address on a chain → that chain quietly dropped from the network map.
/// Empty final map disables the subscription without dropping the contract entry
/// from the object literal — keeps TS-inferred event names stable so handlers
/// below always typecheck.
///
/// GOTCHA (2026-07-30 audit): pre-migration this only registered `base:`; when
/// gemu NFT moved to RH the subscription silently stopped indexing → flywheel
/// publishEpoch throwed 'no holders in indexer' every 24h. Do NOT re-narrow.
function ecosystemTokenNet(
  baseKey: 'URU_TOKEN_ADDRESS' | 'GEMU_NFT_ADDRESS',
  rhKey: 'ROBINHOOD_URU_ADDRESS' | 'ROBINHOOD_GEMU_NFT_ADDRESS',
): Partial<Record<ChainSlug, { address: `0x${string}`; startBlock: number }>> {
  const map: Partial<Record<ChainSlug, { address: `0x${string}`; startBlock: number }>> = {};
  const baseAddr = process.env[baseKey] as `0x${string}` | undefined;
  if (baseAddr && ENABLED.includes('base')) {
    map.base = { address: baseAddr, startBlock: readStartBlock('base') };
  }
  const rhAddr = process.env[rhKey] as `0x${string}` | undefined;
  if (rhAddr && ENABLED.includes('robinhood')) {
    map.robinhood = { address: rhAddr, startBlock: readStartBlock('robinhood') };
  }
  return map;
}

const contracts = {
  NameRegistry: { abi: nameRegistryAbi, network: netFor('NAME_REGISTRY') },
  // includeTransactionReceipts toggle is a real cache-key change in Ponder 0.7 -- unlike
  // the `filter: { event }` trick which is silently no-op (the cache key uses handler-
  // derived topic0, not filter config, so filters that match already-registered events
  // don't change the fragment id). Setting this to true actually invalidates the cached
  // sync pointer for Router across all networks and forces a fresh scan from each
  // chain's startBlock. Base mainnet's Router was stuck at 0 rows despite verified env
  // vars; base-sepolia's may also benefit. The receipts are indexed but no handler reads
  // them -- tiny extra DB write per Launched event, negligible.
  Router: {
    abi: routerAbi,
    network: netFor('ROUTER'),
    // Widened from just 'Launched' to include the RouterV2 event pair for URU-paid
    // launches + WL-configured launches. Non-RouterV2 chains simply never emit these,
    // so the extra topic0 subscriptions are cheap no-ops.
    filter: { event: ['Launched', 'LaunchedInURU', 'LaunchedWithWhitelist'] as const },
    includeTransactionReceipts: true,
  },
  ERC20Factory: { abi: factoryAbi, network: netFor('ERC20_FACTORY') },
  ERC721AFactory: { abi: factoryAbi, network: netFor('ERC721A_FACTORY') },
  ERC1155Factory: { abi: factoryAbi, network: netFor('ERC1155_FACTORY') },
  CurveFactory: { abi: curveFactoryAbi, network: netFor('CURVE_FACTORY') },
  PoolManager: { abi: poolManagerAbi, network: poolManagerNet() },
  // Explicit event filter — narrows the subscription to just the `Swapped` event we
  // handle. Functionally identical to no-filter since Swapped is the only event we
  // listen for from this contract, BUT adding the filter changes Ponder's per-source
  // config hash. This is intentional: base-sepolia's V4SwapRouter subscription got
  // stuck at block 44160111 with a stale cached sync pointer after multiple redeploys
  // during the multi-chain refactor. Changing the hash forces Ponder to re-scan from
  // startBlock as if it were a fresh subscription -- indexed rows past 44160111 land
  // as they should. Existing rows are preserved via onConflictDoNothing() in the
  // handler. Safe to leave the filter in place indefinitely; only removing it would
  // trigger another re-sync.
  V4SwapRouter: {
    abi: v4SwapRouterAbi,
    network: netFor('V4_SWAP_ROUTER'),
    filter: { event: 'Swapped' as const },
    // Same real cache-bust as Router -- the filter above doesn't actually invalidate
    // Ponder's cached sync pointer (topic0 is derived from registered handlers, not
    // filter config). includeTransactionReceipts IS part of the cache key though, so
    // toggling this forces a fresh sync. Base-sepolia's V4SwapRouter was stuck at
    // block 44160111 -- this should finally clear it.
    includeTransactionReceipts: true,
  },
  BondingCurve: { abi: bondingCurveAbi, network: bondingCurveNet() },
  Token: { abi: erc20Abi, network: tokenNet() },
  UruToken: { abi: erc20Abi, network: ecosystemTokenNet('URU_TOKEN_ADDRESS', 'ROBINHOOD_URU_ADDRESS') },
  GemuNft: { abi: erc721Abi, network: ecosystemTokenNet('GEMU_NFT_ADDRESS', 'ROBINHOOD_GEMU_NFT_ADDRESS') },
  MultiHookHost: { abi: multiHookHostAbi, network: netFor('MULTI_HOOK_HOST') },
  FeeSplitter: { abi: feeSplitterAbi, network: netFor('FEE_SPLITTER') },
  UruBuybackVault: { abi: uruBuybackVaultAbi, network: netFor('URU_BUYBACK_VAULT') },
  UruDepositSink: { abi: uruDepositSinkAbi, network: netFor('URU_DEPOSIT_SINK') },
  NftLaunchFactory: { abi: nftLaunchFactoryAbi, network: netFor('NFT_LAUNCH_FACTORY') },
  NftMintModule: { abi: nftMintModuleAbi, network: nftMintModuleNet() },
};

// ---------------------------------------------------------------- database

/// Postgres in prod (Railway attaches DATABASE_URL from its Postgres plugin), pglite
/// for local dev. Making the switch explicit keeps behaviour obvious at a glance.
const pgUrl = process.env.DATABASE_PRIVATE_URL ?? process.env.DATABASE_URL;

export default createConfig({
  database: pgUrl
    ? {
        kind: 'postgres',
        connectionString: pgUrl,
        // Cap the pg pool at 10 connections per Ponder instance. Default is 30. With
        // 4 per-chain services running against the same shared Railway Postgres,
        // 4 × 30 = 120 connections exceeds Railway's default max_connections (100)
        // and causes "sorry, too many clients already" crashes. 4 × 10 = 40 stays
        // comfortably under the limit.
        poolConfig: { max: 10 },
      }
    : { kind: 'pglite' },
  networks,
  contracts,
});
