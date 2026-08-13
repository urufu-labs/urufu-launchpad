/// Server-side helpers for the /api/agent/* endpoints. Consolidates the public
/// client + address book so each route handler stays tiny and doesn't drift.
///
/// These endpoints exist so any AI agent (Claude, Cursor, Clawbot, ChatGPT,
/// LangChain, anything else a human hands their skill file to) can preflight +
/// verify a quick-mode launch through plain HTTP, without needing to know
/// how to encode a LaunchParams struct or hash a configHash.

import { createPublicClient, http, keccak256, encodeAbiParameters, isAddress, type Address } from 'viem';

import { robinhoodChain } from './wagmi';

/// Robinhood chain id — this whole API surface is RH-only for v1. Everything
/// downstream (address book, LAUNCHPAD_LIVE flag, indexer scope) is scoped to
/// this chain. Adding more later is a copy-paste, not a rewrite.
export const AGENT_CHAIN_ID = 4663;

/// Bare-ERC20 configHash — the module-less shape every quick launch uses.
/// Matches `keccak256(abi.encode("ERC20", ""))` as computed by the create page
/// and the contracts' `_bareConfigHash`. Precomputed rather than re-derived on
/// each request because the value never changes.
export const QUICK_CONFIG_HASH = keccak256(
  encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }],
    ['ERC20', ''],
  ),
);

/// Default curve supply for quick launches. Matches CurveFactory constructor +
/// current on-chain defaults (800M tokens with 18 decimals). Router-as-recipient
/// is baked into initData so the CurveFactory can pull the launch supply during
/// install.
export const QUICK_CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

/// Anti-sniper cadence. RH runs on Arbitrum stack — `block.number` inside a
/// contract returns the L1 Ethereum block, ~12 sec cadence. The agent skill
/// speaks seconds; contracts speak L1 blocks. 5 blocks = 60 sec, matching the
/// quick-launch default in the create page.
export const QUICK_ANTI_SNIPER_BLOCKS = 5;

/// Ownership mode enum from Solidity. Curve launches force Renounce; the
/// Router reverts otherwise. Baked into every quick launch.
export const OWNERSHIP_RENOUNCE = 0;

/// BaseType enum — ERC20 is 0, first slot in the Solidity enum.
export const BASE_ERC20 = 0;

const RPC_URL = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? robinhoodChain.rpcUrls.default.http[0]!;

/// Cached client — createPublicClient is cheap but hot-path routes benefit from
/// not re-wiring the transport each request.
let cachedClient: ReturnType<typeof createPublicClient> | null = null;
export function agentPublicClient() {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL) });
  return cachedClient;
}

/// Fallbacks match the current live RH stack (V10 CF + V11 MHH + V3 Graduator
/// as of 2026-08-13). Sync-addresses.mjs writes matching env vars in production,
/// but if Vercel env goes unset for any reason the fallbacks below keep every
/// /api/agent/* endpoint returning CURRENT production addresses rather than
/// years-old stale ones. Update these anchors alongside every RH rotation.
function req(name: string, fallback: Address): Address {
  const v = process.env[name];
  return (v && isAddress(v) ? (v as Address) : fallback);
}

export const AGENT_ADDRESSES = {
  Router: req('ROBINHOOD_ROUTER_ADDRESS', '0xb41e0Bd37D4EF19A7bd2cCEacc13CbbcD8339269'),
  NameRegistry: req('ROBINHOOD_NAME_REGISTRY_ADDRESS', '0x965Aa2420635Ca0431888c6752b9aE8Bbe8d1F05'),
  CurveFactory: req('ROBINHOOD_CURVE_FACTORY_ADDRESS', '0xEC96D023426167e68598FF9ea946882b7f0AE91f'),
  MultiHookHost: req('ROBINHOOD_MULTI_HOOK_HOST_ADDRESS', '0x83d6fa59BEF503112887b16277CF559fDC93E0C4'),
  Graduator: req('ROBINHOOD_GRADUATOR_ADDRESS', '0xB5aA5Fb4863Fe11ea7BdD6Deaf44004A09BD0C23'),
  V4SwapRouter: req('ROBINHOOD_V4_SWAP_ROUTER_ADDRESS', '0xDb3D1C43225faEe04551b663E5aA0969937beEa4'),
} as const;

/// Build the initData bytes for a quick ERC20 launch: `abi.encode(supply,
/// recipient, moduleData[])`. Recipient is always the Router because the
/// bonding curve pulls tokens from Router during install; setting anything
/// else would leave the curve unable to seed itself.
export function buildQuickInitData(): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes[]' }],
    [QUICK_CURVE_SUPPLY, AGENT_ADDRESSES.Router, []],
  );
}

/// Assemble the LaunchParams tuple for a quick launch given the caller's
/// choice of name + ticker. Every other field is a compile-time constant.
export function buildQuickLaunchParams(name: string, ticker: string) {
  return {
    base: BASE_ERC20,
    name,
    ticker,
    configHash: QUICK_CONFIG_HASH,
    initData: buildQuickInitData(),
    moduleCount: 1n,
    installHook: false,
    installGovernance: false,
    installBondingCurve: true,
    ownership: OWNERSHIP_RENOUNCE,
    ownerTargetIfMultisig: '0x0000000000000000000000000000000000000000' as Address,
    antiSniperBlocks: QUICK_ANTI_SNIPER_BLOCKS,
    buybackBurnBps: 0,
  } as const;
}

/// The `Launched` event signature Router emits on every entrypoint. Agents
/// pass a txHash to /api/agent/verify and we pluck the token address out of
/// this log — no ABI decoding required client-side.
export const LAUNCHED_EVENT_TOPIC = '0x8a482f58a69c4fea74667327ae25ad97e5ba519d148fecd5a7ce05d0dcc1bf8d' as const;
