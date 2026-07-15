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
  installedHook: t.boolean().notNull(),
  installedGovernance: t.boolean().notNull(),
  installedBondingCurve: t.boolean().notNull(),    // set from Router:CurveInstalled event
  curveAddress: t.hex(),                           // populated when a bonding curve is installed
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
  createdAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
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
