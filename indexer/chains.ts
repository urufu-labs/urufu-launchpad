/// Multi-chain indexer catalog. Shared by `ponder.config.ts` (network + contract
/// registration) and `src/index.ts` (per-handler chainId-based lookups like the v4
/// poolId hook address).
///
/// Enable a chain by setting BOTH:
///   1. Its RPC URL:  `<PREFIX>_RPC_URL`
///   2. At least one contract address: `<PREFIX>_ROUTER_ADDRESS`, etc.
///
/// Which chains this instance runs against is controlled by `INDEXER_CHAINS`
/// (comma-separated slug list) or the legacy `INDEXER_CHAIN` (single slug).
/// If NEITHER is set, every chain in the catalog is candidate-enabled and the
/// one that ends up subscribed is decided by which chains have RPC + addresses
/// configured — so "just set the env vars and it works" is the default UX.
///
/// Backward-compat: for a chain that matches the legacy `INDEXER_CHAIN`, the
/// unprefixed `NEXT_PUBLIC_<NAME>_ADDRESS` env vars are read as a fallback
/// when the prefixed form isn't set. Lets the existing single-chain Railway
/// service keep working while env vars migrate to the prefixed pattern.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/// Load repo-root `.env` into `process.env` (Ponder's own dotenv only reads the
/// indexer/ workspace). Called once at import time; safe to import from
/// multiple files because `process.env` is a shared singleton.
const rootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || key.startsWith('#') || rawValue === undefined) continue;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type ChainSlug =
  | 'sepolia'
  | 'mainnet'
  | 'base'
  | 'base-sepolia'
  | 'robinhood'
  | 'robinhood-testnet';

export interface ChainMeta {
  id: number;
  /// Uppercase env-var prefix. `${prefix}_ROUTER_ADDRESS`, `${prefix}_RPC_URL`, etc.
  envPrefix: string;
  /// Fallback RPC URL if `<PREFIX>_RPC_URL` isn't set. Only defined for chains that
  /// have a usable public RPC — mainnet/base need a paid endpoint (Alchemy/QuickNode).
  defaultRpc: string;
}

export const CHAIN_CATALOG: Record<ChainSlug, ChainMeta> = {
  sepolia: {
    id: 11_155_111,
    envPrefix: 'SEPOLIA',
    defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  mainnet: {
    id: 1,
    envPrefix: 'MAINNET',
    defaultRpc: '',
  },
  base: {
    id: 8453,
    envPrefix: 'BASE',
    defaultRpc: 'https://mainnet.base.org',
  },
  'base-sepolia': {
    id: 84_532,
    envPrefix: 'BASE_SEPOLIA',
    defaultRpc: 'https://sepolia.base.org',
  },
  robinhood: {
    id: 4663,
    envPrefix: 'ROBINHOOD',
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
  },
  'robinhood-testnet': {
    id: 46_630,
    envPrefix: 'ROBINHOOD_TESTNET',
    defaultRpc: 'https://rpc.testnet.chain.robinhood.com',
  },
};

const ALL_SLUGS = Object.keys(CHAIN_CATALOG) as ChainSlug[];

/// Legacy single-chain selector. Read once, used to enable the unprefixed
/// `NEXT_PUBLIC_*` env-var fallback for exactly that chain.
export const LEGACY_SINGLE_CHAIN: ChainSlug | null = (() => {
  const s = process.env.INDEXER_CHAIN;
  if (!s) return null;
  return ALL_SLUGS.includes(s as ChainSlug) ? (s as ChainSlug) : null;
})();

/// Parse `INDEXER_CHAINS=base-sepolia,base` into a slug list; falls back to the
/// legacy single-chain value; if neither is set, considers every catalog chain.
function requestedChains(): ChainSlug[] {
  const list = process.env.INDEXER_CHAINS;
  if (list) {
    return list
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is ChainSlug => (ALL_SLUGS as string[]).includes(s));
  }
  if (LEGACY_SINGLE_CHAIN) return [LEGACY_SINGLE_CHAIN];
  return ALL_SLUGS;
}

/// Contract address env-var name suffixes. Kept in one place so the schema
/// stays consistent across ponder.config + handler code + docs.
export const ADDRESS_KEYS = [
  'NAME_REGISTRY',
  'ROUTER',
  'ERC20_FACTORY',
  'ERC721A_FACTORY',
  'ERC1155_FACTORY',
  'CURVE_FACTORY',
  'POOL_MANAGER',
  'V4_SWAP_ROUTER',
  'MULTI_HOOK_HOST',
] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];

/// Read a per-chain address env var. Falls back to the unprefixed
/// `NEXT_PUBLIC_<NAME>_ADDRESS` for the legacy single-chain slug.
export function readAddress(slug: ChainSlug, key: AddressKey): `0x${string}` | undefined {
  const prefix = CHAIN_CATALOG[slug].envPrefix;
  const explicit = process.env[`${prefix}_${key}_ADDRESS`];
  if (explicit) return explicit as `0x${string}`;
  if (slug === LEGACY_SINGLE_CHAIN) {
    const legacy = process.env[`NEXT_PUBLIC_${key}_ADDRESS`];
    if (legacy) return legacy as `0x${string}`;
  }
  return undefined;
}

/// Read the RPC URL for a chain. Falls back to the catalog default (only
/// non-empty for chains with a usable public endpoint). Legacy `<PREFIX>_RPC_URL`
/// env var names are unchanged so the existing Railway config keeps working.
export function readRpcUrl(slug: ChainSlug): string {
  const prefix = CHAIN_CATALOG[slug].envPrefix;
  return process.env[`${prefix}_RPC_URL`] ?? CHAIN_CATALOG[slug].defaultRpc ?? '';
}

/// Read the Ponder start block for a chain. `PONDER_START_BLOCK_<PREFIX>` — same
/// pattern as before, just made per-chain-aware.
export function readStartBlock(slug: ChainSlug): number {
  const prefix = CHAIN_CATALOG[slug].envPrefix;
  return Number(process.env[`PONDER_START_BLOCK_${prefix}`] ?? 0);
}

/// The chains this indexer will actually subscribe to. A slug is enabled iff:
///   - it appears in `requestedChains()`, AND
///   - `readRpcUrl(slug)` returns a non-empty URL, AND
///   - at least one contract address is configured for it.
/// Silently skipping unconfigured chains keeps deploy-day churn low — Railway
/// operators enable a chain by adding its env vars, not by re-editing this file.
export function enabledChains(): ChainSlug[] {
  return requestedChains().filter((slug) => {
    if (!readRpcUrl(slug)) return false;
    return ADDRESS_KEYS.some((k) => readAddress(slug, k));
  });
}

/// Per-chainId hook host lookup — used at graduation time to compute the v4 poolId
/// (`computeV4PoolId(token, hookHost)`). Returns undefined if not configured for
/// the chain the graduation happened on.
export function hookHostForChainId(chainId: number): `0x${string}` | undefined {
  for (const slug of ALL_SLUGS) {
    if (CHAIN_CATALOG[slug].id === chainId) return readAddress(slug, 'MULTI_HOOK_HOST');
  }
  return undefined;
}
