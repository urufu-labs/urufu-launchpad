import { onchainTable, relations } from '@ponder/core';

/// A single launch through Router.launch. Correlates the NameRegistry reservation with the
/// factory deploy — the two events fire in the same tx and share a token address.
export const launches = onchainTable('launches', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${tokenAddress}`
  chainId: t.integer().notNull(),
  tokenAddress: t.hex().notNull(),
  launchedBy: t.hex().notNull(),
  base: t.integer().notNull(),                     // 0=ERC20, 1=ERC721A, 2=ERC1155
  nameHash: t.hex().notNull(),
  tickerHash: t.hex().notNull(),
  name: t.text().notNull(),
  ticker: t.text().notNull(),
  configHash: t.hex().notNull(),
  impl: t.hex(),                                   // set from factory.Deployed correlated event
  feePaid: t.bigint().notNull(),
  /// GH-13 field cleanup — the Router `Launched` event's `installedHook` /
  /// `installedGovernance` flags describe what the launcher REQUESTED, not what
  /// is factually on-chain post-launch. The legacy columns below are kept as-is
  /// so existing GraphQL consumers (web/) keep working; the new `requestedHook`
  /// / `requestedGovernance` columns are the honest names for the same event
  /// data, and the REST `/api/launches/:token` endpoint additionally exposes an
  /// `installedHook` field derived from on-chain state (a `poolPolicy` row
  /// exists for the token's pool AND `immutableAfterLaunch == true`, both of
  /// which happen atomically inside MHH.beforeInitialize when the wired
  /// initializer opens the pool). Dual-write keeps every consumer happy —
  /// legacy queries see the same field, new consumers get the disambiguated
  /// pair through the REST layer.
  installedHook: t.boolean().notNull(),
  installedGovernance: t.boolean().notNull(),
  requestedHook: t.boolean().notNull().default(false),
  requestedGovernance: t.boolean().notNull().default(false),
  installedBondingCurve: t.boolean().notNull(),    // set from Router:CurveInstalled event
  curveAddress: t.hex(),                           // populated when a bonding curve is installed
  /// "ETH" (default) or "URU" — set to "URU" by Router:LaunchedInURU handler for URU-paid
  /// launches. Discover / analytics filter on this without touching on-chain state.
  payToken: t.text().notNull().default('ETH'),
  /// Amount of URU pulled from the launcher when payToken == 'URU'. Null for ETH launches.
  uruPaid: t.bigint(),
  /// True for launches that installed a whitelist via launchWithWhitelist /
  /// launchWithURUAndWhitelist. Full WL config lives on the curves row (populated
  /// via BondingCurve:WhitelistConfigured); this boolean is the fast filter for
  /// discover-page "WL only" queries without a join.
  hasWhitelist: t.boolean().notNull().default(false),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// One row per launched BondingCurve. Live state (ethReserve, tokenReserve, graduated) is
/// updated on every Trade + the Graduated event. Immutable init params come from CurveInitialized.
export const curves = onchainTable('curves', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${curveAddress}`
  chainId: t.integer().notNull(),
  curveAddress: t.hex().notNull(),
  tokenAddress: t.hex().notNull(),
  feeReceiver: t.hex().notNull(),
  curveSupply: t.bigint().notNull(),
  virtualTokenReserve: t.bigint().notNull(),
  virtualEthReserve: t.bigint().notNull(),
  graduationTargetEth: t.bigint().notNull(),
  tradeFeeBps: t.integer().notNull(),
  ethReserve: t.bigint().notNull(),
  tokenReserve: t.bigint().notNull(),
  tradeCount: t.integer().notNull(),
  graduated: t.boolean().notNull(),
  graduatedAt: t.bigint(),                         // block timestamp when Graduated fired
  /// Whitelist state — populated by BondingCurve:WhitelistConfigured on WL launches.
  /// Non-WL curves keep the default values. `wlSold` + `wlHeldTotal` are running
  /// tallies maintained by WlBought / WlClaimed handlers so the trade page can render
  /// a fill % progress bar without an extra on-chain call.
  hasWhitelist: t.boolean().notNull().default(false),
  whitelistRoot: t.hex(),
  reservedTokens: t.bigint().notNull().default(0n),
  maxWlPerAddress: t.bigint().notNull().default(0n),
  fallbackTs: t.bigint().notNull().default(0n),
  sourceTokenAddress: t.hex(),
  sourceChainId: t.integer().notNull().default(0),
  declaredHolderCount: t.integer().notNull().default(0),
  wlSold: t.bigint().notNull().default(0n),
  wlHeldTotal: t.bigint().notNull().default(0n),
  createdAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/// Per-buyer WL purchase — one row per `buyWithProof` call. Powers trade-page WL
/// activity feed + per-buyer holding lookups pre-graduation.
export const wlPurchases = onchainTable('wl_purchases', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  curveAddress: t.hex().notNull(),
  tokenAddress: t.hex().notNull(),
  buyer: t.hex().notNull(),
  ethIn: t.bigint().notNull(),
  tokensOut: t.bigint().notNull(),
  /// Running total of WL-held tokens for this buyer at this curve after the buy.
  /// Denormalized so a query for "current WL holdings" only needs the latest row.
  wlPurchasedAfter: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Per-buyer post-graduation WL claim — one row per `claimWl` call.
export const wlClaims = onchainTable('wl_claims', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  curveAddress: t.hex().notNull(),
  tokenAddress: t.hex().notNull(),
  buyer: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Per-trade row. Powers the chart candles + recent-trades feed on the trade page.
export const trades = onchainTable('trades', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  curveAddress: t.hex().notNull(),
  tokenAddress: t.hex().notNull(),
  trader: t.hex().notNull(),
  isBuy: t.boolean().notNull(),
  ethAmount: t.bigint().notNull(),
  tokenAmount: t.bigint().notNull(),
  ethReserveAfter: t.bigint().notNull(),
  tokenReserveAfter: t.bigint().notNull(),
  priceWeiPerToken: t.bigint().notNull(),          // realized price of this trade
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Per-swap row for Uniswap v4 pools spawned by graduation. Same shape as `trades` for
/// symmetry — the frontend can merge both when building the chart / live rail. `poolId` is
/// the v4 PoolKey hash; `tokenAddress` is looked up from the graduations table when the
/// swap fires so the frontend can filter by token without an extra join.
export const v4Swaps = onchainTable('v4_swaps', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  poolId: t.hex().notNull(),                       // v4 PoolKey hash
  tokenAddress: t.hex(),                           // resolved via graduations lookup; null if unknown
  sender: t.hex().notNull(),
  amount0: t.bigint().notNull(),                   // signed; negative = pool paid out
  amount1: t.bigint().notNull(),
  sqrtPriceX96: t.bigint().notNull(),
  liquidity: t.bigint().notNull(),
  tick: t.integer().notNull(),
  fee: t.integer().notNull(),
  priceWeiPerToken: t.bigint().notNull(),          // derived from sqrtPriceX96
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// One row per curve that has graduated. Useful for the "graduated" filter + trophy list.
/// `poolId` is computed at graduation time from the known PoolKey (ETH + token + fixed
/// fee/tickSpacing/hook) so the v4Swaps handler can reverse-look-up a swap's token by
/// poolId without an expensive scan. Populated only when NEXT_PUBLIC_MULTI_HOOK_HOST_ADDRESS
/// is set for the graduating chain — otherwise stays null and v4 swaps stay orphaned.
export const graduations = onchainTable('graduations', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${curveAddress}`
  chainId: t.integer().notNull(),
  curveAddress: t.hex().notNull(),
  tokenAddress: t.hex().notNull(),
  poolId: t.hex(),                                 // keccak256(abi.encode(PoolKey))
  /// MultiHookHost address that was used at pool initialization for this graduation.
  /// Persisted per-row so that a future hook redeploy (e.g. MultiHookHost v2 with
  /// per-pool creator addresses) doesn't break trade pages for tokens that graduated
  /// against the OLD hook — the frontend reads this to compute poolId + route
  /// claim/read calls to the correct hook contract per token.
  hookAddress: t.hex(),
  ethReserveFinal: t.bigint().notNull(),
  tokenReserveFinal: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Per-holder balance snapshots for launched tokens. ERC-20 only for now; NFTs get a separate
/// table when their handlers land.
export const holders = onchainTable('holders', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${tokenAddress}-${holderAddress}`
  chainId: t.integer().notNull(),
  tokenAddress: t.hex().notNull(),
  holderAddress: t.hex().notNull(),
  balance: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/// V4SwapRouter.Swapped rows — one per post-graduation trade done through our router.
/// Complements `v4Swaps` (which is indexed at the PoolManager level where `sender` is
/// the router itself, not the user). This table's `user` field is the actual EOA that
/// initiated the swap — used by the profile page to list a wallet's post-grad activity.
export const v4RouterSwaps = onchainTable('v4_router_swaps', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  user: t.hex().notNull(),                         // the wallet that initiated the swap
  tokenAddress: t.hex().notNull(),                 // ERC20 token side of the pool
  isBuy: t.boolean().notNull(),                    // true = user paid ETH → got tokens
  amountIn: t.bigint().notNull(),                  // ETH in (buy) OR tokens in (sell)
  amountOut: t.bigint().notNull(),                 // tokens out (buy) OR ETH out (sell)
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Per-token transfer log. Powers the "recent transfers" widget on the token page.
export const transfers = onchainTable('transfers', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  tokenAddress: t.hex().notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

// =========================================================
// Flywheel visibility tables — MultiHookHost + FeeSplitter + UruBuybackVault
// + UruDepositSink events. Wired for chains where those contracts are deployed
// (RH V2 today). Non-flywheel chains simply never populate these tables.
// =========================================================

/// PoolConfigSet — per-pool anti-sniper + buyback-burn config on the MultiHookHost.
/// One row per pool (identified by v4 PoolId). Upserted on each PoolConfigSet event
/// so the latest values reflect current on-chain config.
export const hookConfigs = onchainTable('hook_configs', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${hookAddress}-${poolId}`
  chainId: t.integer().notNull(),
  hookAddress: t.hex().notNull(),
  poolId: t.hex().notNull(),
  antiSniperBlocks: t.integer().notNull(),
  buybackBurnBps: t.integer().notNull(),
  updatedAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// GH-13: aggregator-facing per-pool policy snapshot. One row per (chain,
/// poolId) — populated exactly once by the MHH.HookPolicySet event that fires
/// atomically inside `beforeInitialize`. Post-launch the on-chain struct is
/// frozen (any second write reverts `MultiHookHost__PolicyFrozen(poolId)`), so
/// this row's data matches on-chain state indefinitely.
///
/// Aggregators / block explorers consume this table (or its GraphQL projection
/// + the REST `/api/launches/:token` launch-card) instead of stitching
/// PoolConfigSet + CreatorSet + hook constants together. All eight struct
/// fields from `MultiHookHost.PoolPolicy` are stored 1:1 so the schema maps
/// straight onto the on-chain ABI.
export const poolPolicy = onchainTable('pool_policy', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${poolId}`
  chainId: t.integer().notNull(),
  poolId: t.hex().notNull(),
  hookAddress: t.hex().notNull(),                  // the MHH that emitted this event
  antiSniperBlocks: t.integer().notNull(),         // uint16 on-chain, safe in JS integer
  buybackBurnBps: t.integer().notNull(),           // uint16
  platformFeeBps: t.integer().notNull(),           // uint16
  creatorFeeBps: t.integer().notNull(),            // uint16
  creatorRecipient: t.hex().notNull(),             // address; 0x0 means the constructor fallback creator
  launchBlock: t.bigint().notNull(),               // uint64 on-chain; bigint here to survive the widening
  immutableAfterLaunch: t.boolean().notNull(),     // always true when this row exists — the flag is what freezes further writes
  emittedAtBlock: t.bigint().notNull(),            // block that emitted HookPolicySet — matches launchBlock in practice
  emittedAtTxHash: t.hex().notNull(),
}));

/// Per-currency running fee accrual on a MultiHookHost. Every FeeAccrued event
/// splits the swap fee into a platform share (routed to FeeSplitter) and a
/// creator share (claimable via FeeClaimed).
export const hookFees = onchainTable('hook_fees', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  hookAddress: t.hex().notNull(),
  currency: t.hex().notNull(),                     // v4 Currency (token addr; 0x0 = ETH)
  platformShare: t.bigint().notNull(),
  creatorShare: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// FeeClaimed — creator (or platform) pulls accrued fees from the hook. One row
/// per claim call. `to` is the destination address of the withdrawal.
export const hookFeeClaims = onchainTable('hook_fee_claims', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  hookAddress: t.hex().notNull(),
  currency: t.hex().notNull(),
  to: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// BuybackBurned — MultiHookHost's per-pool buyback-burn slice sending tokens
/// (or ETH) to the burn address. One row per fired event.
export const hookBurns = onchainTable('hook_burns', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  hookAddress: t.hex().notNull(),
  currency: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// FeeReceived — ETH landing in the FeeSplitter, from either a Router launch fee
/// or the UruDepositSink URU→ETH conversion. `base` mirrors BaseType (0=ERC20,
/// 1=ERC721A, 2=ERC1155); launcher is the source launch's `launchedBy`.
export const flywheelReceipts = onchainTable('flywheel_receipts', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  splitter: t.hex().notNull(),
  launcher: t.hex().notNull(),
  base: t.integer().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Distributed — FeeSplitter's 40/35/25 (buyback/nft/treasury) fan-out. Total
/// equals sum of the three splits. Powers dashboards showing "buyback pressure",
/// "NFT holder distributions", and "treasury inflow" over time.
export const flywheelDistributions = onchainTable('flywheel_distributions', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  splitter: t.hex().notNull(),
  total: t.bigint().notNull(),
  toBuyback: t.bigint().notNull(),
  toNft: t.bigint().notNull(),
  toTreasury: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// BuybackExecuted — UruBuybackVault swap of ETH into URU (via allowlisted
/// UniversalRouter target). ethIn is the ETH consumed from the vault; uruOut
/// is the URU sent to the distribution sink.
export const uruBuybacks = onchainTable('uru_buybacks', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  vault: t.hex().notNull(),
  ethIn: t.bigint().notNull(),
  uruOut: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// UruDepositSink.Deposited — URU landing in the sink from URU-paid launches.
/// One row per RouterV2.launchWithURU (or launchWithURUAndWhitelist) call — the
/// launcher pays URU, RouterV2 forwards it to the sink for later conversion.
export const uruSinkDeposits = onchainTable('uru_sink_deposits', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  sink: t.hex().notNull(),
  from: t.hex().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// UruDepositSink.ConversionExecuted — the sink's URU→ETH swap (via allowlisted
/// UniversalRouter). ethOut lands in the FeeSplitter (see FeeReceived) so the
/// same 40/35/25 fan-out covers both ETH-paid AND URU-paid launches.
export const uruSinkConversions = onchainTable('uru_sink_conversions', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  sink: t.hex().notNull(),
  uruIn: t.bigint().notNull(),
  ethOut: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// NFT collections launched through the Router (phase-0 scaffolding).
///
/// Populated once ERC721Factory registers impls + NftMintModule ships. Ponder
/// handlers for these tables are still stubbed — the shape is defined here
/// first so the web/ API layer can compile against real types (empty results
/// today, real rows after contracts land).
///
/// One row per NFT collection deploy. `mintMode` is 0=fixed, 1=linearStep;
/// pricing fields are interpreted per-mode. `wlRoot == 0x00…` means public
/// mint from block 0.
export const nftCollections = onchainTable('nft_collections', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${collectionAddress}`
  chainId: t.integer().notNull(),
  collectionAddress: t.hex().notNull(),
  launchedBy: t.hex().notNull(),
  name: t.text().notNull(),
  ticker: t.text().notNull(),
  baseUri: t.text().notNull(),
  maxSupply: t.bigint().notNull(),
  mintMode: t.integer().notNull(),                 // 0=fixed, 1=linearStep
  basePriceWei: t.bigint().notNull(),
  priceStepWei: t.bigint().notNull().default(0n),
  wlRoot: t.hex().notNull(),                       // 0x00… means "no WL"
  wlOpenWindowSec: t.integer().notNull().default(0),
  mintedCount: t.bigint().notNull().default(0n),   // updated on Mint events
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/// Individual mint events on an NFT collection. Used to render the recent-mint
/// feed on the /collection/[address] page and to derive per-holder counts.
export const nftMints = onchainTable('nft_mints', (t) => ({
  id: t.text().primaryKey(),                       // `${chainId}-${txHash}-${logIndex}`
  chainId: t.integer().notNull(),
  collectionAddress: t.hex().notNull(),
  minter: t.hex().notNull(),
  tokenId: t.bigint().notNull(),
  quantity: t.integer().notNull(),
  pricePaidWei: t.bigint().notNull(),              // per-token price actually paid (post-discount)
  wlUsed: t.boolean().notNull().default(false),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const launchesRelations = relations(launches, ({ many, one }) => ({
  holders: many(holders),
  transfers: many(transfers),
  curve: one(curves, {
    fields: [launches.curveAddress],
    references: [curves.curveAddress],
  }),
}));

export const curvesRelations = relations(curves, ({ many, one }) => ({
  trades: many(trades),
  launch: one(launches, {
    fields: [curves.tokenAddress],
    references: [launches.tokenAddress],
  }),
}));

export const tradesRelations = relations(trades, ({ one }) => ({
  curve: one(curves, {
    fields: [trades.curveAddress],
    references: [curves.curveAddress],
  }),
}));

export const holdersRelations = relations(holders, ({ one }) => ({
  launch: one(launches, {
    fields: [holders.tokenAddress],
    references: [launches.tokenAddress],
  }),
}));

export const transfersRelations = relations(transfers, ({ one }) => ({
  launch: one(launches, {
    fields: [transfers.tokenAddress],
    references: [launches.tokenAddress],
  }),
}));

/// GH-13: relate a poolPolicy row to the graduation that opened its pool. Join
/// key is v4 `poolId` — set on the graduations row at Graduated-event time from
/// `computeV4PoolId(token, hookHost)` so the REST launch-card can hop
/// `launches → curves → graduations → poolPolicy` without knowing the poolId
/// directly. `one()` on both sides because a poolId is unique per graduated
/// token AND unique per policy row.
export const graduationsRelations = relations(graduations, ({ one }) => ({
  policy: one(poolPolicy, {
    fields: [graduations.poolId],
    references: [poolPolicy.poolId],
  }),
}));

export const poolPolicyRelations = relations(poolPolicy, ({ one }) => ({
  graduation: one(graduations, {
    fields: [poolPolicy.poolId],
    references: [graduations.poolId],
  }),
}));
