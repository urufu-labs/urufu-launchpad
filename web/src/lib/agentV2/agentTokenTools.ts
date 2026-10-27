/// Phase 2 tools: agent tokens (docs/PLAN-agents-and-swarms.md 3). An agent
/// account (Safe + Roles policy, see agentPolicy.ts) launches its own Fair token,
/// the creator fee flows to the Safe, and the Fair forfeit rule applies as-is.
///
///   launch_agent_token  owner: one Safe tx that launches the Fair token from the
///                       Safe and lists it for the agent with selling OFF
///   get_agent_token     anyone: one agent token's creator-fee state, read from chain
///   get_agent_profile   anyone: an agent account's owners, policy, caps, balance
///                       and tokens; what the /agent/[address] page shows
///
/// The policy is read from chain on every call. The indexer is only used to find
/// which tokens a Safe launched; each one is re-checked on chain before it's shown.

import { formatUnits, getAddress, parseAbi, parseEther, type Address } from 'viem';

import { erc20TokenAbi, fairHookHostAbi, fairLaunchFactoryAbi } from '../abis';
import { buildApproveTx, buildFairLaunchTx } from '../launchTx';
import { assertOwned, policyBase, resolveTokens, TOKENS_PATTERN } from './accountTools';
import { ALLOWANCE_DAILY, ALLOWANCE_TRADE, agentTokenLaunchCalls, rolesAbi, safeAbi, safeBatchTx, type Call } from './agentPolicy';
import { addressField, ETH_AMOUNT_PATTERN } from './schema';
import { fmtEth, fmtUru, MINUTE, NAME_PATTERN, revertMessage, ToolError, txOut, ZERO, type AgentDeps, type ToolDef } from './tools';
import { ethPoolKey, poolIdOf } from './tradeTools';

const fairCurveStateAbi = parseAbi([
  'function launcher() view returns (address)',
  'function graduated() view returns (bool)',
  'function creatorSold() view returns (bool)',
  'function batchSettled() view returns (bool)',
]);
const forfeitDropAbi = parseAbi(['function forfeitDropBps() view returns (uint16)']);
const rolesModuleAbi = parseAbi(['function owner() view returns (address)', 'function avatar() view returns (address)']);
const SENTINEL: Address = '0x0000000000000000000000000000000000000001';

// ---------------------------------------------------------------- launch

interface LaunchInput { owner: string; safe: string; roles: string; name: string; ticker: string; depositEth: string; payWith: 'ETH' | 'URU'; listedTokens?: string }

export const launchAgentTokenTool: ToolDef<LaunchInput> = {
  name: 'launch_agent_token',
  title: 'Launch an agent\'s own token (Fair lane)',
  description:
    'Owner-only: one Safe tx that launches a Fair token with the agent account Safe as creator (so the creator fee goes to the Safe), pays the fee and the opening deposit from the Safe, and lists the token for the agent with selling OFF: the agent can buy it, use its opening batch and claim its fees, but never sell, approve or move it, because a creator sell or a balance drop burns the creator fee for good.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: addressField('Safe owner (sends the tx)'),
      safe: addressField('The agent account Safe: the token\'s creator'),
      roles: addressField('Its Roles policy module'),
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: NAME_PATTERN, description: 'Token name' },
      ticker: { type: 'string', minLength: 1, maxLength: 16, pattern: NAME_PATTERN, description: 'Ticker / symbol' },
      depositEth: { type: 'string', pattern: ETH_AMOUNT_PATTERN, default: '0', description: 'The Safe\'s own opening-batch deposit in ETH, paid from the Safe. With 0 the Safe holds nothing at graduation and never earns the fee.' },
      payWith: { type: 'string', enum: ['ETH', 'URU'], default: 'ETH', description: 'Pay the launch fee in ETH or URU, from the Safe' },
      listedTokens: { type: 'string', pattern: TOKENS_PATTERN, description: 'The agent\'s current token list (`tokenList` from setup or the last update). Its v4 buy permission is rewritten to these plus the new token.' },
    },
    required: ['owner', 'safe', 'roles', 'name', 'ticker'],
    additionalProperties: false,
  },
  rate: { limit: 10, windowMs: MINUTE },
  walletRate: { field: 'owner', rule: { limit: 5, windowMs: MINUTE } },
  cacheTtlMs: 0,
  async handler(deps, input) {
    const owner = getAddress(input.owner);
    const safe = getAddress(input.safe);
    const roles = getAddress(input.roles);
    const name = input.name.trim();
    const ticker = input.ticker.trim().toUpperCase();
    if (!name || !ticker) throw new ToolError('INVALID_INPUT', 'name and ticker must not be blank');
    await assertOwned(deps, owner, safe, roles);
    const { client, book } = deps;
    const depositWei = parseEther(input.depositEth);
    // Only urufu tokens can be on the list (the same check update_agent_account runs).
    const listed = (await resolveTokens(deps, input.listedTokens, { allowSells: false, dailySellTokens: undefined, dailyWei: 0n, safe })).map((t) => t.token);

    const [open, ethFee, minUru, uru, safeEth, predicted, dropBps] = await Promise.all([
      client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'launchesOpen' }) as Promise<boolean>,
      client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'ethFeeFor', args: [safe] }) as Promise<bigint>,
      client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'minUruFeeFor', args: [safe] }) as Promise<bigint>,
      client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'uru' }) as Promise<Address>,
      client.getBalance({ address: safe }),
      client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'predictAddresses', args: [safe, name, ticker] }) as Promise<readonly [Address, Address, Address]>,
      client.readContract({ address: book.FairHookHost, abi: forfeitDropAbi, functionName: 'forfeitDropBps' }).catch(() => null) as Promise<number | null>,
    ]);
    const [token, curve, batch] = predicted;
    const code = await client.getCode({ address: token });

    const errors: string[] = [];
    const warnings: string[] = [];
    if (!deps.flags.fairEnabled) errors.push('The Fair lane is not enabled on the site.');
    if (!open) errors.push('Fair launches are closed on-chain (FairLaunchFactory.launchesOpen is false).');
    if (code && code !== '0x') errors.push('This Safe already launched a Fair token with this exact name and ticker.');
    if (depositWei === 0n) warnings.push('No opening deposit: the Safe would hold nothing at graduation, so the creator fee is forfeited from the start.');

    const launch: Call[] = [];
    let fee = ethFee;
    if (input.payWith === 'URU') {
      if (uru === ZERO || minUru === 0n) throw new ToolError('UNAVAILABLE', 'The Fair lane URU fee is not configured. Use payWith "ETH".', 409);
      fee = minUru;
      const uruBal = (await client.readContract({ address: uru, abi: erc20TokenAbi, functionName: 'balanceOf', args: [safe] })) as bigint;
      if (uruBal < fee) errors.push(`The Safe holds ${fmtUru(uruBal)} but the fee is ${fmtUru(fee)}.`);
      // Exact-amount approve from the Safe, spent by the launch in the same tx.
      launch.push(buildApproveTx(uru, book.FairLaunchFactory, fee));
    }
    launch.push(buildFairLaunchTx({ factory: book.FairLaunchFactory, name, ticker, payWith: input.payWith, fee, depositWei }));
    const ethOut = launch.reduce((s, c) => s + c.value, 0n);
    if (safeEth < ethOut) errors.push(`The Safe has ${fmtEth(safeEth)} but the launch needs ${fmtEth(ethOut)} from it. Fund the Safe first.`);

    const calls = agentTokenLaunchCalls({ roles, policy: policyBase(deps), launch, own: { token, curve, batch }, listed });
    const tx = safeBatchTx(safe, owner, calls);

    let simulation: { ok: boolean; error: string | null; skipped?: string } = { ok: false, error: null, skipped: 'blocking errors' };
    if (errors.length === 0) {
      try {
        await client.call({ account: owner, to: tx.to, data: tx.data, value: 0n });
        simulation = { ok: true, error: null };
      } catch (err) {
        simulation = { ok: false, error: revertMessage(err) };
        errors.push(`Simulation reverted: ${simulation.error}`);
      }
    }

    const dropPct = dropBps !== null ? `${dropBps / 100}%` : 'the Fair lane limit';
    const feeText = input.payWith === 'URU' ? fmtUru(fee) : fmtEth(fee);
    const summary =
      `From Safe ${safe}: launch "${name}" ($${ticker}) on the Fair lane with the Safe as creator. Fee ${feeText}, opening deposit ${fmtEth(depositWei)}, ` +
      `${fmtEth(ethOut)} from the Safe. The agent may buy it and claim its fees but can never sell or move it.`;
    const tokenList = [...listed.filter((t) => t.toLowerCase() !== token.toLowerCase()), token].join(',');
    return {
      data: {
        owner, safe, roles,
        predicted: { token, curve, batch },
        fee: { token: input.payWith, amount: fee.toString(), formatted: feeText },
        deposit: { amount: depositWei.toString(), formatted: fmtEth(depositWei) },
        ethFromSafe: ethOut.toString(),
        tokenList,
        creatorFeeRule:
          `The creator fee goes to the Safe while the Safe keeps holding: if its balance of this token falls more than ${dropPct} below its balance at graduation, ` +
          'or the Safe sells on the curve before graduation, the fee is burned for good. The policy keeps the agent from selling or moving it; the owner still can, and that would forfeit it.',
        transactions: [txOut(tx, 1, 'launchAgentToken', summary)],
        simulation,
        errors,
        warnings,
        canBroadcast: errors.length === 0,
        summary,
        next: 'Show `summary` to the OWNER and wait for a clear yes; the OWNER sends this tx. Keep `tokenList` for the next update_agent_account. Then check it with get_agent_token.',
      },
    };
  },
};

// ---------------------------------------------------------------- reads

interface AgentTokenState {
  token: Address;
  curve: Address;
  isAgentToken: boolean;
  stage: 'batch' | 'curve' | 'graduated';
  safeBalance: string;
  creatorSold: boolean;
  pool: null | {
    poolId: `0x${string}`;
    baseline: string;
    floor: string;
    forfeited: boolean;
    fees: { pendingEth: string; claimableEth: string; pendingToken: string; claimableToken: string };
  };
  status: string;
}

/// One token's creator-fee state for `safe`, from chain only. Null when the token
/// isn't a Fair launch.
export async function readAgentToken(deps: AgentDeps, safe: Address, token: Address): Promise<AgentTokenState | null> {
  const { client, book } = deps;
  const curve = (await client.readContract({ address: book.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'curveFor', args: [token] }).catch(() => ZERO)) as Address;
  if (!curve || curve === ZERO) return null;
  const [launcher, graduated, creatorSold, settled, balance] = await Promise.all([
    client.readContract({ address: curve, abi: fairCurveStateAbi, functionName: 'launcher' }) as Promise<Address>,
    client.readContract({ address: curve, abi: fairCurveStateAbi, functionName: 'graduated' }) as Promise<boolean>,
    client.readContract({ address: curve, abi: fairCurveStateAbi, functionName: 'creatorSold' }) as Promise<boolean>,
    client.readContract({ address: curve, abi: fairCurveStateAbi, functionName: 'batchSettled' }) as Promise<boolean>,
    client.readContract({ address: token, abi: erc20TokenAbi, functionName: 'balanceOf', args: [safe] }) as Promise<bigint>,
  ]);
  const isAgentToken = launcher.toLowerCase() === safe.toLowerCase();
  const stage = graduated ? 'graduated' : settled ? 'curve' : 'batch';
  let pool: AgentTokenState['pool'] = null;
  let status: string;
  if (graduated) {
    const poolId = poolIdOf(ethPoolKey(token, book.FairHookHost));
    const [ps, fees, forfeited, dropBps] = await Promise.all([
      client.readContract({ address: book.FairHookHost, abi: fairHookHostAbi, functionName: 'pools', args: [poolId] }) as Promise<readonly [Address, Address, bigint, number, number, number, boolean, boolean, bigint]>,
      client.readContract({ address: book.FairHookHost, abi: fairHookHostAbi, functionName: 'creatorFees', args: [poolId] }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
      client.readContract({ address: book.FairHookHost, abi: fairHookHostAbi, functionName: 'isForfeited', args: [poolId] }) as Promise<boolean>,
      client.readContract({ address: book.FairHookHost, abi: forfeitDropAbi, functionName: 'forfeitDropBps' }) as Promise<number>,
    ]);
    const baseline = ps[8];
    const floor = (baseline * BigInt(10_000 - dropBps)) / 10_000n;
    pool = {
      poolId,
      baseline: baseline.toString(),
      floor: floor.toString(),
      forfeited,
      fees: { pendingEth: fees[0].toString(), pendingToken: fees[1].toString(), claimableEth: fees[2].toString(), claimableToken: fees[3].toString() },
    };
    status = forfeited
      ? 'Creator fee forfeited: new fees are burned.'
      : `Earning. The Safe holds ${formatUnits(balance, 18)} and must stay above ${formatUnits(floor, 18)} to keep earning.`;
  } else {
    status = creatorSold
      ? 'The creator sold on the curve: the fee will be forfeited at graduation.'
      : stage === 'batch'
        ? 'Opening batch: fees start once the token graduates to its Uniswap pool.'
        : 'Trading on the curve: fees start once it graduates to its Uniswap pool.';
  }
  return { token, curve, isAgentToken, stage, safeBalance: balance.toString(), creatorSold, pool, status };
}

interface TokenInput { safe: string; token: string }

export const getAgentTokenTool: ToolDef<TokenInput> = {
  name: 'get_agent_token',
  title: 'Agent token fee status',
  description: 'Read, from chain, an agent token\'s creator-fee state for its Safe: stage, whether the Safe really is the creator, the Safe\'s balance against the forfeit floor, whether the fee is forfeited, and fees pending and claimable (claim with build_claim_creator_fees, run through agent_exec).',
  inputSchema: { type: 'object', properties: { safe: addressField('Agent account Safe'), token: addressField('Its Fair token') }, required: ['safe', 'token'], additionalProperties: false },
  rate: { limit: 60, windowMs: MINUTE },
  cacheTtlMs: 5_000,
  async handler(deps, input) {
    const safe = getAddress(input.safe);
    const token = getAddress(input.token);
    const state = await readAgentToken(deps, safe, token);
    if (!state) throw new ToolError('NOT_FOUND', `${token} is not a Fair lane token.`, 404);
    return { data: { safe, ...state } };
  },
};

/// The Roles module guarding `safe`: an enabled module owned by and acting on it.
export async function findRolesModule(deps: AgentDeps, safe: Address): Promise<Address | null> {
  const page = (await deps.client.readContract({ address: safe, abi: safeAbi, functionName: 'getModulesPaginated', args: [SENTINEL, 10n] }).catch(() => null)) as readonly [Address[], Address] | null;
  for (const m of page?.[0] ?? []) {
    const [owner, avatar] = await Promise.all([
      deps.client.readContract({ address: m, abi: rolesModuleAbi, functionName: 'owner' }).catch(() => null) as Promise<Address | null>,
      deps.client.readContract({ address: m, abi: rolesModuleAbi, functionName: 'avatar' }).catch(() => null) as Promise<Address | null>,
    ]);
    if (owner?.toLowerCase() === safe.toLowerCase() && avatar?.toLowerCase() === safe.toLowerCase()) return getAddress(m);
  }
  return null;
}

interface ProfileInput { safe: string }

/// Each token costs ~10 chain reads; keep one profile call cheap for the RPC.
const MAX_PROFILE_TOKENS = 5;

export const getAgentProfileTool: ToolDef<ProfileInput> = {
  name: 'get_agent_profile',
  title: 'Agent account profile',
  description: 'Everything public about an agent account, read live from chain: Safe owners, its policy module and whether it is on, ETH caps, the Safe\'s balance, and each Fair token the Safe launched with its creator-fee state.',
  inputSchema: { type: 'object', properties: { safe: addressField('Agent account Safe') }, required: ['safe'], additionalProperties: false },
  rate: { limit: 20, windowMs: MINUTE },
  cacheTtlMs: 15_000,
  async handler(deps, input) {
    const safe = getAddress(input.safe);
    const { client } = deps;
    const [owners, threshold, balance, dropBps] = await Promise.all([
      client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }).catch(() => null) as Promise<Address[] | null>,
      client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }).catch(() => null) as Promise<bigint | null>,
      client.getBalance({ address: safe }),
      client.readContract({ address: deps.book.FairHookHost, abi: forfeitDropAbi, functionName: 'forfeitDropBps' }).catch(() => null) as Promise<number | null>,
    ]);
    if (!owners) throw new ToolError('NOT_FOUND', `${safe} is not a Safe on Robinhood Chain.`, 404);
    const roles = await findRolesModule(deps, safe);
    let caps = null;
    if (roles) {
      const [daily, trade] = await Promise.all([
        client.readContract({ address: roles, abi: rolesAbi, functionName: 'allowances', args: [ALLOWANCE_DAILY] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
        client.readContract({ address: roles, abi: rolesAbi, functionName: 'allowances', args: [ALLOWANCE_TRADE] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
      ]);
      caps = { perDay: daily[1].toString(), perTx: trade[1].toString() };
    }
    // The indexer only says which tokens to look at; each is re-checked on chain.
    const launches = ((await deps.indexer.launchesByCreator(safe).catch(() => null)) ?? []).filter((l) => l.lane === 'fair').slice(0, MAX_PROFILE_TOKENS);
    const tokens = (await Promise.all(launches.map((l) => readAgentToken(deps, safe, getAddress(l.tokenAddress)).catch(() => null))))
      .filter((t): t is AgentTokenState => !!t && t.isAgentToken);
    return {
      data: {
        safe,
        owners,
        threshold: threshold?.toString() ?? null,
        roles,
        policyActive: roles !== null,
        caps,
        safeBalance: balance.toString(),
        forfeitDropBps: dropBps,
        tokens,
        note: 'Policy, caps and fee state are read from chain. The list of tokens comes from the indexer and each one is checked on chain.',
      },
    };
  },
};

export const AGENT_TOKEN_TOOLS = [launchAgentTokenTool, getAgentTokenTool, getAgentProfileTool] as unknown as ReadonlyArray<ToolDef<never>>;
