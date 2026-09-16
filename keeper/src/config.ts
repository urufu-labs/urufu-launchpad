/**
 * Keeper configuration.
 *
 * Env-driven so ops can rotate values without a redeploy. Every process
 * loads the same source of truth here, then `loadConfig()` parses +
 * validates, throwing loudly on any missing / malformed input.
 */

import type { Address, Hex } from 'viem';

/// Tax modes — mirror Dn404TaxTemplate.TaxMode. Order MUST match the
/// on-chain enum (uint8) so `taxMode() -> TaxMode[uint]` round-trips.
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

/// Human-readable name for logs.
export const taxModeName = (m: number): string => {
  const found = Object.entries(TaxMode).find(([, v]) => v === m);
  return found ? found[0] : `Unknown(${m})`;
};

export interface LaunchWatch {
  /// Base ERC-20 (Dn404TaxTemplate clone) address.
  readonly base: Address;
  /// Sweep-trigger threshold in wei. Once `accumulatedTax` >= this value,
  /// keeper submits sweepAccumulated for the full accumulated amount.
  readonly threshold: bigint;
  /// Optional per-launch destination override. For BuyAllowedToken this
  /// is the swap-target token; for BuybackURU it's implicit (URU).
  /// Advisory: authoritative target still comes from the on-chain
  /// `taxTarget()` view; this override is only used by handlers that
  /// need extra config the on-chain state doesn't expose (e.g. where
  /// to send URU after the buyback).
  readonly finalDestination?: Address;
}

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly keeperPrivateKey: Hex;

  /// Contracts the keeper interacts with regardless of which launch it
  /// is sweeping. All chain-scoped, loaded from env.
  readonly v4SwapRouter: Address;
  readonly uruToken: Address;
  /// Where post-buyback URU lands. Typically the URU burn address
  /// (0x0000...dead) or the UruBuybackVault so the flywheel picks it up.
  readonly uruBuybackSink: Address;
  /// Fallback sink for advanced destinations that don't yet have an
  /// automated action (AddToLP / HolderReflections / MirrorFloorSupport).
  /// Keeper sweeps to this address and logs a TODO — ops handles the
  /// destination-specific action manually until the automation ships.
  readonly advancedDestinationTreasury: Address;

  /// Which launches to watch. Loaded from KEEPER_LAUNCHES env as a
  /// JSON array — `[{"base":"0x..","threshold":"1000000000000000000000"}, ...]`.
  /// Advisory `finalDestination` field optional per entry.
  readonly launches: readonly LaunchWatch[];

  /// Poll cadence — how often the keeper reads every launch's
  /// `accumulatedTax` value. 30s is a reasonable v1 default; can be
  /// tightened if launches accumulate faster than that.
  readonly pollIntervalMs: number;

  /// Safety guard: if `accumulatedTax` exceeds this value in a single
  /// poll interval (i.e. a launch is receiving tax faster than the
  /// keeper can sweep), refuse to sweep and log LOUD. Prevents the
  /// keeper from becoming a MEV target in pathological states.
  readonly maxSweepPerPoll: bigint;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const rpcUrl = required(env, 'KEEPER_RPC_URL');
  const chainId = Number(required(env, 'KEEPER_CHAIN_ID'));
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`KEEPER_CHAIN_ID must be a positive integer, got ${chainId}`);
  }

  const keeperPrivateKey = requiredHex(env, 'KEEPER_PRIVATE_KEY');
  const v4SwapRouter = requiredAddress(env, 'KEEPER_V4_SWAP_ROUTER');
  const uruToken = requiredAddress(env, 'KEEPER_URU_TOKEN');
  const uruBuybackSink = requiredAddress(env, 'KEEPER_URU_BUYBACK_SINK');
  const advancedDestinationTreasury = requiredAddress(env, 'KEEPER_ADVANCED_DEST_TREASURY');

  const launchesRaw = required(env, 'KEEPER_LAUNCHES');
  const launches = parseLaunches(launchesRaw);
  if (launches.length === 0) {
    throw new Error('KEEPER_LAUNCHES parsed to zero launches — nothing to watch');
  }

  const pollIntervalMs = Number(env.KEEPER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(`KEEPER_POLL_INTERVAL_MS must be >= 1000ms, got ${pollIntervalMs}`);
  }

  const maxSweepPerPoll = BigInt(env.KEEPER_MAX_SWEEP_PER_POLL ?? '10000000000000000000000000');

  return {
    rpcUrl,
    chainId,
    keeperPrivateKey,
    v4SwapRouter,
    uruToken,
    uruBuybackSink,
    advancedDestinationTreasury,
    launches,
    pollIntervalMs,
    maxSweepPerPoll,
  };
}

// -- validation helpers ----------------------------------------------

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

function requiredAddress(env: NodeJS.ProcessEnv, key: string): Address {
  const v = required(env, key);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${key} must be a 20-byte hex address`);
  return v as Address;
}

function parseLaunches(raw: string): readonly LaunchWatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`KEEPER_LAUNCHES not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('KEEPER_LAUNCHES must be a JSON array');
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`KEEPER_LAUNCHES[${i}] not an object`);
    }
    const e = entry as Record<string, unknown>;
    const base = e.base;
    const threshold = e.threshold;
    if (typeof base !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(base)) {
      throw new Error(`KEEPER_LAUNCHES[${i}].base must be a 20-byte hex address`);
    }
    if (typeof threshold !== 'string') {
      throw new Error(`KEEPER_LAUNCHES[${i}].threshold must be a string bigint`);
    }
    const finalDestination = e.finalDestination;
    if (
      finalDestination !== undefined &&
      (typeof finalDestination !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(finalDestination))
    ) {
      throw new Error(
        `KEEPER_LAUNCHES[${i}].finalDestination when set must be a 20-byte hex address`,
      );
    }
    return {
      base: base as Address,
      threshold: BigInt(threshold),
      finalDestination: finalDestination as Address | undefined,
    };
  });
}
