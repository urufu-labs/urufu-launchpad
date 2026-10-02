import { http, createConfig } from 'wagmi';
import { mainnet, sepolia, base, baseSepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { defineChain } from 'viem';

import type { ChainKey } from './config';

/// Robinhood Chain (Arbitrum L2, ETH gas). Uniswap v4 lives here so post-graduation
/// hook modules can target it directly.
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Testnet Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

/// Wagmi config. Sepolia is the only user-facing chain in Phase 1.
/// Mainnet + Base + Robinhood are pre-wired so post-audit expansion is a one-line
/// CHAINS_ENABLED bump.
export const wagmiConfig = createConfig({
  chains: [sepolia, mainnet, base, baseSepolia, robinhoodChain, robinhoodChainTestnet],
  connectors: [injected()],
  // Browser transports use each chain's PUBLIC default RPC only (http() with no
  // URL = chain.rpcUrls.default). NEVER read NEXT_PUBLIC_*_RPC_URL here: every
  // NEXT_PUBLIC_ value is baked into the shipped JS, and keyed provider URLs
  // (Alchemy etc.) set in Vercel were scraped from the bundle and ran up a
  // ~$800 bill / account suspension (2026-10-02). Guarded by
  // src/lib/noKeyedRpcInBundle.test.mjs.
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [base.id]: http(),
    [baseSepolia.id]: http(),
    [robinhoodChain.id]: http(),
    [robinhoodChainTestnet.id]: http(),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const CHAIN_ID_TO_KEY: Record<number, ChainKey> = {
  [mainnet.id]: 'mainnet',
  [sepolia.id]: 'sepolia',
  [base.id]: 'base',
  [baseSepolia.id]: 'base-sepolia',
  [robinhoodChain.id]: 'robinhood',
  [robinhoodChainTestnet.id]: 'robinhood-testnet',
};

export const CHAIN_KEY_TO_ID = {
  mainnet: mainnet.id,
  sepolia: sepolia.id,
  base: base.id,
  'base-sepolia': baseSepolia.id,
  robinhood: robinhoodChain.id,
  'robinhood-testnet': robinhoodChainTestnet.id,
} as const satisfies Record<ChainKey, number>;

export type WagmiChainId = (typeof CHAIN_KEY_TO_ID)[ChainKey];

const EXPLORERS: Record<ChainKey, string> = {
  mainnet: 'https://etherscan.io',
  sepolia: 'https://sepolia.etherscan.io',
  base: 'https://basescan.org',
  'base-sepolia': 'https://sepolia.basescan.org',
  robinhood: 'https://robinhoodchain.blockscout.com',
  'robinhood-testnet': 'https://explorer.testnet.chain.robinhood.com',
};

export function explorerTxUrl(chain: ChainKey, txHash: string): string {
  return `${EXPLORERS[chain]}/tx/${txHash}`;
}

export function explorerAddressUrl(chain: ChainKey, address: string): string {
  return `${EXPLORERS[chain]}/address/${address}`;
}
