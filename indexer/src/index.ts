// @ponder/core@0.7.x exposes the `ponder` singleton via the '@/generated' virtual module
// (Vite plugin at @ponder/core/src/build/plugin.ts). The 'ponder:registry' name is 0.8+.
import { ponder } from '@/generated';
import { keccak256, encodeAbiParameters } from 'viem';
import { eq } from '@ponder/core';

import {
  launches, curves, trades, v4Swaps, v4RouterSwaps, graduations, holders, transfers,
  wlPurchases, wlClaims,
  hookConfigs, hookFees, hookFeeClaims, hookBurns,
  flywheelReceipts, flywheelDistributions,
  uruBuybacks, uruSinkDeposits, uruSinkConversions,
} from '../ponder.schema.ts';
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
interface PendingCurve {
  curveAddress: `0x${string}`;
}

const pendingReserved = new Map<string, PendingReserved>();
const pendingDeployed = new Map<string, PendingDeployed>();
/// Same buffer pattern as pendingReserved/pendingDeployed. Populated by
/// CurveFactory:CurveCreated (and BondingCurve:CurveInitialized as a
/// belt-and-suspenders) whenever those fire BEFORE Router:Launched in the
/// same tx — which is always the case when a curve is installed atomically
/// via Router.launch (log order: CurveInitialized → CurveCreated → CurveInstalled → Launched).
/// Router:Launched consumes + deletes at insert time so the row lands with
/// installedBondingCurve=true + curveAddress set on the first write.
const pendingCurve = new Map<string, PendingCurve>();

ponder.on('Router:Launched', async ({ event, context }) => {
  const { token, launchedBy, base, nameHash, tickerHash, feePaid, installedHook, installedGovernance } =
    event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;

  const reserved = pendingReserved.get(id);
  const deployed = pendingDeployed.get(id);
  const curve = pendingCurve.get(id);
  pendingReserved.delete(id);
  pendingDeployed.delete(id);
  pendingCurve.delete(id);

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
    // If the curve was installed atomically (Router.launch with installBondingCurve=true),
    // its CurveInitialized/CurveCreated events fired earlier in this same tx and buffered
    // the address into pendingCurve. Standalone CurveFactory.createCurve() after launch
    // is handled by the update-in-place path in CurveFactory:CurveCreated below.
    installedBondingCurve: curve !== undefined,
    curveAddress: curve?.curveAddress ?? null,
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

  // Same-tx path: Router.launch installs curve → CurveCreated fires BEFORE
  // Router.Launched writes the launches row. The .update below no-ops (row
  // doesn't exist yet) and Launched picks curveAddress up from pendingCurve.
  //
  // Standalone path: launcher calls CurveFactory.createCurve() in a separate
  // tx after launch. The launches row exists so .update writes directly, and
  // the pendingCurve entry is harmless — never consumed but never grows past
  // a single stale entry per token that will only ever be created once.
  pendingCurve.set(launchId, { curveAddress: curve });
  await context.db
    .update(launches, { id: launchId })
    .set({ installedBondingCurve: true, curveAddress: curve })
    .catch(() => {});
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

  // Backfill the launches row so the frontend feeds bucket it correctly.
  // Two paths:
  //   1. Atomic-install (Router.launch with installBondingCurve=true) — this
  //      handler fires BEFORE Router.Launched in the same tx (CurveInitialized
  //      → CurveCreated → CurveInstalled → Launched log order). The update
  //      below no-ops (row doesn't exist yet); we stash the curve address in
  //      pendingCurve for Router.Launched to pick up when it inserts the row.
  //   2. Standalone-install (CurveFactory.createCurve() called after launch)
  //      — the launches row exists from a prior block, so update writes
  //      straight through and the pendingCurve entry is a harmless stale
  //      leftover (only ever grows one entry per token, never consumed).
  const launchId = `${chainId}-${token.toLowerCase()}`;
  pendingCurve.set(launchId, { curveAddress });
  try {
    await context.db
      .update(launches, { id: launchId })
      .set({ installedBondingCurve: true, curveAddress });
    console.log(`[indexer] linked curve ${curveAddress} → launch ${launchId}`);
  } catch {
    // Row doesn't exist yet — pendingCurve above will flip the fields at
    // insert time inside the Router:Launched handler. Silent skip.
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
    // Persist the hook that was used at graduation — frontend reads this per-token
    // so trade pages keep working after any future hook redeploy (V2 with per-pool
    // creators, etc). Null only when the graduating chain didn't have a wired hook.
    hookAddress: hookHost ?? null,
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
// Whitelist / URU-pay handlers — RouterV2 + WL-aware BondingCurve additions.
// Non-WL launches never fire these events; existing curves without WL storage
// keep working with the base handlers above.
//
// Ordering inside a WL launch tx (log-index):
//   1. BondingCurve.CurveInitialized      → creates curves row (base handler above)
//   2. BondingCurve.WhitelistConfigured   → this handler backfills WL fields
//   3. Router.Launched                    → creates launches row (base handler above)
//   4. Router.LaunchedInURU (if URU-paid) → this handler sets payToken=URU
//   5. Router.LaunchedWithWhitelist       → this handler sets launches.hasWhitelist=true
// =========================================================

ponder.on('Router:LaunchedInURU', async ({ event, context }) => {
  const { token, uruPaid } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;
  try {
    await context.db
      .update(launches, { id })
      .set({ payToken: 'URU', uruPaid });
  } catch (err) {
    // Router.Launched should always land first in the same tx. If this update misses,
    // the base row hasn't been written yet — log and continue rather than crash the
    // whole indexer, matching the pattern of other correlated-event handlers.
    console.warn(`[indexer] LaunchedInURU: launches row missing for ${id}:`, err instanceof Error ? err.message : err);
  }
});

ponder.on('Router:LaunchedWithWhitelist', async ({ event, context }) => {
  const { token } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${token.toLowerCase()}`;
  // Full WL config lives on the curves row (populated by WhitelistConfigured). This
  // handler just flags the launches row so discover-page "WL only" queries don't
  // need a join to filter.
  try {
    await context.db.update(launches, { id }).set({ hasWhitelist: true });
  } catch (err) {
    console.warn(`[indexer] LaunchedWithWhitelist: launches row missing for ${id}:`, err instanceof Error ? err.message : err);
  }
});

ponder.on('BondingCurve:WhitelistConfigured', async ({ event, context }) => {
  const {
    root,
    reservedTokens,
    maxWlPerAddress,
    fallbackTs,
    sourceTokenAddress,
    sourceChainId,
    declaredHolderCount,
  } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const id = `${chainId}-${curveAddress.toLowerCase()}`;
  try {
    await context.db.update(curves, { id }).set({
      hasWhitelist: true,
      whitelistRoot: root,
      reservedTokens,
      maxWlPerAddress,
      fallbackTs: BigInt(fallbackTs),
      sourceTokenAddress,
      sourceChainId: Number(sourceChainId),
      declaredHolderCount: Number(declaredHolderCount),
      updatedAt: event.block.timestamp,
    });
  } catch (err) {
    console.warn(`[indexer] WhitelistConfigured: curves row missing for ${id}:`, err instanceof Error ? err.message : err);
  }
});

ponder.on('BondingCurve:WlBought', async ({ event, context }) => {
  const { buyer, ethIn, tokensOut, wlPurchasedAfter } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;

  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`);

  await context.db.insert(wlPurchases).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    curveAddress,
    tokenAddress,
    buyer,
    ethIn,
    tokensOut,
    wlPurchasedAfter,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  if (curve) {
    await context.db.update(curves, { id: curveId }).set({
      wlSold: curve.wlSold + tokensOut,
      wlHeldTotal: curve.wlHeldTotal + tokensOut,
      updatedAt: event.block.timestamp,
    });
  }
});

ponder.on('BondingCurve:WlClaimed', async ({ event, context }) => {
  const { buyer, amount } = event.args;
  const chainId = chainIdOf(context);
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;

  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`);

  await context.db.insert(wlClaims).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    curveAddress,
    tokenAddress,
    buyer,
    amount,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();

  if (curve) {
    // wlHeldTotal drains as buyers claim. Guard against underflow just in case an
    // event replays out of order — clamp to zero rather than crash.
    const nextHeld = curve.wlHeldTotal > amount ? curve.wlHeldTotal - amount : 0n;
    await context.db.update(curves, { id: curveId }).set({
      wlHeldTotal: nextHeld,
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

// gemu NFT (ERC-721, deployed on Base then migrated to Robinhood 2026-07-25 —
// canonical home is now RH; Base kept for legacy reads). Subscribed on both
// chains when their address env vars + chain enablement are present (see
// ecosystemTokenNet in ponder.config.ts). Same holder-tracking pipeline as
// ERC-20 but each Transfer moves exactly ONE token, so we pass 1n as the
// balance delta. The `holders` row's `balance` field stores the current NFT
// count for a given wallet — feeds the flywheel snapshot service that
// publishes Merkle roots for NftRevenueVault.claim.
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

// =========================================================
// Flywheel handlers — MultiHookHost + FeeSplitter + UruBuybackVault +
// UruDepositSink. Each event maps 1:1 to a schema table with the same shape
// as the on-chain event. Chains without a wired flywheel address simply never
// fire these handlers (netFor returns an empty subscription map).
// =========================================================

ponder.on('MultiHookHost:FeeAccrued', async ({ event, context }) => {
  const { currency, platformShare, creatorShare } = event.args;
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
});

ponder.on('MultiHookHost:FeeClaimed', async ({ event, context }) => {
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

ponder.on('MultiHookHost:BuybackBurned', async ({ event, context }) => {
  const { currency, amount } = event.args;
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
});

/// PoolConfigSet fires on both initial config AND updates — we upsert (insert
/// with a stable per-(hook,pool) id, override on conflict) so the row always
/// reflects the LATEST config. Chart/UI only ever needs "what is the config now".
ponder.on('MultiHookHost:PoolConfigSet', async ({ event, context }) => {
  const { poolId, antiSniperBlocks, buybackBurnBps } = event.args;
  const chainId = chainIdOf(context);
  const id = `${chainId}-${event.log.address.toLowerCase()}-${poolId}`;
  const existing = await context.db.find(hookConfigs, { id });
  if (existing) {
    await context.db.update(hookConfigs, { id }).set({
      antiSniperBlocks,
      buybackBurnBps,
      updatedAt: event.block.timestamp,
      txHash: event.transaction.hash,
    });
  } else {
    await context.db.insert(hookConfigs).values({
      id,
      chainId,
      hookAddress: event.log.address,
      poolId,
      antiSniperBlocks,
      buybackBurnBps,
      updatedAt: event.block.timestamp,
      txHash: event.transaction.hash,
    }).onConflictDoNothing();
  }
});

ponder.on('FeeSplitter:FeeReceived', async ({ event, context }) => {
  const { launcher, base, amount } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(flywheelReceipts).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    splitter: event.log.address,
    launcher,
    base: Number(base),
    amount,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

ponder.on('FeeSplitter:Distributed', async ({ event, context }) => {
  const { total, toBuyback, toNft, toTreasury } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(flywheelDistributions).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    splitter: event.log.address,
    total,
    toBuyback,
    toNft,
    toTreasury,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

ponder.on('UruBuybackVault:BuybackExecuted', async ({ event, context }) => {
  const { ethIn, uruOut } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(uruBuybacks).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vault: event.log.address,
    ethIn,
    uruOut,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

ponder.on('UruDepositSink:Deposited', async ({ event, context }) => {
  const { from, amount } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(uruSinkDeposits).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    sink: event.log.address,
    from,
    amount,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});

ponder.on('UruDepositSink:ConversionExecuted', async ({ event, context }) => {
  const { uruIn, ethOut } = event.args;
  const chainId = chainIdOf(context);
  await context.db.insert(uruSinkConversions).values({
    id: `${chainId}-${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    sink: event.log.address,
    uruIn,
    ethOut,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});
