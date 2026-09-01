// Central app config. Every magic number, address, or chain constant lives here.
// Populated as contracts land on testnet/mainnet — leave as null placeholders until
// Router deploy broadcasts (VM-033).

import type { Address } from 'viem';

export type ChainKey =
  | 'mainnet'
  | 'sepolia'
  | 'base'
  | 'base-sepolia'
  | 'robinhood'
  | 'robinhood-testnet';

/// Chains the user can actually select and interact with today. Consumers treat this as
/// the source of truth for "is this chain live"; validation, feed fetches, and default
/// picks all read from here. Order here == order in the dropdown.
///
/// Robinhood-only for now — urufu gemu migration consolidated the ecosystem onto RH and
/// we're focusing the launchpad there while it stabilizes. Other chains are grayed out
/// in the UI (see CHAINS_COMING_SOON) but the code paths (config.ts CONTRACTS/HOOKS/
/// GRADUATORS entries, wagmi transports, indexer subscriptions) are kept intact so
/// re-enabling is a one-line change here.
export const CHAINS_ENABLED: readonly ChainKey[] = [
  'robinhood',
] as const;

/// Chains rendered in the header dropdown as disabled/grayed "coming soon" chips.
/// UI-only — not a source of truth for anything else. Order == display order under
/// the live chains.
export const CHAINS_COMING_SOON: readonly ChainKey[] = [
  'base',
  'mainnet',
  'base-sepolia',
] as const;

/// Default chain used when the wallet isn't connected or is on an unsupported chain.
/// Must be one of CHAINS_ENABLED so pages that fire reads before the user picks a chain
/// hit a populated CONTRACTS entry.
export const DEFAULT_CHAIN: ChainKey = 'robinhood';

/// Chain display metadata for the header switcher + any per-chain badge in the UI.
/// `iconPath` points at an SVG in `web/public/chains/`; swap those files to use official
/// brand assets. `emoji` is a fallback for text-only contexts (a11y descriptions, alt).
/// `jp` is the kawaii kanji shown next to the label in the dropdown.
export const CHAIN_META: Record<ChainKey, { iconPath: string; emoji: string; jp: string }> = {
  base: { iconPath: '/chains/base.svg', emoji: '🔷', jp: '基' },
  mainnet: { iconPath: '/chains/mainnet.svg', emoji: '⛓️', jp: '本' },
  robinhood: { iconPath: '/chains/robinhood.svg', emoji: '🏹', jp: '侠' },
  'base-sepolia': { iconPath: '/chains/base-sepolia.svg', emoji: '🧪', jp: '基試' },
  sepolia: { iconPath: '/chains/base-sepolia.svg', emoji: '🧪', jp: '試' },
  'robinhood-testnet': { iconPath: '/chains/robinhood.svg', emoji: '🏹', jp: '侠試' },
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

/// Uniswap v4 hooks the launchpad uses per chain. `MultiHookHost` is the
/// production hook (LP-lock + anti-sniper + fee-redirect + buyback-burn all
/// consolidated in one hook address, per v4's one-hook-per-pool rule). The
/// other slots exist for historical stack snapshots — new launches only
/// attach MultiHookHost. Values maintained manually in `.env` after each
/// broadcast; there is no auto-sync tool.
export interface HookSet {
  PoolManager: Address;
  LPLockedHook: Address;
  FeeRedirectHook: Address;
  AntiSniperHook: Address;
  MultiHookHost: Address;
  BuybackBurnHook: Address;
}

/// urufu labs flywheel (URU buyback / gemu NFT revenue / royalty router).
/// Values maintained manually in `.env` after each flywheel broadcast. Only
/// meaningful on chains where URU + gemu nft are deployed — Robinhood today.
export interface FlywheelSet {
  FeeSplitter: Address;
  LoyaltyOracle: Address;
  NftRevenueVault: Address;
  UruBuybackVault: Address;
  RoyaltyRouterImpl: Address;
  RoyaltyRouterFactory: Address;
}

export const CONTRACTS: Record<ChainKey, ContractSet | null> = {
  // Ethereum mainnet is not currently deployed. The previous contents of this
  // block were a copy-paste mixture of RH addresses and pre-migration Base
  // ecosystem tokens (ERC721AWithSoulboundImpl held the Base URU address, etc.),
  // and would ship stale/wrong bytecode targets in the client bundle if this
  // chain were ever enabled. Repopulate only after a real ETH mainnet broadcast.
  mainnet: null,
  sepolia: null, // populate after Router deploy broadcasts
  // Base + Base Sepolia: launchpad is RH-only for now (per user 2026-08-01).
  // Chains remain in the dropdown via CHAINS_COMING_SOON so users see them as
  // grayed-out "coming soon" entries. Previous contents of these blocks are in
  // git history (the base block also had RH ecosystem token addresses leaked
  // into two ERC20 template impl slots, which nulling clears). Repopulate only
  // after a real Base broadcast.
  base: null,
  'base-sepolia': null,
  robinhood: {
    // V9 fresh stack, broadcast 2026-08-06.
    // Source of truth: contracts/deployment-fresh.4663.json.
    NameRegistry: '0x965Aa2420635Ca0431888c6752b9aE8Bbe8d1F05',
    Router: '0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269',
    // FeeReceiver = FeeSplitter address (Router.feeReceiver returns it).
    FeeReceiver: '0x60835C422a3671b5F01E6806Fd96b27c90941C83',
    ERC20Factory: '0xfCfE7Db4F4d4ed6CC2fa6143a8C163Da11246f99',
    ERC20TemplateImpl: '0xcb6e0D31FDC6cBC9c1099Dd55a9832CA98294D28',
    // ERC20With*Impl slots were NOT in the fresh V9 broadcast JSON — only the
    // base ERC20Impl rotated. Slots below are the pre-V9 (V8) impls, pending
    // clarification whether V9 preserves impl compatibility or a separate
    // register-impls broadcast is coming. Do not treat any With* Impl below
    // as authoritative for V9 until re-registered against the new factory.
    ERC20WithAntiBotImpl: '0x14b8132547d9e724Ce557F69897E66b9e699e64a',
    ERC20WithAntiWhaleImpl: '0xdD7c50BEb82b53F8FFa746dd85cc3BcDa43BabcD',
    ERC20WithFoTImpl: '0x19E133a55c45ce9195dd8F994C58dd97edff93BC',
    ERC20WithPausableImpl: '0x1Ccbf53F79372fBb700b0779B1fEA1E43Ba2E3e8',
    ERC20WithPermitImpl: '0xA46Af17d1B3C0DfeeD0E5D8d6CEb8d49698D4de1',
    ERC20WithVestingImpl: '0x203F3687dEf60bc54280b78E6fe0d66FD26Db731',
    ERC20WithStakingImpl: '0x4601B97eE914FDcd571546D48d6D5330B28928e4',
    ERC20WithVotesImpl: '0xf0a7AA9d95793DA05Ec07EAe5DDa23C1982AF0E8',
    ERC721AFactory: '0xA3C03b4874C3fA0b1C8453565c326cF2658de8EA',
    // Same caveat as ERC20With* — ERC721A*Impl slots are pre-V9 pending
    // impl-registration confirmation.
    ERC721ATemplateImpl: '0xb7b804F8dA3Be3F8159D5E1aE6c659a8e317ca78',
    ERC721AWithDelayedRevealImpl: '0x45C36c475D29c4aA46Cc50569A09b57e6BdD018d',
    ERC721AWithSvgImpl: '0xc7BB288008B1751D6F0b86897D614E52ECa38a60',
    ERC721AWithRoyaltyImpl: '0x5F61f73a31e3A973177Dc6dd5b4CE51e75587801',
    ERC721AWithSvgAndRoyaltyImpl: '0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac',
    ERC721AWithSoulboundImpl: '0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A',
    ERC721AWithRefundableImpl: '0x9cCD1f59543c4160B658233DaD0D197CFa964c2F',
    ERC1155Factory: '0x63ee240906c80842261191e47d10ED0ea12D5946',
    // Same caveat as ERC20With* — ERC1155TemplateImpl is pre-V9 pending
    // impl-registration confirmation.
    ERC1155TemplateImpl: '0x8728FFEB1E017B123408209f2ae7f7207741Be5b',
    // V10 stack (broadcast 2026-08-12) — WL immediate-transfer redesign.
    // Buyers of a WL curve receive tokens in their wallet at buy time (no
    // more claimWl / hold-until-graduation), so a stalled WL curve is never
    // a funds-stuck failure mode. Existing curves stay on V9 impl.
    CurveFactory: '0xEC96D023426167e68598FF9ea946882b7f0AE91f',
    BondingCurveImpl: '0x616462099AE1a40DA8327D2af2797c540507DBB2',
  },
  'robinhood-testnet': null,
};

export const HOOKS: Record<ChainKey, HookSet | null> = {
  mainnet: {
    PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    LPLockedHook: '0x3345A99403bA5687B75d9c5b4B6f058ca35e0200',
    FeeRedirectHook: '0x46D3367ee25B28A50a3c82533A9623e593b3C044',
    AntiSniperHook: '0xd5530a2971699E340166b61e7A61a29Ce478A080',
    MultiHookHost: '0x629b2cD1641958B677A0106087CcBB89966262C4',
    BuybackBurnHook: '0xD8Ff51EFAf5daAE757bf152034d96cd2D61F0044',
  },
  sepolia: null,
  base: {
    PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    LPLockedHook: '0xD0090A6ffc3D528D395f32152b982B5A3b844200',
    FeeRedirectHook: '0x7793Af471c3B2585CA123971edd0f6b4645A0044',
    AntiSniperHook: '0x402E046c57184A729901bcd28C8bc79FC843a080',
    MultiHookHost: '0xb6b8e00450Ca203b96498E2577CCEEf92029e2c4',
    BuybackBurnHook: '0x8E0C4cDB00b6b8a9f20a1C8b5e854171f52A8044',
  },
  'base-sepolia': {
    PoolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
    LPLockedHook: '0x809f3BADA85D0a489320296fEE4578451a3F0200',
    FeeRedirectHook: '0xE44fB149edbfF3E67270e5CE0441e5Cad7AAc044',
    AntiSniperHook: '0x07526068b5Ae79178296B19f484Ca9aC3627E080',
    // Was 0x5295Ee9c86A40667A46C525A99931a29c354e2C4 — that entry (dead on Sepolia,
    // live on Robinhood) had been swapped with Robinhood's. Real Sepolia hook is
    // the one Graduator.defaultHook() returns.
    MultiHookHost: '0xe7462359E59E7CF6e5c78B7D3b01a685D468A2c4',
    BuybackBurnHook: '0x6Ee28706e839B8022435e075a2Ad37D3F70c0044',
  },
  robinhood: {
    PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    LPLockedHook: '0x6c8B8C72bf0047CEb6ed24C67A928bf8126EC200',
    FeeRedirectHook: '0x852Ba4d70b88834406bDC6b987C1869De217C044',
    AntiSniperHook: '0x836131f7Dbf2dAC65b9de6e6B5e8bD4331F9A080',
    // MHH — this field is the CLIENT-SIDE FALLBACK the trade page uses when the
    // indexer's `graduations.hookAddress` row is null (legacy tokens indexed
    // before the column existed). It MUST point at whatever MHH existing pools
    // actually use, or every legacy graduation stops resolving to its pool.
    //
    // Currently: V10 MHH (0x48C22af8). All three graduated tokens live now
    // (LUV, plus 2) were graduated by the V10 Graduator against V10 MHH.
    //
    // On 2026-08-12 we deployed a V11 MHH (0x83d6fa59) paired with
    // GraduatorV3 (0xB5aA5Fb4) so that NEW graduations use pump.fun-style
    // LP seeding. But V3 records its hook in graduations.hookAddress at
    // graduation time, so the trade page reads V11 straight from the indexer
    // for new pools — this fallback never applies to them. For legacy pools,
    // the fallback stays on V10 so they keep working.
    //
    // If you ever fully retire V10 MHH (no pools left, or all rows have
    // hookAddress populated), you can move this to V11.
    MultiHookHost: '0x48C22af8Ad989fc9d5e82D6055dc0F263076e0C4',
    BuybackBurnHook: '0xd46e8DA6A66B1513d8CE7aeC6a29929B59f4c044',
  },
  'robinhood-testnet': null,
};

/// One Graduator per chain — routes graduated bonding curves into a v4 pool with
/// `MultiHookHost` as the default hook. `null` until `DeployGraduator` broadcasts.
export const GRADUATORS: Record<ChainKey, Address | null> = {
  mainnet: '0xfCadca2f846533e50c6f9A7126535aBA54b6854c',
  sepolia: null,
  base: '0xfB55944f70c5ba2bc8962eBB75934e9D8ab40715',
  'base-sepolia': '0xdb0FD0eA7a80Cc3fB74D3A5E5ec12343682134a3',
  // GraduatorV3 — pump.fun-style LP seed, broadcast 2026-08-12. Seeds v4 pool
  // at the curve's marginal price (virtEth+ethIn) / (virtTok+tokenIn) and burns
  // any leftover tokens after LP mint so post-graduation spot ≈ curve last-buy
  // price. Replaces V10 Graduator's raw-real-ratio seed that produced a ~50%
  // price cliff at graduation. Bound to CurveFactory 0xEC96D0...E91f (unchanged)
  // and paired with MHH 0x83d6fa59BEF503112887b16277CF559fDC93E0C4.
  robinhood: '0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23',
  'robinhood-testnet': null,
};

/// Post-graduation swap router — the trade widget on `/trade/[address]` calls this
/// contract's swap functions once a curve has graduated. One per chain, wired to the
/// same PoolManager as GRADUATORS. `null` until `DeployV4SwapRouter` broadcasts.
export const V4_ROUTERS: Record<ChainKey, Address | null> = {
  mainnet: '0x96dCf3eA38b319927554e518BD8e1899e0488a2e',
  sepolia: null,
  base: '0x6657e76803d3Bb000CFb68Af9C9587C4D9eF8288',
  'base-sepolia': '0x729844c9Cc23407BF400535B28F787344c3321c1',
  // V4SwapRouter — V9 fresh stack, broadcast 2026-08-06.
  robinhood: '0xDb3D1C43225faEe04551b663E5aA0969937beEa4',
  'robinhood-testnet': null,
};

/// Uniswap v4 `StateView` — read-only helper that exposes packed pool slots (getSlot0,
/// getLiquidity, etc.) with typed returns. Deployed by Uniswap per chain, not by us.
/// Reference addresses at https://developers.uniswap.org/docs/protocols/v4/deployments.
export const V4_STATE_VIEWS: Record<ChainKey, Address | null> = {
  mainnet: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  sepolia: null,
  base: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
  'base-sepolia': '0x571291b572eD32CE6751A2Cb2486EbEe8DEFB9b4',
  robinhood: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  'robinhood-testnet': null,
};

export const FLYWHEEL: Record<ChainKey, FlywheelSet | null> = {
  mainnet: null,
  sepolia: null,
  // Base flywheel retired post-2026-07-25 migration to Robinhood.
  base: null,
  'base-sepolia': null,
  robinhood: {
    // V9 fresh stack, broadcast 2026-08-06.
    FeeSplitter: '0x60835C422a3671b5F01E6806Fd96b27c90941C83',
    LoyaltyOracle: '0xDcAd73EB96Bd0573b6ed0Ac3FFA32b1A7e0C0b52',
    // NftRevenueVault stays at 0x375337c4 (the vault the compile-service has
    // tree data for). Pending epoch activates 2026-08-13T17:35Z; user proofs
    // served by /rewards/robinhood/:epoch/:addr match this vault's root.
    // UruBuybackVault at 0x68c5Ec matches the buyback vault the keeper's
    // executeBuyback path targets (its distributionSink is 0x93CFF459 —
    // to be consolidated post-launch).
    NftRevenueVault: '0x375337c4c3B85a44948e7D98d7C05256DEFf0eA8',
    UruBuybackVault: '0x68c5Ec467027fCe56f158eB1ff34cF89d0929354',
    RoyaltyRouterImpl: '0x6344Efa1d3A0Cb5a75E9eDA308bDe3E7A4594F90',
    RoyaltyRouterFactory: '0xd9439BA974108af90E84fABFc206b63f6b70cAF1',
  },
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

/// URU pay-to-deploy wiring. `null` on chains where URU isn't paired with the
/// native/WETH side yet, or where RouterV2 isn't deployed. The create page reads
/// `URU_PAY[targetChain]` to decide whether to show the URU pay toggle.
///   `token`  — URU ERC-20 address (used for approve + allowance reads)
///   `poolId` — v4 pool ID for URU/WETH (used with StateView.getSlot0 to quote the
///              URU amount equivalent to the current ETH fee)
///   `uruIsCurrency1` — TRUE if URU is `currency1` in the pool (i.e. WETH sorts
///              lower). Determines whether `sqrtPriceX96` encodes URU/WETH (true)
///              or WETH/URU (false). Set at deploy time from the actual pool key.
export interface UruPayConfig {
  token: Address;
  poolId: `0x${string}`;
  uruIsCurrency1: boolean;
}

export const URU_PAY: Record<ChainKey, UruPayConfig | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': null,
  robinhood: {
    token: '0x9fbe210007ddd8389f98d0253018e65cc48b9d24',
    // URU/WETH pool ID on Robinhood — from the post-migration deploy address book.
    poolId: '0xd307e8754c65c451ca726c4549917b3f5765cce16a76f35a6d19aaf7bc230284',
    // WETH `0x0Bd7...` sorts lower than URU `0x9fbe...` → WETH is currency0, URU
    // is currency1 → sqrtPriceX96 encodes URU per WETH.
    uruIsCurrency1: true,
  },
  'robinhood-testnet': null,
};

/// Ecosystem token addresses (URU ERC-20 + urufu gemu ERC-721) per chain.
/// Used for balance reads on the profile page (loyalty tier context) and
/// eventually anywhere the launchpad needs to check holder status client-side.
/// Only Robinhood has canonical live values today; other chains are null
/// so a `?.` guard hides the widget cleanly.
export interface EcosystemTokens {
  uruToken: Address;
  gemuNft: Address;
}

/// NFT launch modules — populated after NftMintModule / NftCurveMintModule /
/// NftWhitelistMintModule broadcasts. Each slot is a module contract the
/// Router attaches to newly-launched ERC721 collections to enforce the
/// selected mint mechanic (fixed price, linear step-up curve, whitelist).
///
/// While `null`, the /create/nft UI still renders (so we can iterate on the
/// form / collection page) but the actual submit button is disabled — the
/// launch flow refuses to broadcast a tx against zero-address modules. Once
/// a real module ships, populate the slot here and the UI unlocks.
export interface NftLaunchSet {
  /// The singleton user-facing entrypoint. `launch(LaunchParams)` here
  /// deploys the ERC-721 + mint module + optional WL module in one tx.
  LaunchFactory: Address;
  // Impl addresses — informational, not called directly from the frontend
  // (the factory clones them internally). Kept in config for indexer /
  // Blockscout verification workflows.
  Erc721Impl: Address;
  MintModuleImpl: Address;
  WhitelistModuleImpl: Address;
}

export const NFT_LAUNCHES: Record<ChainKey, NftLaunchSet | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': null,
  // NFT stack V3 deployed 2026-09-01. Fixed the ExternalNft attestation
  // ourCollection semantics (mint module now passes `token`, not
  // `address(this)`) so the compile-service flow works end-to-end.
  // Superseded V1 (0xBe33…) + V2 (0x5b4D…), both dark. Site stays hidden
  // until NFT_LAUNCHES_ENABLED[robinhood] flips true.
  robinhood: {
    LaunchFactory: '0x861A4725d255508AA54bD5C145c0E1dFc39b44A9',
    Erc721Impl: '0x425fa35fd79F38af6a855d31c6144d7B9Aa22E12',
    MintModuleImpl: '0x3ADcf3DBf50D5A4E04b38f6B0437f4eF458Ff4f4',
    WhitelistModuleImpl: '0x779E726cc39C45E96d0D95fd5eCFa0B41DD56979',
  },
  'robinhood-testnet': null,
};

/// Per-chain feature flag for the NFT launch experience. Controls whether
/// the "nft" option in the create dropdown, the /create/nft route, the
/// /collection/[address] route, and the NFT tab on /discover render at all.
/// Independent from NFT_LAUNCHES (which gates the actual on-chain submit),
/// so we can ship UI ahead of contracts.
export const NFT_LAUNCHES_ENABLED: Record<ChainKey, boolean> = {
  mainnet: false,
  sepolia: false,
  base: false,
  'base-sepolia': false,
  robinhood: false,
  'robinhood-testnet': false,
};

/// Convenience: submit-time gate. UI is enabled iff `NFT_LAUNCHES_ENABLED[chain]`
/// is true AND every module address in `NFT_LAUNCHES[chain]` is populated.
export function isNftDeployReady(chain: ChainKey): boolean {
  return NFT_LAUNCHES_ENABLED[chain] === true && NFT_LAUNCHES[chain] !== null;
}

export const ECOSYSTEM_TOKENS: Record<ChainKey, EcosystemTokens | null> = {
  mainnet: null,
  sepolia: null,
  base: null,
  'base-sepolia': null,
  robinhood: {
    uruToken: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24',
    gemuNft: '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17',
  },
  'robinhood-testnet': null,
};

export const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? 'http://localhost:3001';

export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';
