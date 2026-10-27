/// Phase 1c tools: set up and run an autonomous agent account (Safe + Zodiac Roles
/// policy, see agentPolicy.ts). All unsigned txs:
///
///   setup_agent_account   owner: create Safe, deploy Roles, arm the policy, fund
///   update_agent_account  owner: add tokens, change caps (one Safe tx)
///   revoke_agent          owner: remove the agent from the role (one Safe tx)
///   get_agent_account     anyone: owners, module, caps left, Safe balance
///   agent_exec            agent: wrap a quote tool's tx so it runs from the Safe
///                         under the policy, and check now whether the policy allows it
///
/// The agent's key only ever signs `agent_exec` txs. It can't move funds the policy
/// doesn't allow, whatever text it reads or is told.

import { decodeFunctionResult, encodeFunctionData, formatEther, getAddress, parseEther, type Address, type Hex } from 'viem';

import { fairLaunchFactoryAbi } from '../abis';
import {
  AGENT_ROLE_KEY,
  ALLOWANCE_DAILY,
  ALLOWANCE_TRADE,
  agentExecTx,
  allowanceCalls,
  basePermissionCalls,
  configureCalls,
  createSafeTx,
  deployRolesTx,
  moduleProxyFactoryAbi,
  rolesAbi,
  safeAbi,
  safeBatchTx,
  safeProxyFactoryAbi,
  tokenPermissionCalls,
  type Call,
  type PolicyInput,
  type PolicyTokens,
} from './agentPolicy';
import { addressField, ETH_AMOUNT_PATTERN } from './schema';
import { revertMessage, MINUTE, ToolError, txOut, ZERO, type AgentDeps, type ToolDef } from './tools';
import { resolveMarket } from './tradeTools';

const MAX_TOKENS = 20;
const MAX_DAILY_WEI = parseEther('10');
const TOKENS_PATTERN = '^0x[0-9a-fA-F]{40}(,0x[0-9a-fA-F]{40}){0,19}$';

const fmt = (w: bigint) => `${formatEther(w)} ETH`;

function policyBase(deps: AgentDeps): Omit<PolicyInput, 'tokens'> {
  const b = deps.book;
  return {
    v4SwapRouter: b.V4SwapRouter,
    hooks: [b.MultiHookHost, b.LegacyMultiHookHost, b.FairHookHost],
    multiHookHosts: [b.MultiHookHost, b.LegacyMultiHookHost],
    fairHookHost: b.FairHookHost,
    fairLaunchFactory: b.FairLaunchFactory,
  };
}

/// Curve (and Fair batch) for each token, from chain. DN404 and unknown tokens refused.
async function resolveTokens(deps: AgentDeps, list: string | undefined): Promise<PolicyTokens[]> {
  if (!list) return [];
  const tokens = [...new Set(list.split(',').map((t) => getAddress(t.trim())))];
  if (tokens.length > MAX_TOKENS) throw new ToolError('INVALID_INPUT', `at most ${MAX_TOKENS} tokens per call`);
  const out: PolicyTokens[] = [];
  for (const token of tokens) {
    let market;
    try {
      market = await resolveMarket(deps, token);
    } catch (err) {
      throw new ToolError('BAD_TOKEN', `${token}: ${(err as Error).message}`, 400);
    }
    let batch: Address | null = null;
    if (market.lane === 'fair') {
      const b = (await deps.client.readContract({ address: deps.book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'batchFor', args: [token] })) as Address;
      batch = b && b !== ZERO ? b : null;
    }
    out.push({ token, curve: market.curve, batch });
  }
  return out;
}

function caps(dailyEth: string, perTradeEth: string) {
  const daily = parseEther(dailyEth);
  const perTrade = parseEther(perTradeEth);
  if (perTrade === 0n || daily === 0n) throw new ToolError('INVALID_INPUT', 'caps must be more than 0');
  if (perTrade > daily) throw new ToolError('INVALID_INPUT', 'the per-trade cap can\'t be above the daily cap');
  if (daily > MAX_DAILY_WEI) throw new ToolError('INVALID_INPUT', `daily cap above ${fmt(MAX_DAILY_WEI)} is refused here; keep agent accounts small`);
  return { daily, perTrade };
}

async function predict(deps: AgentDeps, from: Address, tx: Call, kind: 'safe' | 'roles'): Promise<Address> {
  try {
    const res = await deps.client.call({ account: from, to: tx.to, data: tx.data });
    if (!res.data) throw new Error('empty result');
    return kind === 'safe'
      ? (decodeFunctionResult({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', data: res.data }) as Address)
      : (decodeFunctionResult({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', data: res.data }) as Address);
  } catch (err) {
    throw new ToolError('UPSTREAM', `could not predict the ${kind} address (${revertMessage(err)}); try again`, 502);
  }
}

/// The Safe must be 1-of-1 owned by `owner` and the Roles module owned by that
/// Safe: owner-sent Safe txs use the "approved by sender" signature.
async function assertOwned(deps: AgentDeps, owner: Address, safe: Address, roles: Address) {
  const [owners, threshold, rolesOwner] = await Promise.all([
    deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }).catch(() => null) as Promise<Address[] | null>,
    deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }).catch(() => null) as Promise<bigint | null>,
    deps.client.readContract({ address: roles, abi: rolesAbi, functionName: 'owner' }).catch(() => null) as Promise<Address | null>,
  ]);
  if (!owners) throw new ToolError('NOT_FOUND', `${safe} is not a Safe on Robinhood Chain.`, 404);
  if (!owners.some((o) => o.toLowerCase() === owner.toLowerCase())) throw new ToolError('NOT_OWNER', `${owner} is not an owner of Safe ${safe}.`, 403);
  if (threshold !== 1n) throw new ToolError('UNSUPPORTED', 'This Safe needs more than one signature; propose the change in the Safe app instead.', 409);
  if (!rolesOwner || rolesOwner.toLowerCase() !== safe.toLowerCase()) throw new ToolError('NOT_FOUND', `${roles} is not a Roles module owned by this Safe.`, 404);
}

const commonCaps = {
  dailyEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0.25', description: 'Most ETH the agent may spend per 24 h (default 0.25)' },
  perTradeEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0.05', description: 'Most ETH one agent tx may spend (default 0.05)' },
} as const;

// ---------------------------------------------------------------- setup

interface SetupInput { owner: string; agent: string; tokens?: string; dailyEth: string; perTradeEth: string; fundEth: string; allowFairLaunch: boolean }

export const setupAgentAccountTool: ToolDef<SetupInput> = {
  name: 'setup_agent_account',
  title: 'Set up an autonomous agent account',
  description:
    'Owner-only setup for an agent that trades on its own: a Safe owned by the owner holds the funds, and the agent key gets a Zodiac Roles policy enforced on chain (urufu contracts only, listed tokens only, recipient pinned to the Safe, ETH caps per tx and per day). Returns the unsigned owner txs in order. The agent key is never a Safe owner.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: addressField('Human owner wallet: sends these txs and controls the Safe'),
      agent: addressField('The agent\'s own wallet (signs agent_exec txs, pays its own gas)'),
      tokens: { type: 'string', pattern: TOKENS_PATTERN, description: 'Comma-separated token addresses the agent may trade (up to 20). More can be added later.' },
      ...commonCaps,
      fundEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0', description: 'ETH to move from the owner into the Safe at the end' },
      allowFairLaunch: { type: 'boolean', default: false, description: 'Also let the agent launch Fair tokens (within the caps)' },
    },
    required: ['owner', 'agent'],
    additionalProperties: false,
  },
  rate: { limit: 10, windowMs: MINUTE },
  walletRate: { field: 'owner', rule: { limit: 5, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const owner = getAddress(input.owner);
    const agent = getAddress(input.agent);
    if (owner === agent) throw new ToolError('INVALID_INPUT', 'The agent must use its own wallet, not the owner\'s.');
    const { daily, perTrade } = caps(input.dailyEth, input.perTradeEth);
    const fund = parseEther(input.fundEth);
    const tokens = await resolveTokens(deps, input.tokens);
    const salt = BigInt(deps.now());
    const cs = createSafeTx(owner, salt);
    const safe = await predict(deps, owner, cs, 'safe');
    const dr = deployRolesTx(safe, salt);
    const roles = await predict(deps, owner, dr, 'roles');
    const policy: PolicyInput = { ...policyBase(deps), tokens };
    const arm = safeBatchTx(safe, owner, configureCalls({ safe, roles, agent, policy, dailyWei: daily, perTradeWei: perTrade, allowFairLaunch: input.allowFairLaunch }));

    const transactions = [
      txOut(cs, 1, 'createSafe', `Create a Safe owned only by ${owner}. It will be at ${safe}.`),
      txOut(dr, 2, 'deployRoles', `Deploy the agent policy module at ${roles}, owned by the Safe.`),
      txOut(arm, 3, 'armPolicy', `From the Safe: enable the module, let ${agent} act within the policy, cap it at ${fmt(perTrade)} per tx and ${fmt(daily)} per day.`),
    ];
    if (fund > 0n) transactions.push(txOut({ to: safe, value: fund, data: '0x' }, 4, 'fund', `Move ${fmt(fund)} from ${owner} into the Safe.`));
    return {
      data: {
        owner, agent, safe, roles, salt: salt.toString(),
        policy: policySummary(deps, tokens, daily, perTrade, input.allowFairLaunch),
        transactions,
        summary: `Set up an agent account: Safe ${safe} owned by ${owner}; agent ${agent} may trade ${tokens.length} token(s) on urufu, at most ${fmt(perTrade)} per tx and ${fmt(daily)} per day, with everything it buys landing in the Safe. ${transactions.length} owner txs.`,
        next: 'The OWNER sends these in order, each after the previous confirms. Then the agent uses quote_buy / quote_sell / quote_batch_deposit with the Safe as buyer/seller/depositor, and wraps each tx with agent_exec.',
      },
    };
  },
};

function policySummary(deps: AgentDeps, tokens: PolicyTokens[], daily: bigint, perTrade: bigint, allowFairLaunch: boolean) {
  return {
    caps: { perTx: fmt(perTrade), perDay: fmt(daily), note: 'Only ETH the Safe sends counts. Sells and claims bring ETH in and are not capped.' },
    tokens: tokens.map((t) => ({ token: t.token, curve: t.curve, fairBatch: t.batch })),
    allowed: [
      'buy / sell on each listed token\'s bonding curve',
      'approve a listed token to its curve or the V4SwapRouter only',
      'Fair opening batch: deposit, settle, claim, withdrawRefund to the Safe only',
      'Uniswap v4 swaps through the urufu V4SwapRouter, ETH/token 3000/60 pools at urufu hooks only, recipient = the Safe',
      'creator fee claims (MultiHookHost, FairHookHost)',
      ...(allowFairLaunch ? ['launch a Fair token (fee + deposit within the caps)'] : []),
    ],
    blocked: ['sending ETH or tokens anywhere else', 'any other contract or function', 'delegatecall', 'changing the policy or the Safe'],
    hooks: [deps.book.MultiHookHost, deps.book.LegacyMultiHookHost, deps.book.FairHookHost],
  };
}

// ---------------------------------------------------------------- update / revoke

interface UpdateInput { owner: string; safe: string; roles: string; addTokens?: string; dailyEth?: string; perTradeEth?: string; allowFairLaunch?: boolean }

export const updateAgentAccountTool: ToolDef<UpdateInput> = {
  name: 'update_agent_account',
  title: 'Change an agent account\'s policy',
  description: 'Owner-only: add tokens the agent may trade, change the ETH caps, or allow Fair launches. Returns one unsigned Safe tx for the owner.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: addressField('Safe owner (sends the tx)'),
      safe: addressField('The agent account Safe'),
      roles: addressField('Its Roles policy module'),
      addTokens: { type: 'string', pattern: TOKENS_PATTERN, description: 'Comma-separated tokens to add' },
      dailyEth: { ...commonCaps.dailyEth, default: undefined },
      perTradeEth: { ...commonCaps.perTradeEth, default: undefined },
      allowFairLaunch: { type: 'boolean', description: 'true to allow Fair launches (can\'t be turned off here; use revoke_agent and set up again)' },
    },
    required: ['owner', 'safe', 'roles'],
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
    const calls: Call[] = [];
    const changes: string[] = [];
    if ((input.dailyEth === undefined) !== (input.perTradeEth === undefined)) {
      throw new ToolError('INVALID_INPUT', 'set dailyEth and perTradeEth together');
    }
    if (input.dailyEth !== undefined) {
      const { daily, perTrade } = caps(input.dailyEth, input.perTradeEth!);
      calls.push(...allowanceCalls(roles, daily, perTrade));
      changes.push(`caps: ${fmt(perTrade)} per tx, ${fmt(daily)} per day`);
    }
    const tokens = await resolveTokens(deps, input.addTokens);
    const policy: PolicyInput = { ...policyBase(deps), tokens };
    for (const t of tokens) calls.push(...tokenPermissionCalls(roles, policy, t));
    if (tokens.length) changes.push(`add ${tokens.length} token(s)`);
    if (input.allowFairLaunch) {
      calls.push(...basePermissionCalls(roles, policy, true).slice(-2));
      changes.push('allow Fair launches');
    }
    if (calls.length === 0) throw new ToolError('INVALID_INPUT', 'nothing to change');
    const tx = safeBatchTx(safe, owner, calls);
    const summary = `Update agent account ${safe}: ${changes.join('; ')}.`;
    return { data: { owner, safe, roles, changes, transactions: [txOut(tx, 1, 'updatePolicy', summary)], summary, next: 'The OWNER sends this tx.' } };
  },
};

interface RevokeInput { owner: string; safe: string; roles: string; agent: string }

export const revokeAgentTool: ToolDef<RevokeInput> = {
  name: 'revoke_agent',
  title: 'Stop an agent',
  description: 'Owner-only: remove the agent key from the policy at once. The agent can do nothing after this confirms; funds stay in the Safe, which the owner controls as before.',
  inputSchema: {
    type: 'object',
    properties: { owner: addressField('Safe owner'), safe: addressField('Agent account Safe'), roles: addressField('Its Roles module'), agent: addressField('Agent wallet to remove') },
    required: ['owner', 'safe', 'roles', 'agent'],
    additionalProperties: false,
  },
  rate: { limit: 10, windowMs: MINUTE },
  walletRate: { field: 'owner', rule: { limit: 10, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const owner = getAddress(input.owner);
    const safe = getAddress(input.safe);
    const roles = getAddress(input.roles);
    const agent = getAddress(input.agent);
    await assertOwned(deps, owner, safe, roles);
    const tx = safeBatchTx(safe, owner, [{ to: roles, value: 0n, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [agent, [AGENT_ROLE_KEY], [false]] }) }]);
    const summary = `Stop agent ${agent}: remove it from the policy of Safe ${safe}.`;
    return { data: { owner, safe, roles, agent, transactions: [txOut(tx, 1, 'revoke', summary)], summary, next: 'The OWNER sends this tx. It takes effect as soon as it confirms.' } };
  },
};

// ---------------------------------------------------------------- read + agent exec

interface AccountInput { safe: string; roles: string }

export const getAgentAccountTool: ToolDef<AccountInput> = {
  name: 'get_agent_account',
  title: 'Agent account status',
  description: 'Read an agent account: Safe owners, whether the policy module is on, ETH caps left right now, and the Safe\'s ETH balance.',
  inputSchema: { type: 'object', properties: { safe: addressField('Agent account Safe'), roles: addressField('Its Roles module') }, required: ['safe', 'roles'], additionalProperties: false },
  rate: { limit: 60, windowMs: MINUTE },
  cacheTtlMs: 5_000,
  async handler(deps, input) {
    const safe = getAddress(input.safe);
    const roles = getAddress(input.roles);
    const [owners, threshold, enabled, rolesOwner, daily, trade, balance] = await Promise.all([
      deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }).catch(() => null),
      deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }).catch(() => null),
      deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [roles] }).catch(() => null),
      deps.client.readContract({ address: roles, abi: rolesAbi, functionName: 'owner' }).catch(() => null),
      deps.client.readContract({ address: roles, abi: rolesAbi, functionName: 'allowances', args: [ALLOWANCE_DAILY] }).catch(() => null),
      deps.client.readContract({ address: roles, abi: rolesAbi, functionName: 'allowances', args: [ALLOWANCE_TRADE] }).catch(() => null),
      deps.client.getBalance({ address: safe }),
    ]);
    if (!owners) throw new ToolError('NOT_FOUND', `${safe} is not a Safe on Robinhood Chain.`, 404);
    const allowance = (a: unknown) => {
      if (!a) return null;
      const [refill, maxRefill, period, bal, ts] = a as readonly [bigint, bigint, bigint, bigint, bigint];
      // Balance as stored; refills are applied lazily by the module on next use.
      return { storedBalance: bal.toString(), refill: refill.toString(), maxRefill: maxRefill.toString(), periodSec: Number(period), lastRefill: Number(ts) };
    };
    return {
      data: {
        safe, roles, owners, threshold: threshold?.toString() ?? null,
        policyActive: enabled === true && (rolesOwner as Address | null)?.toLowerCase() === safe.toLowerCase(),
        caps: { daily: allowance(daily), perTx: allowance(trade) },
        safeBalance: balance.toString(), safeBalanceFormatted: fmt(balance),
      },
    };
  },
};

interface ExecInput { safe: string; roles: string; agent: string; to: string; value: string; data: string }

export const agentExecTool: ToolDef<ExecInput> = {
  name: 'agent_exec',
  title: 'Run a tx from the agent account',
  description:
    'Autonomous mode: wrap one unsigned tx from quote_buy / quote_sell / quote_batch_deposit / build_* (built with the Safe as buyer, seller or user) so the AGENT key sends it and the Safe executes it under the on-chain policy. Simulates it now from the agent and says if the policy allows it.',
  inputSchema: {
    type: 'object',
    properties: {
      safe: addressField('Agent account Safe'),
      roles: addressField('Its Roles module'),
      agent: addressField('Agent wallet that will send the wrapped tx'),
      to: addressField('`to` of the tx to run'),
      value: { type: 'string', pattern: '^\\d{1,30}$', default: '0', description: '`value` of the tx to run, in wei' },
      data: { type: 'string', pattern: '^0x([0-9a-fA-F]{2}){0,8192}$', description: '`data` of the tx to run' },
    },
    required: ['safe', 'roles', 'agent', 'to', 'data'],
    additionalProperties: false,
  },
  rate: { limit: 60, windowMs: MINUTE },
  walletRate: { field: 'agent', rule: { limit: 30, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const safe = getAddress(input.safe);
    const roles = getAddress(input.roles);
    const agent = getAddress(input.agent);
    const inner: Call = { to: getAddress(input.to), value: BigInt(input.value), data: input.data as Hex };
    const avatar = (await deps.client.readContract({ address: roles, abi: rolesAbi, functionName: 'avatar' }).catch(() => null)) as Address | null;
    if (!avatar || avatar.toLowerCase() !== safe.toLowerCase()) throw new ToolError('NOT_FOUND', `${roles} is not the policy module of Safe ${safe}.`, 404);
    const tx = agentExecTx(roles, inner);
    let allowed = true;
    let reason: string | null = null;
    try {
      await deps.client.call({ account: agent, to: tx.to, data: tx.data, value: 0n });
    } catch (err) {
      allowed = false;
      reason = revertMessage(err);
    }
    const summary = `Agent ${agent} runs a tx from Safe ${safe} to ${inner.to}, sending ${fmt(inner.value)} from the Safe.`;
    return {
      data: {
        safe, roles, agent, allowedNow: allowed, reason,
        transactions: allowed ? [txOut(tx, 1, 'agentExec', summary)] : [],
        summary,
        errors: allowed ? [] : [`The policy or the target refused it: ${reason}`],
        canBroadcast: allowed,
        next: allowed ? 'The AGENT wallet sends this tx (value 0; the ETH comes from the Safe).' : 'Do not send. Check the caps with get_agent_account, or ask the owner to add the token.',
      },
    };
  },
};

export const ACCOUNT_TOOLS = [setupAgentAccountTool, updateAgentAccountTool, revokeAgentTool, getAgentAccountTool, agentExecTool] as unknown as ReadonlyArray<ToolDef<never>>;
