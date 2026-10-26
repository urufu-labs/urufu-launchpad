/// Production wiring for the v2 tools: public Robinhood RPC (never a keyed URL),
/// the Ponder indexer, the compile-service (metadata + IPFS pin), and the guarded
/// image fetch. Server-only.

import type { Address, Hex } from 'viem';

import { AGENT_ADDRESSES, agentPublicClient } from '../agentApi';
import {
  DN404_LAUNCHES,
  DN404_LAUNCHES_ENABLED,
  ECOSYSTEM_TOKENS,
  FAIR_LAUNCHES,
  FAIR_LAUNCHES_ENABLED,
  FLYWHEEL,
  HOOKS,
  NFT_LAUNCHES,
  NFT_LAUNCHES_ENABLED,
  URU_PAY,
  V4_STATE_VIEWS,
} from '../config';
import {
  fetchCurveByToken,
  fetchDn404MirrorForBase,
  fetchGraduationForToken,
  fetchHoldersForToken,
  fetchLatestTradesForCurve,
  fetchLaunchesByTokens,
  fetchNftCollectionsByAddresses,
  fetchV4SwapsForPoolId,
  fetchV4SwapsForToken,
} from '../indexer';
import { LAUNCHPAD_LIVE } from '../launchpadStatus';
import { fetchTokenMetadata } from '../socialApi';
import { checkDataUrl, safeFetchImage } from './safeFetch';
import type { AgentBook, AgentDeps } from './tools';

const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? process.env.COMPILE_SERVICE_URL ?? 'http://localhost:3001';

/// ERC-8004 Identity Registry on Robinhood (plan section 7). Listed for reference;
/// registration tools arrive in phase 1b.
const ERC8004_IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export function agentBook(): AgentBook {
  const fair = FAIR_LAUNCHES.robinhood!;
  const uru = URU_PAY.robinhood!;
  return {
    Router: AGENT_ADDRESSES.Router,
    NameRegistry: AGENT_ADDRESSES.NameRegistry,
    CurveFactory: AGENT_ADDRESSES.CurveFactory,
    MultiHookHost: AGENT_ADDRESSES.MultiHookHost,
    Graduator: AGENT_ADDRESSES.Graduator,
    V4SwapRouter: AGENT_ADDRESSES.V4SwapRouter,
    PoolManager: HOOKS.robinhood!.PoolManager,
    StateView: V4_STATE_VIEWS.robinhood!,
    FairLaunchFactory: fair.LaunchFactory,
    FairHookHost: fair.HookHost,
    NftLaunchFactory: NFT_LAUNCHES.robinhood?.LaunchFactory ?? null,
    Dn404LaunchFactory: DN404_LAUNCHES.robinhood?.LaunchFactory ?? null,
    Dn404CurveFactory: DN404_LAUNCHES.robinhood?.CurveFactory ?? null,
    URU: ECOSYSTEM_TOKENS.robinhood!.uruToken,
    UruWethPoolId: uru.poolId,
    uruIsCurrency1: uru.uruIsCurrency1,
    FeeSplitter: FLYWHEEL.robinhood!.FeeSplitter,
    LoyaltyOracle: FLYWHEEL.robinhood!.LoyaltyOracle,
    Erc8004IdentityRegistry: ERC8004_IDENTITY_REGISTRY,
  };
}

async function pinImage(dataUrl: string, filename?: string): Promise<{ cid: string; gatewayUrl: string }> {
  const res = await fetch(`${COMPILE_SERVICE_URL}/pin/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl, filename }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`pin service returned HTTP ${res.status}`);
  const pin = (await res.json()) as { cid?: string; gatewayUrl?: string };
  if (!pin.cid || !pin.gatewayUrl) throw new Error('pin service returned an unexpected response');
  return { cid: pin.cid, gatewayUrl: pin.gatewayUrl };
}

let deps: AgentDeps | null = null;

export function productionDeps(): AgentDeps {
  if (deps) return deps;
  deps = {
    client: agentPublicClient() as unknown as AgentDeps['client'],
    book: agentBook(),
    flags: {
      launchpadLive: LAUNCHPAD_LIVE,
      fairEnabled: FAIR_LAUNCHES_ENABLED.robinhood === true,
      nftEnabled: NFT_LAUNCHES_ENABLED.robinhood === true,
      dn404Enabled: DN404_LAUNCHES_ENABLED.robinhood === true,
    },
    indexer: {
      launchByToken: async (t) => (await fetchLaunchesByTokens([t]))?.[0] ?? null,
      curveByToken: (t) => fetchCurveByToken(t),
      graduationForToken: (t) => fetchGraduationForToken(t),
      dn404ForBase: (t) => fetchDn404MirrorForBase(t),
      nftCollection: async (a) => (await fetchNftCollectionsByAddresses([a]))?.[0] ?? null,
      latestCurveTrades: (c, n) => fetchLatestTradesForCurve(c, n),
      v4SwapsForToken: (t, n) => fetchV4SwapsForToken(t, n),
      v4SwapsForPoolId: (p: Hex, n) => fetchV4SwapsForPoolId(p, n),
      holdersForToken: (t, n) => fetchHoldersForToken(t, n),
    },
    metadata: (t) => fetchTokenMetadata(4663, t),
    pinImage,
    fetchImage: (url) => safeFetchImage(url),
    checkDataUrl: (d) => checkDataUrl(d),
  };
  return deps;
}
