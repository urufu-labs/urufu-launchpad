// Fair launch lane handlers (docs/SPEC-fair-launch.md). Event sources only, no
// block-interval jobs. Curve Trade / Graduated reuse the token lane's tables so
// the trade page chart and holders logic work unchanged.
import { ponder } from '@/generated';
import { decodeAbiParameters } from 'viem';
import { eq } from '@ponder/core';

import {
  curves, trades, graduations, v4Swaps, hookFees, hookFeeClaims, hookBurns, fairLaunches, fairDeposits,
} from '../ponder.schema.ts';
import { fairHookHostForChainId, poolManagerForChainId } from '../chains';
import { V4_SWAP_TOPIC0, computeEthPoolId } from '../poolId';

type Hex = `0x${string}`;
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

function chainIdOf(context: { network?: { chainId: unknown } | undefined }): number {
  const raw = context.network?.chainId;
  if (typeof raw !== 'number') throw new Error('ponder: missing network.chainId in event context');
  return raw;
}

// Narrow structural type for the bits of the Ponder context these helpers use.
type Db = {
  db: {
    sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    insert: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  network?: { chainId: unknown };
};

type FairLaunchRow = typeof fairLaunches.$inferSelect;

async function launchBy(context: Db, col: 'curve' | 'batch' | 'pool', value: Hex): Promise<FairLaunchRow | undefined> {
  const column =
    col === 'curve' ? fairLaunches.curveAddress : col === 'batch' ? fairLaunches.batchAddress : fairLaunches.poolId;
  const rows = (await context.db.sql.select().from(fairLaunches).where(eq(column, value)).limit(1)) as FairLaunchRow[];
  return rows[0];
}

async function recordBurn(
  context: Db,
  event: { log: { address: Hex; logIndex: number }; block: { number: bigint; timestamp: bigint }; transaction: { hash: Hex } },
  currency: Hex,
  amount: bigint,
) {
  const chainId = chainIdOf(context);
  await context.db.insert(hookBurns).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    hookAddress: event.log.address,
    currency,
    amount,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
}

// ================================================================ factory

ponder.on('FairLaunchFactory:FairLaunched', async ({ event, context }) => {
  const a = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(fairLaunches).values({
    id: `${chainId}-${a.token.toLowerCase()}`,
    chainId,
    tokenAddress: a.token,
    curveAddress: a.curve,
    batchAddress: a.batch,
    launcher: a.launcher,
    name: a.name,
    ticker: a.symbol,
    curveSupply: a.curveSupply,
    batchCapTokens: a.batchCapTokens,
    batchCloseTs: a.batchCloseTs,
    creatorDeposit: a.creatorDeposit,
    // The creator's deposit (if any) is the only one that can land in the launch tx.
    totalDeposited: a.creatorDeposit,
    depositorCount: a.creatorDeposit > 0n ? 1 : 0,
    settled: false,
    creatorSold: false,
    graduated: false,
    forfeited: false,
    sniperTaxBurnedTokens: 0n,
    sniperTaxBankedEth: 0n,
    creatorFeeBurnedTokens: 0n,
    creatorFeeBankedEth: 0n,
    bankBurnedEth: 0n,
    bankBurnedTokens: 0n,
    createdAt: event.block.timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

// ================================================================ curve

ponder.on('FairBondingCurve:CurveInitialized', async ({ event, context }) => {
  const a = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  await context.db.insert(curves).values({
    id: `${chainId}-${curveAddress.toLowerCase()}`,
    chainId,
    curveAddress,
    tokenAddress: a.token,
    feeReceiver: a.feeReceiver,
    curveSupply: a.curveSupply,
    virtualTokenReserve: a.virtualTokenReserve,
    virtualEthReserve: a.virtualEthReserve,
    graduationTargetEth: a.graduationTargetEth,
    tradeFeeBps: Number(a.tradeFeeBps),
    ethReserve: 0n,
    tokenReserve: a.curveSupply,
    tradeCount: 0,
    graduated: false,
    graduatedAt: null,
    createdAt: event.block.timestamp,
    updatedAt: event.block.timestamp,
  }).onConflictDoNothing();
});

ponder.on('FairBondingCurve:Trade', async ({ event, context }) => {
  const { trader, isBuy, ethAmount, tokenAmount, ethReserve, tokenReserve } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;
  const curve = await context.db.find(curves, { id: curveId });
  await context.db.insert(trades).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    curveAddress,
    tokenAddress: curve?.tokenAddress ?? ZERO,
    trader,
    isBuy,
    ethAmount,
    tokenAmount,
    ethReserveAfter: ethReserve,
    tokenReserveAfter: tokenReserve,
    priceWeiPerToken: tokenAmount > 0n ? (ethAmount * 10n ** 18n) / tokenAmount : 0n,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
  if (curve) {
    await context.db.update(curves, { id: curveId }).set({
      ethReserve,
      tokenReserve,
      tradeCount: curve.tradeCount + 1,
      updatedAt: event.block.timestamp,
    });
  }
});

ponder.on('FairBondingCurve:CreatorSold', async ({ event, context }) => {
  const row = await launchBy(context, 'curve', event.log.address);
  if (row) await context.db.update(fairLaunches, { id: row.id }).set({ creatorSold: true });
});

ponder.on('FairBondingCurve:Graduated', async ({ event, context }) => {
  const { ethReserve, tokenReserve } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;
  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ZERO;
  const hook = fairHookHostForChainId(chainId);
  const poolId = hook && tokenAddress !== ZERO ? computeEthPoolId(tokenAddress, hook) : null;

  await context.db.insert(graduations).values({
    id: curveId,
    chainId,
    curveAddress,
    tokenAddress,
    poolId,
    hookAddress: hook ?? null,
    ethReserveFinal: ethReserve,
    tokenReserveFinal: tokenReserve,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
  if (curve) {
    await context.db.update(curves, { id: curveId }).set({
      graduated: true,
      graduatedAt: event.block.timestamp,
      ethReserve,
      tokenReserve,
      updatedAt: event.block.timestamp,
    });
  }
  const row = await launchBy(context, 'curve', curveAddress);
  if (row) {
    await context.db.update(fairLaunches, { id: row.id }).set({
      graduated: true,
      graduatedAt: event.block.timestamp,
      poolId: row.poolId ?? poolId,
      hookAddress: row.hookAddress ?? hook ?? null,
    });
  }
});

// ================================================================ opening batch

ponder.on('OpeningBatch:Deposited', async ({ event, context }) => {
  const { user, amount, userTotal, batchTotal } = event.args;
  const chainId = chainIdOf(context);
  const batchAddress = event.log.address;
  await context.db.insert(fairDeposits).values({
    id: `${chainId}-${batchAddress.toLowerCase()}-${user.toLowerCase()}`,
    chainId,
    batchAddress,
    user,
    deposited: userTotal,
    claimed: false,
    updatedAt: event.block.timestamp,
  }).onConflictDoUpdate({ deposited: userTotal, updatedAt: event.block.timestamp });
  // The creator's deposit inside the launch tx fires before FairLaunched, so the
  // row may not exist yet; FairLaunched seeds the totals from creatorDeposit.
  const row = await launchBy(context, 'batch', batchAddress);
  if (row) {
    await context.db.update(fairLaunches, { id: row.id }).set({
      totalDeposited: batchTotal,
      depositorCount: userTotal === amount ? row.depositorCount + 1 : row.depositorCount,
    });
  }
});

ponder.on('OpeningBatch:Settled', async ({ event, context }) => {
  const { ethSpent, tokensBought, ethRefund, totalEth } = event.args;
  const row = await launchBy(context, 'batch', event.log.address);
  if (!row) return;
  await context.db.update(fairLaunches, { id: row.id }).set({
    settled: true,
    settledAt: event.block.timestamp,
    totalDeposited: totalEth,
    tokensBought,
    ethSpent,
    ethRefund,
  });
});

ponder.on('OpeningBatch:Claimed', async ({ event, context }) => {
  const { user, tokens, ethRefund } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${event.log.address.toLowerCase()}-${user.toLowerCase()}`;
  const dep = await context.db.find(fairDeposits, { id });
  if (!dep) return;
  await context.db.update(fairDeposits, { id }).set({
    claimed: true,
    tokensClaimed: tokens,
    refundClaimed: ethRefund,
    updatedAt: event.block.timestamp,
  });
});

// ================================================================ hook

ponder.on('FairHookHost:FairPoolInitialized', async ({ event, context }) => {
  const a = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${a.token.toLowerCase()}`;
  const row = await context.db.find(fairLaunches, { id });
  if (!row) return;
  await context.db.update(fairLaunches, { id }).set({
    poolId: a.poolId,
    hookAddress: event.log.address,
    poolLaunchTs: a.launchTs,
    taxStartBps: Number(a.taxStartBps),
    taxDecaySecs: Number(a.taxDecaySecs),
    forfeitDropBps: Number(a.forfeitDropBps),
    creatorBaseline: a.creatorBaseline,
    forfeited: row.forfeited || a.forfeited,
    forfeitedAt: a.forfeited && !row.forfeited ? event.block.timestamp : row.forfeitedAt,
  });
});

ponder.on('FairHookHost:FeeAccrued', async ({ event, context }) => {
  const { poolId, currency, platformShare, creatorShare } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(hookFees).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    hookAddress: event.log.address,
    currency,
    platformShare,
    creatorShare,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  // Pull the PoolManager Swap log for this pool out of the same receipt so every
  // Fair-pool swap lands in v4_swaps, whatever router sent it (Uniswap app,
  // aggregators, our V4SwapRouter). Same id shape as the PoolManager:Swap
  // handler, so a site-router swap seen by both stays one row.
  const pm = poolManagerForChainId(chainId)?.toLowerCase();
  const receipt = event.transactionReceipt;
  if (!pm || !receipt) return;
  const row = await launchBy(context, 'pool', poolId);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pm || log.topics[0] !== V4_SWAP_TOPIC0) continue;
    if ((log.topics[1] ?? '').toLowerCase() !== poolId.toLowerCase()) continue;
    const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = decodeAbiParameters(
      [
        { type: 'int128' }, { type: 'int128' }, { type: 'uint160' },
        { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' },
      ],
      log.data,
    );
    const sq = sqrtPriceX96 * sqrtPriceX96;
    await context.db.insert(v4Swaps).values({
      id: `${chainId}-${log.transactionHash}-${Number(log.logIndex)}`,
      chainId,
      poolId,
      tokenAddress: row?.tokenAddress ?? null,
      sender: `0x${(log.topics[2] ?? '0x').slice(26)}` as Hex,
      amount0,
      amount1,
      sqrtPriceX96,
      liquidity,
      tick: Number(tick),
      fee: Number(fee),
      priceWeiPerToken: sq > 0n ? ((10n ** 18n) << 192n) / sq : 0n,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    }).onConflictDoNothing();
  }
});

ponder.on('FairHookHost:FeeClaimed', async ({ event, context }) => {
  const { currency, to, amount } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(hookFeeClaims).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    hookAddress: event.log.address,
    currency,
    to,
    amount,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

ponder.on('FairHookHost:SniperTaxBurned', async ({ event, context }) => {
  const { poolId, tokenAmount } = event.args;
  const row = await launchBy(context, 'pool', poolId);
  if (!row) return;
  await recordBurn(context, event, row.tokenAddress, tokenAmount);
  await context.db.update(fairLaunches, { id: row.id }).set({
    sniperTaxBurnedTokens: row.sniperTaxBurnedTokens + tokenAmount,
  });
});

ponder.on('FairHookHost:SniperTaxBanked', async ({ event, context }) => {
  const { poolId, ethAmount } = event.args;
  const row = await launchBy(context, 'pool', poolId);
  if (!row) return;
  await context.db.update(fairLaunches, { id: row.id }).set({
    sniperTaxBankedEth: row.sniperTaxBankedEth + ethAmount,
  });
});

ponder.on('FairHookHost:CreatorFeeBurned', async ({ event, context }) => {
  const { poolId, currency, amount } = event.args;
  const row = await launchBy(context, 'pool', poolId);
  if (!row) return;
  if (currency === ZERO) {
    await context.db.update(fairLaunches, { id: row.id }).set({
      creatorFeeBankedEth: row.creatorFeeBankedEth + amount,
    });
  } else {
    await recordBurn(context, event, currency, amount);
    await context.db.update(fairLaunches, { id: row.id }).set({
      creatorFeeBurnedTokens: row.creatorFeeBurnedTokens + amount,
    });
  }
});

ponder.on('FairHookHost:CreatorFeeForfeited', async ({ event, context }) => {
  const row = await launchBy(context, 'pool', event.args.poolId);
  if (!row || row.forfeited) return;
  await context.db.update(fairLaunches, { id: row.id }).set({
    forfeited: true,
    forfeitedAt: event.block.timestamp,
  });
});

ponder.on('FairHookHost:BankBurned', async ({ event, context }) => {
  const { poolId, ethIn, tokensBurned } = event.args;
  const row = await launchBy(context, 'pool', poolId);
  if (!row) return;
  await recordBurn(context, event, row.tokenAddress, tokensBurned);
  await context.db.update(fairLaunches, { id: row.id }).set({
    bankBurnedEth: row.bankBurnedEth + ethIn,
    bankBurnedTokens: row.bankBurnedTokens + tokensBurned,
  });
});
