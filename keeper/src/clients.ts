/**
 * viem client + account factory. Kept behind a tiny module so tests can
 * swap in a mock chain without patching every handler.
 */

import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { KeeperConfig } from './config.ts';

/// Robinhood chain id is 4663 per every other launchpad component. We
/// pin the chain object here rather than importing from viem/chains so
/// the keeper works against any chain the launchpad ships on next.
export function chainForConfig(cfg: KeeperConfig) {
  return defineChain({
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export type PublicClient = ReturnType<typeof createPublicClient>;
export type WalletClient = ReturnType<typeof createWalletClient>;

export function makeClients(cfg: KeeperConfig): {
  public: PublicClient;
  wallet: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} {
  const chain = chainForConfig(cfg);
  const account = privateKeyToAccount(cfg.keeperPrivateKey);
  return {
    public: createPublicClient({ chain, transport: http(cfg.rpcUrl) }),
    wallet: createWalletClient({ chain, transport: http(cfg.rpcUrl), account }),
    account,
  };
}
