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
/// switcher and gets its own /discover feed slice. Order here == order in the dropdown.
/// Mainnet chains first, testnet last. Sepolia + robinhood-testnet excluded — we don't
/// have contracts deployed there and don't want them in the picker as dead options.
export const CHAINS_ENABLED: readonly ChainKey[] = [
  'base',
  'mainnet',
  'robinhood',
  'base-sepolia',
] as const;

/// Default chain used when the wallet isn't connected or is on an unsupported chain.
/// Set to whichever chain currently has live contracts + real activity — otherwise
/// pages that fire reads before the user picks a chain hit a null CONTRACTS entry and
/// silently show nothing. Base mainnet is now the primary target.
export const DEFAULT_CHAIN: ChainKey = 'base';

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
  mainnet: {
    NameRegistry: '0x6d7F228A56A558F812054B21a2c0598437421C77',
    Router: '0x518DD310fAe76318eF56c04806c93861C8cC86CA',
    FeeReceiver: '0x60b797f18292d941E72B2b59916C0afC1A81118C',
    ERC20Factory: '0x50200Eda4693f4b839d8c436D42568B5e92EADE3',
    ERC20TemplateImpl: '0x14c1f066b91760565d5eEc8Cf4696A4648b552F2',
    ERC20WithAntiBotImpl: '0x6722AC329bF4701C7d6A408bE387D083741C3719',
    ERC20WithAntiWhaleImpl: '0x14b8132547d9e724Ce557F69897E66b9e699e64a',
    ERC20WithFoTImpl: '0xdD7c50BEb82b53F8FFa746dd85cc3BcDa43BabcD',
    ERC20WithPausableImpl: '0x19E133a55c45ce9195dd8F994C58dd97edff93BC',
    ERC20WithPermitImpl: '0x1Ccbf53F79372fBb700b0779B1fEA1E43Ba2E3e8',
    ERC20WithAirdropImpl: '0xA46Af17d1B3C0DfeeD0E5D8d6CEb8d49698D4de1',
    ERC20WithVestingImpl: '0x7Eb2F7313557e0625Cc22De2c3EbBE879684C7AF',
    ERC20WithStakingImpl: '0x203F3687dEf60bc54280b78E6fe0d66FD26Db731',
    ERC20WithVotesImpl: '0x4601B97eE914FDcd571546D48d6D5330B28928e4',
    ERC721AFactory: '0x64E8DE0afc6fE16806abF3513294d5f643606799',
    ERC721ATemplateImpl: '0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc',
    ERC721AWithDelayedRevealImpl: '0xb7b804F8dA3Be3F8159D5E1aE6c659a8e317ca78',
    ERC721AWithSvgImpl: '0x45C36c475D29c4aA46Cc50569A09b57e6BdD018d',
    ERC721AWithRoyaltyImpl: '0xc7BB288008B1751D6F0b86897D614E52ECa38a60',
    ERC721AWithSvgAndRoyaltyImpl: '0x5F61f73a31e3A973177Dc6dd5b4CE51e75587801',
    ERC721AWithSoulboundImpl: '0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac',
    ERC721AWithRefundableImpl: '0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A',
    ERC1155Factory: '0x55356c5045Cb7F299A8F5b2a17a4C2f16b68E88b',
    ERC1155TemplateImpl: '0x0f16a0D9aEef54e2321Ea6Fa264d638130297597',
    CurveFactory: '0x2207e3A3117F219636F42b9209d021b73811485C',
    BondingCurveImpl: '0x4D168e17443454590ff97206789E458e457dFB81',
  },
  sepolia: null, // populate after DeployPhase1 broadcasts
  base: {
    NameRegistry: '0xC3e117CD904db351F919134adCee7237F3ebC2A7',
    Router: '0x38461D94d6f84204399132AEc891E3B90563939a',
    FeeReceiver: '0xd5A09e3c553b79B13e0C7A7c3F42Eb3f775910eE',
    ERC20Factory: '0x347c9567bf379a5a046f925498FD805a9A34457A',
    ERC20TemplateImpl: '0x7De79F785d3B01f672f6c513B5a3eac29088fc38',
    ERC20WithAntiBotImpl: '0xFdf065eF2341F37f7a05E8dB330C966d5304db74',
    ERC20WithAntiWhaleImpl: '0xdA73D6081410edCe19C07224d0E35dD205b72213',
    ERC20WithFoTImpl: '0x4aa169b3407e781c18eB0D32981842899265C024',
    ERC20WithPausableImpl: '0xf501baD83fbEdeBE9227964EE107F62Cc1137f45',
    ERC20WithPermitImpl: '0xF3038eb78220e5AC6263821236Ce1fff713c26F5',
    ERC20WithAirdropImpl: '0xA2550078c38944E30AaC46AF6B67A04f3b10Fa88',
    ERC20WithVestingImpl: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24',
    ERC20WithStakingImpl: '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17',
    ERC20WithVotesImpl: '0x485a9deA97538eC24E61dE511bD69e9E8Eea2A4d',
    ERC721AFactory: '0x330e6c63d4c976D63029fA65f21bA4218157c6e6',
    ERC721ATemplateImpl: '0x4e0C3Cd114Ad235d69F41037d56844960708B86B',
    ERC721AWithDelayedRevealImpl: '0x503C5FDd4c1D0BAd39c8E534DBc658924Da4bCb4',
    ERC721AWithSvgImpl: '0x37E780ae97352f99C89589CbD92B21f2916Eecb3',
    ERC721AWithRoyaltyImpl: '0x2C3277d55C8859e58F0B357887553EBa8B28bFF6',
    ERC721AWithSvgAndRoyaltyImpl: '0xD549aC3E58DF46D0A761B988Cb989f43e9d90DF7',
    ERC721AWithSoulboundImpl: '0x5666866B7B412AD8a8514103bA104B0AB12C51bb',
    ERC721AWithRefundableImpl: '0xB4a1999d1045671D9177c69f70fd8A74eEE67464',
    ERC1155Factory: '0xb0F341CB55FcD23c1BE08d2D1CcAe5829CF2FE7a',
    ERC1155TemplateImpl: '0x5A0D5596389F7efc55424C95bf4313b405A01345',
    CurveFactory: '0x7d89aa4AE1f53bB185e905a005D0673014220a61',
    BondingCurveImpl: '0x7B56640d2610D5ac278E834670a0752d1341Ede1',
  },
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
  robinhood: {
    NameRegistry: '0x60b797f18292d941E72B2b59916C0afC1A81118C',
    Router: '0x50200Eda4693f4b839d8c436D42568B5e92EADE3',
    FeeReceiver: '0x518DD310fAe76318eF56c04806c93861C8cC86CA',
    ERC20Factory: '0x14c1f066b91760565d5eEc8Cf4696A4648b552F2',
    ERC20TemplateImpl: '0x6722AC329bF4701C7d6A408bE387D083741C3719',
    ERC20WithAntiBotImpl: '0x14b8132547d9e724Ce557F69897E66b9e699e64a',
    ERC20WithAntiWhaleImpl: '0xdD7c50BEb82b53F8FFa746dd85cc3BcDa43BabcD',
    ERC20WithFoTImpl: '0x19E133a55c45ce9195dd8F994C58dd97edff93BC',
    ERC20WithPausableImpl: '0x1Ccbf53F79372fBb700b0779B1fEA1E43Ba2E3e8',
    ERC20WithPermitImpl: '0xA46Af17d1B3C0DfeeD0E5D8d6CEb8d49698D4de1',
    ERC20WithAirdropImpl: '0x7Eb2F7313557e0625Cc22De2c3EbBE879684C7AF',
    ERC20WithVestingImpl: '0x203F3687dEf60bc54280b78E6fe0d66FD26Db731',
    ERC20WithStakingImpl: '0x4601B97eE914FDcd571546D48d6D5330B28928e4',
    ERC20WithVotesImpl: '0xf0a7AA9d95793DA05Ec07EAe5DDa23C1982AF0E8',
    ERC721AFactory: '0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc',
    ERC721ATemplateImpl: '0xb7b804F8dA3Be3F8159D5E1aE6c659a8e317ca78',
    ERC721AWithDelayedRevealImpl: '0x45C36c475D29c4aA46Cc50569A09b57e6BdD018d',
    ERC721AWithSvgImpl: '0xc7BB288008B1751D6F0b86897D614E52ECa38a60',
    ERC721AWithRoyaltyImpl: '0x5F61f73a31e3A973177Dc6dd5b4CE51e75587801',
    ERC721AWithSvgAndRoyaltyImpl: '0xF018A077a59fD9a24e99B76D0a7d0780792eB1Ac',
    ERC721AWithSoulboundImpl: '0xE9FfA2B7Dc3b7012A4E919DA293E663ddfbFec9A',
    ERC721AWithRefundableImpl: '0x9cCD1f59543c4160B658233DaD0D197CFa964c2F',
    ERC1155Factory: '0x0f16a0D9aEef54e2321Ea6Fa264d638130297597',
    ERC1155TemplateImpl: '0x8728FFEB1E017B123408209f2ae7f7207741Be5b',
    CurveFactory: '0x14b2FFb9e183ba51fAaf880f89490484F25B9223',
    BondingCurveImpl: '0x2207e3A3117F219636F42b9209d021b73811485C',
  },
  'robinhood-testnet': null,
};

export const HOOKS: Record<ChainKey, HookSet | null> = {
  mainnet: {
    PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    LPLockedHook: '0x3345A99403bA5687B75d9c5b4B6f058ca35e0200',
    FeeRedirectHook: '0x46D3367ee25B28A50a3c82533A9623e593b3C044',
    AntiSniperHook: '0xd5530a2971699E340166b61e7A61a29Ce478A080',
    MultiHookHost: '0x6B2da7926e496577F13fb4f1e08E1BAFe1C2e2C4',
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
    MultiHookHost: '0x75CF8eA5e271d73a69C498c3F2c57EFE9C6d22c4',
    BuybackBurnHook: '0x6Ee28706e839B8022435e075a2Ad37D3F70c0044',
  },
  robinhood: {
    PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    LPLockedHook: '0x6c8B8C72bf0047CEb6ed24C67A928bf8126EC200',
    FeeRedirectHook: '0x852Ba4d70b88834406bDC6b987C1869De217C044',
    AntiSniperHook: '0x836131f7Dbf2dAC65b9de6e6B5e8bD4331F9A080',
    MultiHookHost: '0x5295Ee9c86A40667A46C525A99931a29c354e2C4',
    BuybackBurnHook: '0xd46e8DA6A66B1513d8CE7aeC6a29929B59f4c044',
  },
  'robinhood-testnet': null,
};

/// One Graduator per chain — routes graduated bonding curves into a v4 pool with
/// `MultiHookHost` as the default hook. `null` until `DeployGraduator` broadcasts.
export const GRADUATORS: Record<ChainKey, Address | null> = {
  mainnet: '0x17E2572E148384cA484E274e9fF8365A50Eff17F',
  sepolia: null,
  base: '0xfB55944f70c5ba2bc8962eBB75934e9D8ab40715',
  'base-sepolia': '0x736D1280E30B0CCEEc7e3998E66620D9EB7fFa99',
  robinhood: '0x426294dC9afFEF39033412611433f91f59438Ac9',
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
  robinhood: '0x96E040a16A8B8B17a7896BDbDf02978895368bf6',
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
  base: {
    FeeSplitter: '0xA4B874cCDeB780FaC684DbFFc408Ad2B4D7E44d5',
    LoyaltyOracle: '0x31b723fe159fEaB1668DE6C08C6FbA5287A51ce7',
    NftRevenueVault: '0xf40fa5a1b30d7933B89387F46E464DA0D9CC7543',
    UruBuybackVault: '0xF68c7E6EF97676DD59690445aF7B237f1c9682a2',
    RoyaltyRouterImpl: '0x998515dfB6A1C15c02F938FcC3EC290732A0C635',
    RoyaltyRouterFactory: '0x8d6E1ef643cb287b7fd15108D0cB3933f0a9127A',
  },
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
