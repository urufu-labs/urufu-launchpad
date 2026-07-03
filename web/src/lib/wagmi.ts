import { http, createConfig } from 'wagmi';
import { mainnet, sepolia, base, baseSepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

import type { ChainKey } from './config';

/// Wagmi config. Sepolia is the only user-facing chain in Phase 1.
/// Mainnet + Base are pre-wired so post-audit expansion is a one-line CHAINS_ENABLED bump.
export const wagmiConfig = createConfig({
  chains: [sepolia, mainnet, base, baseSepolia],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
    [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL),
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
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
};

export const CHAIN_KEY_TO_ID = {
  mainnet: mainnet.id,
  sepolia: sepolia.id,
  base: base.id,
  'base-sepolia': baseSepolia.id,
} as const satisfies Record<ChainKey, number>;

export type WagmiChainId = (typeof CHAIN_KEY_TO_ID)[ChainKey];

const EXPLORERS: Record<ChainKey, string> = {
  mainnet: 'https://etherscan.io',
  sepolia: 'https://sepolia.etherscan.io',
  base: 'https://basescan.org',
  'base-sepolia': 'https://sepolia.basescan.org',
};

export function explorerTxUrl(chain: ChainKey, txHash: string): string {
  return `${EXPLORERS[chain]}/tx/${txHash}`;
}

export function explorerAddressUrl(chain: ChainKey, address: string): string {
  return `${EXPLORERS[chain]}/address/${address}`;
}
