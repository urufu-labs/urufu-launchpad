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

/// Uniswap v4 hooks the launchpad deploys per chain. `MultiHookHost` is the
/// production default (LP-lock + fee-split in one hook address); the others are
/// available for advanced launches. Populated by `sync-addresses.mjs` after
/// `DeployHooks` broadcasts on a chain.
export interface HookSet {
  PoolManager: Address;
  LPLockedHook: Address;
  FeeRedirectHook: Address;
  AntiSniperHook: Address;
  MultiHookHost: Address;
  BuybackBurnHook: Address;
}

/// urufu labs flywheel (URU buyback / gemu NFT revenue / royalty router).
/// Populated by `sync-addresses.mjs` after `DeployFlywheel` broadcasts. Only
/// meaningful on chains where URU + gemu nft are deployed — Base today.
export interface FlywheelSet {
  FeeSplitter: Address;
  LoyaltyOracle: Address;
  NftRevenueVault: Address;
  UruBuybackVault: Address;
  RoyaltyRouterImpl: Address;
  RoyaltyRouterFactory: Address;
}

export const CONTRACTS: Record<ChainKey, ContractSet | null> = {
  mainnet: null,
  sepolia: null, // populate after DeployPhase1 broadcasts
  base: null,
  'base-sepolia': {
    NameRegistry: '0xBca595B8B2176A9493e444befeB272b6Be0298BF',
    Router: '0xB2455Ee7Fe8eCFDe05D5CA8a65E2379e2D1d920d',
    FeeReceiver: '0x535F518109A9b3AbB0516F2e068C748E3A985d60',
    ERC20Factory: '0xa120605f68F3065F94bf58CF9eb4773e288c9c17',
    ERC20TemplateImpl: '0xCfB63FC82b0ee223b816BFD67D0f118A458a2708',
    ERC20WithAntiBotImpl: '0x1e901d5a6C4859AEbed2a5B88843e0bdEef7D061',
    ERC20WithAntiWhaleImpl: '0xaf3df333993f835a33A6852249bcE4240dfE378F',
    ERC20WithFoTImpl: '0x599C874831241638Bb531C90ab78dABb86b581FA',
    ERC20WithPausableImpl: '0xb0Ec2f41d00F23cFB7b9928e45845Dc0d7402ab3',
    ERC20WithPermitImpl: '0x3cF804B14e06b4202a7a9A921Bca132Cb618C7D4',
    ERC20WithAirdropImpl: '0xFAC4C3623FBC2a3f2B56E523747dC8760005dF75',
    ERC20WithVestingImpl: '0xf593a5798E4DeCa20cb65Eb15f3dceD5aF1E8ca1',
    ERC20WithStakingImpl: '0xB63D60F69e3900C8d880a3766dAfe1a45f626917',
    ERC20WithVotesImpl: '0x65ce5F20Fc1aA10fed6A854D75f58a1AB95A52B0',
    ERC721AFactory: '0x6CDC3aFd3dEFadc1115F5f0b9515C8798f80Be89',
    ERC721ATemplateImpl: '0x50d025D3B192C10fFDFd4Eb0d7c37245075702e7',
    ERC721AWithDelayedRevealImpl: '0x947CC0dc27A6f3D615554E4247AF33904556201E',
    ERC721AWithSvgImpl: '0xdef4Bc92E6992260d6236E39Ed455575450f0D7b',
    ERC721AWithRoyaltyImpl: '0x3501A7c679FcaD06b8ACE7252eCeB3159D2b239B',
    ERC721AWithSvgAndRoyaltyImpl: '0x732AC8245046711681a4ea675494EB66735f2e53',
    ERC721AWithSoulboundImpl: '0x434bf31Fe4E0F6357a221B249DA1a6EfEE289E3a',
    ERC721AWithRefundableImpl: '0x616462099AE1a40DA8327D2af2797c540507DBB2',
    ERC1155Factory: '0x0b57D35F7BAed17436C7c3AE21aE3FD38620E3aa',
    ERC1155TemplateImpl: '0x9B484f026D1f0670b81689d3B7e0e5D6F1180B62',
    CurveFactory: '0xB8Cf1418f7DF58d57bd9b37b986280de1D8f938B',
    BondingCurveImpl: '0x684bb1309C3f5270A42ccc4aBdC579d8c7052d95',
  },
  robinhood: null,
  'robinhood-testnet': null,
};

export const HOOKS: Record<ChainKey, HookSet | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': {
    PoolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
    LPLockedHook: '0x809f3BADA85D0a489320296fEE4578451a3F0200',
    FeeRedirectHook: '0xE44fB149edbfF3E67270e5CE0441e5Cad7AAc044',
    AntiSniperHook: '0x07526068b5Ae79178296B19f484Ca9aC3627E080',
    MultiHookHost: '0x75CF8eA5e271d73a69C498c3F2c57EFE9C6d22c4',
    BuybackBurnHook: '0x6Ee28706e839B8022435e075a2Ad37D3F70c0044',
  },
  robinhood: null,
  'robinhood-testnet': null,
};

/// One Graduator per chain — routes graduated bonding curves into a v4 pool with
/// `MultiHookHost` as the default hook. `null` until `DeployGraduator` broadcasts.
export const GRADUATORS: Record<ChainKey, Address | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': '0x736D1280E30B0CCEEc7e3998E66620D9EB7fFa99',
  robinhood: null,
  'robinhood-testnet': null,
};

/// Post-graduation swap router — the trade widget on `/trade/[address]` calls this
/// contract's swap functions once a curve has graduated. One per chain, wired to the
/// same PoolManager as GRADUATORS. `null` until `DeployV4SwapRouter` broadcasts.
export const V4_ROUTERS: Record<ChainKey, Address | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': '0x729844c9Cc23407BF400535B28F787344c3321c1',
  robinhood: null,
  'robinhood-testnet': null,
};

/// Uniswap v4 `StateView` — read-only helper that exposes packed pool slots (getSlot0,
/// getLiquidity, etc.) with typed returns. Deployed by Uniswap per chain, not by us.
/// Reference addresses at https://docs.uniswap.org/contracts/v4/deployments.
export const V4_STATE_VIEWS: Record<ChainKey, Address | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': '0x571291b572eD32CE6751A2Cb2486EbEe8DEFB9b4',
  robinhood: null,
  'robinhood-testnet': null,
};

export const FLYWHEEL: Record<ChainKey, FlywheelSet | null> = {
  mainnet: null,
  sepolia: null,
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
