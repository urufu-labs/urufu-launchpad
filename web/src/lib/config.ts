// Central app config. Every magic number, address, or chain constant lives here.
// Populated as contracts land on testnet/mainnet — leave as null placeholders until
// DeployPhase1 broadcasts (VM-033).

import type { Address } from 'viem';

export type ChainKey =
  | 'mainnet'
  | 'sepolia'
  | 'base'
  | 'base-sepolia'
  | 'robinhood'
  | 'robinhood-testnet';

/// Chains the user can select in the shop. Every chain here shows up in the header chain
/// switcher and gets its own /discover feed slice. Enable a chain once its DeployPhase1
/// addresses are populated below OR you want mock-mode preview on it.
export const CHAINS_ENABLED: readonly ChainKey[] = [
  'sepolia',
  'mainnet',
  'base',
  'base-sepolia',
  'robinhood',
  'robinhood-testnet',
] as const;

/// Default chain used when the wallet isn't connected or is on an unsupported chain.
export const DEFAULT_CHAIN: ChainKey = 'sepolia';

/// Human-readable emoji + JP label pairs so the chain switcher UI stays kawaii.
export const CHAIN_META: Record<ChainKey, { emoji: string; jp: string }> = {
  mainnet: { emoji: '⛓️', jp: '本' },
  sepolia: { emoji: '🧪', jp: '試' },
  base: { emoji: '🔷', jp: '基' },
  'base-sepolia': { emoji: '🧪', jp: '基試' },
  robinhood: { emoji: '🏹', jp: '侠' },
  'robinhood-testnet': { emoji: '🏹', jp: '侠試' },
};

export interface ContractSet {
  NameRegistry: Address;
  Router: Address;
  FeeReceiver: Address;
  ERC20Factory: Address;
  ERC20TemplateImpl: Address;
  ERC20WithAntiBotImpl: Address;
  ERC20WithAntiWhaleImpl: Address;
  ERC20WithFoTImpl: Address;
  ERC20WithPausableImpl: Address;
  ERC20WithPermitImpl: Address;
  ERC20WithAirdropImpl: Address;
  ERC20WithVestingImpl: Address;
  ERC20WithStakingImpl: Address;
  ERC20WithVotesImpl: Address;
  ERC20WithGovernorImpl: Address;
  ERC20VotesTemplateImpl: Address;
  ERC721AFactory: Address;
  ERC721ATemplateImpl: Address;
  ERC721AWithDelayedRevealImpl: Address;
  ERC721AWithSvgImpl: Address;
  ERC721AWithRoyaltyImpl: Address;
  ERC721AWithSvgAndRoyaltyImpl: Address;
  ERC721AWithSoulboundImpl: Address;
  ERC721AWithRefundableImpl: Address;
  ERC1155Factory: Address;
  ERC1155TemplateImpl: Address;
  CurveFactory: Address;
  BondingCurveImpl: Address;
}

export const CONTRACTS: Record<ChainKey, ContractSet | null> = {
  mainnet: null,
  sepolia: null, // populate after DeployPhase1 broadcasts
  base: null,
  'base-sepolia': null,
  robinhood: null,
  'robinhood-testnet': null,
};

export const CHAIN_LABELS: Record<ChainKey, string> = {
  mainnet: 'Ethereum',
  sepolia: 'Sepolia',
  base: 'Base',
  'base-sepolia': 'Base Sepolia',
  robinhood: 'Robinhood',
  'robinhood-testnet': 'Robinhood Testnet',
};

export const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';
