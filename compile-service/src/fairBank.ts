/// Fair launch lane keeper job: burn each Fair pool's banked ETH.
///
/// `FairHookHost` parks ETH-side sniper tax and forfeited creator fees in a
/// per-pool burn bank. `burnBank(poolId, minTokensOut)` swaps it for tokens and
/// sends them to 0xdEaD. Nothing calls it on its own, so this loop does, every
/// 10 minutes, so banks stay small (smaller banks = less to sandwich).
///
/// The hook does its own safety work: it refuses if the price moved more than ~2%
/// in the current second and stops each burn at ~1% price impact. So the loop
/// burns in steps, at least 2 s apart, until the bank is under the threshold or
/// the per-tick step budget is spent; a refused step just waits for the next one.
///
/// Pool discovery is events only (`FairPoolInitialized` from the hook), scanned
/// in 50k-block chunks to fit the public RPC (project_alchemy_suspended_public_rpc).
///
/// Env (all required, loop skipped otherwise; also needs KEEPER_ENABLED=true):
///   ROBINHOOD_RPC_URL, KEEPER_PRIVATE_KEY,
///   ROBINHOOD_FAIR_HOOK_HOST_ADDRESS, ROBINHOOD_FAIR_HOOK_START_BLOCK
///
/// Platform fees on FairHookHost use the same `owed` / `pushOwed` as
/// MultiHookHost, so the existing sweep-mhh loop covers them: add the hook to
/// ROBINHOOD_MULTI_HOOK_HOSTS.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const FAIR_HOOK_ABI = parseAbi([
  'function bankedEth(bytes32 id) view returns (uint256)',
  'function burnBank(bytes32 id, uint256 minTokensOut) returns (uint256)',
]);

export const FAIR_POOL_INITIALIZED = parseAbiItem(
  'event FairPoolInitialized(bytes32 indexed poolId, address indexed token, address indexed creator, uint256 creatorBaseline, bool forfeited, uint64 launchTs, uint16 taxStartBps, uint32 taxDecaySecs, uint16 forfeitDropBps)',
);

/// Below this a burn costs more gas than it is worth.
export const BANK_BURN_THRESHOLD_WEI = 200_000_000_000_000n; // 0.0002 ETH
/// Max burn txs per pool per tick (each is impact-capped by the hook).
export const MAX_STEPS_PER_POOL = 5;
/// The hook's guard is per second; space steps so each starts in a new second.
export const STEP_GAP_MS = 2_000;
export const LOG_CHUNK = 50_000n;

export interface FairBankConfig {
  rpcUrl: string;
  keeperKey: Hex;
  hook: Address;
  startBlock: bigint;
}

export function fairBankConfig(env: NodeJS.ProcessEnv = process.env): FairBankConfig | null {
  const rpcUrl = env.ROBINHOOD_RPC_URL;
  const rawKey = env.KEEPER_PRIVATE_KEY;
  const hook = env.ROBINHOOD_FAIR_HOOK_HOST_ADDRESS?.trim();
  const start = env.ROBINHOOD_FAIR_HOOK_START_BLOCK?.trim();
  if (!rpcUrl || !rawKey || !hook || !start || !/^\d+$/.test(start)) return null;
  const keeperKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  return { rpcUrl, keeperKey, hook: hook as Address, startBlock: BigInt(start) };
}

/// Block ranges [from, to] covering (from..head] in LOG_CHUNK steps.
export function chunkRanges(from: bigint, head: bigint, chunk = LOG_CHUNK): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let a = from; a <= head; a += chunk) {
    const b = a + chunk - 1n < head ? a + chunk - 1n : head;
    out.push([a, b]);
  }
  return out;
}

/// Pools whose bank is worth burning this tick.
export function poolsToBurn(banks: Array<{ poolId: Hex; banked: bigint }>, threshold = BANK_BURN_THRESHOLD_WEI): Hex[] {
  return banks.filter((b) => b.banked >= threshold).map((b) => b.poolId);
}

/// Kept across ticks so discovery is incremental.
const state: { scannedTo: bigint | null; pools: Set<Hex> } = { scannedTo: null, pools: new Set() };

export async function discoverPools(cfg: FairBankConfig, pub: PublicClient): Promise<Hex[]> {
  const head = await pub.getBlockNumber();
  const from = state.scannedTo === null ? cfg.startBlock : state.scannedTo + 1n;
  for (const [a, b] of chunkRanges(from, head)) {
    const logs = await pub.getLogs({ address: cfg.hook, event: FAIR_POOL_INITIALIZED, fromBlock: a, toBlock: b });
    for (const l of logs) if (l.args.poolId) state.pools.add(l.args.poolId as Hex);
    state.scannedTo = b;
  }
  return [...state.pools];
}

export async function fairBankBurnOnce(cfg: FairBankConfig): Promise<void> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) }) as PublicClient;
  const pools = await discoverPools(cfg, pub);
  const banks = await Promise.all(
    pools.map(async (poolId) => ({
      poolId,
      banked: (await pub.readContract({ address: cfg.hook, abi: FAIR_HOOK_ABI, functionName: 'bankedEth', args: [poolId] })) as bigint,
    })),
  );
  const todo = poolsToBurn(banks);
  if (todo.length === 0) {
    console.log(JSON.stringify({ keeper: 'fair-bank-burn', action: 'skip', pools: pools.length }));
    return;
  }
  const account = privateKeyToAccount(cfg.keeperKey);
  const wallet = createWalletClient({
    account,
    transport: http(cfg.rpcUrl),
    chain: {
      id: 4663,
      name: 'robinhood',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    },
  });
  for (const poolId of todo) {
    for (let step = 0; step < MAX_STEPS_PER_POOL; step++) {
      const banked = (await pub.readContract({ address: cfg.hook, abi: FAIR_HOOK_ABI, functionName: 'bankedEth', args: [poolId] })) as bigint;
      if (banked < BANK_BURN_THRESHOLD_WEI) break;
      try {
        // minTokensOut = 1: the hook's own price guard + impact cap are the real
        // protection; a quote here would be read in the same block anyway.
        const hash = await wallet.writeContract({ address: cfg.hook, abi: FAIR_HOOK_ABI, functionName: 'burnBank', args: [poolId, 1n] });
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        console.log(JSON.stringify({ keeper: 'fair-bank-burn', poolId, action: 'burned', banked: banked.toString(), tx: hash, status: r.status }));
      } catch (err) {
        // Price moved this second (BankPriceMoved) or a transient RPC error:
        // stop this pool for the tick, the next tick retries.
        console.log(JSON.stringify({ keeper: 'fair-bank-burn', poolId, action: 'deferred', error: (err as Error).message.slice(0, 200) }));
        break;
      }
      await new Promise((res) => setTimeout(res, STEP_GAP_MS));
    }
  }
}

/// 10 min cadence, first run 3 min after boot.
export function startFairBankLoop(cfg: FairBankConfig): void {
  const run = async () => {
    try {
      await fairBankBurnOnce(cfg);
    } catch (err) {
      console.log(JSON.stringify({ keeper: 'fair-bank-burn', action: 'error', error: (err as Error).message.slice(0, 300) }));
    }
  };
  setTimeout(run, 3 * 60 * 1000);
  setInterval(run, 10 * 60 * 1000);
}
