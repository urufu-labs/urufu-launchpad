/// Money in and out of an agent account (docs/PLAN-agents-and-swarms.md 3.3: "owner
/// pulls the fee out: allowed, but shown on the agent page"). Read from the Safe's own
/// SafeL2 1.4.1 events over the public RPC, so it needs no indexer source:
///
///   SafeSetup                 where the Safe's history starts (scan stops here)
///   SafeReceived              ETH sent in (funding)
///   SafeMultiSigTransaction   every owner tx: to, value, data, call or delegatecall
///   ExecutionFailure          the owner tx in the same tx hash reverted inside the Safe
///
/// Owner txs that are MultiSend batches (delegatecall) are unpacked so each inner call
/// is classified. Agent txs (SafeModuleTransaction) are trades and show elsewhere.
///
/// The public RPC answers address-filtered getLogs over ~10M blocks (~12 days) per
/// call, so the scan walks back in windows from the head until it reaches SafeSetup,
/// up to MAX_WINDOWS; anything older is reported as not scanned.

import { decodeAbiParameters, decodeFunctionData, formatEther, formatUnits, getAddress, hexToBigInt, parseAbi, toEventSelector, type Address, type Hex } from 'viem';

import { AGENT_ACCOUNT_CONTRACTS } from './agentPolicy';
import type { AgentDeps } from './tools';

export const HISTORY_WINDOW_BLOCKS = 9_500_000n;
export const MAX_WINDOWS = 6;

const EV = {
  setup: toEventSelector('SafeSetup(address,address[],uint256,address,address)'),
  received: toEventSelector('SafeReceived(address,uint256)'),
  multisig: toEventSelector('SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)'),
  failure: toEventSelector('ExecutionFailure(bytes32,uint256)'),
} as const;

/// Canonical MultiSend deployments for Safe 1.4.1 (call-only and full).
const MULTISEND = new Set([AGENT_ACCOUNT_CONTRACTS.MultiSendCallOnly.toLowerCase(), '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526']);

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);

export interface RawLog {
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  blockTimestamp?: bigint | number | string | null;
  logIndex: number | null;
}

export type HistoryKind = 'funded' | 'withdrew_eth' | 'withdrew_token' | 'spent' | 'changed_limits' | 'settings' | 'other';

export interface HistoryEntry {
  kind: HistoryKind;
  label: string;
  /// ETH moved by this entry, in wei (0 when none).
  eth: string;
  to: Address | null;
  token: Address | null;
  amount: string | null;
  failed: boolean;
  txHash: Hex | null;
  blockNumber: string | null;
  timestamp: number | null;
}

interface Call { to: Address; value: bigint; data: Hex }

/// MultiSend packing: op(1) to(20) value(32) dataLength(32) data, repeated.
export function unpackMultiSend(packed: Hex): Array<Call & { operation: number }> {
  const hex = packed.slice(2);
  const out: Array<Call & { operation: number }> = [];
  let i = 0;
  while (i + 170 <= hex.length) {
    const operation = parseInt(hex.slice(i, i + 2), 16);
    const to = getAddress(`0x${hex.slice(i + 2, i + 42)}`);
    const value = hexToBigInt(`0x${hex.slice(i + 42, i + 106)}`);
    const len = Number(hexToBigInt(`0x${hex.slice(i + 106, i + 170)}`));
    out.push({ operation, to, value, data: `0x${hex.slice(i + 170, i + 170 + len * 2)}` });
    i += 170 + len * 2;
  }
  return out;
}

const trim = (v: string, places: number) => {
  const [whole, frac = ''] = v.split('.');
  const f = frac.slice(0, places).replace(/0+$/, '');
  return f ? `${whole}.${f}` : whole;
};
const fmt = (wei: bigint) => (wei > 0n && wei < 1_000_000_000_000n ? 'under 0.000001 ETH' : `${trim(formatEther(wei), 6)} ETH`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Known { safe: Address; roles: Address | null; urufu: Set<string> }

/// One owner call -> one entry. Plain ETH sends and token transfers out are the
/// withdrawals; ETH sent along with a contract call is spending, not withdrawing.
function classifyCall(c: Call, k: Known): Omit<HistoryEntry, 'failed' | 'txHash' | 'blockNumber' | 'timestamp'> {
  const to = getAddress(c.to);
  const base = { eth: '0', to, token: null, amount: null };
  if (to.toLowerCase() === k.safe.toLowerCase()) return { ...base, kind: 'settings', label: 'Changed the Safe’s settings' };
  if (k.roles && to.toLowerCase() === k.roles.toLowerCase()) return { ...base, kind: 'changed_limits', label: 'Changed the agent’s limits' };
  if (c.data === '0x' || c.data.length < 10) {
    if (c.value === 0n) return { ...base, kind: 'other', label: `Empty call to ${short(to)}` };
    return { ...base, kind: 'withdrew_eth', eth: c.value.toString(), label: `Owner took out ${fmt(c.value)} to ${short(to)}` };
  }
  try {
    const t = decodeFunctionData({ abi: erc20Abi, data: c.data });
    const [dest, amount] = t.args as readonly [Address, bigint];
    return { kind: 'withdrew_token', eth: c.value.toString(), to: getAddress(dest), token: to, amount: amount.toString(), label: `Owner moved ${trim(formatUnits(amount, 18), 2)} tokens of ${short(to)} to ${short(dest)}` };
  } catch { /* not a transfer */ }
  const where = k.urufu.has(to.toLowerCase()) ? 'urufu' : short(to);
  if (c.value > 0n) return { ...base, kind: 'spent', eth: c.value.toString(), label: `Owner spent ${fmt(c.value)} on ${where}` };
  return { ...base, kind: 'other', label: `Owner called ${where}` };
}

export interface HistorySummary {
  fundedEth: string;
  ownerWithdrewEth: string;
  ownerSpentEth: string;
  tokenWithdrawals: Array<{ token: Address; amount: string }>;
  entries: HistoryEntry[];
}

/// Pure: turn a Safe's logs into history entries (newest first) and totals.
export function classifySafeLogs(logs: RawLog[], k: Known): HistorySummary {
  const failedTx = new Set(logs.filter((l) => l.topics[0] === EV.failure).map((l) => l.transactionHash));
  const entries: HistoryEntry[] = [];
  const ordered = [...logs].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  for (const l of ordered) {
    const meta = {
      txHash: l.transactionHash,
      blockNumber: l.blockNumber?.toString() ?? null,
      // The public RPC returns blockTimestamp 0x0; callers fill real times in.
      timestamp: l.blockTimestamp != null && BigInt(l.blockTimestamp) > 0n ? Number(BigInt(l.blockTimestamp)) : null,
    };
    if (l.topics[0] === EV.received) {
      const from = getAddress(`0x${l.topics[1]!.slice(26)}`);
      const [value] = decodeAbiParameters([{ type: 'uint256' }], l.data);
      if (value === 0n) continue;
      entries.push({ kind: 'funded', label: `Put in ${fmt(value)} from ${short(from)}`, eth: value.toString(), to: null, token: null, amount: null, failed: false, ...meta });
    } else if (l.topics[0] === EV.multisig) {
      const [to, value, data, operation] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
        l.data,
      ) as unknown as [Address, bigint, Hex, number];
      const failed = failedTx.has(l.transactionHash);
      let calls: Call[];
      if (operation === 1 && MULTISEND.has(to.toLowerCase())) {
        try {
          calls = unpackMultiSend(decodeFunctionData({ abi: multiSendAbi, data }).args[0] as Hex);
        } catch {
          calls = [];
        }
      } else if (operation === 1) {
        entries.push({ kind: 'other', label: `Owner ran a delegatecall to ${short(to)}`, eth: '0', to, token: null, amount: null, failed, ...meta });
        continue;
      } else {
        calls = [{ to, value, data }];
      }
      // A batch that only edits the policy shows once, not once per Roles call.
      let limitsShown = false;
      for (const c of calls) {
        const e = classifyCall(c, k);
        if (e.kind === 'changed_limits') {
          if (limitsShown) continue;
          limitsShown = true;
        }
        entries.push({ ...e, failed, ...meta });
      }
    }
  }
  let funded = 0n;
  let withdrew = 0n;
  let spent = 0n;
  const tokens = new Map<string, bigint>();
  for (const e of entries) {
    if (e.failed) continue;
    if (e.kind === 'funded') funded += BigInt(e.eth);
    if (e.kind === 'withdrew_eth') withdrew += BigInt(e.eth);
    if (e.kind === 'spent') spent += BigInt(e.eth);
    if (e.kind === 'withdrew_token' && e.token) tokens.set(e.token, (tokens.get(e.token) ?? 0n) + BigInt(e.amount ?? '0'));
  }
  return {
    fundedEth: funded.toString(),
    ownerWithdrewEth: withdrew.toString(),
    ownerSpentEth: spent.toString(),
    tokenWithdrawals: [...tokens].map(([token, amount]) => ({ token: token as Address, amount: amount.toString() })),
    entries: entries.reverse(),
  };
}

export interface HistoryScan { logs: RawLog[]; fromBlock: bigint; toBlock: bigint; complete: boolean }

/// Walks back from the head in windows until SafeSetup is found or MAX_WINDOWS.
export async function scanSafeLogs(deps: AgentDeps, safe: Address): Promise<HistoryScan> {
  const head = await deps.client.getBlockNumber();
  const logs: RawLog[] = [];
  let to = head;
  for (let w = 0; w < MAX_WINDOWS; w++) {
    const from = to > HISTORY_WINDOW_BLOCKS ? to - HISTORY_WINDOW_BLOCKS + 1n : 0n;
    const batch = (await deps.client.getLogs({ address: safe, fromBlock: from, toBlock: to })) as unknown as RawLog[];
    logs.push(...batch);
    if (batch.some((l) => l.topics[0] === EV.setup) || from === 0n) return { logs, fromBlock: from, toBlock: head, complete: true };
    to = from - 1n;
  }
  return { logs, fromBlock: to + 1n, toBlock: head, complete: false };
}

/// Fill in block times the RPC left out (one getBlock per distinct block).
export async function fillTimestamps(deps: Pick<AgentDeps, 'client'>, entries: HistoryEntry[]): Promise<HistoryEntry[]> {
  const missing = [...new Set(entries.filter((e) => e.timestamp === null && e.blockNumber).map((e) => e.blockNumber!))];
  const times = new Map<string, number>();
  await Promise.all(missing.map(async (n) => {
    const b = await deps.client.getBlock({ blockNumber: BigInt(n) }).catch(() => null);
    if (b) times.set(n, Number(b.timestamp));
  }));
  return entries.map((e) => (e.timestamp === null && e.blockNumber && times.has(e.blockNumber) ? { ...e, timestamp: times.get(e.blockNumber)! } : e));
}
