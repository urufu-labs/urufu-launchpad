/// Production wiring for the v2 tools: public Robinhood RPC (never a keyed URL),
/// the Ponder indexer, the compile-service (metadata + IPFS pin), and the guarded
/// image fetch. Server-only.

import { getAddress, type Address, type Hex } from 'viem';

import { ERC8004_IDENTITY_REGISTRY } from '../../../../shared/agent-link';

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
  fetchLaunchesByCreator,
  fetchLaunchesByTokens,
  fetchNftCollectionsByAddresses,
  fetchV4SwapsForPoolId,
  fetchV4SwapsForToken,
} from '../indexer';
import { LAUNCHPAD_LIVE } from '../launchpadStatus';
import { V10_MULTI_HOOK_HOST } from '../legacyGraduations';
import { fetchTokenMetadata } from '../socialApi';
import { checkDataUrl, safeFetchImage } from './safeFetch';
import type { AgentBook, AgentDeps, AgentLinkInput, AgentRecord } from './tools';

const COMPILE_SERVICE_URL =
  process.env.NEXT_PUBLIC_COMPILE_SERVICE_URL ?? process.env.COMPILE_SERVICE_URL ?? 'http://localhost:3001';

/// SwarmVaultFactory: not deployed yet (audit first, docs/PLAN-agents-and-swarms.md §8).
/// Set this to the verified address when it goes live; null keeps the swarm tools off.
const SWARM_VAULT_FACTORY: Address | null = null;

/// Uniswap v4 Quoter on Robinhood (post-migration address book).
const V4_QUOTER: Address = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';

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
    V4Quoter: V4_QUOTER,
    LegacyMultiHookHost: V10_MULTI_HOOK_HOST,
    SwarmVaultFactory: SWARM_VAULT_FACTORY,
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

/// Agent link store on the compile-service (it verifies the owner's signature and
/// the ERC-8004 record itself; nothing here is trusted by it).
async function linkAgent(input: AgentLinkInput): ReturnType<AgentDeps['agents']['link']> {
  try {
    const res = await fetch(`${COMPILE_SERVICE_URL}/agents/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { record?: AgentRecord; code?: string; message?: string };
    if (res.ok && body.record) return { ok: true, record: body.record };
    return { ok: false, status: res.status >= 400 && res.status < 600 ? res.status : 502, code: body.code ?? 'LINK_FAILED', message: body.message ?? `agent store returned HTTP ${res.status}` };
  } catch {
    return { ok: false, status: 502, code: 'UPSTREAM', message: 'agent store unreachable; try again shortly' };
  }
}

async function agentsByWallets(wallets: Address[]): Promise<AgentRecord[] | null> {
  if (wallets.length === 0) return [];
  try {
    const q = encodeURIComponent(wallets.slice(0, 100).map((w) => getAddress(w).toLowerCase()).join(','));
    const res = await fetch(`${COMPILE_SERVICE_URL}/agents?wallets=${q}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { agents: AgentRecord[] }).agents ?? [];
  } catch {
    return null;
  }
}

async function saveMetadata(token: Address, body: Record<string, unknown>): Promise<{ status: number; code?: string }> {
  try {
    const res = await fetch(`${COMPILE_SERVICE_URL}/token/4663/${token.toLowerCase()}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { code?: string };
    return { status: res.status, code: json.code };
  } catch {
    return { status: 502, code: 'UPSTREAM' };
  }
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
      launchesByCreator: (c) => fetchLaunchesByCreator(c, 100),
    },
    agents: { link: linkAgent, byWallets: agentsByWallets },
    saveMetadata,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    metadata: (t) => fetchTokenMetadata(4663, t),
    pinImage,
    fetchImage: (url) => safeFetchImage(url),
    checkDataUrl: (d) => checkDataUrl(d),
  };
  return deps;
}
