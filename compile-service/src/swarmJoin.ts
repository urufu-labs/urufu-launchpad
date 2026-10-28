/// Swarm keeper job (docs/PLAN-agents-and-swarms.md §4.1 step 4): puts each swarm's
/// pool into its creator's opening batch the moment the creator launches, and
/// collects the batch share for the swarm once the window closes.
///
/// A Fair batch is open for only 60 s after launch, so this polls every 10 s. Both
/// calls are permissionless and the vault checks everything itself (vote passed,
/// right batch, window open), so the worst a wrong call does is revert and cost gas.
/// The keeper key never holds or moves anyone's funds: `joinBatch` sends the vault's
/// own ETH to the batch, `claimFromBatch` pulls the batch share into the vault.
///
/// Swarm discovery is events only (`SwarmCreated` from the SwarmVaultFactory), scanned
/// in 50k-block chunks to fit the public RPC.
///
/// Env (all required, loop skipped otherwise; also needs KEEPER_ENABLED=true):
///   ROBINHOOD_RPC_URL, KEEPER_PRIVATE_KEY,
///   ROBINHOOD_SWARM_VAULT_FACTORY, ROBINHOOD_SWARM_START_BLOCK

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

import { chunkRanges } from './fairBank.ts';

export const SWARM_CREATED = parseAbiItem(
  'event SwarmCreated(address indexed vault, address indexed proposer, address indexed creator, address token, address batch, string name, string ticker, uint64 joinDeadline, uint64 launchDeadline, uint16 quorumBps, uint256 minPool, uint256 maxPool, uint256 minDeposit, string metadataURI)',
);

export const SWARM_VAULT_ABI = parseAbi([
  'function joined() view returns (bool)',
  'function batchClaimed() view returns (bool)',
  'function passed() view returns (bool)',
  'function pool() view returns (uint256)',
  'function approvedEth() view returns (uint256)',
  'function joinDeadline() view returns (uint64)',
  'function launchDeadline() view returns (uint64)',
  'function joinBatch()',
  'function claimFromBatch()',
]);

export const BATCH_ABI = parseAbi([
  'function openTs() view returns (uint64)',
  'function closeTs() view returns (uint64)',
  'function settled() view returns (bool)',
]);

/// How often to look. The batch window is 60 s; 10 s leaves time for a retry.
export const POLL_MS = 10_000;
/// Swarms whose launch window ended this long ago and never joined are dropped.
export const FORGET_AFTER_S = 2 * 60 * 60;

export interface SwarmJoinConfig {
  rpcUrl: string;
  keeperKey: Hex;
  factory: Address;
  startBlock: bigint;
}

export function swarmJoinConfig(env: NodeJS.ProcessEnv = process.env): SwarmJoinConfig | null {
  const rpcUrl = env.ROBINHOOD_RPC_URL;
  const rawKey = env.KEEPER_PRIVATE_KEY;
  const factory = env.ROBINHOOD_SWARM_VAULT_FACTORY?.trim();
  const start = env.ROBINHOOD_SWARM_START_BLOCK?.trim();
  if (!rpcUrl || !rawKey || !factory || !/^0x[0-9a-fA-F]{40}$/.test(factory) || !start || !/^\d+$/.test(start)) return null;
  const keeperKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  return { rpcUrl, keeperKey, factory: factory as Address, startBlock: BigInt(start) };
}

export interface SwarmSnapshot {
  joined: boolean;
  batchClaimed: boolean;
  passed: boolean;
  unanimous: boolean;
  joinDeadline: number;
  launchDeadline: number;
  batchExists: boolean;
  openTs: number;
  closeTs: number;
  settled: boolean;
}

export type SwarmMove = 'join' | 'claim' | 'wait' | 'done';

/// What to do with one swarm right now. Mirrors SwarmVault.joinBatch / claimFromBatch
/// so the keeper only sends txs the vault will accept.
export function swarmMove(s: SwarmSnapshot, now: number): SwarmMove {
  if (s.batchClaimed) return 'done';
  if (s.joined) return s.batchExists && (s.settled || now >= s.closeTs) ? 'claim' : 'wait';
  if (!s.batchExists) return now >= s.launchDeadline + FORGET_AFTER_S ? 'done' : 'wait';
  if (s.openTs >= s.launchDeadline) return 'done'; // launched too late: members leave
  if (s.settled || now >= s.closeTs) return 'done'; // window missed: members leave
  if (!s.passed) return 'wait'; // the vote may still pass (late leaves of no-voters)
  if (now < s.joinDeadline && !s.unanimous) return 'wait';
  return 'join';
}

/// Kept across ticks so discovery is incremental and finished swarms are skipped.
const state: { scannedTo: bigint | null; swarms: Map<Address, Address>; done: Set<Address> } = {
  scannedTo: null,
  swarms: new Map(), // vault -> batch
  done: new Set(),
};

async function discover(cfg: SwarmJoinConfig, pub: PublicClient): Promise<void> {
  const head = await pub.getBlockNumber();
  const from = state.scannedTo === null ? cfg.startBlock : state.scannedTo + 1n;
  for (const [a, b] of chunkRanges(from, head)) {
    const logs = await pub.getLogs({ address: cfg.factory, event: SWARM_CREATED, fromBlock: a, toBlock: b });
    for (const l of logs) if (l.args.vault && l.args.batch) state.swarms.set(l.args.vault as Address, l.args.batch as Address);
    state.scannedTo = b;
  }
}

async function snapshot(pub: PublicClient, vault: Address, batch: Address): Promise<SwarmSnapshot> {
  const v = (fn: string) => pub.readContract({ address: vault, abi: SWARM_VAULT_ABI, functionName: fn } as Parameters<PublicClient['readContract']>[0]);
  const [joined, batchClaimed, passed, pool, approvedEth, jd, ld, code] = await Promise.all([
    v('joined'), v('batchClaimed'), v('passed'), v('pool'), v('approvedEth'), v('joinDeadline'), v('launchDeadline'),
    pub.getCode({ address: batch }),
  ]);
  const batchExists = !!code && code !== '0x';
  let openTs = 0;
  let closeTs = 0;
  let settled = false;
  if (batchExists) {
    const [o, c, s] = await Promise.all([
      pub.readContract({ address: batch, abi: BATCH_ABI, functionName: 'openTs' }),
      pub.readContract({ address: batch, abi: BATCH_ABI, functionName: 'closeTs' }),
      pub.readContract({ address: batch, abi: BATCH_ABI, functionName: 'settled' }),
    ]);
    openTs = Number(o);
    closeTs = Number(c);
    settled = s as boolean;
  }
  return {
    joined: joined as boolean,
    batchClaimed: batchClaimed as boolean,
    passed: passed as boolean,
    unanimous: (approvedEth as bigint) === (pool as bigint),
    joinDeadline: Number(jd),
    launchDeadline: Number(ld),
    batchExists, openTs, closeTs, settled,
  };
}

export async function swarmJoinOnce(cfg: SwarmJoinConfig): Promise<void> {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) }) as PublicClient;
  await discover(cfg, pub);
  const now = Math.floor(Date.now() / 1000);
  let wallet: ReturnType<typeof createWalletClient> | null = null;
  for (const [vault, batch] of state.swarms) {
    if (state.done.has(vault)) continue;
    let move: SwarmMove;
    try {
      move = swarmMove(await snapshot(pub, vault, batch), now);
    } catch (err) {
      console.log(JSON.stringify({ keeper: 'swarm-join', vault, action: 'read-error', error: (err as Error).message.slice(0, 200) }));
      continue;
    }
    if (move === 'done') {
      state.done.add(vault);
      continue;
    }
    if (move === 'wait') continue;
    wallet ??= createWalletClient({
      account: privateKeyToAccount(cfg.keeperKey),
      transport: http(cfg.rpcUrl),
      chain: { id: 4663, name: 'robinhood', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } },
    });
    const functionName = move === 'join' ? 'joinBatch' : 'claimFromBatch';
    try {
      const hash = await wallet.writeContract({ address: vault, abi: SWARM_VAULT_ABI, functionName, chain: wallet.chain, account: wallet.account! });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(JSON.stringify({ keeper: 'swarm-join', vault, action: functionName, tx: hash, status: r.status }));
      if (move === 'claim' && r.status === 'success') state.done.add(vault);
    } catch (err) {
      // Someone else got there first, or the window just closed: the next tick re-reads.
      console.log(JSON.stringify({ keeper: 'swarm-join', vault, action: `${functionName}-failed`, error: (err as Error).message.slice(0, 200) }));
    }
  }
}

/// Every 10 s; one tick at a time.
export function startSwarmJoinLoop(cfg: SwarmJoinConfig): void {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await swarmJoinOnce(cfg);
    } catch (err) {
      console.log(JSON.stringify({ keeper: 'swarm-join', action: 'error', error: (err as Error).message.slice(0, 300) }));
    } finally {
      busy = false;
    }
  }, POLL_MS);
}
