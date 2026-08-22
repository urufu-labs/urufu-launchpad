import { parseAbi } from 'viem';

/// Solidity BaseType enum → uint8 for on-chain calls.
export const BASE_TYPE = {
  ERC20: 0,
  ERC721A: 1,
  ERC1155: 2,
} as const;

/// Solidity OwnershipMode enum → uint8.
export const OWNERSHIP_MODE = {
  Renounce: 0,
  TransferToMultisig: 1,
  KeepEOA: 2,
} as const;

/// LaunchParams struct tuple type — kept as a shared reference for typed args.
export const LAUNCH_PARAMS_TUPLE = '(uint8 base, string name, string ticker, bytes32 configHash, bytes initData, uint256 moduleCount, bool installHook, bool installGovernance, bool installBondingCurve, uint8 ownership, address ownerTargetIfMultisig, uint32 antiSniperBlocks, uint16 buybackBurnBps)' as const;

export const RESERVATION_TUPLE = '(address token, address launchedBy, uint64 timestamp, uint32 chainId, string name, string ticker)' as const;

export const nameRegistryAbi = parseAbi([
  `struct Reservation { address token; address launchedBy; uint64 timestamp; uint32 chainId; string name; string ticker; }`,
  `function isNameAvailable(string name) view returns (bool)`,
  `function isTickerAvailable(string ticker) view returns (bool)`,
  `function validateName(string name) view returns (bool valid, uint8 reason)`,
  `function validateTicker(string ticker) view returns (bool valid, uint8 reason)`,
  `function reservationOf(bytes32 nameHash) view returns (Reservation)`,
  `function tickerOwner(bytes32 tickerHash) view returns (address)`,
  `function isTickerReserved(bytes32 tickerHash) view returns (bool)`,
  `function router() view returns (address)`,
  `function treasury() view returns (address)`,
  `event Reserved(bytes32 indexed nameHash, bytes32 indexed tickerHash, address indexed token, address launchedBy, string name, string ticker, uint256 timestamp, uint256 chainId)`,
] as const);

export const routerAbi = parseAbi([
  `struct LaunchParams { uint8 base; string name; string ticker; bytes32 configHash; bytes initData; uint256 moduleCount; bool installHook; bool installGovernance; bool installBondingCurve; uint8 ownership; address ownerTargetIfMultisig; uint32 antiSniperBlocks; uint16 buybackBurnBps; }`,
  `function quote(LaunchParams params) view returns (uint256)`,
  /// Discount-aware quote — reads the wired LoyaltyOracle and applies the launcher's
  /// discount slice. Returns 0 when discount is 100% (staff/promo). Every launch
  /// path should prefer this over `quote()` so the receipt matches what Router
  /// actually charges — otherwise users pay less than the UI showed and never learn
  /// the flywheel rewarded them.
  `function quoteFor(LaunchParams params, address launcher) view returns (uint256)`,
  `function loyaltyOracle() view returns (address)`,
  `function launch(LaunchParams params) payable returns (address token)`,
  `function fees(uint8 base) view returns (uint256)`,
  `function moduleAddOnFee() view returns (uint256)`,
  `function hookAddOnFee() view returns (uint256)`,
  `function governanceAddOnFee() view returns (uint256)`,
  `function paused() view returns (bool)`,
  `function factories(uint8 base) view returns (address)`,
  `event Launched(address indexed token, address indexed launchedBy, uint8 indexed base, bytes32 nameHash, bytes32 tickerHash, uint256 feePaid, bool installedHook, bool installedGovernance)`,
  /// RouterV2 additions (Robinhood only). Callable when the on-chain Router is a
  /// RouterV2 deployment; missing on the legacy Router (call reverts on those chains).
  /// See contracts/src/router/RouterV2.sol for the full contract.
  `function launchWithURU(LaunchParams params, uint256 uruAmount) returns (address token)`,
  `function uru() view returns (address)`,
  `function uruSink() view returns (address)`,
  /// Minimum URU required per launch (loyalty discount applied) - the create
  /// page reads this and takes max(spot-quoted, floor) before approve/send so
  /// launches don't revert with RouterV2__InsufficientUru after the user has
  /// paid gas.
  `function minUruFeeFor(address launcher) view returns (uint256)`,
  `function minUruFee() view returns (uint256)`,
  `event LaunchedInURU(address indexed token, address indexed launchedBy, uint256 uruPaid)`,
  /// Whitelisted-curve launch entries (RouterV2 + WL-aware CurveFactory required).
  /// See contracts/src/curve/BondingCurve.sol:WhitelistInit for the struct shape.
  `struct WhitelistInit { bytes32 root; uint256 reservedTokens; uint256 maxWlPerAddress; uint64 fallbackTs; address sourceTokenAddress; uint32 sourceChainId; uint32 declaredHolderCount; }`,
  `function launchWithWhitelist(LaunchParams params, WhitelistInit wl) payable returns (address token)`,
  `function launchWithURUAndWhitelist(LaunchParams params, uint256 uruAmount, WhitelistInit wl) returns (address token)`,
  `event LaunchedWithWhitelist(address indexed token, address indexed launchedBy, bytes32 whitelistRoot, uint256 reservedTokens, uint256 maxWlPerAddress, uint64 fallbackTs, address sourceTokenAddress, uint32 sourceChainId)`,
  /// GH-8: atomic launch + first buy. Router deploys the token, opens the
  /// curve, then IMMEDIATELY calls BondingCurve.buyFor(recipient, minTokensOut)
  /// with `initialBuyEth` — all in one tx so no mempool bot can front-run the
  /// launcher's first purchase. msg.value must equal fee + initialBuyEth.
  /// Only exists on the plain ETH-paid non-WL path.
  `function launchAndBuy(LaunchParams params, uint256 initialBuyEth, uint256 minTokensOut, address recipient) payable returns (address token)`,
  `event LaunchedWithInitialBuy(address indexed token, address indexed launchedBy, address recipient, uint256 initialBuyEth, uint256 tokensOut)`,
] as const);

export const erc20FactoryAbi = parseAbi([
  `function implFor(bytes32 configHash) view returns (address)`,
  `function predictAddress(address launcher, string name, string ticker, bytes32 configHash) view returns (address)`,
  `function usageCount(bytes32 configHash) view returns (uint256)`,
] as const);

export const erc20TokenAbi = parseAbi([
  `function name() view returns (string)`,
  `function symbol() view returns (string)`,
  `function decimals() view returns (uint8)`,
  `function totalSupply() view returns (uint256)`,
  `function balanceOf(address account) view returns (uint256)`,
  `function owner() view returns (address)`,
  `function approve(address spender, uint256 amount) returns (bool)`,
  `function allowance(address owner, address spender) view returns (uint256)`,
] as const);

export const bondingCurveAbi = parseAbi([
  `function token() view returns (address)`,
  `function tokenReserve() view returns (uint256)`,
  `function ethReserve() view returns (uint256)`,
  `function virtualTokenReserve() view returns (uint256)`,
  `function virtualEthReserve() view returns (uint256)`,
  `function graduationTargetEth() view returns (uint256)`,
  `function curveSupply() view returns (uint256)`,
  `function tradeFeeBps() view returns (uint16)`,
  `function graduated() view returns (bool)`,
  `function priceWeiPerToken() view returns (uint256)`,
  `function quoteBuy(uint256 ethIn) view returns (uint256 tokensOut, uint256 fee)`,
  `function quoteSell(uint256 tokensIn) view returns (uint256 ethOut, uint256 fee)`,
  `function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)`,
  `function sell(uint256 tokensIn, uint256 minEthOut) returns (uint256 ethOut)`,
  `event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)`,
  `event Graduated(uint256 ethReserve, uint256 tokenReserve, uint256 timestamp)`,
  /// Whitelist views + buy/claim entry points. Present on WL-aware BondingCurve
  /// clones (post-CurveFactoryV2 launches). Reads return zero on non-WL curves,
  /// so it's safe to include unconditionally.
  `function whitelistRoot() view returns (bytes32)`,
  `function reservedTokens() view returns (uint256)`,
  `function wlSold() view returns (uint256)`,
  `function maxWlPerAddress() view returns (uint256)`,
  `function fallbackTs() view returns (uint64)`,
  `function sourceTokenAddress() view returns (address)`,
  `function sourceChainId() view returns (uint32)`,
  `function declaredHolderCount() view returns (uint32)`,
  `function wlBought(address) view returns (uint256)`,
  `function buyWithProof(bytes32[] proof, uint256 minTokensOut) payable returns (uint256 tokensOut)`,
  /// Whitelist lifecycle events — emitted for configuration + per-purchase.
  /// WL buyers receive tokens immediately in their wallet (no post-graduation
  /// claim step), so no separate Claimed event is needed.
  `event WhitelistConfigured(bytes32 root, uint256 reservedTokens, uint256 maxWlPerAddress, uint64 fallbackTs, address sourceTokenAddress, uint32 sourceChainId, uint32 declaredHolderCount)`,
  `event WlBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 wlPurchasedAfter)`,
] as const);

export const curveFactoryAbi = parseAbi([
  `function curveFor(address token) view returns (address)`,
  `function predictCurveAddress(address token) view returns (address)`,
  `function defaultCurveSupply() view returns (uint256)`,
  `function defaultGraduationTargetEth() view returns (uint256)`,
  `function defaultVirtualTokenReserve() view returns (uint256)`,
  `function defaultVirtualEthReserve() view returns (uint256)`,
  `function defaultTradeFeeBps() view returns (uint16)`,
] as const);

/// Same shape as `erc20FactoryAbi.predictAddress` — used for both ERC-721A + ERC-1155 factories.
export const nftFactoryAbi = parseAbi([
  `function implFor(bytes32 configHash) view returns (address)`,
  `function predictAddress(address launcher, string name, string ticker, bytes32 configHash) view returns (address)`,
] as const);

export const royaltyRouterFactoryAbi = parseAbi([
  `function IMPLEMENTATION() view returns (address)`,
  `function PLATFORM_BPS() view returns (uint16)`,
  `function platformSink() view returns (address)`,
  `function predictFor(address collection) view returns (address)`,
  `function deployFor(address collection, address launcherPayout) returns (address clone)`,
  `event RoyaltyRouterDeployed(address indexed collection, address indexed clone, address indexed launcherPayout, uint16 launcherBps, uint16 platformBps)`,
] as const);

export const royaltyRouterAbi = parseAbi([
  `function launcherPayout() view returns (address)`,
  `function platformSink() view returns (address)`,
  `function launcherBps() view returns (uint16)`,
  `function platformBps() view returns (uint16)`,
  `function setLauncherPayout(address newPayout)`,
  `function distributeStuck()`,
] as const);

/// V4SwapRouter — the post-graduation trade widget's write surface. PoolKey struct is
/// passed as a tuple; solidity-side selectors are `swapExactETHForToken((address,address,uint24,int24,address),uint256,address)`
/// and `swapExactTokenForETH((address,address,uint24,int24,address),uint256,uint256,address)`.
export const POOL_KEY_TUPLE =
  '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)' as const;

export const v4SwapRouterAbi = parseAbi([
  `function swapExactETHForToken(${POOL_KEY_TUPLE} key, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256 amountOut)`,
  `function swapExactTokenForETH(${POOL_KEY_TUPLE} key, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) returns (uint256 amountOut)`,
] as const);

/// Subset of Uniswap v4 `StateView` — enough to read a pool's current price + liquidity.
export const v4StateViewAbi = parseAbi([
  `function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)`,
  `function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)`,
] as const);

/// Subset of `NftRevenueVault` — enough to read epoch state + submit a claim.
/// `claim(epochId, amount, proof)` verifies against the on-chain merkleRoot via
/// solady MerkleProofLib; the frontend fetches (amount, proof) from
/// compile-service's /rewards routes and forwards them here.
export const nftRevenueVaultAbi = parseAbi([
  `function nextEpochId() view returns (uint256)`,
  `function epochs(uint256) view returns (bytes32 merkleRoot, uint256 totalAmount, uint256 unclaimed)`,
  `function isClaimed(uint256 epochId, address holder) view returns (bool)`,
  `function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof)`,
  // URU-A11: production vault uses propose/activate for epochs. Frontend reads
  // pendingEpoch to render "unlocks in Xh Ym" for allocations whose tree is
  // published off-chain but on-chain activation is still in the timelock window.
  `function pendingEpoch() view returns (uint256 expectedEpochId, bytes32 merkleRoot, uint256 totalAmount, uint64 readyAt)`,
] as const);

/// Ownable + module-specific owner reads/writes probed by the profile page's
/// "your tokens" widget. Owner detection: try each module's marker view — if it
/// reverts, that module isn't installed. Owner-write functions have `onlyOwner`
/// on-chain, so an unauthorized sender's tx reverts before it lands. See
/// `web/src/components/TokenOwnerControls.tsx`.
export const tokenOwnerAbi = parseAbi([
  // Ownable (present on every launched token)
  `function owner() view returns (address)`,
  `function transferOwnership(address newOwner)`,
  `function renounceOwnership()`,
  // Pausable
  `function pausablePaused() view returns (bool)`,
  `function pause()`,
  `function unpause()`,
  // AntiBot
  `function antiBotIsAllowed(address who) view returns (bool)`,
  `function antiBotGateEndsAtBlock() view returns (uint256)`,
  `function antiBotIsGated() view returns (bool)`,
  `function setAntiBotAllowed(address who, bool allowed)`,
  // AntiWhale
  `function antiWhaleConfig() view returns (uint128 maxWallet, uint128 maxTx, uint32 expiresAtBlock)`,
  `function antiWhaleIsExcluded(address who) view returns (bool)`,
  `function antiWhaleIsActive() view returns (bool)`,
  `function setAntiWhaleExcluded(address who, bool excluded)`,
] as const);

/// Public holder-facing module functions probed by `TokenHolderModules.tsx`.
/// Every marker view has a matching action write; the panel shows only the
/// modules whose marker view succeeds (allowFailure: true). Bare-ERC20 tokens
/// return failure across the board and the panel renders nothing.
///
/// Modules covered:
///   - Staking  → stakingRewardRate marker, stake/withdraw/claim actions
///   - Vesting  → vestingBeneficiary marker, vestingRelease action (beneficiary-only)
///   - Votes    → getVotes marker, delegate action
export const tokenHolderModulesAbi = parseAbi([
  // Staking module — Synthetix-style reward pool held at address(this).
  `function stakingRewardRate() view returns (uint256)`,
  `function stakingBalanceOf(address user) view returns (uint256)`,
  `function stakingEarned(address user) view returns (uint256)`,
  `function stakingTotalStaked() view returns (uint256)`,
  `function stakingPeriodFinish() view returns (uint64)`,
  `function stake(uint256 amount)`,
  `function stakingWithdraw(uint256 amount)`,
  `function stakingClaim()`,
  // Vesting module — single-beneficiary, linear cliff → end release.
  `function vestingBeneficiary() view returns (address)`,
  `function vestingTotal() view returns (uint256)`,
  `function vestingReleased() view returns (uint256)`,
  `function vestingReleasable() view returns (uint256)`,
  `function vestingCliffTimestamp() view returns (uint64)`,
  `function vestingEndTimestamp() view returns (uint64)`,
  `function vestingRelease()`,
  // ERC20Votes module — self-delegation required to activate voting power.
  `function getVotes(address account) view returns (uint256)`,
  `function delegates(address account) view returns (address)`,
  `function delegate(address delegatee)`,
  // Owner-restrictable module markers — surfaced by the risk banner so
  // buyers know the deployer still holds a lever. Not user actions; the
  // matching owner-writes live in tokenOwnerAbi and TokenOwnerControls.
  `function owner() view returns (address)`,
  `function pausablePaused() view returns (bool)`,
  `function antiBotIsGated() view returns (bool)`,
  `function antiWhaleIsActive() view returns (bool)`,
] as const);

/// GraduatorV2 — pull-based refund path. Every graduation credits any LP
/// residual to `claimableRefunds[launcher]`. Launchers pull with
/// `claimRefund()` (delivers to msg.sender) or `claimRefundTo(recipient)`
/// (for Safe-owned launchers that can't receive ETH directly). See the
/// `GraduatorRefund.tsx` panel on the profile page.
export const graduatorAbi = parseAbi([
  `function claimableRefunds(address launcher) view returns (uint256)`,
  `function totalClaimable() view returns (uint256)`,
  `function claimRefund()`,
  `function claimRefundTo(address recipient)`,
  `event RefundCredited(address indexed token, address indexed launcher, uint256 amount)`,
  `event RefundClaimed(address indexed launcher, address indexed recipient, uint256 amount)`,
] as const);

/// FeeSplitter — public status reads for the /flywheel dashboard. Sinks +
/// bps show where every launch fee goes; pendingConfig surfaces owner
/// proposals still in the URU-A11 2-day timelock. No write path (activation
/// is a multisig op via the safe UI, not urufulabs.xyz).
export const feeSplitterAbi = parseAbi([
  `function uruBuybackSink() view returns (address)`,
  `function nftRevenueSink() view returns (address)`,
  `function treasurySink() view returns (address)`,
  `function uruBuybackBps() view returns (uint16)`,
  `function nftRevenueBps() view returns (uint16)`,
  `function treasuryBps() view returns (uint16)`,
  `function minConfigDelay() view returns (uint256)`,
  `function pendingConfig() view returns (address uruBuybackSink, address nftRevenueSink, address treasurySink, uint16 uruBuybackBps, uint16 nftRevenueBps, uint16 treasuryBps, uint64 readyAt)`,
  `event Distributed(uint256 total, uint256 toBuyback, uint256 toNft, uint256 toTreasury)`,
] as const);

/// UruBuybackVault — public activity read for the flywheel dashboard.
/// `BuybackExecuted(ethIn, uruOut)` fires when the keeper routes accumulated
/// buyback ETH through the Universal Router into URU; totals prove the
/// flywheel is actually turning.
export const uruBuybackVaultAbi = parseAbi([
  `event BuybackExecuted(uint256 ethIn, uint256 uruOut)`,
] as const);

/// UruDepositSink — accumulates URU paid via launchWithURU + converts to
/// ETH periodically. Same dashboard read pattern as the buyback vault.
export const uruDepositSinkAbi = parseAbi([
  `event Deposited(address indexed from, uint256 amount)`,
  `event ConversionExecuted(uint256 uruIn, uint256 ethOut)`,
] as const);

/// Subset of `MultiHookHost` — the read + claim path the profile "creator
/// earnings" widget needs. `owed(currency, recipient)` is the accumulator the hook
/// credits during afterSwap; `claim(currency)` pulls msg.sender's whole balance
/// out. V1 hook: creator is a single immutable address (deploy wallet). V2 hook:
/// per-pool creators via setCreator — each launcher earns from their own tokens.
export const multiHookHostAbi = parseAbi([
  `function owed(address currency, address recipient) view returns (uint256)`,
  `function claim(address currency)`,
  `function platform() view returns (address)`,
  `function creator() view returns (address)`,
  /// GH-9 canonical per-pool rules. Populated at graduation-time
  /// `beforeInitialize`; `immutableAfterLaunch = true` freezes further
  /// writes. Read on the trade page to disclose creator fee %, anti-sniper
  /// remaining, and buyback-burn bps to post-graduation buyers.
  `function poolPolicy(bytes32 poolId) view returns (uint16 antiSniperBlocks, uint16 buybackBurnBps, uint16 platformFeeBps, uint16 creatorFeeBps, address creatorRecipient, uint64 launchBlock, bool immutableAfterLaunch)`,
] as const);

/// NFT stack — enums first, then the factory + mint module + ERC-721 ABIs.
/// Nested `DiscountTier[]` prevents a parseAbi one-liner; ABIs are spelled
/// out as objects and match the on-chain structs byte-for-byte.
export const NFT_MINT_MODE = { Fixed: 0, LinearStep: 1 } as const;
export const NFT_TIER_KIND = { WalletList: 0, ExternalNft: 1 } as const;
export const NFT_WL_FLAVOR = { Off: 0, Holders: 1, WalletList: 2 } as const;

export const nftLaunchFactoryAbi = [
  {
    type: 'function',
    name: 'launch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'ticker', type: 'string' },
          { name: 'baseURI', type: 'string' },
          { name: 'maxSupply', type: 'uint256' },
          { name: 'mintMode', type: 'uint8' },
          { name: 'basePriceWei', type: 'uint256' },
          { name: 'priceStepWei', type: 'uint256' },
          { name: 'discountFloorBps', type: 'uint256' },
          { name: 'perWalletMintCap', type: 'uint256' },
          { name: 'payWithUru', type: 'bool' },
          {
            name: 'tiers',
            type: 'tuple[]',
            components: [
              { name: 'kind', type: 'uint8' },
              { name: 'walletListRoot', type: 'bytes32' },
              { name: 'externalCollection', type: 'address' },
              { name: 'externalChainId', type: 'uint256' },
              { name: 'percentPerNftBps', type: 'uint256' },
              { name: 'maxCountedNfts', type: 'uint256' },
              { name: 'fixedDiscountBps', type: 'uint256' },
            ],
          },
          { name: 'wlFlavor', type: 'uint8' },
          { name: 'wlHoldersTarget', type: 'address' },
          { name: 'wlHoldersTargetChainId', type: 'uint256' },
          { name: 'wlHoldersMinCount', type: 'uint256' },
          { name: 'wlWalletListRoot', type: 'bytes32' },
          { name: 'wlWindowEnd', type: 'uint256' },
          { name: 'uruAmount', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'mintModule', type: 'address' },
      { name: 'whitelistModule', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'minUruFeeFor',
    stateMutability: 'view',
    inputs: [{ name: 'launcher', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'CollectionLaunched',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'launcher', type: 'address', indexed: true },
      { name: 'mintModule', type: 'address' },
      { name: 'whitelistModule', type: 'address' },
      { name: 'configHash', type: 'bytes32' },
      { name: 'uruPaid', type: 'uint256' },
      { name: 'name', type: 'string' },
      { name: 'ticker', type: 'string' },
    ],
  },
] as const;

export const nftMintModuleAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      { name: 'qty', type: 'uint256' },
      { name: 'wlProof', type: 'bytes32[]' },
      { name: 'wlCount', type: 'uint256' },
      { name: 'wlExpiry', type: 'uint256' },
      { name: 'wlSig', type: 'bytes' },
      {
        name: 'discountProofs',
        type: 'tuple[]',
        components: [
          { name: 'tierId', type: 'uint256' },
          { name: 'merkleProof', type: 'bytes32[]' },
          { name: 'count', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'sig', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintWithUru',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'qty', type: 'uint256' },
      { name: 'uruAmount', type: 'uint256' },
      { name: 'wlProof', type: 'bytes32[]' },
      { name: 'wlCount', type: 'uint256' },
      { name: 'wlExpiry', type: 'uint256' },
      { name: 'wlSig', type: 'bytes' },
      {
        name: 'discountProofs',
        type: 'tuple[]',
        components: [
          { name: 'tierId', type: 'uint256' },
          { name: 'merkleProof', type: 'bytes32[]' },
          { name: 'count', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
          { name: 'sig', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'launcher', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paymentToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'basePriceWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'priceStepWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mintMode', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'discountFloorBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'perWalletMintCap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'whitelistModule', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'grossPriceFor',
    stateMutability: 'view',
    inputs: [{ name: 'qty', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'launcherBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'launcherBalanceUru', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawUru',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

export const nftErc721Abi = [
  { type: 'function', name: 'totalMinted', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'baseURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
