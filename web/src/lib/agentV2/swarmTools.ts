/// Phase 3 tools: swarm launches (docs/PLAN-agents-and-swarms.md §4). A swarm is a
/// SwarmVault where members (people or agent accounts) pool ETH, vote with it, and back
/// a named creator's Fair launch as one opening-batch participant. All unsigned txs:
///
///   get_swarm           anyone: a swarm's settings, vote, stage and a member's share
///   create_swarm        proposer: start a swarm for a named creator's coin
///   swarm_action        member: join, approve, unapprove, leave, join_batch, claim
///   allow_agent_swarm   owner: let an agent account take part in one swarm
///
/// Until the SwarmVaultFactory is deployed (after its audit) `book.SwarmVaultFactory` is
/// null and every tool here says swarms aren't live yet. A vault is only accepted if
/// the factory says it made it, so a look-alike contract can't pose as a swarm.

import { encodeFunctionData, formatEther, getAddress, parseAbi, parseAbiItem, parseEther, type Address, type Hex } from 'viem';

import { assertOwned } from './accountTools';
import { removeSwarmCalls, safeBatchTx, swarmPermissionCalls, swarmVaultAbi } from './agentPolicy';
import { addressField, ETH_AMOUNT_PATTERN } from './schema';
import { fmtEth, MINUTE, NAME_PATTERN, revertMessage, simulate, SITE, ToolError, txOut, type AgentDeps, type ToolDef } from './tools';
import { untrustedBlock } from './untrusted';

export const swarmFactoryAbi = parseAbi([
  'struct Params { address creator; string name; string ticker; uint32 joinSeconds; uint32 launchSeconds; uint16 quorumBps; uint256 minPool; uint256 maxPool; uint256 minDeposit; string metadataURI; }',
  'function createSwarm(Params p) returns (address vault)',
  'function isSwarm(address vault) view returns (bool)',
]);

const swarmViewAbi = parseAbi([
  'function creator() view returns (address)',
  'function token() view returns (address)',
  'function batch() view returns (address)',
  'function name() view returns (string)',
  'function ticker() view returns (string)',
  'function joinDeadline() view returns (uint64)',
  'function launchDeadline() view returns (uint64)',
  'function quorumBps() view returns (uint16)',
  'function minPool() view returns (uint256)',
  'function maxPool() view returns (uint256)',
  'function minDeposit() view returns (uint256)',
  'function pool() view returns (uint256)',
  'function approvedEth() view returns (uint256)',
  'function passed() view returns (bool)',
  'function joined() view returns (bool)',
  'function batchClaimed() view returns (bool)',
  'function deposits(address) view returns (uint256)',
  'function approved(address) view returns (bool)',
  'function withdrawn(address) view returns (bool)',
  'function shareOf(address) view returns (uint256 tokens, uint256 eth)',
]);
const batchCloseAbi = parseAbi(['function closeTs() view returns (uint64)', 'function settled() view returns (bool)']);

const nowSec = (deps: AgentDeps) => Math.floor(deps.now() / 1000);

function factoryOf(deps: AgentDeps): Address {
  const f = deps.book.SwarmVaultFactory;
  if (!f) throw new ToolError('UNAVAILABLE', 'Swarm launches aren\'t live yet: the swarm contracts are waiting on their audit.', 409);
  return f;
}

export type SwarmStage = 'joining' | 'waiting_for_launch' | 'ready_to_join_batch' | 'in_batch' | 'claimable' | 'failed';

export interface SwarmState {
  vault: Address;
  creator: Address;
  token: Address;
  batch: Address;
  name: string;
  ticker: string;
  joinDeadline: number;
  launchDeadline: number;
  quorumBps: number;
  minPool: bigint;
  maxPool: bigint;
  minDeposit: bigint;
  pool: bigint;
  approvedEth: bigint;
  passed: boolean;
  joined: boolean;
  batchClaimed: boolean;
  creatorLaunched: boolean;
  batchOpen: boolean;
  stage: SwarmStage;
}

/// A swarm's whole state from chain. Refuses anything the factory didn't make.
export async function readSwarm(deps: AgentDeps, vaultIn: string): Promise<SwarmState> {
  const factory = factoryOf(deps);
  const vault = getAddress(vaultIn);
  const isSwarm = (await deps.client.readContract({ address: factory, abi: swarmFactoryAbi, functionName: 'isSwarm', args: [vault] }).catch(() => false)) as boolean;
  if (!isSwarm) throw new ToolError('NOT_FOUND', `${vault} is not an urufu swarm.`, 404);
  const r = <T,>(functionName: string) => deps.client.readContract({ address: vault, abi: swarmViewAbi, functionName } as Parameters<AgentDeps['client']['readContract']>[0]) as Promise<T>;
  const [creator, token, batch, name, ticker, jd, ld, quorumBps, minPool, maxPool, minDeposit, pool, approvedEth, passed, joined, batchClaimed] = await Promise.all([
    r<Address>('creator'), r<Address>('token'), r<Address>('batch'), r<string>('name'), r<string>('ticker'),
    r<bigint>('joinDeadline'), r<bigint>('launchDeadline'), r<number>('quorumBps'),
    r<bigint>('minPool'), r<bigint>('maxPool'), r<bigint>('minDeposit'),
    r<bigint>('pool'), r<bigint>('approvedEth'), r<boolean>('passed'), r<boolean>('joined'), r<boolean>('batchClaimed'),
  ]);
  const code = await deps.client.getCode({ address: batch });
  const creatorLaunched = !!code && code !== '0x';
  let batchOpen = false;
  if (creatorLaunched) {
    const [close, settled] = await Promise.all([
      deps.client.readContract({ address: batch, abi: batchCloseAbi, functionName: 'closeTs' }) as Promise<bigint>,
      deps.client.readContract({ address: batch, abi: batchCloseAbi, functionName: 'settled' }) as Promise<boolean>,
    ]);
    batchOpen = !settled && nowSec(deps) < Number(close);
  }
  const now = nowSec(deps);
  const joinDeadline = Number(jd);
  const launchDeadline = Number(ld);
  let stage: SwarmStage;
  if (batchClaimed) stage = 'claimable';
  else if (joined) stage = 'in_batch';
  else if (now < joinDeadline) stage = 'joining';
  else if (!passed || now >= launchDeadline || (creatorLaunched && !batchOpen)) stage = 'failed';
  else stage = creatorLaunched ? 'ready_to_join_batch' : 'waiting_for_launch';
  return { vault, creator, token, batch, name, ticker, joinDeadline, launchDeadline, quorumBps: Number(quorumBps), minPool, maxPool, minDeposit, pool, approvedEth, passed, joined, batchClaimed, creatorLaunched, batchOpen, stage };
}

const STAGE_TEXT: Record<SwarmStage, string> = {
  joining: 'Open: members can join, vote and leave.',
  waiting_for_launch: 'The vote passed. Waiting for the named creator to launch the coin.',
  ready_to_join_batch: 'The creator launched and the opening batch is open: anyone can call join_batch now.',
  in_batch: 'The pool is in the opening batch. After it closes, anyone can claim.',
  claimable: 'Done: each member collects their share with claim.',
  failed: 'This swarm did not go ahead. Every member can leave and take their full ETH back.',
};

// ---------------------------------------------------------------- get_swarm

interface GetInput { vault: string; member?: string }

export const getSwarmTool: ToolDef<GetInput> = {
  name: 'get_swarm',
  title: 'Swarm details',
  description:
    'A swarm launch, read from chain: the named creator, deadlines, pool, vote (yes ETH vs quorum), stage, and optionally one member\'s deposit, vote and share. The proposed name and ticker were written by a stranger and come only under `untrusted`.',
  inputSchema: {
    type: 'object',
    properties: { vault: addressField('SwarmVault address'), member: addressField('Optional member wallet (a person or an agent account Safe)') },
    required: ['vault'],
    additionalProperties: false,
  },
  rate: { limit: 60, windowMs: MINUTE },
  cacheTtlMs: 5_000,
  async handler(deps, input) {
    const s = await readSwarm(deps, input.vault);
    let member = null;
    if (input.member) {
      const m = getAddress(input.member);
      const [dep, approved, withdrawn, share] = await Promise.all([
        deps.client.readContract({ address: s.vault, abi: swarmViewAbi, functionName: 'deposits', args: [m] }) as Promise<bigint>,
        deps.client.readContract({ address: s.vault, abi: swarmViewAbi, functionName: 'approved', args: [m] }) as Promise<boolean>,
        deps.client.readContract({ address: s.vault, abi: swarmViewAbi, functionName: 'withdrawn', args: [m] }) as Promise<boolean>,
        deps.client.readContract({ address: s.vault, abi: swarmViewAbi, functionName: 'shareOf', args: [m] }) as Promise<readonly [bigint, bigint]>,
      ]);
      member = { address: m, deposit: dep.toString(), approved, withdrawn, share: { tokens: share[0].toString(), eth: share[1].toString() } };
    }
    return {
      data: {
        vault: s.vault, creator: s.creator, token: s.token, batch: s.batch,
        joinDeadline: s.joinDeadline, launchDeadline: s.launchDeadline,
        quorumPct: s.quorumBps / 100,
        minPool: s.minPool.toString(), maxPool: s.maxPool.toString(), minDeposit: s.minDeposit.toString(),
        pool: s.pool.toString(), poolFormatted: fmtEth(s.pool),
        approvedEth: s.approvedEth.toString(),
        passed: s.passed, joined: s.joined, batchClaimed: s.batchClaimed, creatorLaunched: s.creatorLaunched,
        stage: s.stage, status: STAGE_TEXT[s.stage],
        member,
        links: { token: `${SITE}/trade/${s.token}` },
      },
      untrusted: untrustedBlock({ name: s.name, ticker: s.ticker }, { name: 'name', ticker: 'ticker' }),
    };
  },
};

// ---------------------------------------------------------------- create_swarm

interface CreateInput {
  proposer: string; creator: string; name: string; ticker: string;
  joinHours: number; launchHours: number; quorumPct: number;
  minPoolEth: string; maxPoolEth: string; minDepositEth: string; metadataURI?: string;
}

/// Pure builder (also used by the fork fixture).
export function buildCreateSwarmTx(factory: Address, p: {
  creator: Address; name: string; ticker: string; joinSeconds: number; launchSeconds: number; quorumBps: number;
  minPool: bigint; maxPool: bigint; minDeposit: bigint; metadataURI: string;
}) {
  return {
    to: factory,
    value: 0n,
    data: encodeFunctionData({ abi: swarmFactoryAbi, functionName: 'createSwarm', args: [p] }),
  };
}

export const createSwarmTool: ToolDef<CreateInput> = {
  name: 'create_swarm',
  title: 'Start a swarm launch',
  description:
    'Build the unsigned tx that starts a swarm: members pool ETH, vote, and if the vote passes the pool buys into the NAMED creator\'s Fair launch of this exact name and ticker, at the opening price. The creator must launch after the vote closes. Returns the tx for the proposer; nothing is signed.',
  inputSchema: {
    type: 'object',
    properties: {
      proposer: addressField('Wallet that sends the tx'),
      creator: addressField('Wallet that will launch the coin (a person or an agent account). It becomes the coin\'s creator.'),
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: NAME_PATTERN, description: 'Coin name, exactly as the creator will launch it' },
      ticker: { type: 'string', minLength: 1, maxLength: 16, pattern: NAME_PATTERN, description: 'Ticker, exactly as the creator will launch it' },
      joinHours: { type: 'integer', minimum: 1, maximum: 168, default: 24, description: 'Hours to join and vote (1-168)' },
      launchHours: { type: 'integer', minimum: 1, maximum: 168, default: 24, description: 'Hours after that for the creator to launch (1-168)' },
      quorumPct: { type: 'integer', minimum: 50, maximum: 100, default: 60, description: 'Share of the pooled ETH that must vote yes' },
      minPoolEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0.1', description: 'Smallest pool that can go ahead (at least 0.1 ETH)' },
      maxPoolEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0', description: 'Largest pool, 0 = no limit beyond the opening batch cap' },
      minDepositEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0.001', description: 'Smallest deposit per join (at least 0.001 ETH)' },
      metadataURI: { type: 'string', maxLength: 300, pattern: '^(https://|ipfs://)[^\\s]+$', description: 'Optional link to the coin idea (art, description)' },
    },
    required: ['proposer', 'creator', 'name', 'ticker'],
    additionalProperties: false,
  },
  rate: { limit: 10, windowMs: MINUTE },
  walletRate: { field: 'proposer', rule: { limit: 5, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const factory = factoryOf(deps);
    const proposer = getAddress(input.proposer);
    const creator = getAddress(input.creator);
    const name = input.name.trim();
    const ticker = input.ticker.trim().toUpperCase();
    if (!name || !ticker) throw new ToolError('INVALID_INPUT', 'name and ticker must not be blank');
    const params = {
      creator, name, ticker,
      joinSeconds: input.joinHours * 3600,
      launchSeconds: input.launchHours * 3600,
      quorumBps: input.quorumPct * 100,
      minPool: parseEther(input.minPoolEth),
      maxPool: parseEther(input.maxPoolEth),
      minDeposit: parseEther(input.minDepositEth),
      metadataURI: input.metadataURI ?? '',
    };
    const tx = buildCreateSwarmTx(factory, params);
    const simulation = await simulate(deps.client, proposer, tx);
    const errors = simulation.ok ? [] : [`Simulation reverted: ${simulation.error}`];
    const summary =
      `Start a swarm for "${name}" ($${ticker}), to be launched by ${creator}. Join and vote for ${input.joinHours} h, then the creator has ${input.launchHours} h to launch. ` +
      `Goes ahead with at least ${fmtEth(params.minPool)} pooled and ${input.quorumPct}% of it voting yes.`;
    return {
      data: {
        proposer, creator, factory, params: { ...params, minPool: params.minPool.toString(), maxPool: params.maxPool.toString(), minDeposit: params.minDeposit.toString() },
        transactions: [txOut(tx, 1, 'createSwarm', summary)],
        simulation, errors, canBroadcast: errors.length === 0, summary,
        warnings: ['The creator must launch AFTER the vote closes, with exactly this name and ticker. A launch before that, or with any other spelling, can\'t receive the pool; members then take their ETH back.'],
        next: 'Show `summary` to the human and wait for a yes. After it confirms, the SwarmCreated event in the receipt gives the vault address; check it with get_swarm.',
      },
    };
  },
};

// ---------------------------------------------------------------- swarm_action

type Action = 'join' | 'approve' | 'unapprove' | 'leave' | 'join_batch' | 'claim';
interface ActionInput { vault: string; member: string; action: Action; ethIn?: string }

export const swarmActionTool: ToolDef<ActionInput> = {
  name: 'swarm_action',
  title: 'Join, vote, leave or claim in a swarm',
  description:
    'Build the unsigned tx(s) for one swarm step: "join" (deposit ethIn), "approve" / "unapprove" (vote yes with all your ETH in the vault, or take it back), "leave" (all your ETH back, until the pool joins the batch), "join_batch" (anyone, once the creator launched), "claim" (your share of the coins and any refund). For an agent account, `member` is the Safe and each tx is then wrapped with agent_exec. Checks the step against the swarm first.',
  inputSchema: {
    type: 'object',
    properties: {
      vault: addressField('SwarmVault address'),
      member: addressField('Who sends it: a person\'s wallet or an agent account Safe'),
      action: { type: 'string', enum: ['join', 'approve', 'unapprove', 'leave', 'join_batch', 'claim'] },
      ethIn: { type: 'string', pattern: ETH_AMOUNT_PATTERN, description: 'join only: ETH to deposit' },
    },
    required: ['vault', 'member', 'action'],
    additionalProperties: false,
  },
  rate: { limit: 30, windowMs: MINUTE },
  walletRate: { field: 'member', rule: { limit: 20, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const s = await readSwarm(deps, input.vault);
    const member = getAddress(input.member);
    const now = nowSec(deps);
    const deposit = (await deps.client.readContract({ address: s.vault, abi: swarmViewAbi, functionName: 'deposits', args: [member] })) as bigint;
    const call = (fn: string, value = 0n) => ({ to: s.vault, value, data: encodeFunctionData({ abi: swarmVaultAbi, functionName: fn } as Parameters<typeof encodeFunctionData>[0]) as Hex });
    const errors: string[] = [];
    const txs: Array<{ tx: ReturnType<typeof call>; purpose: string; summary: string }> = [];

    switch (input.action) {
      case 'join': {
        if (!input.ethIn) throw new ToolError('INVALID_INPUT', '`ethIn` is required to join');
        const v = parseEther(input.ethIn);
        if (s.joined || now >= s.joinDeadline) errors.push('Joining has closed for this swarm.');
        if (v < s.minDeposit) errors.push(`The smallest deposit is ${fmtEth(s.minDeposit)}.`);
        if (s.maxPool > 0n && s.pool + v > s.maxPool) errors.push(`That would take the pool past its limit of ${fmtEth(s.maxPool)}.`);
        txs.push({ tx: call('join', v), purpose: 'join', summary: `Put ${fmtEth(v)} into the swarm from ${member}. You can take it all back until the pool joins the launch.` });
        break;
      }
      case 'approve':
      case 'unapprove':
        if (now >= s.joinDeadline) errors.push('Voting has closed for this swarm.');
        if (deposit === 0n) errors.push('Join first: your vote weight is the ETH you have in the swarm.');
        txs.push({ tx: call(input.action), purpose: input.action, summary: input.action === 'approve' ? `Vote yes with ${fmtEth(deposit)} (and anything you add later).` : 'Take back your yes vote.' });
        break;
      case 'leave':
        if (s.joined) errors.push('The pool already joined the launch; use claim instead.');
        if (deposit === 0n) errors.push('Nothing to take back.');
        txs.push({ tx: call('leave'), purpose: 'leave', summary: `Leave the swarm and take back ${fmtEth(deposit)}.` });
        break;
      case 'join_batch':
        if (s.stage !== 'ready_to_join_batch') errors.push(`Not ready: ${STAGE_TEXT[s.stage]}`);
        txs.push({ tx: call('joinBatch'), purpose: 'joinBatch', summary: `Put the swarm's ${fmtEth(s.pool)} into the coin's opening batch.` });
        break;
      case 'claim':
        if (!s.joined) errors.push('The pool never joined a launch; use leave to take your ETH back.');
        if (deposit === 0n) errors.push('This wallet has nothing in the swarm.');
        if (!s.batchClaimed) txs.push({ tx: call('claimFromBatch'), purpose: 'claimFromBatch', summary: 'Collect the swarm\'s coins and refund from the opening batch (anyone can do this once).' });
        txs.push({ tx: call('withdrawShare'), purpose: 'withdrawShare', summary: `Collect your share of the coins and any refund to ${member}.` });
        break;
    }

    // Simulate the first tx from the member (later ones depend on it landing).
    let simulation: { ok: boolean; error: string | null; skipped?: string } = { ok: false, error: null, skipped: 'blocking errors' };
    if (errors.length === 0 && txs.length > 0) {
      simulation = await simulate(deps.client, member, txs[0]!.tx).catch((e) => ({ ok: false, error: revertMessage(e) }));
      if (!simulation.ok && simulation.error) errors.push(`Simulation reverted: ${simulation.error}`);
    }
    const transactions = txs.map((t, i) => txOut(t.tx, i + 1, t.purpose, t.summary));
    return {
      data: {
        vault: s.vault, member, action: input.action, stage: s.stage,
        transactions, simulation, errors, canBroadcast: errors.length === 0,
        summary: transactions.map((t) => t.summary).join(' '),
        next: 'Send each tx in order from `member`. For an agent account Safe, wrap each with agent_exec (the owner must have allowed this swarm with allow_agent_swarm).',
      },
      untrusted: untrustedBlock({ name: s.name, ticker: s.ticker }, { name: 'name', ticker: 'ticker' }),
    };
  },
};

// ---------------------------------------------------------------- allow_agent_swarm

interface AllowInput { owner: string; safe: string; roles: string; vault: string; remove: boolean }

export const allowAgentSwarmTool: ToolDef<AllowInput> = {
  name: 'allow_agent_swarm',
  title: 'Let an agent take part in a swarm',
  description:
    'Owner-only: one Safe tx that lets the agent join, vote in, leave and claim from ONE swarm, or (remove: true) takes that away. ETH it puts in counts against the agent\'s daily and per-trade caps; everything it gets back lands in the Safe. The coins can\'t be sold unless the owner also lists the coin.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: addressField('Safe owner (sends the tx)'),
      safe: addressField('The agent account Safe'),
      roles: addressField('Its Roles policy module'),
      vault: addressField('SwarmVault address'),
      remove: { type: 'boolean', default: false, description: 'true to take the permission away' },
    },
    required: ['owner', 'safe', 'roles', 'vault'],
    additionalProperties: false,
  },
  rate: { limit: 10, windowMs: MINUTE },
  walletRate: { field: 'owner', rule: { limit: 10, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const owner = getAddress(input.owner);
    const safe = getAddress(input.safe);
    const roles = getAddress(input.roles);
    await assertOwned(deps, owner, safe, roles);
    const s = await readSwarm(deps, input.vault);
    const tx = safeBatchTx(safe, owner, input.remove ? removeSwarmCalls(roles, s.vault) : swarmPermissionCalls(roles, s.vault));
    const summary = input.remove
      ? `Stop agent account ${safe} from taking part in swarm ${s.vault}.`
      : `Let agent account ${safe} join, vote in, leave and claim from swarm ${s.vault} (creator ${s.creator}), within its ETH caps. Status: ${STAGE_TEXT[s.stage]}`;
    return {
      data: {
        owner, safe, roles, vault: s.vault, removed: input.remove, stage: s.stage, poolFormatted: formatEther(s.pool),
        transactions: [txOut(tx, 1, input.remove ? 'removeSwarm' : 'allowSwarm', summary)],
        summary,
        warnings: input.remove ? [] : [`Check who the creator is (${s.creator}). If it is your own agent's wallet, or someone it works with, the creator earns the coin's trading fees from a pool your Safe helps fund. Your caps still limit how much the agent can put in.`],
        next: 'Show `summary` and `warnings` to the OWNER; the OWNER sends this tx. The agent then uses swarm_action with the Safe as `member` and wraps each tx with agent_exec.',
      },
      untrusted: untrustedBlock({ name: s.name, ticker: s.ticker }, { name: 'name', ticker: 'ticker' }),
    };
  },
};

// ---------------------------------------------------------------- list_swarms

export const SWARM_CREATED_EVENT = parseAbiItem(
  'event SwarmCreated(address indexed vault, address indexed proposer, address indexed creator, address token, address batch, string name, string ticker, uint64 joinDeadline, uint64 launchDeadline, uint16 quorumBps, uint256 minPool, uint256 maxPool, uint256 minDeposit, string metadataURI)',
);
/// The public RPC answers address-filtered getLogs over ~10M blocks per call.
const LIST_WINDOW = 9_500_000n;
const LIST_MAX_WINDOWS = 6;
const LIST_LIMIT = 12;

interface ListInput { creator?: string }

export const listSwarmsTool: ToolDef<ListInput> = {
  name: 'list_swarms',
  title: 'List swarm launches',
  description:
    'The newest swarms (up to 12), from the swarm factory\'s events on chain, with each one\'s creator, deadlines, pool and stage. Optionally only swarms for one creator. Proposed names, tickers and idea links were written by strangers and come only under each item\'s `untrusted`.',
  inputSchema: { type: 'object', properties: { creator: addressField('Optional: only swarms for this creator') }, additionalProperties: false },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 30_000,
  async handler(deps, input) {
    const factory = factoryOf(deps);
    const start = deps.book.SwarmVaultFactoryStartBlock ?? 0n;
    const head = await deps.client.getBlockNumber();
    const creator = input.creator ? getAddress(input.creator) : undefined;
    const events: Array<{ args: Record<string, unknown>; blockNumber: bigint | null }> = [];
    let to = head;
    for (let w = 0; w < LIST_MAX_WINDOWS && to >= start && events.length < LIST_LIMIT; w++) {
      const from = to - LIST_WINDOW + 1n > start ? to - LIST_WINDOW + 1n : start;
      const logs = (await deps.client.getLogs({ address: factory, event: SWARM_CREATED_EVENT, args: creator ? { creator } : undefined, fromBlock: from, toBlock: to })) as unknown as typeof events;
      events.push(...[...logs].reverse());
      if (from === start) break;
      to = from - 1n;
    }
    const newest = events.slice(0, LIST_LIMIT);
    const now = nowSec(deps);
    const items = await Promise.all(newest.map(async (e) => {
      const a = e.args as { vault: Address; creator: Address; token: Address; batch: Address; name: string; ticker: string; joinDeadline: bigint; launchDeadline: bigint; quorumBps: number; minPool: bigint; metadataURI: string };
      const r = <T,>(fn: string) => deps.client.readContract({ address: a.vault, abi: swarmViewAbi, functionName: fn } as Parameters<AgentDeps['client']['readContract']>[0]) as Promise<T>;
      const [pool, passed, joined, batchClaimed] = await Promise.all([r<bigint>('pool'), r<boolean>('passed'), r<boolean>('joined'), r<boolean>('batchClaimed')]);
      const jd = Number(a.joinDeadline);
      const ld = Number(a.launchDeadline);
      const stage: SwarmStage | 'closed' = batchClaimed ? 'claimable' : joined ? 'in_batch' : now < jd ? 'joining' : now >= ld ? 'closed' : passed ? 'waiting_for_launch' : 'failed';
      return {
        vault: a.vault, creator: a.creator, token: a.token,
        joinDeadline: jd, launchDeadline: ld, quorumPct: Number(a.quorumBps) / 100,
        minPool: a.minPool.toString(), pool: pool.toString(), poolFormatted: fmtEth(pool), passed, stage,
        createdBlock: e.blockNumber?.toString() ?? null,
        untrusted: untrustedBlock({ name: a.name, ticker: a.ticker, idea: a.metadataURI || null }, { name: 'name', ticker: 'ticker', idea: 'link' }),
      };
    }));
    return { data: { factory, count: items.length, swarms: items } };
  },
};

export const SWARM_TOOLS = [listSwarmsTool, getSwarmTool, createSwarmTool, swarmActionTool, allowAgentSwarmTool] as unknown as ReadonlyArray<ToolDef<never>>;
