/**
 * Keeper configuration, loaded from env. Secrets (private key, OpenSea key)
 * come only from env; every address has a verified Robinhood default in
 * constants.ts so a deploy needs just secrets + RPC.
 *
 * Launches are DISCOVERED from Dn404LaunchFactory.Dn404Launched logs (see
 * discovery.ts); there is no hand-maintained launch list anymore.
 */
import type { Address, Hex } from 'viem';
import { DEAD, RH } from './constants.ts';

/// Mirrors Dn404TaxTemplate.TaxMode exactly (uint8 on chain).
export const TaxMode = {
  Off: 0,
  BurnDead: 1,
  BuybackURU: 2,
  BuyAllowedToken: 3,
  AddToLP: 4,
  HolderReflections: 5,
  MirrorFloorSupport: 6,
} as const;
export type TaxModeValue = (typeof TaxMode)[keyof typeof TaxMode];

export const taxModeName = (m: number): string => {
  const entry = Object.entries(TaxMode).find(([, v]) => v === m);
  return entry ? entry[0] : `Unknown(${m})`;
};

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly keeperPrivateKey: Hex;

  readonly launchFactory: Address;
  /// First block to scan for Dn404Launched (the factory deploy block).
  readonly discoveryStartBlock: bigint;
  /// eth_getLogs window. RH's RPC allows unbounded responses only for
  /// ranges of <= 5000 blocks.
  readonly logChunk: bigint;

  readonly poolManager: Address;
  readonly stateView: Address;
  readonly universalRouter: Address;
  readonly permit2: Address;
  readonly positionManager: Address;
  readonly seaport: Address;
  readonly uru: Address;
  readonly weth: Address;
  readonly hookEth: Address;
  readonly hookPair: Address;
  readonly graduatorEth: Address;
  readonly graduatorPair: Address;
  readonly uruWethHook: Address;
  readonly uruWethPoolId: Hex;
  readonly usdg: Address;
  readonly ethUsdgFee: number;
  readonly ethUsdgTickSpacing: number;
  readonly conduitController: Address;

  /// Where BuybackURU sends the bought URU. Default 0x…dEaD (buy + burn).
  readonly uruBuybackSink: Address;
  /// Per-launch BuyAllowedToken recipient overrides (base -> recipient).
  /// Default recipient is the token's owner() (the launcher).
  readonly buyAllowedRecipients: ReadonlyMap<string, Address>;

  /// Sweep once accumulatedTax >= this many bps of the token's totalSupply.
  readonly minSweepBpsOfSupply: bigint;
  /// Refuse (and alert) if accumulatedTax exceeds this many bps of supply.
  readonly maxSweepBpsOfSupply: bigint;
  /// Max slippage vs pool spot for every keeper swap, in bps. Never 0-min.
  readonly maxSlippageBps: bigint;
  /// Halve a swap until its quote is within this many bps of spot output.
  readonly maxPriceImpactBps: bigint;

  /// HolderReflections: skip payouts below this many token wei.
  readonly reflectionMinPayout: bigint;
  /// HolderReflections: max payout txs per launch per tick.
  readonly reflectionMaxTxPerTick: number;

  /// MirrorFloorSupport: only buy listings priced at least this many bps
  /// below the NFT's pool-implied value.
  readonly floorSafetyMarginBps: bigint;
  /// MirrorFloorSupport: max NFTs bought per launch per tick.
  readonly floorMaxBuysPerTick: number;
  readonly openseaApiKey?: string;
  readonly openseaChain: string;

  readonly pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const rpcUrl = required(env, 'KEEPER_RPC_URL');
  const chainId = Number(env.KEEPER_CHAIN_ID ?? RH.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`KEEPER_CHAIN_ID invalid: ${chainId}`);
  const keeperPrivateKey = requiredHex(env, 'KEEPER_PRIVATE_KEY');

  const addr = (key: string, dflt: Address): Address => {
    const v = env[key];
    if (v === undefined || v === '') return dflt;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${key} must be a 20-byte hex address`);
    return v as Address;
  };

  const pollIntervalMs = Number(env.KEEPER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(`KEEPER_POLL_INTERVAL_MS must be >= 1000ms, got ${pollIntervalMs}`);
  }
  const maxSlippageBps = BigInt(env.KEEPER_MAX_SLIPPAGE_BPS ?? 300);
  if (maxSlippageBps <= 0n || maxSlippageBps >= 10_000n) throw new Error('KEEPER_MAX_SLIPPAGE_BPS must be in (0, 10000)');

  return {
    rpcUrl,
    chainId,
    keeperPrivateKey,
    launchFactory: addr('KEEPER_LAUNCH_FACTORY', RH.launchFactory),
    discoveryStartBlock: BigInt(env.KEEPER_DISCOVERY_START_BLOCK ?? RH.launchFactoryDeployBlock),
    logChunk: BigInt(env.KEEPER_LOG_CHUNK ?? 5000),
    poolManager: addr('KEEPER_POOL_MANAGER', RH.poolManager),
    stateView: addr('KEEPER_STATE_VIEW', RH.stateView),
    universalRouter: addr('KEEPER_UNIVERSAL_ROUTER', RH.universalRouter),
    permit2: addr('KEEPER_PERMIT2', RH.permit2),
    positionManager: addr('KEEPER_POSITION_MANAGER', RH.positionManager),
    seaport: addr('KEEPER_SEAPORT', RH.seaport),
    uru: addr('KEEPER_URU_TOKEN', RH.uru),
    weth: addr('KEEPER_WETH', RH.weth),
    hookEth: addr('KEEPER_HOOK_ETH', RH.hookEth),
    hookPair: addr('KEEPER_HOOK_PAIR', RH.hookPair),
    graduatorEth: addr('KEEPER_GRADUATOR_ETH', RH.graduatorEth),
    graduatorPair: addr('KEEPER_GRADUATOR_PAIR', RH.graduatorPair),
    uruWethHook: addr('KEEPER_URU_WETH_HOOK', RH.uruWethHook),
    uruWethPoolId: (env.KEEPER_URU_WETH_POOL_ID ?? RH.uruWethPoolId) as Hex,
    usdg: addr('KEEPER_USDG', RH.usdg),
    ethUsdgFee: Number(env.KEEPER_ETH_USDG_FEE ?? RH.ethUsdgFee),
    ethUsdgTickSpacing: Number(env.KEEPER_ETH_USDG_TICK_SPACING ?? RH.ethUsdgTickSpacing),
    conduitController: addr('KEEPER_CONDUIT_CONTROLLER', RH.conduitController),
    uruBuybackSink: addr('KEEPER_URU_BUYBACK_SINK', DEAD),
    buyAllowedRecipients: parseRecipients(env.KEEPER_BUY_ALLOWED_RECIPIENTS),
    minSweepBpsOfSupply: BigInt(env.KEEPER_MIN_SWEEP_BPS_OF_SUPPLY ?? 1),
    maxSweepBpsOfSupply: BigInt(env.KEEPER_MAX_SWEEP_BPS_OF_SUPPLY ?? 500),
    maxSlippageBps,
    maxPriceImpactBps: BigInt(env.KEEPER_MAX_PRICE_IMPACT_BPS ?? 1000),
    reflectionMinPayout: BigInt(env.KEEPER_REFLECTION_MIN_PAYOUT_WEI ?? 10n ** 18n),
    reflectionMaxTxPerTick: Number(env.KEEPER_REFLECTION_MAX_TX_PER_TICK ?? 50),
    floorSafetyMarginBps: BigInt(env.KEEPER_FLOOR_SAFETY_MARGIN_BPS ?? 1000),
    floorMaxBuysPerTick: Number(env.KEEPER_FLOOR_MAX_BUYS_PER_TICK ?? 5),
    openseaApiKey: env.OPENSEA_API_KEY || undefined,
    openseaChain: env.KEEPER_OPENSEA_CHAIN ?? 'robinhood',
    pollIntervalMs,
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || v.length === 0) throw new Error(`${key} env var missing`);
  return v;
}

function requiredHex(env: NodeJS.ProcessEnv, key: string): Hex {
  const v = required(env, key);
  if (!/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${key} must be 0x-prefixed hex`);
  return v as Hex;
}

/// `{"0xbase":"0xrecipient", ...}` JSON, optional.
function parseRecipients(raw: string | undefined): ReadonlyMap<string, Address> {
  const m = new Map<string, Address>();
  if (!raw) return m;
  const parsed = JSON.parse(raw) as Record<string, string>;
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(k) || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error('KEEPER_BUY_ALLOWED_RECIPIENTS entries must be address -> address');
    }
    m.set(k.toLowerCase(), v as Address);
  }
  return m;
}
