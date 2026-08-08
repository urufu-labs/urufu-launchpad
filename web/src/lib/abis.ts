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
  `function wlHeldForUser(address) view returns (uint256)`,
  `function wlHeldTotal() view returns (uint256)`,
  `function buyWithProof(bytes32[] proof, uint256 minTokensOut) payable returns (uint256 tokensOut)`,
  `function claimWl() returns (uint256 amount)`,
  /// Whitelist lifecycle events — emitted by WL-aware curves for
  /// configuration, per-purchase, and hold-until-graduation claim.
  `event WhitelistConfigured(bytes32 root, uint256 reservedTokens, uint256 maxWlPerAddress, uint64 fallbackTs, address sourceTokenAddress, uint32 sourceChainId, uint32 declaredHolderCount)`,
  `event WlBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 wlPurchasedAfter)`,
  `event WlClaimed(address indexed buyer, uint256 amount)`,
] as const);

export const curveFactoryAbi = parseAbi([
  `function curveFor(address token) view returns (address)`,
  `function predictCurveAddress(address token) view returns (address)`,
  `function defaultCurveSupply() view returns (uint256)`,
  `function defaultGraduationTargetEth() view returns (uint256)`,
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
] as const);
