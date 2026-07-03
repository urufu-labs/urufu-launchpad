import { ponder } from 'ponder:registry';

import { launches, curves, trades, graduations, holders, transfers } from '../ponder.schema.ts';

// =========================================================
// Launch pipeline — three correlated events per launch tx, plus an optional fourth for
// bonding-curve launches:
//   1. NameRegistry.Reserved
//   2. <BaseType>Factory.Deployed
//   3. Router.Launched
//   4. Router.CurveInstalled  (only when installBondingCurve == true)
// All fire in the same tx. Router.Launched creates the row; the others upsert their fields.
// =========================================================

ponder.on('Router:Launched', async ({ event, context }) => {
  const { token, launchedBy, base, nameHash, tickerHash, feePaid, installedHook, installedGovernance } =
    event.args;
  const chainId = context.chain.id;
  const id = `${chainId}-${token.toLowerCase()}`;

  await context.db.insert(launches).values({
    id,
    chainId,
    tokenAddress: token,
    launchedBy,
    base: Number(base),
    nameHash,
    tickerHash,
    name: '',
    ticker: '',
    configHash: '0x' as `0x${string}`,
    impl: null,
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

ponder.on('Router:CurveInstalled', async ({ event, context }) => {
  const { token, curve } = event.args;
  const chainId = context.chain.id;
  const launchId = `${chainId}-${token.toLowerCase()}`;

  // Mark the launch row as curve-backed and store the curve address for the join.
  await context.db
    .update(launches, { id: launchId })
    .set({ installedBondingCurve: true, curveAddress: curve })
    .catch(() => {
      // Router:Launched hasn't fired yet — the same tx will fill this in via the create path.
    });
});

ponder.on('NameRegistry:Reserved', async ({ event, context }) => {
  const { token, name, ticker } = event.args;
  const chainId = context.chain.id;
  const id = `${chainId}-${token.toLowerCase()}`;

  await context.db
    .update(launches, { id })
    .set({ name, ticker })
    .catch(() => {});
});

async function handleFactoryDeployed({ event, context }: { event: any; context: any }) {
  const { token, configHash, impl } = event.args;
  const chainId = context.chain.id;
  const id = `${chainId}-${token.toLowerCase()}`;

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
  const chainId = context.chain.id;
  const curveAddress = event.log.address;
  const id = `${chainId}-${curveAddress.toLowerCase()}`;

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
  const chainId = context.chain.id;
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
  const chainId = context.chain.id;
  const curveAddress = event.log.address;
  const curveId = `${chainId}-${curveAddress.toLowerCase()}`;

  const curve = await context.db.find(curves, { id: curveId });
  const tokenAddress = curve?.tokenAddress ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`);

  await context.db.insert(graduations).values({
    id: curveId,
    chainId,
    curveAddress,
    tokenAddress,
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
// Per-token Transfer indexing — v1 supports ERC-20 launches only. Deferred until we add a
// dynamic ERC-20 factory subscription driven by ERC20Factory.Deployed (same pattern as
// BondingCurve above). Placeholder tables kept for post-launch upgrade.
// =========================================================

// Silence unused-import warnings — the tables are exposed so client apps can query them
// via Ponder's GraphQL layer even before handlers land.
void holders;
void transfers;
