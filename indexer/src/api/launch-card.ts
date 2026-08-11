// GH-13 pure launch-card assembly logic. Split out from the route file
// (src/api/index.ts) so the shape builder + address helpers can be unit-tested
// under `node --test` without pulling in Ponder's '@/generated' virtual
// module (that module only resolves inside the Ponder build). The route
// handler is a thin wrapper that reads rows from the db and delegates the
// shape assembly here.

import { keccak256, encodeAbiParameters, type Address, type Hex } from 'viem';

/// v4 PoolKey → PoolId. Every launchpad graduation opens an ETH/token pool
/// with the same fixed fee (3000) + tickSpacing (60) + MultiHookHost hook
/// slot, so given the token address + wired hook the poolId is deterministic.
/// Duplicated from src/index.ts to keep the API bundle standalone — the api
/// file and the indexing file are bundled in separate Ponder contexts.
export function computeV4PoolId(tokenAddress: Address, hookAddress: Address): Hex {
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

/// Static human-readable justification for the launch-card's LP-lock claim.
/// The Graduator receives the LP position NFT at graduation and holds it in
/// its own storage with no owner-callable transfer / burn / withdraw path.
/// Kept as a constant so any future change to lock mechanics forces an update
/// to this string too (aggregators surface it verbatim in their trust column).
export const LP_LOCK_SOURCE =
  'graduation LP position NFT held by Graduator with no burn/transfer/withdraw path';

export interface LaunchCard {
  token: Address;
  chainId: number;
  launcher: Address;
  launchTx: Hex;
  launchBlock: string;
  name: string;
  ticker: string;
  curve: {
    address: Address;
    virtualEthReserve: string;
    virtualTokenReserve: string;
    graduationTargetEth: string;
    tradeFeeBps: number;
    ethReserve: string;
    tokenReserve: string;
  } | null;
  graduation: {
    state: 'pre' | 'graduated';
    tx: Hex | null;
    block: string | null;
  };
  pool: {
    poolId: Hex | null;
    hookAddress: Address | null;
    sqrtPriceX96: string | null;
    liquidity: string | null;
  };
  hookPolicy: {
    antiSniperBlocks: number;
    buybackBurnBps: number;
    platformFeeBps: number;
    creatorFeeBps: number;
    creatorRecipient: Address;
    immutableAfterLaunch: boolean;
  } | null;
  lpLock: {
    locked: true;
    source: string;
  };
  loyalty: {
    advertised: boolean;
    live: boolean;
  };
  meta: {
    /// The launcher-REQUESTED flags — what they asked for at Router.launch.
    requestedHook: boolean;
    requestedGovernance: boolean;
    /// FACTUAL on-chain state:
    ///   `installedHook`  — true iff the pool has a `poolPolicy` row with
    ///     `immutableAfterLaunch = true`, i.e. `MHH.beforeInitialize` fired
    ///     and stamped the canonical policy. Aggregators can trust this as
    ///     "the hook is actually running for this pool".
    ///   `installedGovernance` — no on-chain analog exists (no governance
    ///     module is currently deployed on any launched token), so it stays
    ///     equal to `requestedGovernance` and is documented as "advertised
    ///     only" until a governance-registry check exists.
    installedHook: boolean;
    installedGovernance: boolean;
  };
}

/// GH-13 pure builder — takes plain row objects instead of talking to the db.
/// Unit-testable without a Postgres/pglite; the route handler assembles the
/// same row shape from live db reads before calling here.
///
/// `fallbackPoolId` / `fallbackHookAddress` let the caller pass a derived
/// poolId for a token that hasn't graduated yet (the wired MHH + computeV4PoolId
/// produce the same key the future graduation will use). Post-graduation, the
/// `graduation` object supersedes the fallbacks.
export function buildLaunchCard(input: {
  launch: {
    tokenAddress: Address;
    chainId: number;
    launchedBy: Address;
    txHash: Hex;
    blockNumber: bigint;
    name: string;
    ticker: string;
    installedHook: boolean;
    installedGovernance: boolean;
    requestedHook: boolean | null;
    requestedGovernance: boolean | null;
    curveAddress: Address | null;
  };
  curve: {
    curveAddress: Address;
    virtualEthReserve: bigint;
    virtualTokenReserve: bigint;
    graduationTargetEth: bigint;
    tradeFeeBps: number;
    ethReserve: bigint;
    tokenReserve: bigint;
  } | null;
  graduation: {
    poolId: Hex | null;
    hookAddress: Address | null;
    txHash: Hex;
    blockNumber: bigint;
  } | null;
  fallbackPoolId?: Hex | null;
  fallbackHookAddress?: Address | null;
  policy: {
    antiSniperBlocks: number;
    buybackBurnBps: number;
    platformFeeBps: number;
    creatorFeeBps: number;
    creatorRecipient: Address;
    immutableAfterLaunch: boolean;
  } | null;
  latestSwap: {
    sqrtPriceX96: bigint;
    liquidity: bigint;
  } | null;
  /// GH-15: per-chain loyalty availability. Route handler passes
  /// `loyaltyStateForChainId(launch.chainId)` from indexer/chains.ts. When
  /// omitted (e.g. unit tests exercising other fields), defaults to
  /// `{ advertised: false, live: false }` — the pre-#15 behavior.
  loyalty?: { advertised: boolean; live: boolean };
}): LaunchCard {
  const { launch, curve, graduation, policy, latestSwap } = input;
  const loyalty = input.loyalty ?? { advertised: false, live: false };
  const poolId = graduation?.poolId ?? input.fallbackPoolId ?? null;
  const hookAddress = graduation?.hookAddress ?? input.fallbackHookAddress ?? null;

  // GH-13 field-cleanup Option A: `installedHook` is FACTUAL on-chain state,
  // not "the launcher asked for a hook at Router.launch". The distinction is
  // load-bearing: a launcher can request a hook but have the pool never open
  // (curve never graduates), in which case no MHH state exists and any UI
  // that trusted the requested flag would render a false "hook active" badge.
  const installedHook = !!policy?.immutableAfterLaunch;
  // Fall back to the legacy column when the caller's row was populated before
  // the schema migration added `requestedHook` / `requestedGovernance` (which
  // dual-write for new inserts but default `false` on old rows).
  const requestedHook = launch.requestedHook ?? launch.installedHook;
  const requestedGovernance =
    launch.requestedGovernance ?? launch.installedGovernance;

  return {
    token: launch.tokenAddress,
    chainId: launch.chainId,
    launcher: launch.launchedBy,
    launchTx: launch.txHash,
    launchBlock: launch.blockNumber.toString(),
    name: launch.name,
    ticker: launch.ticker,
    curve: curve
      ? {
          address: curve.curveAddress,
          virtualEthReserve: curve.virtualEthReserve.toString(),
          virtualTokenReserve: curve.virtualTokenReserve.toString(),
          graduationTargetEth: curve.graduationTargetEth.toString(),
          tradeFeeBps: curve.tradeFeeBps,
          ethReserve: curve.ethReserve.toString(),
          tokenReserve: curve.tokenReserve.toString(),
        }
      : null,
    graduation: {
      state: graduation ? 'graduated' : 'pre',
      tx: graduation?.txHash ?? null,
      block: graduation ? graduation.blockNumber.toString() : null,
    },
    pool: {
      poolId,
      hookAddress,
      sqrtPriceX96: latestSwap ? latestSwap.sqrtPriceX96.toString() : null,
      liquidity: latestSwap ? latestSwap.liquidity.toString() : null,
    },
    hookPolicy: policy
      ? {
          antiSniperBlocks: policy.antiSniperBlocks,
          buybackBurnBps: policy.buybackBurnBps,
          platformFeeBps: policy.platformFeeBps,
          creatorFeeBps: policy.creatorFeeBps,
          creatorRecipient: policy.creatorRecipient,
          immutableAfterLaunch: policy.immutableAfterLaunch,
        }
      : null,
    lpLock: { locked: true, source: LP_LOCK_SOURCE },
    // GH-15: loyalty metadata derived per-chain from indexer env config.
    // Route handler resolves this via loyaltyStateForChainId(launch.chainId);
    // see indexer/chains.ts for the advertised/live definitions. When the
    // caller omits the field (unit tests exercising other branches), the
    // pre-#15 default of `{advertised:false, live:false}` is preserved so
    // existing consumers don't see a semantic change unexpectedly.
    loyalty,
    meta: {
      requestedHook,
      requestedGovernance,
      installedHook,
      installedGovernance: requestedGovernance,
    },
  };
}
