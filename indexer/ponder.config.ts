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

/// Build the Ponder `networks` map. Every chain in ENABLED gets a network entry
/// with its own RPC + chainId + polling interval. Static conditional spreads
/// preserve literal key types so Ponder's generic inference works.
const networks = {
  ...(has('sepolia') && {
    sepolia: {
      chainId: CHAIN_CATALOG.sepolia.id,
      transport: http(readRpcUrl('sepolia')),
      pollingInterval: 1_000,
    },
  }),
  ...(has('mainnet') && {
    mainnet: {
      chainId: CHAIN_CATALOG.mainnet.id,
      transport: http(readRpcUrl('mainnet')),
      pollingInterval: 1_000,
    },
  }),
  ...(has('base') && {
    base: {
      chainId: CHAIN_CATALOG.base.id,
      transport: http(readRpcUrl('base')),
      pollingInterval: 1_000,
    },
  }),
  ...(has('base-sepolia') && {
    'base-sepolia': {
      chainId: CHAIN_CATALOG['base-sepolia'].id,
      transport: http(readRpcUrl('base-sepolia')),
      pollingInterval: 1_000,
    },
  }),
  ...(has('robinhood') && {
    robinhood: {
      chainId: CHAIN_CATALOG.robinhood.id,
      transport: http(readRpcUrl('robinhood')),
      pollingInterval: 1_000,
    },
  }),
  ...(has('robinhood-testnet') && {
    'robinhood-testnet': {
      chainId: CHAIN_CATALOG['robinhood-testnet'].id,
      transport: http(readRpcUrl('robinhood-testnet')),
      pollingInterval: 1_000,
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

/// Ecosystem token subscriptions — fixed addresses, Base only (URU + gemu NFT live on
/// Base). Used by the flywheel snapshot service to compute per-holder gemu NFT
/// allocations + surface URU balances on profile "URU holder" badges. Reads addresses
/// from the flat `URU_TOKEN_ADDRESS` / `GEMU_NFT_ADDRESS` env vars (not the per-chain
/// prefix pattern) since both are Base-native and were pre-existing before the
/// launchpad. Empty-object network map disables the subscription without dropping the
/// contract entry from the object literal — keeps TS-inferred event names stable so
/// handlers below always typecheck.
function ecosystemTokenNet(envKey: 'URU_TOKEN_ADDRESS' | 'GEMU_NFT_ADDRESS') {
  const baseAddr = process.env[envKey] as `0x${string}` | undefined;
  if (!baseAddr || !ENABLED.includes('base')) return {};
  return { base: { address: baseAddr, startBlock: readStartBlock('base') } };
}

const contracts = {
  NameRegistry: { abi: nameRegistryAbi, network: netFor('NAME_REGISTRY') },
  Router: { abi: routerAbi, network: netFor('ROUTER') },
  ERC20Factory: { abi: factoryAbi, network: netFor('ERC20_FACTORY') },
  ERC721AFactory: { abi: factoryAbi, network: netFor('ERC721A_FACTORY') },
  ERC1155Factory: { abi: factoryAbi, network: netFor('ERC1155_FACTORY') },
  CurveFactory: { abi: curveFactoryAbi, network: netFor('CURVE_FACTORY') },
  PoolManager: { abi: poolManagerAbi, network: netFor('POOL_MANAGER') },
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
  },
  BondingCurve: { abi: bondingCurveAbi, network: bondingCurveNet() },
  Token: { abi: erc20Abi, network: tokenNet() },
  UruToken: { abi: erc20Abi, network: ecosystemTokenNet('URU_TOKEN_ADDRESS') },
  GemuNft: { abi: erc721Abi, network: ecosystemTokenNet('GEMU_NFT_ADDRESS') },
};

// ---------------------------------------------------------------- database

/// Postgres in prod (Railway attaches DATABASE_URL from its Postgres plugin), pglite
/// for local dev. Making the switch explicit keeps behaviour obvious at a glance.
const pgUrl = process.env.DATABASE_PRIVATE_URL ?? process.env.DATABASE_URL;

export default createConfig({
  database: pgUrl
    ? { kind: 'postgres', connectionString: pgUrl }
    : { kind: 'pglite' },
  networks,
  contracts,
});
