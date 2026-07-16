// @ponder/core@0.7.x exposes the `ponder` singleton via the '@/generated' virtual module
// (Vite plugin at @ponder/core/src/build/plugin.ts). The 'ponder:registry' name is 0.8+.
import { ponder } from '@/generated';
import { keccak256, encodeAbiParameters } from 'viem';
import { eq } from '@ponder/core';

import { launches, curves, trades, v4Swaps, v4RouterSwaps, graduations, holders, transfers } from '../ponder.schema.ts';
import { hookHostForChainId } from '../chains';

/// Ponder's multi-network context.network union is `{ name, chainId }` for each
/// enabled chain, but TS widens `chainId` to `unknown` and marks the union member
/// optional. Every event we handle has a network, so we assert non-null + coerce
/// to number in one place so handler bodies stay clean.
function chainIdOf(context: { network?: { chainId: unknown } | undefined }): number {
  const raw = context.network?.chainId;
  if (typeof raw !== 'number') throw new Error('ponder: missing network.chainId in event context');
  return raw;
}

/// v4 PoolKey → PoolId. Every launchpad graduation opens an ETH/token pool with the
/// same fixed fee + tick spacing + MultiHookHost hook — so given the token address we
/// can derive the exact poolId the PoolManager will emit `Swap` events for. Used at
/// graduation time so the v4 Swap handler can join `v4Swaps.poolId → graduations.poolId
/// → tokenAddress` in O(1).
function computeV4PoolId(tokenAddress: `0x${string}`, hookAddress: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, // currency0 = ETH (0x0)
        { type: 'address' }, // currency1 = token
        { type: 'uint24' }, // fee
        { type: 'int24' }, // tickSpacing
        { type: 'address' }, // hooks
      ],
      ['0x0000000000000000000000000000000000000000', tokenAddress, 3000, 60, hookAddress],
    ),
  );
}

// =========================================================
// Launch pipeline — three correlated events per launch tx, plus an optional fourth for
// bonding-curve launches. Ordering inside the tx (log-index order):
//   1. NameRegistry.Reserved       (fires FIRST — NameRegistry.reserve is called before Router emits Launched)
//   2. <BaseType>Factory.Deployed
//   3. Router.Launched             (fires LAST — this is where we have the full launcher/base/feePaid picture)
//   4. Router.CurveInstalled       (only when installBondingCurve == true)
//
// Because Router:Launched is the last event with all the notNull columns known, it does the
// INSERT. The earlier events (Reserved, Deployed) buffer their per-token fields in a JS map
// so Router:Launched can read them and write a fully-populated row on the first try. In-memory
// state is safe here because Ponder processes events in log-index order on a single thread.
// =========================================================

interface PendingReserved {
  name: string;
  ticker: string;
}
interface PendingDeployed {
  configHash: `0x${string}`;
  impl: `0x${string}`;
}

const pendingReserved = new Map<string, PendingReserved>();
const pendingDeployed = new Map<string, PendingDeployed>();

ponder.on('Router:Launched', async ({ event, context }) => {
  const { token, launchedBy, base, nameHash, tickerHash, feePaid, installedHook, installedGovernance } =
    event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;

  const reserved = pendingReserved.get(id);
  const deployed = pendingDeployed.get(id);
  pendingReserved.delete(id);
  pendingDeployed.delete(id);

  await context.db.insert(launches).values({
    id,
    chainId,
    tokenAddress: token,
    launchedBy,
    base: Number(base),
    nameHash,
    tickerHash,
    name: reserved?.name ?? '',
    ticker: reserved?.ticker ?? '',
    configHash: deployed?.configHash ?? ('0x' as `0x${string}`),
    impl: deployed?.impl ?? null,
    feePaid,
    installedHook,
    installedGovernance,
    installedBondingCurve: false, // upserted by Router:CurveInstalled below
    curveAddress: null,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

// Router.CurveInstalled handler removed as part of the Router filter narrowing (see
// ponder.config.ts). Ponder's `filter: { event: 'Launched' }` on Router excludes
// CurveInstalled from the listenable event set, so this handler couldn't type-check.
//
// Curve→launch linking is covered redundantly by two other paths:
//   1. CurveFactory:CurveCreated (below) — fires atomically inside Router.launch() AND
//      standalone via CurveFactory.createCurve()
//   2. BondingCurve:CurveInitialized — fires on every curve boot; also updates launches
//
// Router.CurveInstalled was pure belt-and-suspenders. Both remaining paths cover both
// atomic + standalone install flows, so no data quality loss from dropping it.

// Router.CurveInstalled only fires when a curve is installed atomically via Router.launch().
// If a launcher calls CurveFactory.createCurve() in a separate transaction *after* the token
// launches, Router.CurveInstalled never fires — so we ALSO listen to CurveFactory.CurveCreated
// (which fires on every curve, atomic or standalone) and upsert the same fields.
ponder.on('CurveFactory:CurveCreated', async ({ event, context }) => {
  const { token, curve } = event.args;
  const chainId = chainIdOf(context);
  const launchId = `${chainId}-${token.toLowerCase()}`;

  await context.db
    .update(launches, { id: launchId })
    .set({ installedBondingCurve: true, curveAddress: curve })
    .catch(() => {
      // No launches row for this token yet (createCurve was called for a token launched
      // outside the Router pipeline). The launch row isn't going to appear later — safe skip.
    });
});

ponder.on('NameRegistry:Reserved', async ({ event, context }) => {
  const { token, name, ticker } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;

  // Reserved fires FIRST in the tx, before the launches row exists — buffer for Router:Launched
  // to pick up. Also try an update in case a launches row is already present (e.g. a
  // hypothetical re-reservation post-Launched).
  pendingReserved.set(id, { name, ticker });
  await context.db
    .update(launches, { id })
    .set({ name, ticker })
    .catch(() => {});
});

async function handleFactoryDeployed({ event, context }: { event: any; context: any }) {
  const { token, configHash, impl } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;

  // Same story as Reserved — Deployed fires before Launched, so buffer.
  pendingDeployed.set(id, { configHash, impl });
  await context.db
    .update(launches, { id })
    .set({ configHash, impl })
    .catch(() => {});
}

ponder.on('ERC20Factory:Deployed', handleFactoryDeployed);
ponder.on('ERC721AFactory:Deployed', handleFactoryDeployed);
ponder.on('ERC1155Factory:Deployed', handleFactoryDeployed);

// =========================================================
// BondingCurve pipeline — dynamically subscribed via the CurveFactory factory pattern in
// ponder.config.ts. Every clone the factory ships gets its Trade + Graduated + CurveInitialized
// events indexed automatically.
// =========================================================

ponder.on('BondingCurve:CurveInitialized', async ({ event, context }) => {
  const {
    token,
    feeReceiver,
    curveSupply,
    virtualTokenReserve,
    virtualEthReserve,
    graduationTargetEth,
    tradeFeeBps,
  } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const id = `${chainId}-${curveAddress.toLowerCase()}`;

  // Backfill the launches row so the frontend feeds bucket it correctly. Router.CurveInstalled
  // only fires when Router.launch installs the curve atomically; a standalone
  // CurveFactory.createCurve() bypasses that path. CurveInitialized always fires when the
  // curve boots, so this is the single source of truth for "this launch has a curve".
  //
  // Try the update; log if it throws so we surface any drizzle-level id-mismatch bug in dev
  // instead of silently swallowing with .catch. The launches row is written by Router.Launched
  // at an earlier block, so on historical resync it's guaranteed to exist by the time this
  // handler runs. On live indexing where launch + createCurve happen in the same tx, the
  // events are processed in log-index order so the row is also present.
  const launchId = `${chainId}-${token.toLowerCase()}`;
  try {
    await context.db
      .update(launches, { id: launchId })
      .set({ installedBondingCurve: true, curveAddress });
    console.log(`[indexer] linked curve ${curveAddress} → launch ${launchId}`);
  } catch (err) {
    console.warn(`[indexer] failed to link curve → launch ${launchId}:`, err instanceof Error ? err.message : err);
  }

  await context.db.insert(curves).values({
    id,
    chainId,
    curveAddress,
    tokenAddress: token,
    feeReceiver,
    curveSupply,
    virtualTokenReserve,
    virtualEthReserve,
    graduationTargetEth,
    tradeFeeBps: Number(tradeFeeBps),
    ethReserve: 0n,
    tokenReserve: curveSupply,
    tradeCount: 0,
    graduated: false,
    graduatedAt: null,
    createdAt: event.block.timestamp,
    updatedAt: event.block.timestamp,
  }).onConflictDoNothing();
});

ponder.on('BondingCurve:Trade', async ({ event, context }) => {
  const { trader, isBuy, ethAmount, tokenAmount, ethReserve, tokenReserve } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;
  const tradeId = `${chainId}-${event.transaction.hash}-${event.log.logIndex}`;

  // Realized price = eth/tokens (1e18 scale). Zero-safe.
  const priceWeiPerToken = tokenAmount > 0n ? (ethAmount * 10n ** 18n) / tokenAmount : 0n;

  // Look up the curve to correlate token address (and to bail cleanly if the
  // CurveInitialized event was somehow dropped/replayed out of order).
  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`);

  await context.db.insert(trades).values({
    id: tradeId,
    chainId,
    curveAddress,
    tokenAddress,
    trader,
    isBuy,
    ethAmount,
    tokenAmount,
    ethReserveAfter: ethReserve,
    tokenReserveAfter: tokenReserve,
    priceWeiPerToken,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  // Rolling curve state.
  if (curve) {
    await context.db
      .update(curves, { id: curveId })
      .set({
        ethReserve,
        tokenReserve,
        tradeCount: curve.tradeCount + 1,
        updatedAt: event.block.timestamp,
      });
  }
});

ponder.on('BondingCurve:Graduated', async ({ event, context }) => {
  const { ethReserve, tokenReserve } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;

  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`);

  // Precompute the v4 poolId — v4Swaps handler joins on this to backfill tokenAddress
  // for post-grad swaps (otherwise the home page live-trades rail can't render them).
  // Only meaningful when the graduating token has a real address AND the chain THIS
  // graduation happened on has a wired MultiHookHost. Per-chain lookup so the multi-
  // chain indexer computes each chain's poolId with that chain's own hook address —
  // a Base graduation must not use the Base Sepolia hook or the poolId won't match
  // the emitted Swap events.
  const hookHost = hookHostForChainId(chainId);
  const poolId =
    hookHost && tokenAddress !== '0x0000000000000000000000000000000000000000'
      ? computeV4PoolId(tokenAddress, hookHost)
      : null;

  await context.db.insert(graduations).values({
    id: curveId,
    chainId,
    curveAddress,
    tokenAddress,
    poolId,
    ethReserveFinal: ethReserve,
    tokenReserveFinal: tokenReserve,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  if (curve) {
    await context.db
      .update(curves, { id: curveId })
      .set({
        graduated: true,
        graduatedAt: event.block.timestamp,
        ethReserve,
        tokenReserve,
        updatedAt: event.block.timestamp,
      });
  }
});

// =========================================================
// Uniswap v4 PoolManager.Swap — indexes every swap on every pool on this chain.
//
// Correlates each swap back to a launched token by hashing the expected PoolKey (with
// MultiHookHost as the hook slot) and matching it against the incoming event's poolId.
// If we recognize the poolId, the swap gets a `tokenAddress` set so the frontend can
// filter without a join. Unrecognized pools (any other v4 pool on the chain) still
// get inserted so the schema stays symmetric — the frontend ignores them.
//
// Only registered when NEXT_PUBLIC_POOL_MANAGER_ADDRESS is set in ponder.config.ts.
// =========================================================

ponder.on('PoolManager:Swap', async ({ event, context }) => {
  const { id: poolId, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee } = event.args;
  const chainId = chainIdOf(context);

  // v4 sqrtPriceX96 = sqrt(amount1/amount0) × 2^96 — for ETH(currency0)/token(currency1)
  // that's sqrt(tokens/ETH) atomic. Invert to get wei-ETH per whole token:
  //   weiPerToken = 1e18 / (sqrt^2 / 2^192) = (1e18 << 192) / sqrt^2
  let priceWeiPerToken = 0n;
  if (sqrtPriceX96 > 0n) {
    const sqSq = sqrtPriceX96 * sqrtPriceX96;
    if (sqSq > 0n) priceWeiPerToken = ((10n ** 18n) << 192n) / sqSq;
  }

  // Reverse-lookup: which launchpad token does this poolId belong to? We stored the
  // expected poolId in the graduations row when the Graduated event fired, so a single
  // query lands the tokenAddress. Any pool NOT graduated through the launchpad stays
  // tokenAddress=null — the home page + trade page filter those out.
  const gradRow = await context.db.sql
    .select({ tokenAddress: graduations.tokenAddress })
    .from(graduations)
    .where(eq(graduations.poolId, poolId))
    .limit(1);
  const mappedToken = gradRow[0]?.tokenAddress ?? null;

  await context.db.insert(v4Swaps).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    poolId,
    tokenAddress: mappedToken,
    sender,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick: Number(tick),
    fee: Number(fee),
    priceWeiPerToken,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

// =========================================================
// Per-token Transfer indexing — v1 supports ERC-20 launches only. Deferred until we add a
// dynamic ERC-20 factory subscription driven by ERC20Factory.Deployed (same pattern as
// BondingCurve above). Placeholder tables kept for post-launch upgrade.
// =========================================================

// =========================================================
// V4SwapRouter.Swapped — one row per post-graduation trade tied to the actual user
// wallet. PoolManager's Swap event has sender=router, so it's useless for per-user
// activity feeds. This handler is the source of truth for "wallet X's post-grad
// trades" (profile activity, PnL).
// =========================================================

ponder.on('V4SwapRouter:Swapped', async ({ event, context }) => {
  const { user, token, isBuy, amountIn, amountOut } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(v4RouterSwaps).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    user,
    tokenAddress: token,
    isBuy,
    amountIn,
    amountOut,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

// =========================================================
// Per-token ERC-20 Transfer — dynamically subscribed via the ERC20Factory pattern in
// ponder.config.ts. Every ERC-20 the launchpad ships gets its Transfer events indexed
// automatically, no per-launch config change.
//
// Two outputs per event:
//   1. `transfers`: one row per Transfer log, for the per-token transfer history.
//   2. `holders`:  per-address balance, incremented for `to` and decremented for `from`.
//      Mint (from = 0x0) and burn (to = 0x0) skip the corresponding side.
//
// The `holders` upsert has to survive out-of-order historic backfills (Ponder replays
// events in log order, so this is safe under normal operation) and the initial mint
// creating a holder row that doesn't exist yet — handled by find-then-insert-or-update.
// =========================================================

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`;

/// Shared Transfer indexer: writes a `transfers` row + bumps two `holders` rows.
/// Called by every ERC-20 Transfer handler (launchpad tokens, URU) AND the gemu
/// NFT ERC-721 handler — the balance-delta is passed in as `amount`, so ERC-721
/// callers pass `1n` per token movement while ERC-20 callers pass the raw wei value.
async function indexTransfer(
  context: Parameters<Parameters<typeof ponder.on<'Token:Transfer'>>[1]>[0]['context'],
  event: Parameters<Parameters<typeof ponder.on<'Token:Transfer'>>[1]>[0]['event'],
  amount: bigint,
): Promise<void> {
  const { from, to } = event.args;
  const chainId = chainIdOf(context);
  const tokenAddress = event.log.address;
  const ts = event.block.timestamp;

  await context.db.insert(transfers).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    tokenAddress,
    from,
    to,
    amount,
    blockNumber: event.block.number,
    blockTimestamp: ts,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  // Balance deltas. Mint (from = 0x0) skips the decrement side, burn (to = 0x0) skips
  // the increment side. Clamp to zero on the update path — defense-in-depth against
  // out-of-order chunks the frontend shouldn't render as negatives.
  if (from !== ZERO_ADDR) {
    const fromId = `${chainId}-${tokenAddress.toLowerCase()}-${from.toLowerCase()}`;
    const existing = await context.db.find(holders, { id: fromId });
    if (existing) {
      const next = existing.balance - amount;
      await context.db.update(holders, { id: fromId }).set({
        balance: next < 0n ? 0n : next,
        updatedAt: ts,
      });
    } else {
      await context.db.insert(holders).values({
        id: fromId,
        chainId,
        tokenAddress,
        holderAddress: from,
        balance: 0n,
        updatedAt: ts,
      }).onConflictDoNothing();
    }
  }

  if (to !== ZERO_ADDR) {
    const toId = `${chainId}-${tokenAddress.toLowerCase()}-${to.toLowerCase()}`;
    const existing = await context.db.find(holders, { id: toId });
    if (existing) {
      await context.db.update(holders, { id: toId }).set({
        balance: existing.balance + amount,
        updatedAt: ts,
      });
    } else {
      await context.db.insert(holders).values({
        id: toId,
        chainId,
        tokenAddress,
        holderAddress: to,
        balance: amount,
        updatedAt: ts,
      }).onConflictDoNothing();
    }
  }
}

ponder.on('Token:Transfer', async ({ event, context }) => {
  // Per-launchpad-ERC-20 Transfer — dynamic factory subscription via ERC20Factory.
  await indexTransfer(context, event, event.args.value);
});

// URU token (Base only, fixed address, ERC-20). Same holder-tracking pipeline as our
// launchpad tokens. Powers profile "URU holder" badge + analytics on ecosystem supply.
ponder.on('UruToken:Transfer', async ({ event, context }) => {
  await indexTransfer(context, event, event.args.value);
});

// gemu NFT (Base only, fixed address, ERC-721). Same holder-tracking pipeline but each
// Transfer moves exactly ONE token, so we pass 1n as the balance delta. The `holders`
// row's `balance` field then stores the current NFT count for a given wallet -- feeds
// the flywheel snapshot service that publishes Merkle roots for NftRevenueVault.claim.
ponder.on('GemuNft:Transfer', async ({ event, context }) => {
  const { from, to } = event.args;
  const chainId = chainIdOf(context);
  const tokenAddress = event.log.address;
  const ts = event.block.timestamp;

  // Per-transfer row (uses transfers.amount = 1 as the "one NFT moved" marker; the
  // actual tokenId lives in the tx receipt if anyone needs it later).
  await context.db.insert(transfers).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    tokenAddress,
    from,
    to,
    amount: 1n,
    blockNumber: event.block.number,
    blockTimestamp: ts,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  // Balance = NFT count. Same find-then-update logic as ERC-20 but with delta=1.
  if (from !== ZERO_ADDR) {
    const fromId = `${chainId}-${tokenAddress.toLowerCase()}-${from.toLowerCase()}`;
    const existing = await context.db.find(holders, { id: fromId });
    if (existing) {
      const next = existing.balance - 1n;
      await context.db.update(holders, { id: fromId }).set({
        balance: next < 0n ? 0n : next,
        updatedAt: ts,
      });
    }
  }
  if (to !== ZERO_ADDR) {
    const toId = `${chainId}-${tokenAddress.toLowerCase()}-${to.toLowerCase()}`;
    const existing = await context.db.find(holders, { id: toId });
    if (existing) {
      await context.db.update(holders, { id: toId }).set({
        balance: existing.balance + 1n,
        updatedAt: ts,
      });
    } else {
      await context.db.insert(holders).values({
        id: toId,
        chainId,
        tokenAddress,
        holderAddress: to,
        balance: 1n,
        updatedAt: ts,
      }).onConflictDoNothing();
    }
  }
});
