import { createConfig } from '@ponder/core';
import { http, parseAbi, parseAbiItem } from 'viem';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Ponder's built-in dotenv only reads ./.env / ./.env.local relative to the indexer/
// workspace. The launchpad keeps its single source of truth at the repo-root .env — pull
// that in with a tiny parser (Vite's module graph can't reach dotenv as a transitive dep,
// and we don't want to add it as an explicit dep). Only assigns keys not already in
// process.env so shell overrides still win.
const rootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Which chain this indexer instance runs against. In prod, spin up one indexer per chain
// with `INDEXER_CHAIN=<slug>` set. Default is sepolia for local dev.
const CHAIN_SLUG = (process.env.INDEXER_CHAIN ?? 'sepolia') as
  | 'sepolia'
  | 'mainnet'
  | 'base'
  | 'base-sepolia'
  | 'robinhood'
  | 'robinhood-testnet';

// Per-chain RPC + start-block. Start blocks are the deploy block of the FIRST Phase 1
// contract (Router usually) — set via env when running against a new chain.
const CHAIN_CONFIG = {
  sepolia: {
    id: 11_155_111,
    rpc: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    startBlock: Number(process.env.PONDER_START_BLOCK_SEPOLIA ?? 6_000_000),
  },
  mainnet: {
    id: 1,
    rpc: process.env.MAINNET_RPC_URL ?? '',
    startBlock: Number(process.env.PONDER_START_BLOCK_MAINNET ?? 0),
  },
  base: {
    id: 8453,
    rpc: process.env.BASE_RPC_URL ?? '',
    startBlock: Number(process.env.PONDER_START_BLOCK_BASE ?? 0),
  },
  'base-sepolia': {
    id: 84532,
    rpc: process.env.BASE_SEPOLIA_RPC_URL ?? '',
    startBlock: Number(process.env.PONDER_START_BLOCK_BASE_SEPOLIA ?? 0),
  },
  robinhood: {
    id: 4663,
    rpc: process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
    startBlock: Number(process.env.PONDER_START_BLOCK_ROBINHOOD ?? 0),
  },
  'robinhood-testnet': {
    id: 46630,
    rpc: process.env.ROBINHOOD_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
    startBlock: Number(process.env.PONDER_START_BLOCK_ROBINHOOD_TESTNET ?? 0),
  },
} as const;

const chain = CHAIN_CONFIG[CHAIN_SLUG];
if (!chain) throw new Error(`Unknown INDEXER_CHAIN: ${CHAIN_SLUG}`);
if (!chain.rpc) {
  throw new Error(
    `No RPC URL for ${CHAIN_SLUG}. Set the matching *_RPC_URL env var (see .env.example).`,
  );
}

// Contract addresses — populate the matching NEXT_PUBLIC_*_ADDRESS env vars for the chain
// this indexer is bound to. Undefined addresses skip indexing until set.
const CONTRACTS = {
  NameRegistry: process.env.NEXT_PUBLIC_NAME_REGISTRY_ADDRESS as `0x${string}` | undefined,
  Router: process.env.NEXT_PUBLIC_ROUTER_ADDRESS as `0x${string}` | undefined,
  ERC20Factory: process.env.NEXT_PUBLIC_ERC20_FACTORY_ADDRESS as `0x${string}` | undefined,
  ERC721AFactory: process.env.NEXT_PUBLIC_ERC721A_FACTORY_ADDRESS as `0x${string}` | undefined,
  ERC1155Factory: process.env.NEXT_PUBLIC_ERC1155_FACTORY_ADDRESS as `0x${string}` | undefined,
  CurveFactory: process.env.NEXT_PUBLIC_CURVE_FACTORY_ADDRESS as `0x${string}` | undefined,
  // Uniswap v4 PoolManager for this chain. Enables post-graduation Swap indexing so the
  // home page's live-activity rail keeps ticking after tokens graduate. Optional — leave
  // unset on chains where v4 isn't wired.
  PoolManager: process.env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS as `0x${string}` | undefined,
} as const;

// ABIs — human-readable via parseAbi, same shape wagmi uses on the client side.
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

/// Uniswap v4 PoolManager.Swap — one event per swap across every pool on the chain. On
/// testnets that's manageable; on mainnet you'll want to switch to a per-poolId filter
/// (Ponder doesn't support dynamic topic filters yet, so this is a TODO). We correlate
/// each swap to a launched token in the handler by matching the poolId against known
/// graduated launches.
export const poolManagerAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

export default createConfig({
  networks: {
    [CHAIN_SLUG]: {
      chainId: chain.id,
      transport: http(chain.rpc),
      // Poll the RPC every 1s for new blocks. Ponder's default backs off to keep public
      // RPCs happy — fine for prod on a paid tier, painful for local dev where every
      // extra second of lag is visible on the trade page. Base Sepolia has 2s blocks
      // so 1s polling catches a new head within one block interval.
      pollingInterval: 1_000,
    },
  },
  contracts: {
    NameRegistry: {
      network: CHAIN_SLUG,
      abi: nameRegistryAbi,
      address: CONTRACTS.NameRegistry,
      startBlock: chain.startBlock,
    },
    Router: {
      network: CHAIN_SLUG,
      abi: routerAbi,
      address: CONTRACTS.Router,
      startBlock: chain.startBlock,
    },
    ERC20Factory: {
      network: CHAIN_SLUG,
      abi: factoryAbi,
      address: CONTRACTS.ERC20Factory,
      startBlock: chain.startBlock,
    },
    ERC721AFactory: {
      network: CHAIN_SLUG,
      abi: factoryAbi,
      address: CONTRACTS.ERC721AFactory,
      startBlock: chain.startBlock,
    },
    ERC1155Factory: {
      network: CHAIN_SLUG,
      abi: factoryAbi,
      address: CONTRACTS.ERC1155Factory,
      startBlock: chain.startBlock,
    },
    CurveFactory: {
      network: CHAIN_SLUG,
      abi: curveFactoryAbi,
      address: CONTRACTS.CurveFactory,
      startBlock: chain.startBlock,
    },
    // PoolManager.Swap events — indexed to power the post-graduation chart + home page
    // live-activity rail. Only registered when NEXT_PUBLIC_POOL_MANAGER_ADDRESS is set.
    ...(CONTRACTS.PoolManager
      ? {
          PoolManager: {
            network: CHAIN_SLUG,
            abi: poolManagerAbi,
            address: CONTRACTS.PoolManager,
            startBlock: chain.startBlock,
          },
        }
      : {}),
    // Every BondingCurve is a clone deployed by CurveFactory. Ponder's inline `factory` config
    // subscribes to CurveCreated events and adds each new curve address as a Trade+Graduated
    // source dynamically. No per-launch config change needed.
    BondingCurve: {
      network: CHAIN_SLUG,
      abi: bondingCurveAbi,
      ...(CONTRACTS.CurveFactory
        ? {
            factory: {
              address: CONTRACTS.CurveFactory,
              event: parseAbiItem(
                'event CurveCreated(address indexed token, address indexed curve, address indexed launcher)',
              ),
              parameter: 'curve' as const,
            },
          }
        : {}),
      startBlock: chain.startBlock,
    },
  },
});
